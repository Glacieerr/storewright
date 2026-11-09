import { buildGraph, SPEED, type Graph } from '../region/network';
import type { Km, RoadClass, RoadEdge } from '../region/region';

/**
 * 网络规划用的道路距离：区域的道路图（和仿真同一张），再把门店、候选仓接到最近的路口上（接入段按本地道路算），
 * 区域外的镇沿高速口往外接（按高速算）。距离按自由流时间最短的路径，同时记下里程和沿途的折线（画路线用）。
 */
export interface NetPoint {
  id: string;
  km: Km;
  /** 接到道路图的哪个节点、接入段的真实里程和道路等级 */
  node: string;
  linkKm: number;
  linkCls: RoadClass;
}

export interface Leg {
  km: number;
  hours: number;
  /** 沙盘上的折线（公里坐标），从起点到终点 */
  pts: Km[];
}

/** 接入段的弯曲系数：本地道路 1.3，高速 1.06（和区域道路的系数一致） */
const LINK_CIRCUITY: Record<RoadClass, number> = { highway: 1.06, ring: 1.0, arterial: 1.12, local: 1.3 };

/** 把一个点接到最近的节点（可以限定候选节点）；离节点很近的按 0.4 公里起算 */
export function attach(g: Graph, id: string, km: Km, opts: { nodes?: readonly string[]; node?: string; cls?: RoadClass; linkKm?: number } = {}): NetPoint {
  let node = opts.node ?? '';
  if (!node) {
    let best = Infinity;
    for (const n of opts.nodes ?? [...g.nodes.keys()]) {
      const p = g.nodes.get(n);
      if (!p) continue;
      const d = Math.hypot(p.x - km.x, p.y - km.y);
      if (d < best) {
        best = d;
        node = n;
      }
    }
  }
  const p = g.nodes.get(node) as Km;
  const cls = opts.cls ?? 'local';
  const linkKm = opts.linkKm ?? Math.max(0.4, Math.hypot(p.x - km.x, p.y - km.y) * LINK_CIRCUITY[cls]);
  return { id, km, node, linkKm, linkCls: cls };
}

/** 从一个节点出发到所有节点的最短时间树 */
interface Tree {
  hours: Map<string, number>;
  km: Map<string, number>;
  prev: Map<string, { e: RoadEdge; from: string }>;
}

function tree(g: Graph, src: string): Tree {
  const hours = new Map<string, number>([[src, 0]]);
  const km = new Map<string, number>([[src, 0]]);
  const prev = new Map<string, { e: RoadEdge; from: string }>();
  const done = new Set<string>();
  // 节点只有几十个：每次挑最小的就够快
  for (;;) {
    let u = '';
    let du = Infinity;
    for (const [n, h] of hours) if (!done.has(n) && h < du) [u, du] = [n, h];
    if (!u) break;
    done.add(u);
    for (const { e, to } of g.adj.get(u) ?? []) {
      const nh = du + e.km / SPEED[e.cls];
      if (nh < (hours.get(to) ?? Infinity) - 1e-12) {
        hours.set(to, nh);
        km.set(to, (km.get(u) as number) + e.km);
        prev.set(to, { e, from: u });
      }
    }
  }
  return { hours, km, prev };
}

/** 一组点两两之间的距离（里程、小时、折线） */
export class Distances {
  readonly g: Graph;
  private trees = new Map<string, Tree>();
  private cache = new Map<string, Leg>();

  constructor(g: Graph = buildGraph()) {
    this.g = g;
  }

  private treeOf(node: string): Tree {
    let t = this.trees.get(node);
    if (!t) {
      t = tree(this.g, node);
      this.trees.set(node, t);
    }
    return t;
  }

  /** 节点之间的折线（沿最短时间的路径） */
  private nodePath(a: string, b: string): Km[] {
    const t = this.treeOf(a);
    const chain: { e: RoadEdge; from: string }[] = [];
    for (let v = b; v !== a; ) {
      const p = t.prev.get(v);
      if (!p) return [this.g.nodes.get(a) as Km, this.g.nodes.get(b) as Km];
      chain.push(p);
      v = p.from;
    }
    chain.reverse();
    const pts: Km[] = [this.g.nodes.get(a) as Km];
    for (const { e, from } of chain) pts.push(...(e.a === from ? e.pts : [...e.pts].reverse()).slice(1));
    return pts;
  }

  leg(p: NetPoint, q: NetPoint): Leg {
    if (p.id === q.id) return { km: 0, hours: 0, pts: [p.km] };
    const key = `${p.id}>${q.id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const v = (cls: RoadClass) => SPEED[cls];
    let leg: Leg;
    if (p.node === q.node) {
      // 接在同一个路口上：两段接入路（或者两点之间直接走本地道路，取短的）
      const direct = Math.max(0.4, Math.hypot(p.km.x - q.km.x, p.km.y - q.km.y) * LINK_CIRCUITY.local);
      const via = p.linkKm + q.linkKm;
      leg = direct < via ? { km: direct, hours: direct / v('local'), pts: [p.km, q.km] } : { km: via, hours: p.linkKm / v(p.linkCls) + q.linkKm / v(q.linkCls), pts: [p.km, this.g.nodes.get(p.node) as Km, q.km] };
    } else {
      const t = this.treeOf(p.node);
      const h = t.hours.get(q.node);
      const k = t.km.get(q.node);
      if (h === undefined || k === undefined) throw new Error(`no road ${p.id} → ${q.id}`);
      leg = { km: p.linkKm + k + q.linkKm, hours: p.linkKm / v(p.linkCls) + h + q.linkKm / v(q.linkCls), pts: [p.km, ...this.nodePath(p.node, q.node), q.km] };
    }
    this.cache.set(key, leg);
    return leg;
  }
}
