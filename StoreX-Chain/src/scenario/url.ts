import { clockText, parseScenario, type ParseResult } from './parse';
import type { Scenario } from './types';

/**
 * 场景 ↔ 网址（分享链接）：常用的字段写成好读的参数，设施改动压成一段 base64url 的 JSON。
 *   ?region=random-3&gen=g3&seed=2&load=peak&drill=portCongestion&t=08:30&speed=60&play=1
 *   &cam=port（或 cam=x,y,z,tx,ty,tz）&follow=DR-02&weather=rain&tour=container&ex=ex03&fac=eyJkYyI6…
 *   &scenario=typhoon-port（场景库里的一个文件：scenarios/typhoon-port.json）
 * 页签沿用原来的 #report / #network / #about。网址里的 lang（界面语言）不属于场景，原样保留。
 *
 * Scenario <-> URL query string for share links. Facility edits are a base64url JSON blob.
 */
const KEYS = ['region', 'gen', 'seed', 'load', 'drill', 't', 'speed', 'play', 'cam', 'follow', 'weather', 'tour', 'ex', 'fac', 'scenario'] as const;

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const num = (x: number) => String(Math.round(x * 10) / 10);

/** 场景 → 网址参数（不含 ?）；tab 不在这里，用 scenarioHash */
export function scenarioToSearch(s: Scenario, keep?: URLSearchParams): string {
  const q = new URLSearchParams();
  // 保留不属于场景的参数（界面语言、调试开关……）
  if (keep) for (const [k, v] of keep) if (!(KEYS as readonly string[]).includes(k)) q.set(k, v);
  if (s.region && s.region !== 'default') q.set('region', s.region);
  if (s.gen) q.set('gen', s.gen);
  if (s.seed !== undefined) q.set('seed', String(s.seed));
  if (s.load) q.set('load', s.load);
  if (s.drill && s.drill !== 'none') q.set('drill', s.drill);
  if (s.time !== undefined) q.set('t', clockText(s.time));
  if (s.speed !== undefined) q.set('speed', String(s.speed));
  if (s.play !== undefined) q.set('play', s.play ? '1' : '0');
  if (s.camera?.position && s.camera.target) q.set('cam', [...s.camera.position, ...s.camera.target].map(num).join(','));
  else if (s.camera?.preset) q.set('cam', s.camera.preset);
  if (s.follow) q.set('follow', s.follow);
  if (s.weather && s.weather !== 'auto') q.set('weather', s.weather);
  if (s.tour) q.set('tour', s.tour);
  if (s.exercise) q.set('ex', s.exercise);
  if (s.facilities && Object.keys(s.facilities).length) q.set('fac', b64urlEncode(JSON.stringify(s.facilities)));
  // 冒号、逗号、波浪线在查询串里本来就可以不编码：链接好读一些（t=08:30、cam=x,y,z,…、region=custom-7~sea.S）
  return q.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%7E/gi, '~');
}

/** 页签 → 网址里的 #（双屏孪生页签不写） */
export const scenarioHash = (s: Scenario): string => (s.tab && s.tab !== 'twin' ? `#${s.tab}` : '');

/** 完整的分享链接：base 是页面地址（不带参数） */
export function scenarioUrl(base: string, s: Scenario, keep?: URLSearchParams): string {
  const q = scenarioToSearch(s, keep);
  return `${base}${q ? `?${q}` : ''}${scenarioHash(s)}`;
}

/** 网址里有没有场景参数（只有 region、lang 的网址按原来的方式打开） */
export function hasScenarioParams(search: string): boolean {
  const q = new URLSearchParams(search);
  return KEYS.some((k) => k !== 'region' && q.has(k));
}

export interface UrlScenario extends ParseResult {
  /** ?scenario=：场景库里的文件编号（由网页去读 scenarios/<id>.json，再用网址里其余的参数覆盖） */
  library?: string;
}

/** 网址参数 → 场景（检查规则和场景文件一样）；hash 是 location.hash */
export function scenarioFromSearch(search: string, hash = ''): UrlScenario {
  const q = new URLSearchParams(search);
  const raw: Record<string, unknown> = {};
  const errors: string[] = [];
  const str = (k: string) => q.get(k) ?? undefined;
  if (str('region')) raw.region = str('region');
  if (str('gen')) raw.gen = str('gen');
  if (str('seed')) raw.seed = Number(str('seed'));
  if (str('load')) raw.load = str('load');
  if (str('drill')) raw.drill = str('drill');
  if (str('t')) raw.time = str('t');
  if (str('speed')) raw.speed = Number(str('speed'));
  if (str('play')) raw.play = str('play') === '1' || str('play') === 'true';
  const cam = str('cam');
  if (cam) {
    const parts = cam.split(',').map(Number);
    if (parts.length === 6 && parts.every(Number.isFinite)) raw.camera = { position: parts.slice(0, 3), target: parts.slice(3) };
    else raw.camera = { preset: cam };
  }
  if (str('follow')) raw.follow = str('follow');
  if (str('weather')) raw.weather = str('weather');
  if (str('tour')) raw.tour = str('tour');
  if (str('ex')) raw.exercise = str('ex');
  const fac = str('fac');
  if (fac) {
    try {
      raw.facilities = JSON.parse(b64urlDecode(fac));
    } catch {
      errors.push('fac 参数解不开（链接可能被截断了）');
    }
  }
  const tab = hash.replace(/^#/, '');
  if (['report', 'network', 'about'].includes(tab)) raw.tab = tab;
  const lib = str('scenario');
  const library = lib && /^[a-z0-9][a-z0-9-]{0,79}$/.test(lib) ? lib : undefined;
  if (lib && !library) errors.push('scenario 参数只能是场景库里的编号（小写字母、数字、连字符）');
  const r = parseScenario(raw);
  return { ...r, errors: [...errors, ...r.errors], ...(errors.length ? { scenario: undefined } : {}), ...(library ? { library } : {}) };
}

/** 两份场景合并：b 里写了的字段覆盖 a（网址参数覆盖场景库文件；camera、facilities 按字段合并） */
export function mergeScenario(a: Scenario, b: Scenario): Scenario {
  const out: Scenario = { ...a, ...b };
  if (a.camera || b.camera) out.camera = b.camera?.position || b.camera?.preset ? { ...b.camera } : a.camera;
  if (a.facilities || b.facilities) {
    const f: Record<string, unknown> = { ...(a.facilities ?? {}) };
    for (const [k, v] of Object.entries(b.facilities ?? {})) f[k] = { ...((f[k] as object) ?? {}), ...(v as object) };
    out.facilities = f as Scenario['facilities'];
  }
  return out;
}
