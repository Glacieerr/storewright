import { applyRegionPlan, BASE_EDGES, NODES, type Km, type RoadClass, type RoadEdge } from './region';
import { DEFAULT_REGION, generateRegion, regionSpecText, type RegionPlan, type RegionSpec } from './regionGen';

/**
 * 门店和道路图：区域里只有一家综合型大店（生鲜、食品、日用、饮料、冷冻、烘焙都卖），
 * 规模 2.5 = StoreX 报告里那家店的 2.5 倍，每天约 7.7 万件。店的位置由区域生成器选（一个街区里面），
 * 用一段本地道路接到最近的干道路口；店后面一排 4 个收货口，配送中心的车和长途直送的车共用。
 * 路线用道路图上的最短时间路径。
 */
export interface StoreSite {
  id: number;
  key: string;
  name: string;
  km: Km;
  /** 规模（销量相对 StoreX 那家店） */
  size: number;
  /** 接入道路图的节点 */
  node: string;
  /** 三维里画成细致的门店模型（区域里唯一的门店） */
  flagship: boolean;
  /** 收货区（店房北面；三维动画里车开到这里倒车靠上收货口） */
  dock: Km;
  /** 收货口个数 */
  docks: number;
}

/** 门店接入的候选节点：城区干道的路口（不含绕城快速路的立交和两头） */
const attachNodes = (): string[] => [...new Set(BASE_EDGES.filter((e) => e.cls === 'arterial').flatMap((e) => [e.a, e.b]))].filter((n) => !/^(R\d+|BE\d)$/.test(n));

function site(id: number, name: string, x: number, y: number, size: number, docks: number): StoreSite {
  const km = { x, y };
  let node = '';
  let best = Infinity;
  for (const n of attachNodes()) {
    const p = NODES[n] as Km;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best) {
      best = d;
      node = n;
    }
  }
  // 店房约 150 × 105 米，收货区在店房北面
  return { id, key: `S${String(id + 1).padStart(2, '0')}`, name, km, size, node, flagship: true, dock: { x: x - 0.2, y: y + 0.62 }, docks };
}

/** 当前的区域（默认区域：港口、机场、物流园在原来的位置，城区、道路、铁路和门店按编号 1 生成） */
let PLAN: RegionPlan = generateRegion(DEFAULT_REGION);
applyRegionPlan(PLAN);
export const currentRegion = (): RegionPlan => PLAN;

export const STORES: StoreSite[] = [site(0, '综合店', PLAN.store.x, PLAN.store.y, 2.5, 4)];
/** 区域里唯一的门店 */
export const STORE: StoreSite = STORES[0] as StoreSite;

/**
 * 换区域（默认、随机、自定义）：海岸、河、城区、道路、铁路、设施的位置全部换掉，门店搬到新区域里选好的位置
 * （STORE 对象原地改，引用它的地方不用换）。换完以后新建的道路图、路线缓存和三维场景都按新区域；同一个规格重复调用不做事。
 */
export function setRegion(spec: RegionSpec): RegionPlan {
  if (regionSpecText(spec) === regionSpecText(PLAN.spec)) return PLAN;
  PLAN = generateRegion(spec);
  applyRegionPlan(PLAN);
  Object.assign(STORE, site(0, STORE.name, PLAN.store.x, PLAN.store.y, STORE.size, STORE.docks));
  return PLAN;
}

/** 全部门店的规模之和（相当于多少家 StoreX 门店） */
export const TOTAL_SIZE = STORES.reduce((s, x) => s + x.size, 0);

// —— 道路图 ——

export interface Graph {
  nodes: Map<string, Km>;
  edges: RoadEdge[];
  adj: Map<string, { e: RoadEdge; to: string }[]>;
}

/** 卡车在各级道路上的自由流速度（公里 / 小时） */
export const SPEED: Record<RoadClass, number> = { highway: 82, ring: 72, arterial: 38, local: 28 };

export function buildGraph(closed: ReadonlySet<string> = new Set()): Graph {
  const nodes = new Map<string, Km>(Object.entries(NODES));
  const edges: RoadEdge[] = [...BASE_EDGES];
  for (const s of STORES) {
    nodes.set(s.key, s.km);
    const p = NODES[s.node] as Km;
    const d = Math.hypot(p.x - s.km.x, p.y - s.km.y);
    edges.push({ a: s.node, b: s.key, cls: 'local', km: Math.max(0.4, d * 1.3), pts: [p, s.km] });
  }
  const adj = new Map<string, { e: RoadEdge; to: string }[]>();
  for (const e of edges) {
    if (closed.has(edgeKey(e))) continue;
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ] as const) {
      const list = adj.get(from) ?? [];
      list.push({ e, to });
      adj.set(from, list);
    }
  }
  return { nodes, edges, adj };
}

export const edgeKey = (e: { a: string; b: string }): string => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`);

export interface PathInfo {
  km: number;
  /** 自由流行驶小时 */
  hours: number;
  /** 其中走市区道路（干道、本地道路）的小时：高峰时会变慢 */
  urbanHours: number;
  /** 沙盘上的折线（公里坐标），从起点到终点 */
  pts: Km[];
  /** 经过的道路图节点（含起点和终点）：三维场景按它把车放到车道上 */
  nodes: string[];
}

/** 最短时间路径（Dijkstra，按自由流时间） */
export function shortestPath(g: Graph, from: string, to: string): PathInfo {
  if (from === to) return { km: 0, hours: 0, urbanHours: 0, pts: [g.nodes.get(from) as Km], nodes: [from] };
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { e: RoadEdge; from: string }>();
  const done = new Set<string>();
  const queue: [number, string][] = [[0, from]];
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, u] = queue.shift() as [number, string];
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const { e, to: v } of g.adj.get(u) ?? []) {
      const nd = d + e.km / SPEED[e.cls];
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, { e, from: u });
        queue.push([nd, v]);
      }
    }
  }
  if (!prev.has(to)) throw new Error(`no path ${from} → ${to}`);
  const chain: { e: RoadEdge; from: string }[] = [];
  for (let v = to; v !== from; ) {
    const p = prev.get(v) as { e: RoadEdge; from: string };
    chain.push(p);
    v = p.from;
  }
  chain.reverse();
  let km = 0;
  let hours = 0;
  let urbanHours = 0;
  const pts: Km[] = [];
  for (const { e, from: u } of chain) {
    km += e.km;
    const h = e.km / SPEED[e.cls];
    hours += h;
    if (e.cls === 'arterial' || e.cls === 'local') urbanHours += h;
    const seg = e.a === u ? e.pts : [...e.pts].reverse();
    for (const p of pts.length ? seg.slice(1) : seg) pts.push(p);
  }
  return { km, hours, urbanHours, pts, nodes: [...chain.map((c) => c.from), to] };
}

/**
 * 时段对市区道路的影响：早晚高峰慢 50–60%，夜里快 15%（高速和快速路不受影响）。
 */
export function congestion(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h < 9.5) return 1.6;
  if (h >= 16 && h < 19) return 1.5;
  if (h >= 22 || h < 5) return 0.85;
  return 1.1;
}

/** 某个时刻出发的实际行驶小时 */
export function travelHours(p: PathInfo, departHour: number): number {
  return p.hours - p.urbanHours + p.urbanHours * congestion(departHour + (p.hours - p.urbanHours) * 0.5);
}

/** 物流园进城的主路：配送中心到门店的最短路上的第一段（「高速封闭」演练封的就是它） */
export function dcMainRoad(): string {
  const g = buildGraph();
  const p = shortestPath(g, 'DC', STORE.key);
  return edgeKey({ a: p.nodes[0] as string, b: p.nodes[1] as string });
}

/** 预先算好常用点之间的路径（配送中心、门店、港口、机场、面包房、出口） */
export class Routes {
  private cache = new Map<string, PathInfo>();
  constructor(readonly g: Graph) {}

  get(a: string, b: string): PathInfo {
    const k = `${a}>${b}`;
    let p = this.cache.get(k);
    if (!p) {
      p = shortestPath(this.g, a, b);
      this.cache.set(k, p);
    }
    return p;
  }
}
