import { defaultFacilities, RANGES, type Facilities } from '../facility/config';
import { DRILL_KEYS, GENS, LOAD_LEVELS, PRESETS, SCENARIO_FORMAT, SCENARIO_VERSION, SPEEDS, TABS, TOURS, WEATHERS, type DeepPartial, type Scenario } from './types';

/**
 * 读场景文件：检查每个字段的类型和取值范围，返回规整后的场景（time 一律换成秒）、错误和提醒。
 * 有错误就不返回 scenario（网页提示、命令行退出码 1）；不认识的字段只提醒，不算错（以后的版本可能加字段）。
 * Reads and validates a scenario object. Errors reject the file; unknown fields are only warnings.
 */
export interface ParseResult {
  scenario?: Scenario;
  errors: string[];
  warnings: string[];
}

const KNOWN = new Set(['$schema', 'format', 'version', 'id', 'title', 'titleEn', 'description', 'descriptionEn', 'region', 'gen', 'seed', 'load', 'drill', 'facilities', 'time', 'speed', 'play', 'camera', 'follow', 'weather', 'tab', 'tour', 'exercise']);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** "08:30"、"8:30"、"08:30:15" 或秒数 → 秒；不合法返回 undefined */
export function parseClock(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v < 86400 ? Math.round(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return undefined;
  return h * 3600 + mi * 60 + s;
}

/** 秒 → "HH:MM"（分享链接、界面里显示） */
export function clockText(t: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.floor(t / 60)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const text = (v: unknown, key: string, errors: string[], max = 2000): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${key} 应该是文字`);
    return undefined;
  }
  if (v.length > max) {
    errors.push(`${key} 太长（最多 ${max} 个字符）`);
    return undefined;
  }
  return v;
};

function oneOf<T extends string>(v: unknown, list: readonly T[], key: string, errors: string[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  errors.push(`${key} 只能是 ${list.join(' / ')}`);
  return undefined;
}

const vec3 = (v: unknown, key: string, errors: string[]): [number, number, number] | undefined => {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e5)) return [v[0], v[1], v[2]] as [number, number, number];
  errors.push(`${key} 应该是三个数 [x, y, z]（米）`);
  return undefined;
};

/** 设施改动：每个数值字段按管理台的取值范围检查；检修设备是文字数组；岗位表是 { key, crew: { early, late, night } } 的数组 */
function facilitiesOf(v: unknown, errors: string[], warnings: string[]): DeepPartial<Facilities> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) {
    errors.push('facilities 应该是对象（port / airport / dc / store）');
    return undefined;
  }
  const d = defaultFacilities();
  const out: Record<string, Record<string, unknown>> = {};
  for (const [fk, fv] of Object.entries(v)) {
    if (!(fk in d)) {
      warnings.push(`facilities.${fk} 不认识，忽略`);
      continue;
    }
    if (!isObj(fv)) {
      errors.push(`facilities.${fk} 应该是对象`);
      continue;
    }
    const ranges = RANGES[fk as keyof typeof RANGES] as Record<string, readonly [number, number]>;
    const base = d[fk as keyof Facilities] as unknown as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(fv)) {
      const key = `facilities.${fk}.${k}`;
      if (!(k in base)) {
        warnings.push(`${key} 不认识，忽略`);
        continue;
      }
      const r = ranges[k];
      if (r) {
        if (typeof x !== 'number' || !Number.isFinite(x) || x < r[0] || x > r[1]) errors.push(`${key} 应该在 ${r[0]}–${r[1]} 之间`);
        else o[k] = x;
      } else if (k === 'down') {
        if (!Array.isArray(x) || !x.every((s) => typeof s === 'string' && s.length < 40)) errors.push(`${key} 应该是设备编号的数组（如 ["QC1"]）`);
        else o[k] = [...x];
      } else if (k === 'staff') {
        // 每个岗位写 key 和要改的班次人数（没写的班次不变）
        const crewOk = (c: unknown) => isObj(c) && Object.entries(c).every(([sh, n]) => ['early', 'late', 'night'].includes(sh) && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 200);
        const keys = new Set((base.staff as { key: string }[]).map((r) => r.key));
        const ok = Array.isArray(x) && x.every((s) => isObj(s) && typeof s.key === 'string' && keys.has(s.key) && crewOk(s.crew));
        if (!ok) errors.push(`${key} 应该是岗位数组：[{ "key": "recv", "crew": { "early": 3 } }, …]（key 是这个设施已有的岗位：${[...keys].join('、')}）`);
        else o[k] = x;
      } else if (typeof x === typeof base[k]) o[k] = x;
      else errors.push(`${key} 类型不对`);
    }
    out[fk] = o;
  }
  return out as DeepPartial<Facilities>;
}

export function parseScenario(input: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { errors: ['场景文件应该是一个 JSON 对象'], warnings };
  for (const k of Object.keys(input)) if (!KNOWN.has(k)) warnings.push(`字段 ${k} 不认识，忽略`);
  if (input.format !== undefined && input.format !== SCENARIO_FORMAT) errors.push(`format 应该是 "${SCENARIO_FORMAT}"`);
  if (input.version !== undefined && input.version !== SCENARIO_VERSION) errors.push(`version ${String(input.version)} 不支持（这个版本只认 ${SCENARIO_VERSION}）`);
  const s: Scenario = { format: SCENARIO_FORMAT, version: SCENARIO_VERSION };
  const id = text(input.id, 'id', errors, 80);
  if (id !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push('id 只能用小写字母、数字和连字符');
    else s.id = id;
  }
  for (const k of ['title', 'titleEn'] as const) {
    const v = text(input[k], k, errors, 200);
    if (v !== undefined) s[k] = v;
  }
  for (const k of ['description', 'descriptionEn'] as const) {
    const v = text(input[k], k, errors);
    if (v !== undefined) s[k] = v;
  }
  const region = text(input.region, 'region', errors, 200);
  if (region !== undefined) {
    if (!/^(default|random-\d{1,6}|custom-\d{1,6}(~[a-z]+\.[A-Za-z0-9]+)*)$/.test(region)) errors.push('region 应该是 default、random-编号，或自定义写法（custom-7~sea.S~river.1，和网址里的 ?region= 一样）');
    else s.region = region;
  }
  const gen = oneOf(input.gen, GENS, 'gen', errors);
  if (gen) s.gen = gen;
  if (input.seed !== undefined) {
    if (typeof input.seed !== 'number' || !Number.isInteger(input.seed) || input.seed < 1 || input.seed > 9999) errors.push('seed 应该是 1–9999 的整数');
    else s.seed = input.seed;
  }
  const load = oneOf(input.load, LOAD_LEVELS, 'load', errors);
  if (load) s.load = load;
  const drill = oneOf(input.drill, DRILL_KEYS, 'drill', errors);
  if (drill) s.drill = drill;
  const fac = facilitiesOf(input.facilities, errors, warnings);
  if (fac && Object.keys(fac).length) s.facilities = fac;
  if (input.time !== undefined) {
    const t = parseClock(input.time);
    if (t === undefined) errors.push('time 应该是 "HH:MM" 或当天的秒数（0–86399）');
    else s.time = Math.min(t, 86340);
  }
  if (input.speed !== undefined) {
    if (typeof input.speed !== 'number' || !SPEEDS.includes(input.speed)) errors.push(`speed 只能是 ${SPEEDS.join(' / ')}`);
    else s.speed = input.speed;
  }
  if (input.play !== undefined) {
    if (typeof input.play !== 'boolean') errors.push('play 应该是 true / false');
    else s.play = input.play;
  }
  if (input.camera !== undefined) {
    if (!isObj(input.camera)) errors.push('camera 应该是对象：{ "preset": "port" } 或 { "position": [x, y, z], "target": [x, y, z] }');
    else {
      const preset = oneOf(input.camera.preset, PRESETS, 'camera.preset', errors);
      const position = vec3(input.camera.position, 'camera.position', errors);
      const target = vec3(input.camera.target, 'camera.target', errors);
      if (!!position !== !!target) errors.push('camera.position 和 camera.target 要一起给');
      for (const k of Object.keys(input.camera)) if (!['preset', 'position', 'target'].includes(k)) warnings.push(`camera.${k} 不认识，忽略`);
      s.camera = { ...(preset ? { preset } : {}), ...(position && target ? { position, target } : {}) };
    }
  }
  const follow = text(input.follow, 'follow', errors, 40);
  if (follow !== undefined) s.follow = follow;
  const weather = oneOf(input.weather, WEATHERS, 'weather', errors);
  if (weather) s.weather = weather;
  const tab = oneOf(input.tab, TABS, 'tab', errors);
  if (tab) s.tab = tab;
  const tour = oneOf(input.tour, TOURS, 'tour', errors);
  if (tour) s.tour = tour;
  const ex = text(input.exercise, 'exercise', errors, 20);
  if (ex !== undefined) {
    if (!/^ex\d{2}$/.test(ex)) errors.push('exercise 应该像 ex01');
    else s.exercise = ex;
  }
  return errors.length ? { errors, warnings } : { scenario: s, errors, warnings };
}

/** 把设施改动合并到一份完整的配置上（默认配置或现在的配置）；数组整个替换 */
export function mergeFacilities(base: Facilities, part: DeepPartial<Facilities> | undefined): Facilities {
  const out: Facilities = JSON.parse(JSON.stringify(base));
  if (!part) return out;
  for (const [fk, fv] of Object.entries(part)) {
    const tgt = out[fk as keyof Facilities] as unknown as Record<string, unknown>;
    if (!tgt || !fv) continue;
    for (const [k, x] of Object.entries(fv)) {
      if (k === 'staff' && Array.isArray(x)) {
        // 岗位表：按 key 合并（只写 key 和 crew 也行），没写的岗位保持原样
        const staff = tgt.staff as { key: string; crew: Record<string, number> }[];
        for (const r of x as { key: string; crew: Record<string, number> }[]) {
          const i = staff.findIndex((y) => y.key === r.key);
          if (i >= 0) staff[i] = { ...staff[i], ...r, crew: { ...staff[i]!.crew, ...r.crew } } as (typeof staff)[number];
        }
      } else tgt[k] = Array.isArray(x) ? [...x] : x;
    }
  }
  return out;
}

/** 两份设施配置的差别（cur 相对 base 改了的字段）：分享链接、导出场景只写这些 */
export function facilitiesDiff(base: Facilities, cur: Facilities): DeepPartial<Facilities> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const fk of Object.keys(base) as (keyof Facilities)[]) {
    const a = base[fk] as unknown as Record<string, unknown>;
    const b = cur[fk] as unknown as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(a)) {
      if (k === 'staff') {
        const sa = a.staff as { key: string; crew: Record<string, number> }[];
        const sb = b.staff as { key: string; crew: Record<string, number> }[];
        const changed = sb.filter((r) => JSON.stringify(r.crew) !== JSON.stringify(sa.find((y) => y.key === r.key)?.crew)).map((r) => ({ key: r.key, crew: { ...r.crew } }));
        if (changed.length) o.staff = changed;
      } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) o[k] = Array.isArray(b[k]) ? [...(b[k] as unknown[])] : b[k];
    }
    if (Object.keys(o).length) out[fk] = o;
  }
  return out as DeepPartial<Facilities>;
}
