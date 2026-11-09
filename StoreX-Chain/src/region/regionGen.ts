import { footprintKm, identityFrame, kmToWorld, type Frame, type XZ } from './frames';
import { LOCAL_ANCHORAGE, LOCAL_LINER_IN, LOCAL_LINER_OUT, type Km, type RoadClass } from './region';

/**
 * 区域生成器：按现实中滨海城市的样子生成整个区域——海岸线、河流、城区的边界和干道网、高架快速路、过河的桥、
 * 绕城的快速路（不成环，沿内陆一侧绕过城区，两头接到海边）、通往港口、机场、物流园和两个高速出口的高速、
 * 铁路（港口铁路站 → 绕城 → 物流园铁路货运站 → 出区域，沿途一座城市客运站），以及门店的位置。
 *
 * 三种状态：
 * - 默认：港口、机场、物流园、两个高速出口在原来的位置（报告里的数字按它算），城区、河流、道路、铁路和门店按编号 1 生成；
 * - 随机：所有位置都随机——海在哪一侧、港口在海岸的哪一段、机场和物流园在城市的哪个方向多远、铁路从哪边出区域、
 *   两个高速出口的方向、有没有河、城市多大、门店在市中心还是城郊；
 * - 自定义：上面每一项都可以指定（没指定的按编号随机）。
 * 同一个规格每次生成的区域完全一样。坐标单位公里（x 向东、y 向北），市中心在原点。
 *
 * 港口、机场、物流园内部按「局部坐标」画（原来的位置），生成器给每个设施一个坐标系（frames.ts）：平移、旋转进区域。
 */

export type Dir8 = 'E' | 'NE' | 'N' | 'NW' | 'W' | 'SW' | 'S' | 'SE';
export const DIR8: Dir8[] = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
export const DIR_LABEL: Record<Dir8, string> = { E: '东', NE: '东北', N: '北', NW: '西北', W: '西', SW: '西南', S: '南', SE: '东南' };
const dirAngle = (d: Dir8) => (DIR8.indexOf(d) * Math.PI) / 4;
/** 两个方位相差几格（0–4，一格 45°） */
const dirGap = (a: Dir8, b: Dir8) => {
  const k = Math.abs(DIR8.indexOf(a) - DIR8.indexOf(b)) % 8;
  return Math.min(k, 8 - k);
};
/** 一个方向最接近的方位（标签用：「往北 · 国内长途」） */
export function dirOf(v: Km): Dir8 {
  let k = Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4));
  k = ((k % 8) + 8) % 8;
  return DIR8[k] as Dir8;
}

export type CitySize = 'S' | 'M' | 'L';
export type PortSpot = 'left' | 'center' | 'right';
export type StoreSpot = 'center' | 'urban' | 'suburb';
export const SIZE_LABEL: Record<CitySize, string> = { S: '小城市', M: '中等城市', L: '大城市' };
export const PORT_LABEL: Record<PortSpot, string> = { left: '面朝大海的左手边', center: '正对市区', right: '面朝大海的右手边' };
export const STORE_LABEL: Record<StoreSpot, string> = { center: '市中心', urban: '城区', suburb: '城郊' };
/**
 * 城市形态（随机、自定义区域才有；默认区域按原来的生成方式，和「自由生长」一样）：
 * 自由生长——干道按地形自由连成四边形、五边形街区；方格——干道沿两个方向排成方格；环形放射——几圈环路加放射路；
 * 带状——城区沿海岸拉长，几条平行的干道串起来；多组团——城区分成几个组团，组团之间留绿带，各有副中心。
 */
export type CityForm = 'organic' | 'grid' | 'radial' | 'linear' | 'cluster';
/** 海岸：曲折、海湾（城区围着海湾）、半岛（一段陆地伸进海里）、平直、河口（喇叭形的河口和几座岛） */
export type CoastType = 'wavy' | 'bay' | 'peninsula' | 'straight' | 'estuary';
/** 河：一条，或者在城外有一条支流汇进来 */
export type RiverForm = 'one' | 'branching';
export const FORM_LABEL: Record<CityForm, string> = { organic: '自由生长', grid: '方格路网', radial: '环形放射', linear: '带状（沿海岸）', cluster: '多组团（绿带隔开）' };
export const COAST_LABEL: Record<CoastType, string> = { wavy: '曲折海岸', bay: '海湾', peninsula: '半岛', straight: '平直海岸', estuary: '河口和岛屿' };
export const RIVER_FORM_LABEL: Record<RiverForm, string> = { one: '一条河', branching: '干流加一条支流' };

export interface RegionOptions {
  /** 海在城市的哪一侧 */
  sea: Dir8;
  river: boolean;
  size: CitySize;
  /** 港口在海岸的哪一段（站在市区面朝大海看） */
  port: PortSpot;
  airport: Dir8;
  airportFar: boolean;
  park: Dir8;
  parkFar: boolean;
  /** 洲际铁路从哪个方向出区域 */
  rail: Dir8;
  /** 国内长途（含内陆产区）、跨境长途两个高速出口的方向 */
  domestic: Dir8;
  border: Dir8;
  store: StoreSpot;
  /** 下面几项只有随机、自定义区域有（默认区域没有这几项，生成方式和原来一样） */
  form?: CityForm;
  coast?: CoastType;
  riverForm?: RiverForm;
  /** 常年主导风向（风从哪个方向来）：机场跑道顺着风向 */
  wind?: Dir8;
}
export type RegionMode = 'default' | 'random' | 'custom';
export interface RegionSpec {
  mode: RegionMode;
  seed: number;
  /** 自定义：指定的项（没指定的按编号随机） */
  options?: Partial<RegionOptions>;
}
export const DEFAULT_OPTIONS: RegionOptions = { sea: 'S', river: true, size: 'M', port: 'right', airport: 'SE', airportFar: true, park: 'NE', parkFar: true, rail: 'E', domestic: 'N', border: 'E', store: 'urban' };
export const DEFAULT_REGION: RegionSpec = { mode: 'default', seed: 1 };

/** 区域的范围（公里） */
export const BOUNDS = { x0: -40, x1: 48, y0: -28, y1: 36 };

/**
 * 设施在局部坐标（沙盘米，原来的位置）里的参考点、占地和对外的接口：
 * 港口的海在局部 +z 一侧（码头朝南），机场跑道沿局部 x，物流园的大门朝局部 +z、铁路货运站的股道沿局部 x。
 */
export const LOCAL = {
  port: { o: { x: -2100, z: 1240 }, coastRef: { x: -2100, z: 1360 }, rect: { x0: -2950, x1: -1450, z0: 780, z1: 1560 }, node: { x: -21, y: -12.4 }, gate: { x: 0, z: -1 } },
  airport: { o: { x: 1950, z: 1080 }, center: { x: 2125, z: 1065 }, rect: { x0: 950, x1: 3300, z0: 800, z1: 1330 }, node: { x: 19.5, y: -10.8 }, gate: { x: 0, z: -1 } },
  park: { o: { x: 1120, z: -1340 }, center: { x: 1300, z: -1470 }, rect: { x0: 680, x1: 1920, z0: -1730, z1: -1210 }, node: { x: 11.2, y: 13.4 }, gate: { x: 0, z: 1 }, bakery: { x: 15.6, y: 13.95 }, bakeryPath: [{ x: 11.2, y: 13.4 }, { x: 15.15, y: 13.33 }, { x: 15.6, y: 13.95 }] },
};
/**
 * 门店站点要占的地（门店本地坐标，米：StoreX 店房中心在原点、正面朝 +z）：店前停车场（两组双排时最外到 z ≈ 93）、店房、
 * 百货馆、店后的收货场（满配要 85–100 米进深，到 z ≈ −193，再留一点余量）、东侧的货车通道（x 到 80）、西侧的即时取货区（x 到 −61）；
 * attach 是进店路接的干道路口离店房中心多远（门前路、货车通道分岔、到路口至少 22 米）。
 * 随机、自定义区域选门店位置时整块地不压路、铁路、河和海，路口留在正前方；默认区域按原来的位置。
 */
export const STORE_SITE = { x0: -66, x1: 84, z0: -205, z1: 96, attach: 132 };
/** 门店站点的四个角（公里）：店房中心 p、正面朝向 f（单位向量） */
export function storeSitePoly(p: Km, f: Km): Km[] {
  const ex = { x: -f.y, y: f.x };
  return [
    [STORE_SITE.x0, STORE_SITE.z0],
    [STORE_SITE.x1, STORE_SITE.z0],
    [STORE_SITE.x1, STORE_SITE.z1],
    [STORE_SITE.x0, STORE_SITE.z1],
  ].map(([x, z]) => ({ x: p.x + (ex.x * (x as number) + f.x * (z as number)) / 100, y: p.y + (ex.y * (x as number) + f.y * (z as number)) / 100 }));
}

/** 设施的核心区（局部坐标，沙盘米）：港口的闸口、堆场和码头，机场的货站卡车场、机坪和跑道，物流园的库房、挂车场和场站；路不能从里面穿过 */
export const CORES = {
  port: { ...LOCAL.port.rect, z0: 1150 },
  airport: { ...LOCAL.airport.rect, z0: 920 },
  park: { ...LOCAL.park.rect, z1: -1275 },
};
/** 铁路站在局部坐标里的股道（沙盘米）：物流园货运站 西端 W、中点 S、东端 E；港口铁路站从 P0 往内陆 */
const PARK_STATION = (() => {
  const S = { x: 1020, z: -1620 };
  const w = norm2({ x: 600 - 1020, z: -1560 + 1620 });
  const e = norm2({ x: 1800 - 1020, z: -1660 + 1620 });
  return { W: { x: S.x + w.x * 330, z: S.z + w.z * 330 }, S, E: { x: S.x + e.x * 330, z: S.z + e.z * 330 } };
})();
const PORT_STATION = (() => {
  const P0 = { x: -2020, z: 1140 };
  const d = norm2({ x: -1900 + 2020, z: 600 - 1140 });
  return { P0, P1: { x: P0.x + d.x * 330, z: P0.z + d.z * 330 } };
})();

/** 原来的海岸线（默认区域用）：西边和南边是海 */
const OLD_COAST: Km[] = [
  { x: -30, y: 6 },
  { x: -26.5, y: 0 },
  { x: -25.2, y: -6 },
  { x: -23.5, y: -11 },
  { x: -21, y: -13.6 },
  { x: -15, y: -14.6 },
  { x: -6, y: -15.2 },
  { x: 4, y: -15.4 },
  { x: 13, y: -14.2 },
  { x: 22, y: -14.6 },
  { x: 34, y: -15.5 },
];

export interface RegionPlan {
  spec: RegionSpec;
  options: RegionOptions;
  /** 海的方向（单位向量） */
  seaDir: Km;
  /** 海岸线：沿海岸从一头到另一头（站在陆地上面朝大海，从右往左） */
  coast: Km[];
  /** 河：干流（branches 是汇进干流的支流，branchWidth 是支流宽度；默认区域没有支流） */
  river?: { pts: Km[]; width: number; branches?: Km[][]; branchWidth?: number };
  /** 海里的岛（河口那种海岸才有） */
  islands?: Km[][];
  city: { center: Km; radius: number; boundary: Km[]; nodes: string[]; centers: Km[] };
  frames: { port: Frame; airport: Frame; park: Frame };
  nodes: Record<string, Km>;
  edges: { a: string; b: string; cls: RoadClass; via?: Km[] }[];
  /** 绕城快速路：从一头到另一头的节点（两头 BE0、BE1 是平交路口，中间 R0… 是立交） */
  bypass: string[];
  ics: string[];
  /** 立交 → 城区一侧接的路口 */
  gateways: Record<string, string>;
  /** 高架快速路（两头接城区路口，中间跨过干道、河） */
  viaduct?: { a: string; b: string };
  rail: Km[];
  railPortIndex: number;
  railDcIndex: number;
  /** 城市客运站在铁路上的位置（离起点多少公里） */
  railPassenger?: { s: number; name: string };
  /** 两个高速出口往区域外的方向，画到区域边上 */
  offmap: { NORTH: Km; EAST: Km };
  store: Km;
}

// ———————————————————————— 小工具 ————————————————————————

function rng(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function norm2(v: XZ): XZ {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, z: v.z / l };
}
const add = (a: Km, b: Km): Km => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Km, b: Km): Km => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Km, k: number): Km => ({ x: a.x * k, y: a.y * k });
const dot = (a: Km, b: Km) => a.x * b.x + a.y * b.y;
const len = (a: Km) => Math.hypot(a.x, a.y);
const dist = (a: Km, b: Km) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: Km): Km => mul(a, 1 / (len(a) || 1));
const polar = (ang: number, r: number): Km => ({ x: Math.cos(ang) * r, y: Math.sin(ang) * r });
const smooth01 = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const toD = (k: Km): XZ => ({ x: k.x * 100, z: -k.y * 100 });
const fromD = (p: XZ): Km => ({ x: p.x / 100, y: -p.z / 100 });
/** 角度差归到 (−π, π] */
const wrap = (a: number) => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

export function segDist(p: Km, a: Km, b: Km): number {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
  return dist(p, add(a, mul(d, t)));
}
export function polyDist(p: Km, pts: readonly Km[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i - 1] as Km, pts[i] as Km));
  return pts.length === 1 ? dist(p, pts[0] as Km) : best;
}
/** 两条线段在内部相交（共端点不算） */
export function crosses(a: Km, b: Km, c: Km, d: Km): boolean {
  const o = (p: Km, q: Km, r: Km) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const same = (p: Km, q: Km) => dist(p, q) < 1e-6;
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function polyCross(p: readonly Km[], q: readonly Km[]): boolean {
  for (let i = 1; i < p.length; i++) for (let k = 1; k < q.length; k++) if (crosses(p[i - 1] as Km, p[i] as Km, q[k - 1] as Km, q[k] as Km)) return true;
  return false;
}
export function pointInPoly(p: Km, poly: readonly Km[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Km;
    const b = poly[j] as Km;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
/** 线段 a–b 有没有穿过（或者在）多边形里 */
function segInPoly(a: Km, b: Km, poly: readonly Km[]): boolean {
  if (pointInPoly(a, poly) || pointInPoly(b, poly) || pointInPoly(mul(add(a, b), 0.5), poly)) return true;
  return polyCross([a, b], [...poly, poly[0] as Km]);
}
/**
 * 从 a 到 b 绕过多边形（凸的）：沿多边形外扩 m 的角点走，两个方向、经过几个角都试，挑不穿过多边形里最短的一条；
 * 返回中间要插的角点
 */
function detour(a: Km, b: Km, poly: readonly Km[], m: number): Km[] {
  const c = mul(poly.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }), 1 / poly.length);
  const corners = poly.map((p) => add(p, mul(unit(sub(p, c)), m * Math.SQRT2)));
  const n = corners.length;
  let best: { pts: Km[]; len: number } | undefined;
  for (let k0 = 0; k0 < n; k0++)
    for (const dir of [1, -1])
      for (let cnt = 1; cnt <= n; cnt++) {
        const via = Array.from({ length: cnt }, (_, j) => corners[(((k0 + dir * j) % n) + n) % n] as Km);
        const path = [a, ...via, b];
        let ok = true;
        let L = 0;
        for (let i = 1; i < path.length && ok; i++) {
          ok = !segInPoly(path[i - 1] as Km, path[i] as Km, poly);
          L += dist(path[i - 1] as Km, path[i] as Km);
        }
        if (ok && (!best || L < best.len)) best = { pts: via, len: L };
      }
  return best?.pts ?? [];
}

/** 开放的 Catmull-Rom 样条：每段 n 个点 */
function spline(ctrl: readonly Km[], n: number): Km[] {
  if (ctrl.length < 3) return [...ctrl];
  const out: Km[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)] as Km;
    const p1 = ctrl[i] as Km;
    const p2 = ctrl[i + 1] as Km;
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)] as Km;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(ctrl[ctrl.length - 1] as Km);
  return out;
}
/** 折线按大约 step 公里重新取点 */
function resample(pts: readonly Km[], step: number): Km[] {
  const out: Km[] = [pts[0] as Km];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Km;
    const b = pts[i] as Km;
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push(add(a, mul(sub(b, a), k / n)));
  }
  return out;
}
function plen(pts: readonly Km[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1] as Km, pts[i] as Km);
  return s;
}
/** Chaikin 平滑（端点不动） */
function chaikin(pts: readonly Km[], iters: number): Km[] {
  let cur = [...pts];
  for (let it = 0; it < iters; it++) {
    if (cur.length < 3) return cur;
    const next: Km[] = [cur[0] as Km];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i] as Km;
      const b = cur[i + 1] as Km;
      next.push(add(mul(a, 0.75), mul(b, 0.25)), add(mul(a, 0.25), mul(b, 0.75)));
    }
    next.push(cur[cur.length - 1] as Km);
    cur = next;
  }
  return cur;
}
/** 加布里埃尔图：以两点连线为直径的圆里没有别的点就连（平面图） */
function gabriel(ids: readonly string[], pos: Record<string, Km>): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i] as string] as Km;
      const b = pos[ids[j] as string] as Km;
      const m = mul(add(a, b), 0.5);
      const r = dist(a, b) / 2;
      let ok = true;
      for (let k = 0; k < ids.length && ok; k++) if (k !== i && k !== j && dist(pos[ids[k] as string] as Km, m) < r - 1e-9) ok = false;
      if (ok) out.push([ids[i] as string, ids[j] as string]);
    }
  return out;
}
/** 相对邻域图：两点之间没有第三个点比它们彼此更近才连（比加布里埃尔图稀，街区多是四边形、五边形） */
function rngGraph(ids: readonly string[], pos: Record<string, Km>): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = pos[ids[i] as string] as Km;
      const b = pos[ids[j] as string] as Km;
      const d = dist(a, b);
      let ok = true;
      for (let k = 0; k < ids.length && ok; k++) {
        if (k === i || k === j) continue;
        const c = pos[ids[k] as string] as Km;
        if (Math.max(dist(a, c), dist(b, c)) < d - 1e-9) ok = false;
      }
      if (ok) out.add(`${ids[i]}|${ids[j]}`);
    }
  return out;
}

/** 最小生成树（Kruskal），返回边的下标 */
function mst(ids: readonly string[], edges: readonly { a: string; b: string; w: number }[]): Set<number> {
  const parent = new Map(ids.map((x) => [x, x]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const order = edges.map((e, i) => ({ e, i })).sort((p, q) => p.e.w - q.e.w);
  const keep = new Set<number>();
  for (const { e, i } of order) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    keep.add(i);
  }
  return keep;
}
/** 射线从原点往 ang 方向，碰到区域边界的距离 */
function rayToBounds(ang: number): number {
  const d = polar(ang, 1);
  let t = Infinity;
  if (d.x > 1e-9) t = Math.min(t, BOUNDS.x1 / d.x);
  if (d.x < -1e-9) t = Math.min(t, BOUNDS.x0 / d.x);
  if (d.y > 1e-9) t = Math.min(t, BOUNDS.y1 / d.y);
  if (d.y < -1e-9) t = Math.min(t, BOUNDS.y0 / d.y);
  return t;
}
const inBounds = (p: Km, m: number) => p.x > BOUNDS.x0 + m && p.x < BOUNDS.x1 - m && p.y > BOUNDS.y0 + m && p.y < BOUNDS.y1 - m;

// ———————————————————————— 规格 ————————————————————————

const pickOf = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length] as T;

/** 随机状态的各项（同一个编号每次一样） */
export function randomOptions(seed: number): RegionOptions {
  const r = rng(seed * 7919 + 13);
  const sea = pickOf(r, DIR8);
  const inland = DIR8.filter((d) => dirGap(d, sea) >= 2);
  const domestic = pickOf(r, inland);
  const border = pickOf(r, inland.filter((d) => dirGap(d, domestic) >= 2).length ? inland.filter((d) => dirGap(d, domestic) >= 2) : inland.filter((d) => d !== domestic));
  const park = pickOf(r, inland);
  const airport = pickOf(r, DIR8.filter((d) => dirGap(d, sea) >= 1 && d !== park));
  // 新加的几项用另一串随机数（原有各项按编号抽到的和以前一样）
  const r2 = rng(seed * 104729 + 71);
  const form = pickOf(r2, ['organic', 'grid', 'radial', 'linear', 'cluster'] as const);
  const coast = pickOf(r2, ['wavy', 'bay', 'peninsula', 'straight', 'estuary'] as const);
  const riverForm: RiverForm = r2() < 0.4 ? 'branching' : 'one';
  // 主导风向：一半的区域是海风（从海那边来，偏一格以内），其余随机
  const wind = r2() < 0.5 ? pickOf(r2, DIR8.filter((d) => dirGap(d, sea) <= 1)) : pickOf(r2, DIR8);
  return {
    sea,
    river: r() < 0.8,
    size: pickOf(r, ['S', 'M', 'L'] as const),
    port: pickOf(r, ['left', 'center', 'right'] as const),
    airport,
    airportFar: r() < 0.5,
    park,
    parkFar: r() < 0.5,
    rail: pickOf(r, inland),
    domestic,
    border,
    store: pickOf(r, ['center', 'urban', 'suburb'] as const),
    form,
    coast,
    riverForm,
    wind,
  };
}

/** 规格最后用的各项：默认用固定的，随机全按编号，自定义没指定的按编号随机；明显不合理的（出口朝海）挪开 */
export function resolveOptions(spec: RegionSpec): RegionOptions {
  if (spec.mode === 'default') return { ...DEFAULT_OPTIONS };
  const base = randomOptions(spec.seed);
  const o: RegionOptions = spec.mode === 'custom' ? { ...base, ...spec.options } : base;
  const awayFromSea = (d: Dir8, min: number): Dir8 => {
    if (dirGap(d, o.sea) >= min) return d;
    const cand = DIR8.filter((x) => dirGap(x, o.sea) >= min).sort((a, b) => dirGap(a, d) - dirGap(b, d) || DIR8.indexOf(a) - DIR8.indexOf(b));
    return cand[0] as Dir8;
  };
  o.domestic = awayFromSea(o.domestic, 2);
  o.border = awayFromSea(o.border, 2);
  if (o.border === o.domestic) o.border = DIR8.filter((x) => dirGap(x, o.sea) >= 2 && x !== o.domestic)[0] as Dir8;
  o.rail = awayFromSea(o.rail, 2);
  o.park = awayFromSea(o.park, 2);
  o.airport = awayFromSea(o.airport, 1);
  // 河口那种海岸要有河；没有河就改成海湾
  if (o.coast === 'estuary' && !o.river) o.coast = 'bay';
  return o;
}

const OPT_KEYS: [keyof RegionOptions, string][] = [
  ['sea', 'sea'],
  ['river', 'river'],
  ['size', 'size'],
  ['port', 'port'],
  ['airport', 'air'],
  ['airportFar', 'airfar'],
  ['park', 'park'],
  ['parkFar', 'parkfar'],
  ['rail', 'rail'],
  ['domestic', 'dom'],
  ['border', 'border'],
  ['store', 'store'],
  ['form', 'form'],
  ['coast', 'coast'],
  ['riverForm', 'rform'],
  ['wind', 'wind'],
];

/** 网页地址里的区域：default、random-42、custom-7~sea.S~river.1~… */
export function regionSpecText(s: RegionSpec): string {
  if (s.mode === 'default') return 'default';
  if (s.mode === 'random') return `random-${s.seed}`;
  const parts = OPT_KEYS.filter(([k]) => s.options?.[k] !== undefined).map(([k, short]) => {
    const v = s.options?.[k];
    return `${short}.${typeof v === 'boolean' ? (v ? 1 : 0) : v}`;
  });
  return [`custom-${s.seed}`, ...parts].join('~');
}
export function regionSpecFrom(text: string | null | undefined): RegionSpec {
  const t = (text ?? '').trim();
  const m = /^random-(\d{1,6})$/.exec(t);
  if (m) return { mode: 'random', seed: Number(m[1]) };
  const c = /^custom-(\d{1,6})((?:~[a-z]+\.[A-Za-z0-9]+)*)$/.exec(t);
  if (c) {
    const options: Partial<RegionOptions> = {};
    for (const part of (c[2] ?? '').split('~').filter(Boolean)) {
      const [short, v] = part.split('.') as [string, string];
      const key = OPT_KEYS.find(([, s2]) => s2 === short)?.[0];
      if (!key) continue;
      if (key === 'river' || key === 'airportFar' || key === 'parkFar') (options as Record<string, unknown>)[key] = v === '1';
      else if (key === 'size' && ['S', 'M', 'L'].includes(v)) options.size = v as CitySize;
      else if (key === 'port' && ['left', 'center', 'right'].includes(v)) options.port = v as PortSpot;
      else if (key === 'store' && ['center', 'urban', 'suburb'].includes(v)) options.store = v as StoreSpot;
      else if (key === 'form' && v in FORM_LABEL) options.form = v as CityForm;
      else if (key === 'coast' && v in COAST_LABEL) options.coast = v as CoastType;
      else if (key === 'riverForm' && v in RIVER_FORM_LABEL) options.riverForm = v as RiverForm;
      else if (DIR8.includes(v as Dir8) && key !== 'form' && key !== 'coast' && key !== 'riverForm') (options as Record<string, unknown>)[key] = v;
    }
    return { mode: 'custom', seed: Number(c[1]), options };
  }
  return { ...DEFAULT_REGION };
}

// ———————————————————————— 生成 ————————————————————————

export function generateRegion(spec: RegionSpec): RegionPlan {
  const o = resolveOptions(spec);
  const r = rng(spec.mode === 'default' ? 1 : spec.seed);
  const fixed = spec.mode === 'default';
  // 城市形态、海岸、支流、跑道朝向这些新加的随机项用另一串随机数（默认区域一个都不用，生成的和原来一样）
  const r2 = rng((spec.seed + 11) * 7349 + 3);
  const form: CityForm = fixed ? 'organic' : (o.form ?? 'organic');
  const coastType: CoastType = fixed ? 'wavy' : (o.coast ?? 'wavy');
  const s = unit(polar(dirAngle(o.sea), 1));
  // 站在市区面朝大海，左手方向
  const sp: Km = { x: -s.y, y: s.x };
  const R = { S: 7.5, M: 10, L: 12 }[o.size];
  const D0 = { S: 14, M: 15, L: 16.5 }[o.size];

  // —— 港口在海岸上的位置、河口的位置 ——
  const tPort = fixed ? -21 : o.port === 'left' ? 9.5 + r() * 3.5 : o.port === 'right' ? -(9.5 + r() * 3.5) : -2.5 + r() * 5;
  let tMouth = -6 + r() * 12;
  if (Math.abs(tMouth - tPort) < 12) {
    // 河口和港口隔开至少 12 公里（港口那段海岸要拉直）：放到市中心另一边
    const side = Math.abs(tPort) > 3 ? -Math.sign(tPort) : r() < 0.5 ? -1 : 1;
    tMouth = tPort + side * 12.5;
  }
  if (fixed) tMouth = -4;

  // —— 海岸线：沿 sp 方向每 0.5 公里一个点，深度（离市中心沿海方向多远）是几个正弦叠加；港口一段拉直，河口凹进去一点 ——
  const T: number[] = [];
  const DEP: number[] = [];
  /** 海湾、半岛在海岸上的位置（摆岛用） */
  let featureT = tMouth;
  if (fixed) {
    // 默认区域：原来的海岸线（西边那段往北出区域）
    const old: [number, number][] = [[-100, -60], [-30.5, -60], ...OLD_COAST.map((k): [number, number] => [k.x, -k.y]), [100, 15.5]];
    for (let t = -100; t <= 100; t += 0.5) {
      let k = 1;
      while (k < old.length - 1 && (old[k] as [number, number])[0] < t) k++;
      const a = old[k - 1] as [number, number];
      const b = old[k] as [number, number];
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      T.push(t);
      DEP.push(a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, f)));
    }
  } else {
    const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
    // 海岸的样子：平直的起伏小；海湾、半岛放在离港口远的一段（港口那段海岸要拉直）；河口是喇叭形的一段
    const amp = coastType === 'straight' ? 0.28 : coastType === 'bay' || coastType === 'peninsula' ? 0.6 : 1;
    const awayFromPort = (gap: number): number => {
      const cands: number[] = [];
      for (let t = -12; t <= 12; t += 1) if (Math.abs(t - tPort) >= gap && Math.abs(t - tMouth) >= 4) cands.push(t);
      return cands.length ? (cands[Math.floor(r2() * cands.length)] as number) : tPort + (tPort > 0 ? -gap : gap);
    };
    let feature = (_t: number) => 0;
    if (coastType === 'bay') {
      const tb = awayFromPort(12);
      const B = 3.4 + r2() * 2.2;
      const wB = 5.5 + r2() * 2.5;
      featureT = tb;
      feature = (t) => -B * Math.exp(-(((t - tb) / wB) ** 2));
    } else if (coastType === 'peninsula') {
      const tp = awayFromPort(12);
      const P = 4.5 + r2() * 3.5;
      const wP = 2.0 + r2() * 1.4;
      featureT = tp;
      feature = (t) => P * Math.exp(-(((t - tp) / wP) ** 4));
    } else if (coastType === 'estuary') feature = (t) => -2.8 * Math.exp(-(((t - tMouth) / 3.4) ** 2));
    const raw = (t: number) => D0 + amp * (2.4 * Math.sin(t / 10.5 + (ph[0] as number)) + 0.9 * Math.sin(t / 3.6 + (ph[1] as number)) + 0.35 * Math.sin(t / 1.4 + (ph[2] as number))) + feature(t);
    const portDepth = Math.max(D0 - 1.5, Math.min(D0 + 2, raw(tPort)));
    for (let t = -100; t <= 100; t += 0.5) {
      const w = smooth01((10 - Math.abs(t - tPort)) / 4.5);
      let d = raw(t) * (1 - w) + portDepth * w;
      if (coastType !== 'estuary') d += 0.9 * Math.exp(-(((t - tMouth) / 2.2) ** 2));
      T.push(t);
      DEP.push(d);
    }
  }
  const depthAt = (t: number) => {
    const f = (t + 100) / 0.5;
    const i = Math.max(0, Math.min(T.length - 2, Math.floor(f)));
    const k = Math.max(0, Math.min(1, f - i));
    return (DEP[i] as number) * (1 - k) + (DEP[i + 1] as number) * k;
  };
  const isSea = (p: Km) => dot(p, s) > depthAt(dot(p, sp));
  const coast: Km[] = T.map((t, i) => add(mul(s, DEP[i] as number), mul(sp, t)));
  /** 沿 ang 方向离海岸多远 */
  const coastDist = (ang: number): number => {
    const d = polar(ang, 1);
    for (let x = 0.25; x < 80; x += 0.25) if (isSea(mul(d, x))) return x;
    return 80;
  };

  // —— 城区的边界：一个不规则的圈，离海岸至少 1 公里 ——
  const cp = [r() * 6.28, r() * 6.28];
  const spAng = Math.atan2(sp.y, sp.x);
  const lobe0 = r2() * Math.PI * 2;
  /** 城区的轮廓（相对半径）：按城市形态 */
  const shape = (ang: number): number => {
    if (form === 'linear') {
      // 带状：沿海岸方向拉长成椭圆（长半轴 1.6 倍、短半轴 0.62 倍）
      const a = 1.6;
      const b = 0.62;
      const ph = ang - spAng;
      return ((a * b) / Math.hypot(b * Math.cos(ph), a * Math.sin(ph))) * (1 + 0.05 * Math.sin(5 * ang + (cp[1] as number)));
    }
    if (form === 'cluster') return (0.8 + 0.34 * Math.max(0, Math.cos(3 * (ang - lobe0))) ** 1.5) * (1 + 0.04 * Math.sin(5 * ang + (cp[1] as number)));
    if (form === 'radial') return 1 + 0.05 * Math.sin(3 * ang + (cp[0] as number)) + 0.03 * Math.sin(5 * ang + (cp[1] as number));
    if (form === 'grid') return 1 + 0.07 * Math.cos(4 * ang + (cp[0] as number)) + 0.04 * Math.sin(5 * ang + (cp[1] as number));
    return 1 + 0.14 * Math.sin(3 * ang + (cp[0] as number)) + 0.07 * Math.sin(5 * ang + (cp[1] as number));
  };
  const cityR = (ang: number) => Math.min(R * shape(ang), coastDist(ang) - 1.0);
  const boundary: Km[] = Array.from({ length: 72 }, (_, i) => polar((i / 72) * 2 * Math.PI, cityR((i / 72) * 2 * Math.PI)));
  const angOf = (p: Km) => Math.atan2(p.y, p.x);
  const inCity = (p: Km, margin = 0) => len(p) < cityR(angOf(p)) - margin;

  // —— 河：从内陆的区域边上流过城区，在海岸的 tMouth 处入海 ——
  let river: RegionPlan['river'];
  if (o.river) {
    const srcAng = angOf(mul(s, -1)) + (fixed ? 0.18 : (r() - 0.5) * 1.5);
    const src = polar(srcAng, rayToBounds(srcAng) + 3);
    const mouth = add(mul(s, depthAt(tMouth)), mul(sp, tMouth));
    const sideK = fixed ? -1 : r() < 0.5 ? -1 : 1;
    const cityPass = add(mul(sp, sideK * (1.6 + r() * 1.6)), mul(s, -0.5));
    const mid = add(mul(src, 0.5), mul(sp, (r() - 0.5) * 6));
    const ctrl = [src, mid, add(mul(cityPass, 1), mul(s, -R * 0.55)), cityPass, add(mouth, mul(s, -2.5)), mouth, add(mouth, mul(s, 1.2))];
    const base = resample(spline(ctrl, 10), 0.4);
    const mp = [r() * 6.28, r() * 6.28];
    let acc = 0;
    const total = plen(base);
    const pts = base.map((p, i) => {
      if (i > 0) acc += dist(base[i - 1] as Km, p);
      const a = base[Math.max(0, i - 1)] as Km;
      const b = base[Math.min(base.length - 1, i + 1)] as Km;
      const n = unit({ x: -(b.y - a.y), y: b.x - a.x });
      const fade = Math.min(1, acc / 3) * Math.min(1, (total - acc) / 5);
      const m = (0.55 * Math.sin(acc / 2.3 + (mp[0] as number)) + 0.25 * Math.sin(acc / 0.9 + (mp[1] as number))) * fade;
      return add(p, mul(n, m));
    });
    river = { pts, width: 0.34 };
    if (!fixed && o.riverForm === 'branching') {
      // 支流：从内陆另一个方向的区域边上流过来，在干流从源头算 35%–60% 的地方汇进去（多半在城外）
      const target = total * (0.35 + r2() * 0.25);
      let acc2 = 0;
      let ji = pts.length - 1;
      for (let i = 1; i < pts.length; i++) {
        acc2 += dist(pts[i - 1] as Km, pts[i] as Km);
        if (acc2 >= target) {
          ji = i;
          break;
        }
      }
      const join = pts[ji] as Km;
      const a2 = srcAng + (r2() < 0.5 ? -1 : 1) * (0.75 + r2() * 0.55);
      const src2 = polar(a2, rayToBounds(a2) + 3);
      const mid2 = add(mul(add(src2, join), 0.5), mul(sp, (r2() - 0.5) * 5));
      const base2 = resample(spline([src2, mid2, join], 12), 0.4);
      const tot2 = plen(base2);
      const q2 = [r2() * 6.28, r2() * 6.28];
      let a3 = 0;
      const b2 = base2.map((p, i) => {
        if (i > 0) a3 += dist(base2[i - 1] as Km, p);
        const a = base2[Math.max(0, i - 1)] as Km;
        const b = base2[Math.min(base2.length - 1, i + 1)] as Km;
        const n = unit({ x: -(b.y - a.y), y: b.x - a.x });
        const fade = Math.min(1, a3 / 3) * Math.min(1, (tot2 - a3) / 4);
        return add(p, mul(n, (0.4 * Math.sin(a3 / 2.0 + (q2[0] as number)) + 0.18 * Math.sin(a3 / 0.8 + (q2[1] as number))) * fade));
      });
      // 支流不进海、不和干流别处相交；不行就不要支流
      const inSea = b2.some((p) => isSea(p));
      const crossMain = polyCross(b2.slice(0, -3), pts.filter((_, i) => Math.abs(i - ji) > 3));
      if (!inSea && !crossMain && b2.length > 6) {
        b2[b2.length - 1] = { ...join };
        river.branches = [b2];
        river.branchWidth = 0.22;
      }
    }
  }
  const riverLinesKm = (): Km[][] => (river ? [river.pts, ...(river.branches ?? [])] : []);
  const riverDist = (p: Km) => (river ? Math.min(...riverLinesKm().map((l) => polyDist(p, l))) : Infinity);

  // —— 设施的坐标系 ——
  const frameAt = (lo: { o: XZ }, center: XZ, at: Km, rot: number): Frame => {
    // 局部的 center 放到区域里的 at
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const dx = center.x - lo.o.x;
    const dz = center.z - lo.o.z;
    const a = toD(at);
    return { o: { ...lo.o }, w: { x: a.x - (dx * c + dz * sn), z: a.z - (-dx * sn + dz * c) }, rot };
  };
  let portF: Frame;
  let airF: Frame;
  let parkF: Frame;
  const placed: Km[][] = [];
  const sepOk = (poly: Km[], gap: number) => placed.every((q) => poly.every((p) => !pointInPoly(p, q) && polyDist(p, [...q, q[0] as Km]) > gap) && q.every((p) => !pointInPoly(p, poly)));
  const samples = (poly: Km[]) => {
    const out: Km[] = [...poly];
    for (let i = 0; i < poly.length; i++) out.push(mul(add(poly[i] as Km, poly[(i + 1) % poly.length] as Km), 0.5));
    out.push(mul(poly.reduce((acc2, p) => add(acc2, p), { x: 0, y: 0 }), 1 / poly.length));
    return out;
  };
  if (fixed) {
    portF = identityFrame(LOCAL.port.o);
    airF = identityFrame(LOCAL.airport.o);
    parkF = identityFrame(LOCAL.park.o);
    placed.push(footprintKm(portF, LOCAL.port.rect), footprintKm(airF, LOCAL.airport.rect), footprintKm(parkF, LOCAL.park.rect));
  } else {
    // 港口：码头贴着海岸、朝海
    const sd = { x: s.x, z: -s.y };
    const rot = Math.atan2(sd.x, sd.z);
    const pc = add(mul(s, depthAt(tPort)), mul(sp, tPort));
    portF = frameAt(LOCAL.port, LOCAL.port.coastRef, pc, rot);
    placed.push(footprintKm(portF, LOCAL.port.rect));
    const place = (lo: { o: XZ; center: XZ; rect: { x0: number; x1: number; z0: number; z1: number } }, dirOpt: Dir8, far: boolean, rotOf: (at: Km) => number): Frame => {
      let best: { f: Frame; score: number } | undefined;
      // 先在指定的方向附近找，找不到再放宽到任何方向、更远的地方；占地要在陆地上、在城区外、不压河、不压别的设施
      for (let k = 0; k < 420; k++) {
        const widen = Math.min(1, k / 160);
        const anyDir = k >= 220;
        const ang = anyDir ? r() * 2 * Math.PI : dirAngle(dirOpt) + (r() - 0.5) * (0.6 + 1.6 * widen);
        const dd = anyDir ? 12 + r() * 12 : (far ? 16.5 + r() * 4.5 : 12 + r() * 3.5) + widen * 4 * (r() - 0.3);
        const at = polar(ang, Math.max(R + 3, dd));
        const f = frameAt(lo, lo.center, at, rotOf(at));
        const poly = footprintKm(f, lo.rect);
        const pts = samples(poly);
        const land = pts.filter((p) => inBounds(p, 1.5) && !isSea(p) && len(p) > cityR(angOf(p)) + 1.2 && riverDist(p) > (river?.width ?? 0) / 2 + 0.7).length;
        const sep = sepOk(poly, 1.6);
        if (land === pts.length && sep) return f;
        const score = land + (sep ? pts.length : 0);
        if (!best || score > best.score) best = { f, score };
      }
      return (best as { f: Frame }).f;
    };
    // 跑道顺着常年主导风向（侧风小）；跑道的延长线尽量不正对市区（进近、起飞不压城区，最多偏开 25°）
    const windAng = o.wind ? dirAngle(o.wind) : undefined;
    airF = place(LOCAL.airport, o.airport, o.airportFar, (at) => {
      if (windAng === undefined) return r() * Math.PI;
      let best = windAng;
      let bs = -Infinity;
      for (const off of [0, 0.17, -0.17, 0.3, -0.3, 0.44, -0.44]) {
        const rot = windAng + off + (r2() - 0.5) * 0.08;
        const u = polar(rot, 1);
        const rel = mul(at, -1);
        const perp = Math.abs(rel.x * u.y - rel.y * u.x);
        const score = Math.min(perp, R * 0.8) - Math.abs(off) * 5;
        if (score > bs) {
          bs = score;
          best = rot;
        }
      }
      // 跑道两个方向都一样，挑货站（局部 −z 一侧、大门朝外）朝着城区的那一个：进出机场的高速不用绕到跑道另一边
      if (dot(polar(best + Math.PI / 2, 1), mul(at, -1)) < 0) best += Math.PI;
      return ((best % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    });
    placed.push(footprintKm(airF, LOCAL.airport.rect));
    // 物流园：大门（局部 +z）朝着市区
    parkF = place(LOCAL.park, o.park, o.parkFar, (at) => {
      const v = toD(mul(at, -1));
      return Math.atan2(v.x, v.z);
    });
    placed.push(footprintKm(parkF, LOCAL.park.rect));
  }
  const portNode = kmToWorld(portF, LOCAL.port.node);
  const airNode = kmToWorld(airF, LOCAL.airport.node);
  const dcNode = kmToWorld(parkF, LOCAL.park.node);
  const bakery = kmToWorld(parkF, LOCAL.park.bakery);
  const gateDir = (f: Frame, g: XZ): Km => {
    const c = Math.cos(f.rot);
    const sn = Math.sin(f.rot);
    return unit(fromD({ x: g.x * c + g.z * sn, z: -g.x * sn + g.z * c }));
  };

  // —— 两个高速出口：沿方向射到区域边上，往里缩 6 公里；在海里就往陆地转 ——
  const exitAt = (d: Dir8): { node: Km; off: Km } => {
    for (let k = 0; k < 13; k++) {
      const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (Math.PI / 12);
      const ang = dirAngle(d) + step;
      const L = rayToBounds(ang);
      const node = polar(ang, L - 6);
      const off = polar(ang, L);
      if (!isSea(node) && !isSea(off) && placed.every((q) => !pointInPoly(node, q) && polyDist(node, [...q, q[0] as Km]) > 2)) return { node, off };
    }
    const ang = dirAngle(d);
    return { node: polar(ang, rayToBounds(ang) - 6), off: polar(ang, rayToBounds(ang)) };
  };
  const ex = fixed ? { NORTH: { node: { x: 2, y: 24 }, off: { x: 2.3, y: 35.8 } }, EAST: { node: { x: 30, y: 2 }, off: { x: 47.8, y: 2.3 } } } : { NORTH: exitAt(o.domestic), EAST: exitAt(o.border) };

  const nodes: Record<string, Km> = { PORT: portNode, AIR: airNode, DC: dcNode, BAKERY: bakery, NORTH: ex.NORTH.node, EAST: ex.EAST.node };
  const edges: RegionPlan['edges'] = [];

  // —— 绕城快速路：沿内陆一侧绕过城区，两头接到海边（不成环）——
  const seaAng = angOf(s);
  const a0 = seaAng + 1.3;
  const a1 = seaAng + 2 * Math.PI - 1.3;
  const bp = [r() * 6.28, r() * 6.28];
  const footprintPolys = placed.slice();
  const bypassR = (ang: number) => {
    let rr = (R + 1.9) * (1 + 0.08 * Math.sin(2.3 * ang + (bp[0] as number)) + 0.05 * Math.sin(4.1 * ang + (bp[1] as number)));
    rr = Math.max(rr, cityR(ang) + 1.0);
    // 不进海、不压设施
    const floor = cityR(ang) + 0.6;
    for (let k = 0; k < 40 && rr > floor && (isSea(polar(ang, rr)) || footprintPolys.some((q) => pointInPoly(polar(ang, rr), q) || polyDist(polar(ang, rr), [...q, q[0] as Km]) < 0.6)); k++) rr = Math.max(floor, rr - 0.25);
    return rr;
  };
  const bypassPts: Km[] = [];
  for (let a = a0; a <= a1 + 1e-9; a += (a1 - a0) / 60) bypassPts.push(polar(a, bypassR(a)));
  const nIC = { S: 4, M: 5, L: 6 }[o.size];
  // 立交的角度：均匀分布，再往要去的方向（出口、设施）靠
  const targets = [ex.NORTH.node, ex.EAST.node, dcNode, airNode, portNode].map(angOf);
  const icAng: number[] = Array.from({ length: nIC }, (_, k) => a0 + ((k + 0.5) * (a1 - a0)) / nIC);
  const spacing = (a1 - a0) / nIC;
  for (const ta of targets) {
    let rel = wrap(ta - seaAng);
    if (rel < 0) rel += 2 * Math.PI;
    const t = seaAng + rel;
    if (t < a0 + spacing * 0.35 || t > a1 - spacing * 0.35) continue;
    let bi = 0;
    for (let k = 1; k < nIC; k++) if (Math.abs((icAng[k] as number) - t) < Math.abs((icAng[bi] as number) - t)) bi = k;
    const lo = bi > 0 ? (icAng[bi - 1] as number) + spacing * 0.55 : a0 + spacing * 0.35;
    const hi = bi < nIC - 1 ? (icAng[bi + 1] as number) - spacing * 0.55 : a1 - spacing * 0.35;
    icAng[bi] = Math.max(lo, Math.min(hi, (icAng[bi] as number) * 0.4 + t * 0.6));
  }
  const ics = icAng.map((_, k) => `R${k}`);
  nodes.BE0 = polar(a0, bypassR(a0));
  nodes.BE1 = polar(a1, bypassR(a1));
  icAng.forEach((a, k) => (nodes[`R${k}`] = polar(a, bypassR(a))));
  const chain = ['BE0', ...ics, 'BE1'];
  const chainAng = [a0, ...icAng, a1];
  for (let k = 0; k < chain.length - 1; k++) {
    const aa = chainAng[k] as number;
    const bb = chainAng[k + 1] as number;
    const via: Km[] = [];
    const n = Math.max(1, Math.round((bb - aa) / ((a1 - a0) / 60)));
    for (let i = 1; i < n; i++) via.push(polar(aa + ((bb - aa) * i) / n, bypassR(aa + ((bb - aa) * i) / n)));
    edges.push({ a: chain[k] as string, b: chain[k + 1] as string, cls: 'ring', via });
  }

  // —— 高速：设施、出口接到最近的立交（或绕城快速路的一头）；先沿设施大门的方向开出来，绕开城区和海 ——
  const pushInland = (p: Km): Km => {
    let q = p;
    for (let k = 0; k < 60 && isSea(q); k++) q = add(q, mul(s, -0.4));
    return isSea(q) ? q : add(q, mul(s, isSea(add(q, mul(s, 0.6))) ? -0.6 : 0));
  };
  const avoidCity = (pts: Km[]): Km[] => {
    let cur = pts;
    for (let it = 0; it < 4; it++) {
      const next: Km[] = [cur[0] as Km];
      let changed = false;
      for (let i = 1; i < cur.length; i++) {
        const a = cur[i - 1] as Km;
        const b = cur[i] as Km;
        const m = mul(add(a, b), 0.5);
        const near = segDist({ x: 0, y: 0 }, a, b);
        if (near < cityR(angOf(m)) + 0.4 && dist(a, b) > 1) {
          // 中点推到绕城快速路外侧（不往海那边推）
          let ang = angOf(m);
          if (Math.abs(wrap(ang - seaAng)) < 1.3) ang = seaAng + Math.sign(wrap(ang - seaAng) || 1) * 1.3;
          next.push(polar(ang, Math.max(bypassR(ang) + 1.4, len(m))));
          changed = true;
        }
        next.push(b);
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  };
  // 设施的核心区（港口的闸口、堆场和码头，机场的货站卡车场、机坪和跑道，物流园的库房、挂车场和场站）：高速不能从里面穿过
  const cores: { id: string; poly: Km[] }[] = [
    { id: 'PORT', poly: footprintKm(portF, CORES.port) },
    { id: 'AIR', poly: footprintKm(airF, CORES.airport) },
    { id: 'DC', poly: footprintKm(parkF, CORES.park) },
  ];
  /**
   * 高速有没有进设施的核心区：设施自己的进场路出大门的 2.2 公里不算；物流园自己的几条高速本来就贴着园区边走，不查物流园自己
   */
  const coreHit = (pts: readonly Km[], a: string, b: string): boolean => {
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1] as Km;
      const p1 = pts[i] as Km;
      const n = Math.max(6, Math.ceil(dist(p0, p1) / 0.15));
      for (let k = 0; k <= n; k++) {
        const q = add(p0, mul(sub(p1, p0), k / n));
        for (const c of cores) {
          const mine = c.id === a || c.id === b;
          if (mine && c.id === 'DC') continue;
          const own = c.id === a ? (nodes[a] as Km) : c.id === b ? (nodes[b] as Km) : undefined;
          if (own && dist(q, own) < 2.2) continue;
          if (pointInPoly(q, c.poly)) return true;
        }
      }
    }
    return false;
  };
  /** 高速碰到设施的核心区就从外侧绕过去（核心区外扩 m 公里的角点）；设施自己的进场路出大门的第一段不算 */
  const avoidCores = (pts: Km[], own: string, m: number): Km[] => {
    let cur = pts;
    for (let it = 0; it < 6; it++) {
      const next: Km[] = [cur[0] as Km];
      let changed = false;
      for (let i = 1; i < cur.length; i++) {
        const a = cur[i - 1] as Km;
        const b = cur[i] as Km;
        const hit = changed ? undefined : cores.find((c) => !(c.id === own && (i === 1 || own === 'DC')) && segInPoly(a, b, c.poly));
        if (hit) {
          next.push(...detour(a, b, hit.poly, m));
          changed = true;
        }
        next.push(b);
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  };
  /** 一条高速：A → （A 门口开出来的几个点）→ … → B；绕开城区和设施的核心区，在海里的点推回陆地，再平滑 */
  /** 高速的路线（存下来的中间点：平滑后隔一个点取一个）、走不走得通（不进设施的核心区） */
  const route = (a: string, b: string, aLead: Km[] = []): { via: Km[]; ok: boolean } => {
    const A = nodes[a] as Km;
    const B = nodes[b] as Km;
    const raw: Km[] = [A, ...aLead, B];
    // 平滑会把绕行的拐角切掉一块：存下来的路线还进核心区就把绕行放宽再来
    let via: Km[] = [];
    for (let m = 0.6; m < 4.5; m += 0.8) {
      const pts = chaikin(avoidCores(avoidCity(raw), a, m).map((p, i, all) => (i === 0 || i === all.length - 1 ? p : pushInland(p))), 2);
      via = pts.slice(1, -1).filter((_, i) => i % 2 === 0);
      if (!coreHit([A, ...via, B], a, b)) return { via, ok: true };
    }
    return { via, ok: false };
  };
  const highway = (a: string, b: string, aLead: Km[] = []) => {
    edges.push({ a, b, cls: 'highway', via: route(a, b, aLead).via });
  };
  const bypassNodes = chain;
  const nearestOn = (p: Km, list: readonly string[], used: Set<string>) => {
    const free = list.filter((x) => !used.has(x));
    const pool = free.length ? free : [...list];
    return pool.reduce((best, x) => (dist(nodes[x] as Km, p) < dist(nodes[best] as Km, p) ? x : best), pool[0] as string);
  };
  const usedOuter = new Set<string>();
  const lead = (id: string, d?: Km, k = 1.8): Km[] => (d ? [add(nodes[id] as Km, mul(d, k))] : []);
  /** 接最近的立交；最近的走不通（要穿过设施的核心区）就依次换近一点的（最多再试 4 个） */
  const connect = (id: string, aLead: Km[], list: readonly string[] = bypassNodes) => {
    let to = nearestOn(nodes[id] as Km, list, usedOuter);
    let r = route(id, to, aLead);
    if (!r.ok) {
      const p = nodes[id] as Km;
      const free = list.filter((x) => !usedOuter.has(x) && x !== to);
      const alt = (free.length ? free : list.filter((x) => x !== to)).slice().sort((x, y) => dist(nodes[x] as Km, p) - dist(nodes[y] as Km, p));
      for (const cand of alt.slice(0, 4)) {
        const rc = route(id, cand, aLead);
        if (rc.ok) {
          to = cand;
          r = rc;
          break;
        }
      }
    }
    usedOuter.add(to);
    edges.push({ a: id, b: to, cls: 'highway', via: r.via });
  };
  connect('NORTH', lead('NORTH', unit(mul(nodes.NORTH as Km, -1))), ics);
  connect('EAST', lead('EAST', unit(mul(nodes.EAST as Km, -1))), ics);
  connect('DC', lead('DC', gateDir(parkF, LOCAL.park.gate)), ics);
  connect('AIR', lead('AIR', gateDir(airF, LOCAL.airport.gate)));
  connect('PORT', lead('PORT', gateDir(portF, LOCAL.port.gate)));
  // 物流园直通出口的高速（出口在物流园这一侧时）：出大门往前一点，再沿库房侧面拐向出口
  const parkX = gateDir(parkF, { x: 1, z: 0 });
  for (const exId of ['NORTH', 'EAST'] as const) {
    const ea = angOf(nodes[exId] as Km);
    const da = angOf(dcNode);
    if (Math.abs(wrap(ea - da)) >= 1.1) continue;
    const g = gateDir(parkF, LOCAL.park.gate);
    const sgn = dot(sub(nodes[exId] as Km, dcNode), parkX) >= 0 ? 1 : -1;
    const p1 = add(dcNode, mul(g, 0.9));
    highway('DC', exId, [p1, add(p1, mul(parkX, sgn * 7.5))]);
  }
  // 物流园里去面包房的路（局部坐标里绕过冷链中心）
  edges.push({ a: 'DC', b: 'BAKERY', cls: 'local', via: LOCAL.park.bakeryPath.slice(1, -1).map((k) => kmToWorld(parkF, k)) });

  // —— 铁路：港口铁路站 → 往内陆 → 沿城区外缘绕到物流园 → 物流园货运站（西端进、东端出）→ 出区域 ——
  const pst = { P0: fromD(toWorldD(portF, PORT_STATION.P0)), P1: fromD(toWorldD(portF, PORT_STATION.P1)) };
  const kst = { W: fromD(toWorldD(parkF, PARK_STATION.W)), S: fromD(toWorldD(parkF, PARK_STATION.S)), E: fromD(toWorldD(parkF, PARK_STATION.E)) };
  const xdir = unit(sub(kst.E, kst.W));
  const pdir = unit(sub(pst.P1, pst.P0));
  const arcRoute = (from: Km, to: Km, rad: (ang: number) => number): Km[] => {
    let t0 = angOf(from);
    let t1 = angOf(to);
    // 走不经过海那一侧的方向
    const rel0 = ((wrap(t0 - seaAng) + 2 * Math.PI) % (2 * Math.PI));
    const rel1 = ((wrap(t1 - seaAng) + 2 * Math.PI) % (2 * Math.PI));
    t0 = seaAng + rel0;
    t1 = seaAng + rel1;
    const out: Km[] = [];
    const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / 0.3));
    for (let k = 1; k < n; k++) {
      const a = t0 + ((t1 - t0) * k) / n;
      out.push(pushInland(polar(a, rad(a))));
    }
    return out;
  };
  const inner = (ang: number) => Math.max(cityR(ang) * 0.78, 3);
  const toPark = [pst.P1, add(pst.P1, mul(pdir, 1.6)), pushInland(add(pst.P1, mul(s, -3.2)))];
  const parkApp = add(kst.W, mul(xdir, -1.8));
  const route1 = chaikin([...toPark, ...arcRoute(toPark[toPark.length - 1] as Km, parkApp, inner), add(parkApp, mul(xdir, -1.2)), parkApp, kst.W], 3);
  const railExitAng = (() => {
    for (let k = 0; k < 13; k++) {
      const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (Math.PI / 12);
      const ang = dirAngle(o.rail) + step;
      if (!isSea(polar(ang, rayToBounds(ang) - 0.5))) return ang;
    }
    return dirAngle(o.rail);
  })();
  const railOff = polar(railExitAng, rayToBounds(railExitAng) + 1);
  const eApp = add(kst.E, mul(xdir, 1.8));
  let tail: Km[] = [kst.E, eApp, add(eApp, mul(xdir, 1.5))];
  const far = polar(railExitAng, rayToBounds(railExitAng) - 4);
  if (segDist({ x: 0, y: 0 }, tail[tail.length - 1] as Km, far) < (len(far) > 0 ? cityR(railExitAng) + 2 : 0) + 1) tail = [...tail, ...arcRoute(tail[tail.length - 1] as Km, far, (a) => bypassR(a) + 2.6)];
  const route2 = chaikin([...tail, far, railOff], 3);
  const railPts: Km[] = [pst.P0, ...route1.slice(0, -1), kst.W, kst.S, ...route2];
  // 去掉重复点
  const rail: Km[] = [];
  for (const p of railPts) if (!rail.length || dist(rail[rail.length - 1] as Km, p) > 0.05) rail.push(p);
  const dcIndex = rail.findIndex((p) => dist(p, kst.S) < 1e-6);
  // 城市客运站：港口到物流园这一段离市中心最近的地方
  let railPassenger: RegionPlan['railPassenger'];
  {
    let bestS = 0;
    let bestD = Infinity;
    let acc = 0;
    for (let i = 1; i <= dcIndex; i++) {
      acc += dist(rail[i - 1] as Km, rail[i] as Km);
      const d = len(rail[i] as Km);
      if (d < bestD && acc > 4) {
        bestD = d;
        bestS = acc;
      }
    }
    if (bestD < R) railPassenger = { s: bestS, name: '城市客运站' };
  }

  // —— 城区干道：立交内侧的路口、市中心、沿海大道上的路口和随机撒的路口连成加布里埃尔图 ——
  const urban: Record<string, Km> = {};
  const gateways: Record<string, string> = {};
  const offRiver = (p: Km, need: number): Km => {
    if (!river || riverDist(p) >= need) return p;
    let best = p;
    for (let k = 1; k <= 12; k++)
      for (const sgn of [1, -1]) {
        const q = add(p, mul(sp, sgn * k * 0.25));
        if (riverDist(q) >= need && !isSea(q)) return q;
        best = q;
      }
    return best;
  };
  icAng.forEach((a, k) => {
    const rIC = len(nodes[`R${k}`] as Km);
    const g = offRiver(polar(a, Math.min(rIC - 2.0, cityR(a) - 0.4)), 0.8);
    urban[`G${k}`] = g;
    gateways[`R${k}`] = `G${k}`;
  });
  urban.C0 = offRiver({ x: 0, y: 0 }, 0.8);
  // 沿海大道：城区里离海岸 1.3 公里的一串路口
  let kc = 0;
  for (let t = -R; t <= R; t += 3.1) {
    const p = add(mul(s, depthAt(t) - 1.3), mul(sp, t));
    if (!inCity(p, 0.3) || riverDist(p) < 0.9) continue;
    if (Object.values(urban).some((q) => dist(q, p) < 1.9)) continue;
    urban[`K${kc++}`] = p;
  }
  const dMin = { S: 2.1, M: 2.35, L: 2.55 }[o.size];
  let ki = 0;
  // —— 门店站点（随机、自定义区域）：先挑一块放得下整个站点（STORE_SITE）的地方，在它正前方留一个路口给进店路接；
  //    后面撒的路口、连的干道、高架都让开这块地（默认区域按原来的生成方式，最后再找门店的位置）——
  let storeSite: { p: Km; f: Km; s0: string } | undefined;
  const siteAt = (p: Km, f: Km, x: number, z: number): Km => ({ x: p.x + (-f.y * x + f.x * z) / 100, y: p.y + (f.x * x + f.y * z) / 100 });
  const inSite = (q: Km, m: number): boolean => {
    if (!storeSite) return false;
    const d = sub(q, storeSite.p);
    const lx = (-d.x * storeSite.f.y + d.y * storeSite.f.x) * 100;
    const lz = dot(d, storeSite.f) * 100;
    return lx > STORE_SITE.x0 - m * 100 && lx < STORE_SITE.x1 + m * 100 && lz > STORE_SITE.z0 - m * 100 && lz < STORE_SITE.z1 + m * 100;
  };
  const lineHitsSite = (pts: readonly Km[], m: number): boolean => {
    if (!storeSite) return false;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Km;
      const b = pts[i] as Km;
      if (segDist(storeSite.p, a, b) > 3.6) continue;
      const n = Math.max(1, Math.ceil(dist(a, b) / 0.06));
      for (let k = 0; k <= n; k++) if (inSite(add(a, mul(sub(b, a), k / n)), m)) return true;
    }
    return false;
  };
  if (!fixed) {
    const reach = STORE_SITE.attach / 100;
    const bandS = { center: [1.4, 0.42], urban: [0.36, 0.72], suburb: [0.66, 0.92] }[o.store];
    const blockers: Km[][] = [...edges.map((e) => [nodes[e.a] as Km, ...(e.via ?? []), nodes[e.b] as Km]), ...Object.entries(gateways).map(([ic, g]) => [urban[g] as Km, nodes[ic] as Km]), rail, ...riverLinesKm()];
    let best: { p: Km; f: Km; s0: Km; score: number } | undefined;
    for (let k = 0; k < 600 && !(best && k > 150); k++) {
      const ang = r2() * 2 * Math.PI;
      const lo = o.store === 'center' ? (bandS[0] as number) : (bandS[0] as number) * cityR(ang);
      const hi = Math.max(lo + 0.3, (bandS[1] as number) * cityR(ang));
      const p = polar(ang, lo + r2() * (hi - lo));
      if (!inCity(p, 0.6) || isSea(p)) continue;
      for (let j = 0; j < 12; j++) {
        const f = polar((j / 12) * 2 * Math.PI + r2() * 0.2, 1);
        const s0 = add(p, mul(f, reach));
        if (!inCity(s0, 0.5) || isSea(s0) || riverDist(s0) < 0.75) continue;
        if (!Object.values(urban).every((q) => dist(q, p) > reach + 0.4 && dist(q, s0) > dMin * 0.82)) continue;
        let wet = false;
        for (let gx = 0; gx <= 4 && !wet; gx++) for (let gz = 0; gz <= 8 && !wet; gz++) wet = isSea(siteAt(p, f, STORE_SITE.x0 + ((STORE_SITE.x1 - STORE_SITE.x0) * gx) / 4, STORE_SITE.z0 + ((STORE_SITE.z1 - STORE_SITE.z0) * gz) / 8));
        if (wet) continue;
        storeSite = { p, f, s0: '' };
        const hit = blockers.some((l) => lineHitsSite(l, 0.18));
        storeSite = undefined;
        if (hit) continue;
        // 正面朝着市中心的优先，离河远一点
        const score = dot(f, unit(mul(p, -1))) * 1.5 + Math.min(riverDist(p), 3) * 0.2 + r2() * 0.3;
        if (!best || score > best.score) best = { p, f, s0, score };
      }
    }
    if (best) {
      const id = `U${ki++}`;
      urban[id] = best.s0;
      storeSite = { p: best.p, f: best.f, s0: id };
    }
  }
  /** 门店站点那块地和它正前方的路口周围不再撒路口 */
  const siteBlocks = (p: Km) => !!storeSite && (inSite(p, 0.3) || dist(p, storeSite.p) < STORE_SITE.attach / 100 + 0.4);
  // 方格、环形放射、带状：先按形态排好路口，再在边角空着的地方补几个（自由生长、多组团全靠下面的随机撒点）
  const tryNode = (p: Km, gap: number) => {
    if (!inCity(p, 0.7) || isSea(p) || riverDist(p) < 0.75 || siteBlocks(p)) return;
    if (Object.values(urban).some((q) => dist(q, p) < gap)) return;
    urban[`U${ki++}`] = p;
  };
  if (form === 'grid') {
    const th = r2() * (Math.PI / 2);
    const ux = polar(th, 1);
    const uy = polar(th + Math.PI / 2, 1);
    const step = dMin * 1.08;
    const n = Math.ceil((R * 1.7) / step);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) tryNode(add(add(mul(ux, i * step + (r2() - 0.5) * 0.16), mul(uy, j * step + (r2() - 0.5) * 0.16)), mul(ux, step * 0.5)), dMin * 0.82);
  } else if (form === 'radial') {
    const a0r = r2() * Math.PI * 2;
    for (const [k, f] of [0.34, 0.6, 0.86].entries()) {
      const rr = R * f;
      const n = Math.max(5, Math.round((2 * Math.PI * rr) / (dMin * 1.18)));
      const off = a0r + (k % 2 ? Math.PI / n : 0);
      for (let i = 0; i < n; i++) tryNode(polar(off + (i / n) * 2 * Math.PI, rr), dMin * 0.8);
    }
  } else if (form === 'linear') {
    const step = dMin * 1.1;
    for (let j = -2; j <= 2; j++)
      for (let i = -Math.ceil((R * 1.7) / step); i <= Math.ceil((R * 1.7) / step); i++) tryNode(add(mul(sp, i * step + (j % 2 ? step / 2 : 0) + (r2() - 0.5) * 0.2), mul(s, j * dMin * 1.02 - dMin * 0.25)), dMin * 0.82);
  }
  for (let k = 0; k < 2400; k++) {
    const p = polar(r() * 2 * Math.PI, Math.sqrt(r()) * R * 1.2);
    if (!inCity(p, 0.7) || isSea(p) || riverDist(p) < 0.75 || siteBlocks(p)) continue;
    if (Object.values(urban).some((q) => dist(q, p) < dMin)) continue;
    urban[`U${ki++}`] = p;
  }
  const uids = Object.keys(urban);
  const cand = gabriel(uids, urban).map(([a, b]) => ({ a, b, w: dist(urban[a] as Km, urban[b] as Km) }));
  const riverCross = (a: Km, b: Km) => !!river && riverLinesKm().some((l) => polyCross([a, b], l));
  /** 干道穿过门店站点；从门店正前方那个路口出去、方向离门店不到 50° 的也不要（进店路要正对着店接） */
  const siteCross = (a: string, b: string): boolean => {
    if (!storeSite) return false;
    if (lineHitsSite([urban[a] as Km, urban[b] as Km], 0.2)) return true;
    const s0 = storeSite.s0;
    if (a !== s0 && b !== s0) return false;
    const S0 = urban[s0] as Km;
    const other = urban[a === s0 ? b : a] as Km;
    return dot(unit(sub(other, S0)), unit(sub(storeSite.p, S0))) > Math.cos((50 * Math.PI) / 180);
  };
  const weighted = cand.map((e) => ({ ...e, w: e.w + (riverCross(urban[e.a] as Km, urban[e.b] as Km) ? 60 : 0) + (isSea(mul(add(urban[e.a] as Km, urban[e.b] as Km), 0.5)) ? 200 : 0) + (siteCross(e.a, e.b) ? 150 : 0) }));
  const tree = mst(uids, weighted);
  const bridgesMax = { S: 2, M: 3, L: 4 }[o.size];
  const crossing = cand.map((e, i) => ({ e, i })).filter(({ e }) => riverCross(urban[e.a] as Km, urban[e.b] as Km)).sort((p, q) => p.e.w - q.e.w);
  const keepCross = new Set(crossing.slice(0, bridgesMax).map((x) => x.i));
  // 主干：相对邻域图（加最小生成树保证连通），再补一部分短的加布里埃尔边，路网像真实城市一样以四边形、五边形街区为主
  const rngSet = rngGraph(uids, urban);
  const art = cand.filter((e, i) => {
    if (siteCross(e.a, e.b) && !tree.has(i)) return false;
    const mid = mul(add(urban[e.a] as Km, urban[e.b] as Km), 0.5);
    if (isSea(mid)) return tree.has(i);
    if (riverCross(urban[e.a] as Km, urban[e.b] as Km)) return tree.has(i) || keepCross.has(i);
    const inRng = rngSet.has(`${e.a}|${e.b}`) || rngSet.has(`${e.b}|${e.a}`);
    return tree.has(i) || (inRng && e.w <= 6.5) || (e.w <= dMin * 1.18 && r() < 0.5);
  });
  // 去掉只连一条路的断头路（立交的路口、市中心除外），直到没有
  let artEdges = art.map((e) => ({ a: e.a, b: e.b }));
  for (let it = 0; it < 10; it++) {
    const deg = new Map<string, number>();
    const nb = new Map<string, string>();
    for (const e of artEdges) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
      nb.set(e.a, e.b);
      nb.set(e.b, e.a);
    }
    // 只剪「邻居还有别的路」的断头路：不会把立交的进城路口剪成孤点
    const dead = new Set(uids.filter((x) => !x.startsWith('G') && x !== 'C0' && x !== storeSite?.s0 && (deg.get(x) ?? 0) === 1 && (deg.get(nb.get(x) as string) ?? 0) >= 3));
    if (!dead.size) break;
    artEdges = artEdges.filter((e) => !dead.has(e.a) && !dead.has(e.b));
  }
  const used = new Set(artEdges.flatMap((e) => [e.a, e.b]));
  for (const k of Object.keys(gateways)) used.add(gateways[k] as string);
  for (const id of uids) if (used.has(id)) nodes[id] = urban[id] as Km;
  // 弯一点：每条长干道加一两个往旁边偏的点（偏了以后和别的路相交就不偏）
  const artPolys = artEdges.map((e) => [urban[e.a] as Km, urban[e.b] as Km]);
  artEdges.forEach((e, i) => {
    const A = urban[e.a] as Km;
    const B = urban[e.b] as Km;
    const L = dist(A, B);
    if (L < 1.6 || form === 'grid' || form === 'linear') return;
    if (form === 'radial') {
      // 同一圈上的两个路口：沿圆弧走
      const ra = len(A);
      const rb = len(B);
      if (Math.abs(ra - rb) > 0.35 || ra < 1) return;
      const aa = angOf(A);
      const da = wrap(angOf(B) - aa);
      const rm = (ra + rb) / 2;
      const arc = [A, polar(aa + da / 3, rm), polar(aa + (2 * da) / 3, rm), B];
      const others0 = artPolys.filter((_, k) => k !== i);
      if (others0.some((q) => polyCross(arc, q)) || arc.some((p) => isSea(p)) || (river && !riverCross(A, B) && riverLinesKm().some((l) => polyCross(arc, l))) || lineHitsSite(arc, 0.2)) return;
      artPolys[i] = arc;
      return;
    }
    const n = unit({ x: -(B.y - A.y), y: B.x - A.x });
    const u1 = (r() - 0.5) * 0.14;
    const u2 = (r() - 0.5) * 0.1;
    const poly = [A, add(add(A, mul(sub(B, A), 0.36)), mul(n, u1 * L)), add(add(A, mul(sub(B, A), 0.7)), mul(n, (u1 * 0.6 + u2) * L)), B];
    const others = artPolys.filter((_, k) => k !== i);
    if (others.some((q) => polyCross(poly, q)) || poly.some((p) => isSea(p)) || (river && !riverCross(A, B) && riverLinesKm().some((l) => polyCross(poly, l))) || lineHitsSite(poly, 0.2)) return;
    artPolys[i] = poly;
  });
  artEdges.forEach((e, i) => edges.push({ a: e.a, b: e.b, cls: 'arterial', via: (artPolys[i] as Km[]).slice(1, -1) }));
  // 立交 ↔ 城区一侧的路口
  for (const [ic, g] of Object.entries(gateways)) edges.push({ a: g, b: ic, cls: 'arterial' });

  // —— 高架快速路：从一个立交的进城路口穿过市中心旁边到对面的进城路口，跨过沿途的干道和河 ——
  let viaduct: RegionPlan['viaduct'];
  const gws = Object.values(gateways);
  if (gws.length >= 3) {
    let best: [string, string] | undefined;
    let bestGap = 0;
    for (const a of gws)
      for (const b of gws) {
        if (a >= b) continue;
        const gap = Math.abs(wrap(angOf(nodes[a] as Km) - angOf(nodes[b] as Km)));
        if (gap > bestGap) {
          bestGap = gap;
          best = [a, b];
        }
      }
    if (best && bestGap > 1.9) {
      const A = nodes[best[0]] as Km;
      const B = nodes[best[1]] as Km;
      const n = unit({ x: -(B.y - A.y), y: B.x - A.x });
      const sgn0 = r() < 0.5 ? -1 : 1;
      // 试几种往旁边偏的量，挑离路口最远的（高架跨过路口时桥墩会落在路口里）
      let pick: { pts: Km[]; clear: number } | undefined;
      for (const k of [0.9, 1.3, 0.5, 1.8, 0.2, 2.3]) {
        for (const sg of [sgn0, -sgn0]) {
          const off = sg * k;
          const ctrl = [A, add(add(A, mul(sub(B, A), 0.3)), mul(n, off * 0.8)), add(add(A, mul(sub(B, A), 0.5)), mul(n, off)), add(add(A, mul(sub(B, A), 0.7)), mul(n, off * 0.8)), B];
          const pts = resample(spline(ctrl, 6), 0.6);
          if (pts.some((p) => isSea(p)) || lineHitsSite(pts, 0.3)) continue;
          const clear = Math.min(...Object.entries(nodes).filter(([id]) => id !== best?.[0] && id !== best?.[1] && !id.startsWith('R') && !id.startsWith('BE')).map(([, p]) => polyDist(p, pts)));
          if (!pick || clear > pick.clear) pick = { pts, clear };
        }
        if (pick && pick.clear > 0.5) break;
      }
      if (pick && pick.clear > 0.22) {
        viaduct = { a: best[0], b: best[1] };
        edges.push({ a: best[0], b: best[1], cls: 'ring', via: pick.pts.slice(1, -1) });
      }
    }
  }

  // —— 门店：按指定的位置（市中心、城区、城郊）找一块离干道、铁路、高架、河都有一段距离的空地 ——
  const artLines = edges.filter((e) => e.cls === 'arterial' || e.cls === 'ring').map((e) => [nodes[e.a] as Km, ...(e.via ?? []), nodes[e.b] as Km]);
  const band = { center: [1.2, 0.36], urban: [0.36, 0.72], suburb: [0.72, 0.95] }[o.store];
  let store: Km = storeSite ? storeSite.p : { x: R * 0.5, y: 0 };
  let storeScore = -Infinity;
  for (let k = 0; k < 900 && !storeSite; k++) {
    const ang = r() * 2 * Math.PI;
    const lo = o.store === 'center' ? (band[0] as number) : (band[0] as number) * cityR(ang);
    const hi = (band[1] as number) * cityR(ang);
    const p = polar(ang, lo + r() * Math.max(0.2, hi - lo));
    if (!inCity(p, 0.6) || isSea(p)) continue;
    const dArt = Math.min(...artLines.map((l) => polyDist(p, l)));
    const ok = dArt > 1.3 && riverDist(p) > 0.9 && polyDist(p, rail) > 1.0 && Object.values(gateways).every((g) => dist(nodes[g] as Km, p) > 1.5);
    const score = (ok ? 100 : 0) + Math.min(dArt, 2.2);
    if (score > storeScore) {
      storeScore = score;
      store = p;
    }
  }

  const cityNodes = Object.keys(nodes).filter((id) => /^(G|C|K|U)\d*$/.test(id) || id === 'C0');
  const centers = [nodes.C0 as Km];
  if (form === 'cluster') {
    // 多组团：每个组团中间离得最近的路口是它的副中心
    for (let k = 0; k < 3; k++) {
      const want = polar(lobe0 + (k * 2 * Math.PI) / 3, R * 0.68);
      const pick = cityNodes.filter((id) => /^U/.test(id) && centers.every((c) => dist(c, nodes[id] as Km) > R * 0.35)).sort((a, b) => dist(nodes[a] as Km, want) - dist(nodes[b] as Km, want))[0];
      if (pick && dist(nodes[pick] as Km, want) < R * 0.45) centers.push(nodes[pick] as Km);
    }
  }

  // —— 海里的岛（河口；海湾里有时也有）：避开港口的航道、锚地和设施，离岸至少 1 公里 ——
  let islands: Km[][] | undefined;
  if (!fixed && (coastType === 'estuary' || (coastType === 'bay' && r2() < 0.45))) {
    const lanes = [LOCAL_LINER_IN, LOCAL_LINER_OUT].map((l) => l.map((k) => kmToWorld(portF, k)));
    const anch = kmToWorld(portF, LOCAL_ANCHORAGE);
    const foots = [footprintKm(portF, LOCAL.port.rect), footprintKm(airF, LOCAL.airport.rect), footprintKm(parkF, LOCAL.park.rect)];
    const list: Km[][] = [];
    const want = coastType === 'estuary' ? 2 + Math.floor(r2() * 3) : 1 + Math.floor(r2() * 2);
    for (let k = 0; k < 80 && list.length < want; k++) {
      const t = featureT + (r2() - 0.5) * 16;
      const rad = 0.6 + r2() * 1.5;
      const c = add(mul(s, depthAt(t) + 1.6 + rad + r2() * 6.5), mul(sp, t));
      if (!inBounds(c, rad + 1)) continue;
      if (lanes.some((l) => polyDist(c, l) < rad + 3.2) || dist(c, anch) < rad + 3) continue;
      if (list.some((q) => dist(mul(q.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / q.length), c) < rad + 2.6)) continue;
      const ph = [r2() * 6.28, r2() * 6.28];
      const stretch = 1 + r2() * 0.6;
      const poly: Km[] = [];
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        const rr = rad * (1 + 0.22 * Math.sin(2 * a + (ph[0] as number)) + 0.12 * Math.sin(5 * a + (ph[1] as number)));
        poly.push(add(c, add(mul(sp, Math.cos(a) * rr * stretch), mul(s, Math.sin(a) * rr))));
      }
      // 整座岛都在海里、靠岸那边还隔着 1 公里的水；不压设施
      if (poly.some((p) => !isSea(p) || !isSea(add(p, mul(s, -1.0))))) continue;
      if (foots.some((f) => poly.some((p) => pointInPoly(p, f)) || f.some((p) => pointInPoly(p, poly)))) continue;
      list.push(poly);
    }
    if (list.length) islands = list;
  }
  return {
    spec,
    options: o,
    seaDir: s,
    coast,
    ...(river ? { river } : {}),
    city: { center: { x: 0, y: 0 }, radius: R, boundary, nodes: cityNodes, centers },
    frames: { port: portF, airport: airF, park: parkF },
    nodes,
    edges,
    bypass: chain,
    ics,
    gateways,
    ...(viaduct ? { viaduct } : {}),
    rail,
    railPortIndex: 0,
    railDcIndex: dcIndex,
    ...(railPassenger ? { railPassenger } : {}),
    offmap: { NORTH: ex.NORTH.off, EAST: ex.EAST.off },
    store,
    ...(islands ? { islands } : {}),
  };
}

function toWorldD(f: Frame, p: XZ): XZ {
  const dx = p.x - f.o.x;
  const dz = p.z - f.o.z;
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  return { x: f.w.x + dx * c + dz * s, z: f.w.z - dx * s + dz * c };
}
