import type { Dimensions, TempZone } from '@storewright/domain';
import type { RunConfig, StagingRackConfig, StoreConfig } from './schema';

/**
 * 门店运行时模型：由门店配置推导出的行走网络、货位和暂存格位。
 *
 * 行走网络的构建方式：
 * 1. 每条可行走线段（货架通道、走廊）上的节点 = 线段端点 + 货架段中心点 + 落在该线段上的其他锚点
 *    （其他线段的端点、特殊点、楼层连接点）；
 * 2. 同一线段上的节点按位置排序，相邻节点之间连边，边长为欧氏距离；
 * 3. 楼层连接点（电梯、楼梯、扶梯）跨楼层连边，边长按单程耗时折算为等效步行距离。
 */

export interface GraphNode {
  id: number;
  floorId: string;
  x: number;
  y: number;
}

export interface GraphEdge {
  to: number;
  /** 等效步行距离（米） */
  w: number;
}

export type Side = 'L' | 'R' | 'W';

export interface Location {
  id: string;
  runId: string;
  floorId: string;
  nodeId: number;
  bay: number;
  side: Side;
  level: number;
  tempZone: TempZone;
  x: number;
  y: number;
  runSequence: number;
}

export interface StagingSlot {
  code: string;
  rackId: string;
  zoneCode: string;
  tempZone: TempZone;
  purpose: StagingRackConfig['purpose'];
  area: StagingRackConfig['area'];
  capacityTotes: number;
  /** 从暂存点到该格位的步行距离（米） */
  distanceM: number;
}

/** 楼层连接的等效步行速度（米/秒），用于把耗时折算为距离 */
export const CONNECTOR_EQUIV_SPEED = 1.0;
const ON_SEGMENT_TOLERANCE_M = 0.05;

export function formatSlotCode(pattern: string, parts: Record<'zone' | 'rack' | 'level' | 'slot', string | number>, pad: number): string {
  return pattern.replace(/\{(zone|rack|level|slot)\}/g, (_, key: 'zone' | 'rack' | 'level' | 'slot') => {
    const v = parts[key];
    return typeof v === 'number' ? String(v).padStart(pad, '0') : v;
  });
}

/** 商品是否能放进框（尺寸任意旋转） */
export function fitsInside(item: Dimensions, container: Dimensions): boolean {
  const a = [item.l, item.w, item.h].sort((p, q) => p - q);
  const b = [container.l, container.w, container.h].sort((p, q) => p - q);
  return a.every((v, i) => v <= (b[i] ?? 0));
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((k[p] as number) <= key) break;
      k[i] = k[p] as number;
      v[i] = v[p] as number;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] | undefined {
    const k = this.keys;
    const v = this.vals;
    if (k.length === 0) return undefined;
    const topK = k[0] as number;
    const topV = v[0] as number;
    const lastK = k.pop() as number;
    const lastV = v.pop() as number;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = lastK;
        if (l < n && (k[l] as number) < mk) {
          m = l;
          mk = k[l] as number;
        }
        if (r < n && (k[r] as number) < mk) {
          m = r;
        }
        if (m === i) break;
        k[i] = k[m] as number;
        v[i] = v[m] as number;
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return [topK, topV];
  }
}

export class StoreModel {
  readonly nodes: GraphNode[] = [];
  readonly adjacency: GraphEdge[][] = [];
  readonly locations = new Map<string, Location>();
  readonly locationsByRun = new Map<string, Location[]>();
  readonly runs = new Map<string, RunConfig>();
  readonly stagingSlots: StagingSlot[] = [];
  readonly cartDepotNode: number;
  readonly stagingNode: number;
  readonly handoffNode: number;
  readonly backroomNode: number;
  /** 楼层连接两端的节点（连接 id → [a, b]）；扶梯不进入行走网络，见下文 */
  readonly connectorNodes = new Map<string, [number, number]>();
  readonly toteDims: Dimensions;
  readonly toteCapacityL: number;

  private readonly nodeKeys = new Map<string, number>();
  private readonly distCache = new Map<number, Float64Array>();
  private readonly predCache = new Map<number, Int32Array>();
  private readonly runIdsByCategory = new Map<string, string[]>();

  constructor(readonly config: StoreConfig) {
    const { layout } = config;
    for (const run of layout.runs) this.runs.set(run.id, run);

    // 1. 收集锚点
    const anchors: Array<{ floorId: string; x: number; y: number }> = [];
    for (const r of layout.runs) anchors.push({ floorId: r.floorId, ...r.start }, { floorId: r.floorId, ...r.end });
    for (const c of layout.corridors) anchors.push({ floorId: c.floorId, ...c.start }, { floorId: c.floorId, ...c.end });
    for (const p of Object.values(layout.points)) anchors.push(p);
    for (const c of layout.connectors) anchors.push(c.a, c.b);

    // 2. 每条线段上的节点
    const bayNodes = new Map<string, number[]>();
    const segments: Array<{ floorId: string; start: { x: number; y: number }; end: { x: number; y: number }; run?: RunConfig }> = [
      ...layout.runs.map((run) => ({ floorId: run.floorId, start: run.start, end: run.end, run })),
      ...layout.corridors.map((c) => ({ floorId: c.floorId, start: c.start, end: c.end })),
    ];
    for (const seg of segments) {
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const ux = dx / len;
      const uy = dy / len;
      const onSeg: Array<{ t: number; id: number }> = [];
      const add = (t: number): number => {
        const id = this.nodeAt(seg.floorId, seg.start.x + ux * t, seg.start.y + uy * t);
        onSeg.push({ t, id });
        return id;
      };
      add(0);
      add(len);
      if (seg.run) {
        const margin = Math.min(seg.run.endMarginM, len / 4);
        const bayLen = (len - 2 * margin) / seg.run.bays;
        const ids: number[] = [];
        for (let b = 0; b < seg.run.bays; b++) ids.push(add(margin + (b + 0.5) * bayLen));
        bayNodes.set(seg.run.id, ids);
      }
      for (const a of anchors) {
        if (a.floorId !== seg.floorId) continue;
        const px = a.x - seg.start.x;
        const py = a.y - seg.start.y;
        const t = px * ux + py * uy;
        if (t < -ON_SEGMENT_TOLERANCE_M || t > len + ON_SEGMENT_TOLERANCE_M) continue;
        const perp = Math.abs(px * uy - py * ux);
        if (perp > ON_SEGMENT_TOLERANCE_M) continue;
        add(Math.min(len, Math.max(0, t)));
      }
      onSeg.sort((p, q) => p.t - q.t);
      for (let i = 1; i < onSeg.length; i++) {
        const a = onSeg[i - 1] as { t: number; id: number };
        const b = onSeg[i] as { t: number; id: number };
        if (a.id !== b.id) this.connect(a.id, b.id, b.t - a.t);
      }
    }

    // 3. 楼层连接。员工推着拣货车，不能乘自动扶梯，所以扶梯不进入行走网络；
    //    两端节点仍然保留（顾客乘扶梯由画面层处理）
    for (const c of layout.connectors) {
      const a = this.nodeAt(c.a.floorId, c.a.x, c.a.y);
      const b = this.nodeAt(c.b.floorId, c.b.x, c.b.y);
      this.connectorNodes.set(c.id, [a, b]);
      if (c.kind !== 'ESCALATOR') this.connect(a, b, c.traversalSec * CONNECTOR_EQUIV_SPEED);
    }

    // 4. 货位
    for (const run of layout.runs) {
      const ids = bayNodes.get(run.id) ?? [];
      const sides: Side[] = run.sides === 2 ? ['L', 'R'] : ['W'];
      const list: Location[] = [];
      ids.forEach((nodeId, bay) => {
        const node = this.nodes[nodeId] as GraphNode;
        for (const side of sides) {
          for (let level = 1; level <= run.levels; level++) {
            const loc: Location = {
              id: `${run.id}-${side}${String(bay + 1).padStart(2, '0')}-${level}`,
              runId: run.id,
              floorId: run.floorId,
              nodeId,
              bay,
              side,
              level,
              tempZone: run.tempZone,
              x: node.x,
              y: node.y,
              runSequence: run.sequence,
            };
            this.locations.set(loc.id, loc);
            list.push(loc);
          }
        }
      });
      this.locationsByRun.set(run.id, list);
      for (const cat of run.categoryIds) {
        const arr = this.runIdsByCategory.get(cat) ?? [];
        arr.push(run.id);
        this.runIdsByCategory.set(cat, arr);
      }
    }

    // 5. 特殊点
    const p = layout.points;
    this.cartDepotNode = this.nodeAt(p.cartDepot.floorId, p.cartDepot.x, p.cartDepot.y);
    this.stagingNode = this.nodeAt(p.staging.floorId, p.staging.x, p.staging.y);
    this.handoffNode = this.nodeAt(p.handoff.floorId, p.handoff.x, p.handoff.y);
    this.backroomNode = this.nodeAt(p.backroom.floorId, p.backroom.x, p.backroom.y);

    // 6. 暂存格位
    for (const rack of config.staging.racks) {
      for (let level = 1; level <= rack.levels; level++) {
        for (let slot = 1; slot <= rack.slotsPerLevel; slot++) {
          this.stagingSlots.push({
            code: formatSlotCode(config.staging.codePattern, { zone: rack.zoneCode, rack: rack.rackNo, level, slot }, config.staging.pad),
            rackId: rack.id,
            zoneCode: rack.zoneCode,
            tempZone: rack.tempZone,
            purpose: rack.purpose,
            area: rack.area,
            capacityTotes: rack.totesPerSlot,
            distanceM: rack.distanceFromStagingM + (slot - 1) * 0.6,
          });
        }
      }
    }

    const tote = config.equipment.tote;
    this.toteDims = tote.innerCm;
    this.toteCapacityL = (tote.innerCm.l * tote.innerCm.w * tote.innerCm.h) / 1000;
  }

  private nodeAt(floorId: string, x: number, y: number): number {
    const key = `${floorId}:${x.toFixed(2)}:${y.toFixed(2)}`;
    const existing = this.nodeKeys.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ id, floorId, x, y });
    this.adjacency.push([]);
    this.nodeKeys.set(key, id);
    return id;
  }

  private connect(a: number, b: number, w: number): void {
    const la = this.adjacency[a] as GraphEdge[];
    const lb = this.adjacency[b] as GraphEdge[];
    if (la.some((e) => e.to === b)) return;
    la.push({ to: b, w });
    lb.push({ to: a, w });
  }

  private dijkstra(source: number): void {
    const n = this.nodes.length;
    const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    const pred = new Int32Array(n).fill(-1);
    dist[source] = 0;
    const heap = new MinHeap();
    heap.push(0, source);
    for (;;) {
      const top = heap.pop();
      if (!top) break;
      const [d, u] = top;
      if (d > (dist[u] as number)) continue;
      for (const e of this.adjacency[u] as GraphEdge[]) {
        const nd = d + e.w;
        if (nd < (dist[e.to] as number)) {
          dist[e.to] = nd;
          pred[e.to] = u;
          heap.push(nd, e.to);
        }
      }
    }
    this.distCache.set(source, dist);
    this.predCache.set(source, pred);
  }

  /** 两节点之间的最短步行距离（米） */
  distance(a: number, b: number): number {
    if (a === b) return 0;
    let d = this.distCache.get(a);
    if (!d) {
      const reverse = this.distCache.get(b);
      if (reverse) return reverse[a] as number;
      this.dijkstra(a);
      d = this.distCache.get(a) as Float64Array;
    }
    return d[b] as number;
  }

  /** 最短路径上的节点序列（含起点和终点），供模拟器绘制路线 */
  path(a: number, b: number): number[] {
    if (!this.predCache.has(a)) this.dijkstra(a);
    const pred = this.predCache.get(a) as Int32Array;
    const out: number[] = [];
    let cur = b;
    while (cur !== -1 && cur !== a) {
      out.push(cur);
      cur = pred[cur] as number;
    }
    if (cur !== a) return [];
    out.push(a);
    return out.reverse();
  }

  runIdsForCategory(categoryId: string): readonly string[] {
    return this.runIdsByCategory.get(categoryId) ?? [];
  }

  location(id: string): Location {
    const loc = this.locations.get(id);
    if (!loc) throw new Error(`Unknown location ${id}`);
    return loc;
  }

  /** 从某节点不可达的货位（用于配置校验） */
  unreachableLocations(from = this.stagingNode): string[] {
    const out: string[] = [];
    for (const loc of this.locations.values()) {
      if (!Number.isFinite(this.distance(from, loc.nodeId))) out.push(loc.id);
    }
    return out;
  }
}
