/**
 * 界面语言：中文（默认）和英文。
 * - 英文按中文原文查字典（i18n/en.ts），查不到就显示中文；t('还有 {n} 分钟', { n }) 支持 {名字} 插值。
 * - 语言来源按优先级：网址 ?lang=en|zh、本机记住的选择（顶栏的 中文 / EN 切换）、浏览器语言（en 开头用英文）。
 * - 切换语言时重新载入页面（区域、页签都在网址里，会保留）。
 * - 开发模式下记下查不到的英文，控制台列出来，也可以在控制台调 __i18nMissing() 看。
 *
 * UI language: Chinese (default) and English. English strings are looked up by the Chinese source text
 * (i18n/en.ts) and fall back to Chinese when missing. Runtime text (simulation labels, the duty assistant's
 * answers) is translated when shown with tx(), using dictionary entries with {name} placeholders.
 */
export type Lang = 'zh' | 'en';

const KEY = 'storex-chain-lang';
const HAN = /\p{Script=Han}/u;

function detect(): Lang {
  // 没有页面（Node 里跑测试、Web Worker）时一律中文，结果和以前完全一样
  if (typeof document === 'undefined') return 'zh';
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'zh') return q;
  } catch {
    /* 没有网址就跳过 */
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'en' || s === 'zh') return s;
  } catch {
    /* 读不了本机存储（隐私模式等）就跳过 */
  }
  return /^en\b/i.test(navigator.language ?? '') ? 'en' : 'zh';
}

let current: Lang = detect();
let dict: Record<string, string> = {};
// 只有英文才下载字典（中文页面不多加载任何东西）
if (current === 'en') {
  try {
    dict = (await import('./i18n/en')).EN;
  } catch {
    current = 'zh';
  }
}

/** 现在的界面语言 */
export const lang = (): Lang => current;
export const isEn = (): boolean => current === 'en';

/** 开发模式（Vite dev server、vitest） */
const DEV = (() => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

const missing = new Set<string>();
let missTimer: ReturnType<typeof setTimeout> | undefined;
function miss(zh: string): void {
  if (!DEV || missing.has(zh)) return;
  missing.add(zh);
  if (missTimer !== undefined) return;
  missTimer = setTimeout(() => {
    missTimer = undefined;
    console.warn(`[i18n] ${missing.size} 条界面文字没有英文 / strings without English (__i18nMissing() lists them)`);
  }, 3000);
}
/** 开发用：查不到英文的中文原文 */
export const missingKeys = (): string[] => [...missing];
if (DEV && typeof window !== 'undefined') (window as unknown as { __i18nMissing: () => string[] }).__i18nMissing = missingKeys;

// —— 英文的单复数：填进去的数字是 1 时，后面的可数名词改成单数，紧跟的动词跟着变（「1 trucks miss」→「1 truck misses」） ——
// 只看紧跟数字的几个词（中间可以隔「more」「cold-chain」这样的修饰词），遇到介词、标点就停；数字前面是「dock」「door」这样的编号说明时不改
const SINGULAR: Record<string, string> = {
  trucks: 'truck', pallets: 'pallet', doors: 'door', boxes: 'box', units: 'unit', trips: 'trip', days: 'day', jobs: 'job', cards: 'card', stops: 'stop',
  hours: 'hour', minutes: 'minute', seconds: 'second', weeks: 'week', months: 'month', years: 'year', stores: 'store', calls: 'call', positions: 'position',
  items: 'item', arrivals: 'arrival', departures: 'departure', recommendations: 'recommendation', docks: 'dock', vehicles: 'vehicle', families: 'family',
  flights: 'flight', runs: 'run', times: 'time', trailers: 'trailer', spaces: 'space', moves: 'move', events: 'event', changes: 'change', cranes: 'crane',
  stands: 'stand', sets: 'set', orders: 'order', spots: 'spot', objects: 'object', things: 'thing', numbers: 'number', slots: 'slot', warnings: 'warning',
  drops: 'drop', playbooks: 'playbook', 'person-hours': 'person-hour', messages: 'message', decisions: 'decision', combinations: 'combination', entries: 'entry',
  forecasts: 'forecast', simulations: 'simulation', kinds: 'kind', bays: 'bay', movements: 'movement', visits: 'visit', racks: 'rack', cars: 'car',
  islands: 'island', loads: 'load', hits: 'hit', alerts: 'alert', anomalies: 'anomaly', commands: 'command', issues: 'issue', declarations: 'declaration',
  characters: 'character', steps: 'step', seeds: 'seed', 'gate-ins': 'gate-in', trains: 'train', ships: 'ship', vessels: 'vessel', containers: 'container',
  questions: 'question', lines: 'line', lanes: 'lane', routes: 'route', berths: 'berth', shifts: 'shift', workers: 'worker', drivers: 'driver',
  forklifts: 'forklift', robots: 'robot', planes: 'plane', proposals: 'proposal', approvals: 'approval', requests: 'request', tasks: 'task',
  operations: 'operation', deliveries: 'delivery', customers: 'customer', products: 'product', cases: 'case', crates: 'crate', cartons: 'carton',
  parcels: 'parcel', rows: 'row', scenarios: 'scenario', exercises: 'exercise', regions: 'region', stations: 'station', gates: 'gate', zones: 'zone',
  areas: 'area', sites: 'site', legs: 'leg', cameras: 'camera', sensors: 'sensor', readings: 'reading', records: 'record', rules: 'rule', checks: 'check',
  notes: 'note', actions: 'action', options: 'option', people: 'person', persons: 'person', crews: 'crew', teams: 'team', accidents: 'accident',
  incidents: 'incident', breakdowns: 'breakdown', jams: 'jam', closures: 'closure', delays: 'delay', faults: 'fault', reefers: 'reefer', loaders: 'loader',
  dollies: 'dolly', tugs: 'tug', shuttles: 'shuttle', pickers: 'picker', pickups: 'pickup', vans: 'van', buses: 'bus', passengers: 'passenger',
  shelves: 'shelf', pieces: 'piece', packs: 'pack', tonnes: 'tonne', labels: 'label', sections: 'section', points: 'point', pts: 'pt', ports: 'port',
  airports: 'airport', facilities: 'facility', hubs: 'hub', parks: 'park', depots: 'depot', yards: 'yard', bins: 'bin', cycles: 'cycle', waves: 'wave',
  batches: 'batch', layers: 'layer', levels: 'level', windows: 'window', appointments: 'appointment', reservations: 'reservation', violations: 'violation',
  errors: 'error', problems: 'problem', risks: 'risk', conflicts: 'conflict', answers: 'answer', sources: 'source', documents: 'document', words: 'word',
  sailings: 'sailing', voyages: 'voyage', services: 'service', landings: 'landing', takeoffs: 'takeoff', aircraft: 'aircraft',
  rescues: 'rescue', repairs: 'repair', transfers: 'transfer', shipments: 'shipment', consignments: 'consignment', skus: 'SKU', SKUs: 'SKU',
};
// 单数名词后面的动词：复数形式 → 单数第三人称
const VERB1: Record<string, string> = {
  are: 'is', were: 'was', have: 'has', do: 'does', go: 'goes', need: 'needs', miss: 'misses', arrive: 'arrives', wait: 'waits', reach: 'reaches',
  prefer: 'prefers', remain: 'remains', run: 'runs', come: 'comes', leave: 'leaves', depart: 'departs', use: 'uses', show: 'shows', exceed: 'exceeds',
  overlap: 'overlaps', queue: 'queues', sit: 'sits', stand: 'stands', get: 'gets', take: 'takes', hold: 'holds', block: 'blocks', carry: 'carries',
  land: 'lands', finish: 'finishes', start: 'starts', end: 'ends', fail: 'fails', cross: 'crosses', pass: 'passes', stay: 'stays', work: 'works',
  sell: 'sells', expire: 'expires', happen: 'happens', apply: 'applies', affect: 'affects', contain: 'contains', include: 'includes', match: 'matches',
  cost: 'costs', save: 'saves', return: 'returns', require: 'requires', want: 'wants', hit: 'hits', clash: 'clashes', collide: 'collides', touch: 'touches',
  share: 'shares', look: 'looks', seem: 'seems', move: 'moves', break: 'breaks', drive: 'drives', park: 'parks', berth: 'berths', sail: 'sails',
  load: 'loads', unload: 'unloads', open: 'opens', close: 'closes', occupy: 'occupies', cover: 'covers', lack: 'lacks', lose: 'loses',
};
// 数字前面是这些词时，数字是编号（「dock 1」「day 1」），不改
const LABEL_WORD = new Set(['dock', 'door', 'berth', 'gate', 'lane', 'line', 'route', 'day', 'week', 'shift', 'zone', 'platform', 'track', 'crane', 'station', 'bay', 'row', 'step', 'level', 'stage', 'exercise', 'part', 'no', 'no.', '#', 'number', 'version', 'round', 'phase', 'wave', 'quay', 'pier', 'terminal', 'hall', 'area', 'stand', 'slot', 'plan', 'option', 'card', 'scenario', 'region', 'seed', 'park', 'lot', 'parking', 'building', 'floor', 'block', 'section', 'page', 'chapter', 'figure', 'table', 'type', 'class', 'tier', 'grade', 'priority', 'rank', 'item', 'case', 'leg', 'stop', 'warehouse', 'yard', 'store', 'rail', 'apron', 'hangar']);
// 遇到这些词就不再往后找名词
const STOP_SCAN = new Set(['of', 'in', 'at', 'to', 'with', 'for', 'from', 'on', 'by', 'and', 'or', 'per', 'the', 'a', 'an', 'than', 'is', 'are', 'was', 'were', 'will', 'can', 'may', 'must', 'should', 'would', 'could', 'has', 'have', 'had', 'that', 'which', 'who', 'into', 'over', 'under', 'out', 'off', 'up', 'down', 'after', 'before', 'since', 'until', 'via', 'vs', 'versus', 'x', 'min', 'h', 'km', 'm', 's', 't', 'kg', 'g']);
const ADVERB = new Set(['still', 'also', 'now', 'already', 'currently', 'only', 'just', 'usually', 'often', 'probably', 'then']);
const cased = (src: string, out: string) => (/^[A-Z]/.test(src) && /^[a-z]/.test(out) ? out.charAt(0).toUpperCase() + out.slice(1) : out);
function singularWord(w: string): string | undefined {
  const s = SINGULAR[w] ?? SINGULAR[w.toLowerCase()];
  if (s) return cased(w, s);
  // 缩写的复数（ULDs、TEUs）
  if (/^[A-Z]{2,}s$/.test(w)) return w.slice(0, -1);
  return undefined;
}

/**
 * 英文里数字 1 后面的名词改单数：text 里 [start, end) 是填进去的「1」。Count-aware English: after a filled-in "1", the countable noun
 * among the next few words becomes singular and the verb right after it agrees ("1 trucks miss" → "1 truck misses").
 */
export function agreeOne(text: string, start: number, end: number): string {
  const before = /([A-Za-z#.]+)\s*$/.exec(text.slice(0, start))?.[1]?.toLowerCase();
  if (before && LABEL_WORD.has(before.replace(/\.$/, ''))) return text;
  if (/[\d.,/:–-]$/.test(text.slice(0, start)) || /^[\d.,%/:]/.test(text.slice(end))) return text;
  const word = /^( +)([A-Za-z][A-Za-z-]*)/;
  let at = end;
  for (let k = 0; k < 4; k++) {
    const m = word.exec(text.slice(at));
    if (!m) return text;
    const w = m[2] as string;
    const lw = w.toLowerCase();
    if (STOP_SCAN.has(lw)) return text;
    const one = singularWord(w);
    const wStart = at + (m[1] as string).length;
    if (!one) {
      at = wStart + w.length;
      continue;
    }
    let out = text.slice(0, wStart) + one + text.slice(wStart + w.length);
    // 紧跟的动词（中间可以隔一个 still、now 这样的副词）
    let vAt = wStart + one.length;
    for (let j = 0; j < 2; j++) {
      const v = word.exec(out.slice(vAt));
      if (!v) break;
      const vw = v[2] as string;
      const vs = (v[1] as string).length;
      if (ADVERB.has(vw.toLowerCase()) && j === 0) {
        vAt += vs + vw.length;
        continue;
      }
      const v1 = VERB1[vw];
      if (v1) out = out.slice(0, vAt + vs) + v1 + out.slice(vAt + vs + vw.length);
      break;
    }
    return out;
  }
  return text;
}

/** {名字} 换成值；en = 英文时按填进去的数字调整单复数 */
function fill(s: string, vars: Record<string, unknown>, en = false): string {
  if (!en) return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  let out = '';
  let last = 0;
  const ones: [number, number][] = [];
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    out += s.slice(last, m.index);
    const k = m[1] as string;
    const v = k in vars ? String(vars[k]) : m[0];
    if (v === '1') ones.push([out.length, out.length + 1]);
    out += v;
    last = (m.index ?? 0) + m[0].length;
  }
  out += s.slice(last);
  for (let i = ones.length - 1; i >= 0; i--) {
    const [a, b] = ones[i] as [number, number];
    out = agreeOne(out, a, b);
  }
  return out;
}

/** 按中文原文取当前语言的文字；vars 填进 {名字} */
export function t(zh: string, vars?: Record<string, unknown>): string {
  let s = zh;
  let en = false;
  if (current === 'en') {
    const hit = dict[zh];
    if (hit !== undefined) {
      s = hit;
      en = true;
    } else miss(zh);
  }
  return vars ? fill(s, vars, en) : s;
}

// —— 运行时文字（地名、仿真给的标签和作业状态等）：先整句查，再按带 {名字} 的字典条目匹配 ——
// join：「{a}、{b}」这样只有一个分隔符的连接条目，后半段（列表剩下的部分）不算一层嵌套，长列表也能逐项翻
type Pattern = { re: RegExp; names: string[]; en: string; join: boolean; sep: string };
const patternCache = new WeakMap<Record<string, string>, Pattern[]>();
const JOIN = /^\{\w+\}(、|；|，|。| · )\{\w+\}$/;
function patternsOf(d: Record<string, string>): Pattern[] {
  let out = patternCache.get(d);
  if (out) return out;
  const list: (Pattern & { fixed: number })[] = [];
  for (const [zh, en] of Object.entries(d)) {
    if (!/\{\w+\}/.test(zh)) continue;
    const names: string[] = [];
    const src = zh
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) {
          names.push(m[1] as string);
          // 名字以 _ 结尾的只填短语（不跨过中文的逗号、句号、分号、冒号），放在句尾时不会把后面的句子吞进来；
          // 以 __ 结尾的尽量多填（自己带括号的标签后面还跟着括号时用）
          const name = m[1] as string;
          return name.endsWith('__') ? '(.+)' : name.endsWith('_') ? '([^，。；：、！？]+?)' : '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    list.push({ re: new RegExp(`^${src}$`, 's'), names, en, join: JOIN.test(zh), sep: JOIN.exec(zh)?.[1] ?? '', fixed: zh.replace(/\{\w+\}/g, '').length });
  }
  out = list.sort((x, y) => y.fixed - x.fixed);
  patternCache.set(d, out);
  return out;
}

/** 查过的结果（按字典、层数和原文记；没查到记 null）：同一段文字在长句里反复出现时不重复匹配 */
const memoCache = new WeakMap<Record<string, string>, Map<string, string | null>>();

/** 在字典 d 里找 text 的英文：整句，或者按带 {名字} 的条目匹配（填进去的部分再查一次）；找不到返回 undefined */
export function lookup(d: Record<string, string>, text: string, depth = 0): string | undefined {
  const hit = d[text];
  if (hit !== undefined) return hit;
  if (depth > 3) return undefined;
  let memo = memoCache.get(d);
  if (!memo) memoCache.set(d, (memo = new Map()));
  const key = `${depth}\u0001${text}`;
  const known = memo.get(key);
  if (known !== undefined) return known ?? undefined;
  let res: string | undefined;
  next: for (const p of patternsOf(d)) {
    const m = p.re.exec(text);
    if (!m) continue;
    // 连接条目在第一个分隔符切开翻不出来时：前半段自己可能带着分隔符（比如「标签 值」的值里有「；」），浅层的短列表再往后挪几个分隔符试试
    if (p.join && depth <= 1) {
      const first = lookup(d, m[1] as string, depth + 1);
      if (first === undefined) {
        const cuts: number[] = [];
        for (let k = text.indexOf(p.sep, (m[1] as string).length + 1); k > 0 && cuts.length < 7; k = text.indexOf(p.sep, k + 1)) cuts.push(k);
        if (cuts.length <= 6)
          for (const k of cuts) {
            const a = text.slice(0, k);
            const b = text.slice(k + p.sep.length);
            if (!b) continue;
            const ea = lookup(d, a, depth + 1);
            const eb = ea === undefined ? undefined : HAN.test(b) ? lookup(d, b, depth) : b;
            if (ea === undefined || eb === undefined) continue;
            res = fill(p.en, { [p.names[0] as string]: ea, [p.names[1] as string]: eb }, true);
            break next;
          }
        continue;
      }
    }
    // 填进 {名字} 的中文部分也必须查得到，否则不算匹配（避免「{x}车」这种短条目把半句中文套成半中半英）；有一段查不到就不再查后面的
    const vars: Record<string, string> = {};
    // 名字以 raw 开头的原样保留（用户自己打的字，比如错别字提示里的原词）；以 opt 开头的查得到就翻，查不到原样保留
    for (let i = 0; i < p.names.length; i++) {
      const part = m[i + 1] as string;
      const name = p.names[i] as string;
      const keep = name.startsWith('raw');
      let en = keep || !HAN.test(part) ? part : lookup(d, part, p.join && i === p.names.length - 1 ? depth : depth + 1);
      if (en === undefined && name.startsWith('opt')) en = part;
      if (en === undefined) continue next;
      vars[name] = en;
    }
    res = fill(p.en, vars, true);
    break;
  }
  if (memo.size > 20000) memo.clear();
  memo.set(key, res ?? null);
  return res;
}

const cache = new Map<string, string>();
/** 翻译运行时才知道的中文（地名标签、仿真给的名字和作业状态）；中文界面或查不到就原样返回 */
export function tx(zh: string): string {
  if (current !== 'en' || !zh || !HAN.test(zh)) return zh;
  let res = cache.get(zh);
  if (res !== undefined) return res;
  res = lookup(dict, zh);
  if (res === undefined) {
    miss(zh);
    res = zh;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(zh, res);
  return res;
}

/** 数字按当前语言排版（两种语言都用千分位逗号） */
export function fmtNum(v: number, digits = 0): string {
  return v.toLocaleString(current === 'en' ? 'en-US' : 'zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// —— 切换 ——
const listeners = new Set<(l: Lang) => void>();
/** 语言变了通知（返回取消函数） */
export function onChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** 换语言：记在本机，通知监听者 */
export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* 存不了就只在这次有效 */
  }
  if (l === current) return;
  current = l;
  for (const fn of listeners) fn(l);
}

const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'content'];
/** 页面里带 data-i18n 的静态文字：翻译元素自己的文字节点和 title、aria-label 等属性 */
export function applyStatic(root: ParentNode = document): void {
  if (current !== 'en') return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    // data-i18n="键" 指定字典键（同一个词在不同地方译法不同时用），空值就用文字本身
    const explicit = el.dataset.i18n;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const raw = n.nodeValue ?? '';
      const text = raw.trim();
      if (text && HAN.test(text)) n.nodeValue = raw.replace(text, t(explicit || text));
    }
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && HAN.test(v)) el.setAttribute(a, t(v));
    }
  }
}

/** 顶栏的 中文 / EN 切换：换语言后带着 ?lang= 重新载入，区域（?region=）和页签（#）照旧 */
export function mountLangToggle(box: HTMLElement | null): void {
  if (!box) return;
  for (const b of box.querySelectorAll<HTMLButtonElement>('button[data-lang]')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === current));
    b.onclick = () => setLang(b.dataset.lang === 'en' ? 'en' : 'zh');
  }
  onChange((l) => {
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    location.href = u.toString();
  });
}

/** 启动：<html lang>、标题、静态文字、切换按钮、英文模式下的说明 */
export function initI18n(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
  document.documentElement.dataset.lang = current;
  applyStatic();
  mountLangToggle(document.getElementById('lang-toggle'));
  for (const el of document.querySelectorAll<HTMLElement>('[data-lang-only]')) el.hidden = el.dataset.langOnly !== current;
}
