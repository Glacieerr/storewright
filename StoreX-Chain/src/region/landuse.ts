import { footprintKm, kmToLocal, kmToWorld, type Frame } from './frames';
import { LOCAL_RUNWAY, type Km } from './region';
import { DIR_LABEL, dirOf, LOCAL, pointInPoly, type RegionPlan } from './regionGen';

/**
 * 城市总体规划（用地布局）：按区域生成器给的海岸、河、城区边界、道路、铁路和港口、机场、物流园的位置，
 * 把整个区域划成各类用地，供三维的城区、规划图和小街使用。纯函数，同一个区域每次一样。
 *
 * 用地分类按《城市用地分类与规划建设用地标准》（GB 50137-2011）：居住 R、公共管理与公共服务 A、商业服务业 B、
 * 工业 M、物流仓储 W、道路与交通设施 S、公用设施 U、绿地与广场 G，区域里的港口、机场是区域交通设施用地 H2，
 * 海和河是水域 E1，城外是农林用地 E2。布局按通用的规划做法组合（不照搬哪一座城市）：
 * - 中心：市中心是商务、商业中心（CBD），旁边是行政、文化中心和市民广场、中央公园；主轴从市中心通向客运站或滨水；
 *   城区再分几个组团，每个组团有自己的副中心（商业、医院）；
 * - 居住：其余大部分是二类居住，滨水、滨河的一圈是一类（低密度）居住；居住区按「15 分钟生活圈」
 *  （《城市居住区规划设计标准》GB 50180-2018）组织，每个生活圈有社区服务中心、中小学、社区公园、卫生服务站；
 * - 站城一体（TOD）：客运站周围是商业、商务和高密度居住；
 * - 前港后园：港口背后是港口物流园（物流仓储、港口工业），城区一侧是港城过渡带（轻工业、物流）；
 *   临空经济区：机场陆侧是航空物流、轻工业和酒店、会展；物流园挨着高速和铁路，周围是物流仓储和工业；
 * - 防护：工业、物流用地和居住之间留防护绿带；铁路、快速路两侧有防护绿地；机场跑道两头的噪声区里不放居住、学校和医院；
 * - 公用设施：变电站在城区边上，自来水厂在河的上游，污水处理厂在下游靠海（离居住远、有绿带隔开）；
 * - 货运：高速、绕城快速路和门店的配送通道是货运通道，穿过居住、商业区的干道白天限行货车。
 * 用到的数值（用地结构的大致比例、生活圈的服务半径、站点周边的范围、噪声区里不放居住和学校、核心区白天限行货车等）
 * 都是按公开资料取的假设参数，不对应哪一座城市的规定。沙盘把距离压缩成 1/10、建筑按真实大小画，
 * 规划里的距离都按沙盘上的公里算（例如生活圈的间距按沙盘上能看出来的大小取）。
 */

export interface LandClass {
  /** 标准里的代码 */
  code: string;
  label: string;
  /** 规划图的颜色（按规划制图的常用配色：居住黄、商业红、公共服务粉、工业棕、物流紫、绿地绿、公用设施蓝、交通灰） */
  color: string;
  group: 'R' | 'A' | 'B' | 'M' | 'W' | 'S' | 'U' | 'G' | 'H' | 'E';
}

export const LAND: LandClass[] = [
  { code: '', label: '', color: '#000000', group: 'E' },
  { code: 'E1', label: '水域', color: '#8fc3e8', group: 'E' },
  { code: 'E2', label: '农林用地', color: '#d8e8b8', group: 'E' },
  { code: 'H23', label: '港口用地', color: '#b8b3cc', group: 'H' },
  { code: 'H24', label: '机场用地', color: '#c4c6c9', group: 'H' },
  { code: 'W1', label: '一类物流仓储用地', color: '#bba6e6', group: 'W' },
  { code: 'W2', label: '二类物流仓储用地', color: '#9a82d8', group: 'W' },
  { code: 'M1', label: '一类工业用地', color: '#cdaa80', group: 'M' },
  { code: 'M2', label: '二类工业用地', color: '#a9845c', group: 'M' },
  { code: 'R1', label: '一类居住用地', color: '#fff2b3', group: 'R' },
  { code: 'R2', label: '二类居住用地', color: '#ffe170', group: 'R' },
  { code: 'B1', label: '商业用地', color: '#f27e70', group: 'B' },
  { code: 'B2', label: '商务用地', color: '#d6544c', group: 'B' },
  { code: 'A1', label: '行政办公用地', color: '#f2a6cb', group: 'A' },
  { code: 'A2', label: '文化设施用地', color: '#e68dbf', group: 'A' },
  { code: 'A33', label: '中小学用地', color: '#f6bdd9', group: 'A' },
  { code: 'A5', label: '医疗卫生用地', color: '#e276ab', group: 'A' },
  { code: 'A31', label: '高等院校用地', color: '#eba3cc', group: 'A' },
  { code: 'S3', label: '交通枢纽用地', color: '#aab2bb', group: 'S' },
  { code: 'S4', label: '交通场站用地', color: '#c0c6cd', group: 'S' },
  { code: 'U1', label: '供应设施用地', color: '#82b6db', group: 'U' },
  { code: 'U2', label: '环境设施用地', color: '#6ca3cb', group: 'U' },
  { code: 'G1', label: '公园绿地', color: '#93d072', group: 'G' },
  { code: 'G2', label: '防护绿地', color: '#62a75a', group: 'G' },
  { code: 'G3', label: '广场用地', color: '#d3e6c3', group: 'G' },
];
/** 各类用地在 LAND 里的下标 */
export const L = {
  NONE: 0,
  WATER: 1,
  RURAL: 2,
  PORT: 3,
  AIRPORT: 4,
  W1: 5,
  W2: 6,
  M1: 7,
  M2: 8,
  R1: 9,
  R2: 10,
  B1: 11,
  B2: 12,
  A1: 13,
  A2: 14,
  A33: 15,
  A5: 16,
  A31: 17,
  S3: 18,
  S4: 19,
  U1: 20,
  U2: 21,
  G1: 22,
  G2: 23,
  G3: 24,
} as const;

export type DistrictKind = 'center' | 'cluster' | 'port' | 'airport' | 'park' | 'station';
export interface District {
  name: string;
  kind: DistrictKind;
  at: Km;
  /** 面积（沙盘上的平方公里） */
  area: number;
}
/** 一个 15 分钟生活圈：社区服务中心、中小学、社区公园、卫生服务站 */
export interface LifeCircle {
  c: Km;
  /** 中学（服务半径约 1 公里）、小学（约 500 米） */
  school: Km;
  primary: Km;
  park: Km;
  clinic: Km;
}
export type CorridorKind = 'freight' | 'delivery' | 'restricted';
/** 干道、高速在货运上的角色（a、b 是区域生成器的节点） */
export interface Corridor {
  a: string;
  b: string;
  kind: CorridorKind;
}
export type LandmarkKind = 'tower' | 'stadium' | 'wheel' | 'lighthouse' | 'expo' | 'campus' | 'museum' | 'hospital' | 'civic';
export interface Landmark {
  kind: LandmarkKind;
  at: Km;
  label: string;
}
export type UtilityKind = 'substation' | 'waterworks' | 'wastewater' | 'waste' | 'busdepot' | 'truckhub';
export interface Utility {
  kind: UtilityKind;
  at: Km;
  label: string;
}

export interface LandUsePlan {
  /** 用地栅格：x0、y0 是左下角（公里），cell 是格子边长，code 是 LAND 的下标（行优先，y 向北） */
  grid: { x0: number; y0: number; cell: number; w: number; h: number; code: Uint8Array };
  /** 市中心和各组团的副中心 */
  centers: { at: Km; main: boolean; name: string }[];
  districts: District[];
  lifeCircles: LifeCircle[];
  /** 机场噪声区：跑道两头沿中线延伸的范围（70、75 分贝等值线的简化：跑道外延长 ext、半宽 half） */
  noise: { a: Km; b: Km; ext70: number; half70: number; ext75: number; half75: number };
  corridors: Corridor[];
  landmarks: Landmark[];
  utilities: Utility[];
  /** 城市建设用地结构（不含水域、农林、港口和机场）：各大类的面积和占比 */
  stats: { group: string; label: string; km2: number; share: number }[];
  /** 规划里用到的规则（规划图的说明里列出来） */
  rules: string[];
}

const CELL = 0.2;
const GROUP_LABEL: Record<string, string> = { R: '居住用地', A: '公共管理与公共服务设施用地', B: '商业服务业设施用地', M: '工业用地', W: '物流仓储用地', S: '道路与交通设施用地', U: '公用设施用地', G: '绿地与广场用地' };

const dist = (a: Km, b: Km) => Math.hypot(a.x - b.x, a.y - b.y);
function segDist(p: Km, a: Km, b: Km): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}
function rng(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) * 2654435761 + 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 栅格上的距离场（8 邻域倒角距离，两遍扫描）：seed 里非 0 的格子距离为 0，单位是公里 */
function distField(seed: Uint8Array, w: number, h: number, cell: number): Float32Array {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i] as number;
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, (d[i - 1] as number) + a);
      if (y > 0) {
        v = Math.min(v, (d[i - w] as number) + a);
        if (x > 0) v = Math.min(v, (d[i - w - 1] as number) + b);
        if (x < w - 1) v = Math.min(v, (d[i - w + 1] as number) + b);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i] as number;
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, (d[i + 1] as number) + a);
      if (y < h - 1) {
        v = Math.min(v, (d[i + w] as number) + a);
        if (x < w - 1) v = Math.min(v, (d[i + w + 1] as number) + b);
        if (x > 0) v = Math.min(v, (d[i + w - 1] as number) + b);
      }
      d[i] = v;
    }
  return d;
}

/** 海岸线朝海一侧是海：沿岸线方向（站在陆地面朝大海的左手方向）插值出离岸的深度 */
export function seaTester(plan: RegionPlan): (p: Km) => boolean {
  const s = plan.seaDir;
  const sp = { x: -s.y, y: s.x };
  const T = plan.coast.map((c) => c.x * sp.x + c.y * sp.y);
  const D = plan.coast.map((c) => c.x * s.x + c.y * s.y);
  const asc = (T[T.length - 1] as number) >= (T[0] as number);
  const islands = plan.islands ?? [];
  return (p: Km) => {
    for (const isl of islands) if (pointInPoly(p, isl)) return false;
    const t = p.x * sp.x + p.y * sp.y;
    const d = p.x * s.x + p.y * s.y;
    let lo = 0;
    let hi = T.length - 1;
    const key = (i: number) => (asc ? (T[i] as number) : -(T[i] as number));
    const tk = asc ? t : -t;
    if (tk <= key(0)) return d > (D[0] as number);
    if (tk >= key(hi)) return d > (D[hi] as number);
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (key(m) <= tk) lo = m;
      else hi = m;
    }
    const f = (tk - key(lo)) / (key(hi) - key(lo) || 1);
    return d > (D[lo] as number) + ((D[hi] as number) - (D[lo] as number)) * f;
  };
}

/** 河（主河道和支流）的折线和宽度 */
export function riverLines(plan: RegionPlan): { pts: Km[]; width: number }[] {
  if (!plan.river) return [];
  return [{ pts: plan.river.pts, width: plan.river.width }, ...(plan.river.branches ?? []).map((pts) => ({ pts, width: plan.river?.branchWidth ?? plan.river?.width ?? 0.3 }))];
}

const cache = new WeakMap<RegionPlan, LandUsePlan>();

/** 区域的用地规划（同一个区域对象只算一次） */
export function planLandUse(plan: RegionPlan): LandUsePlan {
  const hit = cache.get(plan);
  if (hit) return hit;
  const lu = compute(plan);
  cache.set(plan, lu);
  return lu;
}

/** 一点的用地（LAND 的下标；区域外是 0） */
export function landAt(lu: LandUsePlan, p: Km): number {
  const g = lu.grid;
  const x = Math.floor((p.x - g.x0) / g.cell);
  const y = Math.floor((p.y - g.y0) / g.cell);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return 0;
  return g.code[y * g.w + x] as number;
}

function compute(plan: RegionPlan): LandUsePlan {
  const seed = plan.spec.mode === 'default' ? 1 : plan.spec.seed;
  const r = rng(seed * 4099 + 17);
  const R = plan.city.radius;
  const x0 = -44;
  const y0 = -32;
  const w = Math.round((52 - x0) / CELL);
  const h = Math.round((40 - y0) / CELL);
  const N = w * h;
  const at = (i: number): Km => ({ x: x0 + ((i % w) + 0.5) * CELL, y: y0 + (Math.floor(i / w) + 0.5) * CELL });
  const idx = (p: Km) => {
    const x = Math.floor((p.x - x0) / CELL);
    const y = Math.floor((p.y - y0) / CELL);
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const isSea = seaTester(plan);
  const code = new Uint8Array(N);
  const rules: string[] = [];

  // —— 1）底图：海、河、城区、设施 ——
  const sea = new Uint8Array(N);
  const water = new Uint8Array(N);
  const city = new Uint8Array(N);
  const cityPoly = plan.city.boundary;
  let cb = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  for (const p of cityPoly) cb = { x0: Math.min(cb.x0, p.x), x1: Math.max(cb.x1, p.x), y0: Math.min(cb.y0, p.y), y1: Math.max(cb.y1, p.y) };
  for (let i = 0; i < N; i++) {
    const p = at(i);
    if (isSea(p)) {
      sea[i] = 1;
      water[i] = 1;
      continue;
    }
    if (p.x >= cb.x0 && p.x <= cb.x1 && p.y >= cb.y0 && p.y <= cb.y1 && pointInPoly(p, cityPoly)) city[i] = 1;
  }
  const rivers = riverLines(plan);
  const riverSeed = new Uint8Array(N);
  const stamp = (pts: readonly Km[], half: number, into: Uint8Array) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1] as Km;
      const b = pts[k] as Km;
      const n = Math.max(1, Math.ceil(dist(a, b) / (CELL * 0.5)));
      for (let j = 0; j <= n; j++) {
        const q = { x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n };
        const rr = Math.ceil(half / CELL);
        const qi = idx(q);
        if (qi < 0) continue;
        const qx = qi % w;
        const qy = Math.floor(qi / w);
        for (let dy = -rr; dy <= rr; dy++)
          for (let dx = -rr; dx <= rr; dx++) {
            const x = qx + dx;
            const y = qy + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const c = at(y * w + x);
            if (dist(c, q) <= half + CELL * 0.35) into[y * w + x] = 1;
          }
      }
    }
  };
  for (const rv of rivers) stamp(rv.pts, rv.width / 2, riverSeed);
  for (let i = 0; i < N; i++) if (riverSeed[i]) water[i] = 1;
  const rect = (poly: Km[]) => {
    const m = new Uint8Array(N);
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;
    for (const p of poly) [bx0, bx1, by0, by1] = [Math.min(bx0, p.x), Math.max(bx1, p.x), Math.min(by0, p.y), Math.max(by1, p.y)];
    for (let y = Math.max(0, Math.floor((by0 - y0) / CELL)); y <= Math.min(h - 1, Math.ceil((by1 - y0) / CELL)); y++)
      for (let x = Math.max(0, Math.floor((bx0 - x0) / CELL)); x <= Math.min(w - 1, Math.ceil((bx1 - x0) / CELL)); x++) if (pointInPoly(at(y * w + x), poly)) m[y * w + x] = 1;
    return m;
  };
  const portM = rect(footprintKm(plan.frames.port, LOCAL.port.rect));
  const airM = rect(footprintKm(plan.frames.airport, LOCAL.airport.rect));
  const parkM = rect(footprintKm(plan.frames.park, LOCAL.park.rect));
  const dSea = distField(sea, w, h, CELL);
  const dRiver = distField(riverSeed, w, h, CELL);
  const dPort = distField(portM, w, h, CELL);
  const dAir = distField(airM, w, h, CELL);
  const dPark = distField(parkM, w, h, CELL);
  const outCity = new Uint8Array(N);
  for (let i = 0; i < N; i++) outCity[i] = city[i] ? 0 : 1;
  const dIn = distField(outCity, w, h, CELL);
  // 铁路、高速和绕城快速路
  const railM = new Uint8Array(N);
  stamp(plan.rail, 0.05, railM);
  const dRail = distField(railM, w, h, CELL);
  const hwyM = new Uint8Array(N);
  const node = (id: string) => plan.nodes[id] as Km;
  const edgePts = (e: RegionPlan['edges'][number]) => [node(e.a), ...(e.via ?? []), node(e.b)];
  for (const e of plan.edges) if (e.cls === 'highway' || e.cls === 'ring') stamp(edgePts(e), 0.06, hwyM);
  const dHwy = distField(hwyM, w, h, CELL);
  const artM = new Uint8Array(N);
  for (const e of plan.edges) if (e.cls === 'arterial') stamp(edgePts(e), 0.03, artM);
  const dArt = distField(artM, w, h, CELL);

  // 客运站
  let station: Km | undefined;
  if (plan.railPassenger) {
    let acc = 0;
    for (let k = 1; k < plan.rail.length; k++) {
      const a = plan.rail[k - 1] as Km;
      const b = plan.rail[k] as Km;
      const l = dist(a, b);
      if (acc + l >= plan.railPassenger.s) {
        const f = (plan.railPassenger.s - acc) / (l || 1);
        station = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        break;
      }
      acc += l;
    }
  }
  // 机场跑道和噪声区（跑道外延长、两侧的半宽按沙盘公里）
  const rwA = kmToWorld(plan.frames.airport, LOCAL_RUNWAY.a);
  const rwB = kmToWorld(plan.frames.airport, LOCAL_RUNWAY.b);
  const noise = { a: rwA, b: rwB, ext70: 7, half70: 1.6, ext75: 3.5, half75: 0.9 };
  const rwLen = dist(rwA, rwB) || 1;
  const rwU = { x: (rwB.x - rwA.x) / rwLen, y: (rwB.y - rwA.y) / rwLen };
  const noiseLevel = (p: Km): number => {
    const t = (p.x - rwA.x) * rwU.x + (p.y - rwA.y) * rwU.y;
    const lat = Math.abs(-(p.x - rwA.x) * rwU.y + (p.y - rwA.y) * rwU.x);
    const beyond = t < 0 ? -t : t > rwLen ? t - rwLen : 0;
    // 越往外越窄（离跑道头远了飞机高、声音小）
    const half = (ext: number, hw: number) => (beyond > ext ? -1 : hw * (1 - (0.55 * beyond) / ext));
    if (lat <= half(noise.ext75, noise.half75)) return 75;
    if (lat <= half(noise.ext70, noise.half70)) return 70;
    return 0;
  };

  // —— 2）中心和组团 ——
  const center = plan.city.centers[0] ?? plan.city.center;
  const seaDir = plan.seaDir;
  const cityNodes = plan.city.nodes.map((id) => plan.nodes[id]).filter((p): p is Km => !!p);
  const centers: LandUsePlan['centers'] = [{ at: center, main: true, name: '市中心' }];
  for (const c of plan.city.centers.slice(1)) centers.push({ at: c, main: false, name: '' });
  const want = { S: 2, M: 3, L: 4 }[plan.options.size];
  const cand = cityNodes
    .map((p) => {
      const d = dist(p, center);
      const toward = ((p.x - center.x) * seaDir.x + (p.y - center.y) * seaDir.y) / (d || 1);
      return { p, d, score: -Math.abs(d / R - 0.55) - Math.max(0, toward - 0.4) * 0.6 + r() * 0.08 };
    })
    .filter((c) => c.d > R * 0.38 && c.d < R * 0.78)
    .sort((a, b) => b.score - a.score);
  for (const c of cand) {
    if (centers.length >= want + 1) break;
    const ang = Math.atan2(c.p.y - center.y, c.p.x - center.x);
    if (centers.some((o) => !o.main && Math.abs(Math.atan2(Math.sin(Math.atan2(o.at.y - center.y, o.at.x - center.x) - ang), Math.cos(Math.atan2(o.at.y - center.y, o.at.x - center.x) - ang))) < 1.15)) continue;
    if (dIn[idx(c.p)] !== undefined && (dIn[idx(c.p)] as number) < 0.8) continue;
    centers.push({ at: c.p, main: false, name: '' });
  }
  const used = new Set<string>();
  for (const c of centers) {
    if (c.main) continue;
    const base = `${DIR_LABEL[dirOf({ x: c.at.x - center.x, y: c.at.y - center.y })]}部组团`;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base}${k}`;
    used.add(name);
    c.name = name;
  }
  rules.push('市中心是商务、商业中心，旁边是行政、文化中心、市民广场和中央公园；城区分成几个组团，每个组团有自己的副中心（商业、医院）');

  // 主轴：市中心 → 客运站（没有就通向滨水）
  let axisEnd: Km | undefined = station && dist(station, center) < R * 1.1 ? station : undefined;
  if (!axisEnd) {
    for (let x = 1; x < R * 1.4; x += 0.2) {
      const q = { x: center.x + seaDir.x * x, y: center.y + seaDir.y * x };
      if (isSea(q)) {
        axisEnd = { x: center.x + seaDir.x * (x - 0.8), y: center.y + seaDir.y * (x - 0.8) };
        break;
      }
    }
  }
  // 中央公园、行政中心：市中心旁边（不压主轴）
  const axisDir = axisEnd ? { x: (axisEnd.x - center.x) / (dist(axisEnd, center) || 1), y: (axisEnd.y - center.y) / (dist(axisEnd, center) || 1) } : { x: 1, y: 0 };
  const side = r() < 0.5 ? 1 : -1;
  const park0 = { x: center.x - axisDir.y * side * R * 0.2, y: center.y + axisDir.x * side * R * 0.2 };
  const civic = { x: center.x + axisDir.y * side * R * 0.13 - axisDir.x * R * 0.05, y: center.y - axisDir.x * side * R * 0.13 - axisDir.y * R * 0.05 };

  // —— 3）城外：设施旁边的片区（按设施自己的局部坐标划：港口背后、机场陆侧、物流园大门前和两侧）——
  const loc = (f: Frame, p: Km) => {
    const k = kmToLocal(f, p);
    return { x: k.x * 100, z: -k.y * 100 };
  };
  const PR = LOCAL.port.rect;
  const AR = LOCAL.airport.rect;
  const KR = LOCAL.park.rect;
  /** 港口背后的港口物流园：0 不在，1 紧挨港区（二类物流仓储），2 一类物流仓储，3 港口工业 */
  const portBand = (p: Km) => {
    const q = loc(plan.frames.port, p);
    if (q.x < PR.x0 + 60 || q.x > PR.x1 - 60 || q.z >= PR.z0 || q.z < PR.z0 - 260) return 0;
    return q.z >= PR.z0 - 110 ? 1 : q.z >= PR.z0 - 190 ? 2 : 3;
  };
  /** 机场陆侧的临空经济区：1 航空物流，2 轻工业，3 酒店、会展、办公 */
  const airBand = (p: Km) => {
    const q = loc(plan.frames.airport, p);
    if (q.x < 1250 || q.x > 3050 || q.z >= AR.z0 || q.z < AR.z0 - 220) return 0;
    return q.z >= AR.z0 - 80 ? 1 : q.z >= AR.z0 - 150 ? 2 : 3;
  };
  /** 物流园大门前和两侧：1 物流仓储，2 工业 */
  const parkBand = (p: Km) => {
    const q = loc(plan.frames.park, p);
    const front = q.z > KR.z1 && q.z <= KR.z1 + 170 && q.x >= KR.x0 - 60 && q.x <= KR.x1 + 60;
    const flank = q.z >= KR.z0 && q.z <= KR.z1 && ((q.x < KR.x0 && q.x >= KR.x0 - 150) || (q.x > KR.x1 && q.x <= KR.x1 + 150));
    if (!front && !flank) return 0;
    return (front && q.z <= KR.z1 + 85) || (flank && Math.min(Math.abs(q.x - KR.x0), Math.abs(q.x - KR.x1)) < 75) ? 1 : 2;
  };
  for (let i = 0; i < N; i++) {
    if (water[i]) {
      code[i] = L.WATER;
      continue;
    }
    if (portM[i]) {
      code[i] = L.PORT;
      continue;
    }
    if (airM[i]) {
      code[i] = L.AIRPORT;
      continue;
    }
    if (parkM[i]) {
      code[i] = L.W2;
      continue;
    }
    if (city[i]) continue;
    const p = at(i);
    const pb = portBand(p);
    const kb = pb ? 0 : parkBand(p);
    const ab = pb || kb ? 0 : airBand(p);
    if (pb) code[i] = pb === 1 ? L.W2 : pb === 2 ? L.W1 : L.M2;
    else if (kb) code[i] = kb === 1 ? L.W1 : L.M1;
    else if (ab) code[i] = ab === 1 ? L.W1 : ab === 2 ? L.M1 : L.B1;
    else code[i] = L.RURAL;
  }
  rules.push('物流枢纽按类型挨着交通设施布置：前港后园（港口型：港口背后是二类、一类物流仓储和港口工业）、临空经济区（空港型：机场陆侧是航空物流、轻工业和酒店会展）、陆港型物流园（挨着铁路货运站和高速立交，周围是物流仓储和生产服务的工业）');

  // —— 4）城区 ——
  const R2 = R;
  const portSide = (p: Km) => (dPort[idx(p)] ?? 99) as number;
  for (let i = 0; i < N; i++) {
    if (!city[i] || code[i]) continue;
    const p = at(i);
    const dc = dist(p, center);
    let c: number = L.R2;
    const ds = dSea[i] as number;
    const dr = dRiver[i] as number;
    if (dc < R2 * 0.13) c = L.B2;
    else if (dc < R2 * 0.22) c = L.B1;
    // 主轴两侧的商业
    if (axisEnd && c === L.R2 && dc < dist(axisEnd, center) && segDist(p, center, axisEnd) < 0.55) c = L.B1;
    // 副中心
    for (const o of centers) if (!o.main && dist(p, o.at) < R2 * 0.09) c = L.B1;
    // 离市中心不远的干道两边是沿街商业
    if (c === L.R2 && dc < R2 * 0.62 && (dArt[i] as number) < 0.17) c = L.B1;
    // 站城一体
    if (station && dist(p, station) < R2 * 0.05) c = L.B2;
    else if (station && dist(p, station) < R2 * 0.1 && c === L.R2) c = L.B1;
    // 港城过渡带：靠港口物流园一侧的城区边上是轻工业、物流
    if (portSide(p) < 5.0 && (dIn[i] as number) < 2.0 && c === L.R2) c = (dIn[i] as number) < 0.9 ? L.W1 : L.M1;
    // 物流园、机场那一侧的城区边上：靠外一圈物流仓储，往里一圈轻工业（生产服务）
    if (((dPark[i] as number) < 5.6 || (dAir[i] as number) < 5.4) && (dIn[i] as number) < 1.5 && c === L.R2) c = (dIn[i] as number) < 0.7 ? L.W1 : L.M1;
    // 滨水、滨河：公园带，再往里一圈是低密度居住
    if (ds < 0.55 || (dr < 0.45 && !water[i])) c = L.G1;
    else if ((ds < 1.7 || dr < 1.1) && c === L.R2) c = L.R1;
    // 铁路、快速路两侧的防护绿地
    if ((dRail[i] as number) < 0.25 || (dHwy[i] as number) < 0.2) c = L.G2;
    code[i] = c;
  }
  // 中央公园、行政中心和市民广场、文化中心
  const disk = (c0: Km, rad: number, v: number, only?: (cur: number) => boolean) => {
    const rr = Math.ceil(rad / CELL) + 1;
    const ci = idx(c0);
    if (ci < 0) return;
    const cx = ci % w;
    const cy = Math.floor(ci / w);
    for (let dy = -rr; dy <= rr; dy++)
      for (let dx = -rr; dx <= rr; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!city[i] || water[i] || dist(at(i), c0) > rad) continue;
        if (only && !only(code[i] as number)) continue;
        code[i] = v;
      }
  };
  const notGreen = (c: number) => c !== L.G1 && c !== L.G2 && c !== L.WATER;
  disk(park0, R2 * 0.095, L.G1, notGreen);
  disk(civic, R2 * 0.055, L.A1, notGreen);
  disk({ x: civic.x + axisDir.x * R2 * 0.06, y: civic.y + axisDir.y * R2 * 0.06 }, R2 * 0.032, L.G3, notGreen);
  const culture = { x: park0.x + axisDir.x * R2 * 0.1, y: park0.y + axisDir.y * R2 * 0.1 };
  disk(culture, R2 * 0.045, L.A2, notGreen);
  // 多组团：组团之间的绿带（从城区里一段往外，沿两个副中心中间的方向）
  if (plan.options.form === 'cluster') {
    const subs = centers.filter((c) => !c.main).map((c) => Math.atan2(c.at.y - center.y, c.at.x - center.x)).sort((a, b) => a - b);
    for (let k = 0; k < subs.length && subs.length >= 2; k++) {
      const a1 = subs[k] as number;
      const a2 = k + 1 < subs.length ? (subs[k + 1] as number) : (subs[0] as number) + Math.PI * 2;
      const mid = (a1 + a2) / 2;
      const u = { x: Math.cos(mid), y: Math.sin(mid) };
      for (let i = 0; i < N; i++) {
        if (!city[i] || water[i]) continue;
        const q = at(i);
        const rel = { x: q.x - center.x, y: q.y - center.y };
        const along = rel.x * u.x + rel.y * u.y;
        if (along < R2 * 0.3 || Math.abs(rel.x * u.y - rel.y * u.x) > 0.5) continue;
        code[i] = L.G2;
      }
    }
    rules.push('多组团：组团之间留出绿带（防护绿地），每个组团有自己的副中心');
  }
  if (station) disk(station, R2 * 0.022, L.S3);

  // 门店：商业用地
  disk(plan.store, 1.2, L.B1);

  // —— 5）公共服务：医院、大学、生活圈 ——
  const landmarks: Landmark[] = [];
  const utilities: Utility[] = [];
  const hospitals: Km[] = [{ x: center.x - axisDir.x * R2 * 0.16 + axisDir.y * side * R2 * 0.05, y: center.y - axisDir.y * R2 * 0.16 - axisDir.x * side * R2 * 0.05 }];
  for (const o of centers) if (!o.main) hospitals.push({ x: o.at.x + (center.x - o.at.x) * 0.12, y: o.at.y + (center.y - o.at.y) * 0.12 });
  for (const hp of hospitals) disk(hp, R2 * 0.042, L.A5, notGreen);
  // 每个副中心旁边一处文化体育设施
  for (const o of centers) if (!o.main) disk({ x: o.at.x + (o.at.x - center.x) * 0.1, y: o.at.y + (o.at.y - center.y) * 0.1 }, R2 * 0.032, L.A2, notGreen);
  // 大学：离港口、机场、物流园远的一侧、城区外围
  let uni: Km | undefined;
  let uniBest = -Infinity;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const q = { x: center.x + Math.cos(a) * R2 * 0.7, y: center.y + Math.sin(a) * R2 * 0.7 };
    const qi = idx(q);
    if (qi < 0 || !city[qi] || water[qi] || (dIn[qi] as number) < 1.0) continue;
    const score = Math.min(dPort[qi] as number, dAir[qi] as number, dPark[qi] as number) + (code[qi] === L.R2 || code[qi] === L.R1 ? 2 : 0) - noiseLevel(q) / 10 + r() * 0.5;
    if (score > uniBest) [uniBest, uni] = [score, q];
  }
  if (uni) disk(uni, R2 * 0.085, L.A31, notGreen);
  rules.push('居住区按 15 分钟生活圈组织（GB 50180-2018）：每个生活圈有社区服务中心、中小学、社区公园和卫生服务站；医院在市中心和各组团副中心旁边，大学在离港口、机场远的外围');

  // 生活圈：在居住用地里按间距铺点（泊松圆盘）
  const lifeCircles: LifeCircle[] = [];
  const spacing = Math.max(1.6, R2 * 0.19);
  const resi: number[] = [];
  for (let i = 0; i < N; i++) if (code[i] === L.R2 || code[i] === L.R1) resi.push(i);
  for (let k = 0; k < resi.length * 2 && lifeCircles.length < 60; k++) {
    const i = resi[Math.floor(r() * resi.length)] as number;
    const p = at(i);
    if ((dIn[i] as number) < 0.5 || noiseLevel(p) > 0) continue;
    if (lifeCircles.some((lc) => dist(lc.c, p) < spacing)) continue;
    const ang = r() * Math.PI * 2;
    const school = { x: p.x + Math.cos(ang) * 0.35, y: p.y + Math.sin(ang) * 0.35 };
    const pk = { x: p.x - Math.cos(ang) * 0.32, y: p.y - Math.sin(ang) * 0.32 };
    const clinic = { x: p.x + Math.cos(ang + 1.6) * 0.25, y: p.y + Math.sin(ang + 1.6) * 0.25 };
    const primary = { x: p.x + Math.cos(ang - 1.9) * 0.55, y: p.y + Math.sin(ang - 1.9) * 0.55 };
    lifeCircles.push({ c: p, school, primary, park: pk, clinic });
  }
  const resiOnly = (c: number) => c === L.R2 || c === L.R1;
  for (const lc of lifeCircles) {
    disk(lc.school, 0.3, L.A33, resiOnly);
    disk(lc.primary, 0.22, L.A33, resiOnly);
    disk(lc.park, 0.3, L.G1, resiOnly);
  }

  // —— 6）公用设施 ——
  const pickOn = (score: (p: Km, i: number) => number): Km | undefined => {
    let best: Km | undefined;
    let bs = -Infinity;
    for (let i = 0; i < N; i += 3) {
      const p = at(i);
      const s = score(p, i);
      if (s > bs) [bs, best] = [s, p];
    }
    return bs > -Infinity ? best : undefined;
  };
  const edgeOfCity = (i: number) => !water[i] && !city[i] && (code[i] === L.RURAL || code[i] === L.M1 || code[i] === L.M2) && (dIn[i] as number) <= 0 && (dHwy[i] as number) > 0.5;
  // 自来水厂：河的上游（离海最远的一段河边、城区外）；没有河就在内陆一侧的城外
  const mainRiver = plan.river?.pts;
  const ww = pickOn((p, i) => {
    if (!edgeOfCity(i) || water[i]) return -Infinity;
    const dc = dist(p, center);
    if (dc < R2 + 0.6 || dc > R2 + 4) return -Infinity;
    const inland = -((p.x - center.x) * seaDir.x + (p.y - center.y) * seaDir.y);
    const nearRiver = mainRiver ? -Math.abs((dRiver[i] as number) - 0.7) * 3 : 0;
    return inland + nearRiver;
  });
  if (ww) utilities.push({ kind: 'waterworks', at: ww, label: '自来水厂' });
  // 污水处理厂：下游靠海、城外，离居住远
  const wt = pickOn((p, i) => {
    if (water[i] || city[i] || (dSea[i] as number) < 0.6 || (dSea[i] as number) > 3 || code[i] === L.PORT || code[i] === L.AIRPORT) return -Infinity;
    const dc = dist(p, center);
    if (dc < R2 + 0.8 || dc > R2 + 6) return -Infinity;
    const nearMouth = mainRiver ? -dist(p, mainRiver[mainRiver.length - 1] as Km) * 0.6 : 0;
    return nearMouth - (dPort[i] as number) * 0.05 + ((dPort[i] as number) > 2.5 ? 2 : -4);
  });
  if (wt) utilities.push({ kind: 'wastewater', at: wt, label: '污水处理厂' });
  // 变电站：城区边上两处（方向错开）
  for (let k = 0; k < 2; k++) {
    const sub = pickOn((p, i) => {
      if (!city[i] || water[i] || (dIn[i] as number) > 1.0 || (dIn[i] as number) < 0.4 || code[i] === L.G1) return -Infinity;
      const a = Math.atan2(p.y - center.y, p.x - center.x);
      return -Math.abs(Math.sin((a - k * Math.PI - 0.6) / 2)) * 3 - Math.abs((dHwy[i] as number) - 0.6) + (code[i] === L.M1 || code[i] === L.W1 ? 1 : 0);
    });
    if (sub) utilities.push({ kind: 'substation', at: sub, label: '变电站' });
  }
  // 环卫（垃圾转运）：工业、物流一侧的城外
  const waste = pickOn((p, i) => (water[i] || city[i] || !(code[i] === L.M2 || code[i] === L.M1) ? -Infinity : -dist(p, center) * 0.2 - Math.abs((dIn[i] as number) + 1.2)));
  if (waste) utilities.push({ kind: 'waste', at: waste, label: '垃圾转运站' });
  // 货运场站（货车停车、加油、司机休息）：物流园或港口物流园边上；公交场站：城区边上
  const truckHub = pickOn((p, i) => (water[i] || city[i] || (code[i] !== L.W1 && code[i] !== L.W2) || portM[i] || parkM[i] || airM[i] ? -Infinity : -Math.abs((dHwy[i] as number) - 0.4) * 2 - Math.min(dPark[i] as number, dPort[i] as number) * 0.3));
  if (truckHub) utilities.push({ kind: 'truckhub', at: truckHub, label: '货运场站' });
  const bus = pickOn((p, i) => (!city[i] || water[i] || code[i] !== L.R2 || (dIn[i] as number) > 0.9 || (dIn[i] as number) < 0.3 ? -Infinity : -Math.abs(dist(p, center) - R2 * 0.75) + r() * 0.3));
  if (bus) utilities.push({ kind: 'busdepot', at: bus, label: '公交场站' });
  for (const u of utilities) {
    const v = u.kind === 'busdepot' || u.kind === 'truckhub' ? L.S4 : u.kind === 'substation' || u.kind === 'waterworks' ? L.U1 : L.U2;
    const rad = u.kind === 'substation' ? 0.26 : u.kind === 'busdepot' ? 0.28 : u.kind === 'waste' ? 0.4 : 0.62;
    const rr = Math.ceil(rad / CELL) + 1;
    const ci = idx(u.at);
    if (ci < 0) continue;
    for (let dy = -rr; dy <= rr; dy++)
      for (let dx = -rr; dx <= rr; dx++) {
        const x = (ci % w) + dx;
        const y = Math.floor(ci / w) + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (water[i] || portM[i] || airM[i] || parkM[i] || dist(at(i), u.at) > rad) continue;
        code[i] = v;
      }
  }
  rules.push('公用设施：自来水厂在河的上游，污水处理厂在下游靠海、离居住远，变电站在城区边上；工业、物流和居住之间留防护绿带');

  // —— 7）防护：工业、物流、环境设施和居住之间的绿带；机场噪声区 ——
  const heavy = new Uint8Array(N);
  const light = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = code[i] as number;
    if (c === L.M2 || c === L.W2 || c === L.U2 || c === L.PORT) heavy[i] = 1;
    else if (c === L.M1 || c === L.W1 || c === L.S4) light[i] = 1;
  }
  const dHeavy = distField(heavy, w, h, CELL);
  const dLight = distField(light, w, h, CELL);
  for (let i = 0; i < N; i++) {
    const c = code[i] as number;
    if (c !== L.R1 && c !== L.R2 && c !== L.A33 && c !== L.A5 && c !== L.A31) continue;
    if ((dHeavy[i] as number) < 0.42 || (dLight[i] as number) < 0.22) code[i] = L.G2;
  }
  let noiseMoved = 0;
  for (let i = 0; i < N; i++) {
    const c = code[i] as number;
    if (c !== L.R1 && c !== L.R2 && c !== L.A33 && c !== L.A5 && c !== L.A31) continue;
    const lv = noiseLevel(at(i));
    if (!lv) continue;
    code[i] = city[i] ? (lv >= 75 ? L.G2 : L.M1) : L.RURAL;
    noiseMoved++;
  }
  rules.push(`机场噪声区（跑道两头沿中线外延 ${noise.ext70} 公里的范围）里不放居住、学校和医院${noiseMoved ? '' : '（这个区域的噪声区不压城区）'}；铁路、快速路两侧留防护绿地`);
  rules.push('站城一体（TOD）：客运站周围 300–500 米是核心区（商务、商业），500–800 米是影响区（高密度居住、商业）；主轴从市中心通向客运站或滨水，两侧是商业');
  rules.push('小街按 150–250 米的间距铺（不超过 300 米），居住、商业区的路网密度往每平方公里 8 公里靠');

  // —— 8）片区 ——
  const districts: District[] = [];
  const area = new Map<string, { n: number; sx: number; sy: number; kind: DistrictKind }>();
  const addTo = (name: string, kind: DistrictKind, p: Km) => {
    const a = area.get(name) ?? { n: 0, sx: 0, sy: 0, kind };
    a.n++;
    a.sx += p.x;
    a.sy += p.y;
    area.set(name, a);
  };
  for (let i = 0; i < N; i++) {
    const c = code[i] as number;
    if (!c || c === L.WATER || c === L.RURAL) continue;
    const p = at(i);
    if (city[i]) {
      let best = centers[0] as (typeof centers)[number];
      let bd = Infinity;
      for (const o of centers) {
        const d = dist(p, o.at) * (o.main ? 0.85 : 1);
        if (d < bd) [bd, best] = [d, o];
      }
      if (station && dist(p, station) < R2 * 0.1) addTo('站前片区', 'station', p);
      else addTo(best.main ? '中心城区' : best.name, best.main ? 'center' : 'cluster', p);
    } else if (c === L.PORT || (dPort[i] as number) < 3.4) addTo('港城片区', 'port', p);
    else if (c === L.AIRPORT || (dAir[i] as number) < 2.8) addTo('临空经济区', 'airport', p);
    else if ((dPark[i] as number) < 2.6) addTo('物流园片区', 'park', p);
  }
  for (const [name, a] of area) districts.push({ name, kind: a.kind, at: { x: a.sx / a.n, y: a.sy / a.n }, area: a.n * CELL * CELL });
  districts.sort((a, b) => b.area - a.area);

  // —— 9）货运通道和限行 ——
  const corridors: Corridor[] = [];
  const adj = new Map<string, { to: string; len: number; e: number }[]>();
  plan.edges.forEach((e, k) => {
    if (e.cls !== 'arterial') return;
    const pts = edgePts(e);
    let len = 0;
    for (let j = 1; j < pts.length; j++) len += dist(pts[j - 1] as Km, pts[j] as Km);
    for (const [a, b] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as const) {
      const l = adj.get(a) ?? [];
      l.push({ to: b, len, e: k });
      adj.set(a, l);
    }
  });
  // 门店的配送通道：门店最近的城区路口 → 最近的立交（最短路）
  const storeNode = [...adj.keys()].filter((id) => !/^R\d|^BE/.test(id)).reduce((best, id) => (dist(node(id), plan.store) < dist(node(best), plan.store) ? id : best), [...adj.keys()].filter((id) => !/^R\d|^BE/.test(id))[0] ?? '');
  const delivery = new Set<number>();
  if (storeNode) {
    const D = new Map<string, number>([[storeNode, 0]]);
    const prev = new Map<string, { from: string; e: number }>();
    const open = [storeNode];
    while (open.length) {
      open.sort((a, b) => (D.get(a) as number) - (D.get(b) as number));
      const u = open.shift() as string;
      for (const n of adj.get(u) ?? []) {
        const nd = (D.get(u) as number) + n.len;
        if (nd < (D.get(n.to) ?? Infinity)) {
          D.set(n.to, nd);
          prev.set(n.to, { from: u, e: n.e });
          open.push(n.to);
        }
      }
    }
    const ic = plan.ics.filter((id) => D.has(id)).sort((a, b) => (D.get(a) as number) - (D.get(b) as number))[0];
    for (let cur = ic; cur && cur !== storeNode; ) {
      const pv = prev.get(cur);
      if (!pv) break;
      delivery.add(pv.e);
      cur = pv.from;
    }
  }
  plan.edges.forEach((e, k) => {
    if (e.cls === 'highway' || e.cls === 'ring') corridors.push({ a: e.a, b: e.b, kind: 'freight' });
    else if (e.cls === 'arterial') {
      if (delivery.has(k)) {
        corridors.push({ a: e.a, b: e.b, kind: 'delivery' });
        return;
      }
      const pts = edgePts(e);
      const mid = pts[Math.floor(pts.length / 2)] as Km;
      const m2 = pts.length % 2 ? mid : { x: (mid.x + (pts[pts.length / 2 - 1] as Km).x) / 2, y: (mid.y + (pts[pts.length / 2 - 1] as Km).y) / 2 };
      const c = LAND[landAt({ grid: { x0, y0, cell: CELL, w, h, code } } as LandUsePlan, m2)]?.group;
      if (/^R\d/.test(e.a) || /^R\d/.test(e.b) || c === 'M' || c === 'W' || c === 'S' || c === 'U') corridors.push({ a: e.a, b: e.b, kind: 'freight' });
      else corridors.push({ a: e.a, b: e.b, kind: 'restricted' });
    }
  });
  rules.push('货运：高速、绕城快速路、立交进城的路和工业、物流区里的干道是货运通道；门店的配送通道（门店到最近的立交）全天通行；穿过居住、商业区的其余干道白天（6:00–23:00）限行货车（通用的核心区限行做法）');

  // —— 10）地标（随机区域每次不一样，默认区域固定）——
  const pickB2 = pickOn((p, i) => (code[i] === L.B2 && city[i] ? -dist(p, center) + r() * 0.3 : -Infinity));
  if (pickB2) landmarks.push({ kind: 'tower', at: pickB2, label: '电视塔' });
  const civicAt = civic;
  landmarks.push({ kind: 'civic', at: civicAt, label: '市民中心' });
  landmarks.push({ kind: 'museum', at: culture, label: '文化中心' });
  for (const hp of hospitals.slice(0, 2)) landmarks.push({ kind: 'hospital', at: hp, label: '医院' });
  if (uni) landmarks.push({ kind: 'campus', at: uni, label: '大学' });
  const sub1 = centers.find((c) => !c.main);
  const extra: LandmarkKind[] = ['stadium', 'wheel', 'expo', 'lighthouse'];
  for (const kind of extra) {
    if (plan.spec.mode !== 'default' && r() < 0.25) continue;
    if (kind === 'stadium' && sub1) landmarks.push({ kind, at: { x: sub1.at.x + (sub1.at.x - center.x) * 0.12, y: sub1.at.y + (sub1.at.y - center.y) * 0.12 }, label: '体育中心' });
    if (kind === 'wheel') {
      const q = pickOn((p, i) => (code[i] === L.G1 && city[i] && (dSea[i] as number) < 0.5 ? -dist(p, center) + r() : -Infinity));
      if (q) landmarks.push({ kind, at: q, label: '摩天轮' });
    }
    if (kind === 'expo') {
      const q = pickOn((p, i) => (code[i] === L.B1 && !city[i] && (dAir[i] as number) < 2.8 ? -Math.abs((dAir[i] as number) - 2.3) + r() * 0.2 : -Infinity));
      if (q) landmarks.push({ kind, at: q, label: '会展中心' });
    }
    if (kind === 'lighthouse') {
      // 离港口不远、伸进海里最多的一段海岸
      const q = pickOn((p, i) => (water[i] || (dSea[i] as number) > 0.25 || portM[i] || (dPort[i] as number) < 1.5 ? -Infinity : -(dPort[i] as number) * 0.08 + (p.x * seaDir.x + p.y * seaDir.y) * 0.5 + r() * 0.2));
      if (q) landmarks.push({ kind, at: q, label: '灯塔' });
    }
  }

  // —— 11）用地结构 ——
  const sums = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < N; i++) {
    const cl = LAND[code[i] as number] as LandClass;
    if (cl.group === 'E' || cl.group === 'H' || !code[i]) continue;
    if (!city[i] && cl.group !== 'W' && cl.group !== 'M' && cl.group !== 'S' && cl.group !== 'U') continue;
    if (parkM[i]) continue;
    sums.set(cl.group, (sums.get(cl.group) ?? 0) + CELL * CELL);
    total += CELL * CELL;
  }
  // 道路用地：栅格里不画路，按干道长度 × 红线宽度（约 45 米）加支路（城区面积的一成多）估算
  let artKm = 0;
  for (const e of plan.edges) {
    if (e.cls !== 'arterial') continue;
    const pts = edgePts(e);
    for (let j = 1; j < pts.length; j++) artKm += dist(pts[j - 1] as Km, pts[j] as Km);
  }
  let cityKm2 = 0;
  for (let i = 0; i < N; i++) if (city[i] && !water[i]) cityKm2 += CELL * CELL;
  const roadKm2 = artKm * 0.045 + cityKm2 * 0.12;
  sums.set('S', (sums.get('S') ?? 0) + roadKm2);
  total += roadKm2;
  const stats = ['R', 'A', 'B', 'M', 'W', 'S', 'U', 'G'].map((g) => ({ group: g, label: GROUP_LABEL[g] as string, km2: sums.get(g) ?? 0, share: total ? (sums.get(g) ?? 0) / total : 0 }));
  rules.push(`用地结构按 GB 50137-2011 的城市建设用地分类统计（道路用地按干道长度和红线宽度估算，干道 ${artKm.toFixed(0)} 公里）`);

  return { grid: { x0, y0, cell: CELL, w, h, code }, centers, districts, lifeCircles, noise, corridors, landmarks, utilities, stats, rules };
}
