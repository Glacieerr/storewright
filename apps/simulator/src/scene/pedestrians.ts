import { createRng, type Rng } from '@storewright/domain';
import { greenRemaining, signalLight, type SignalGroup, type SiteLayout } from './site';

/**
 * 路边行人：沿主路和支路的人行道走，在路口按行人信号过马路。
 * - 横过主路与支路车流同向放行（支路绿灯时走），横过支路与主路车流同向放行；
 * - 绿灯剩余时间不够走完时在路口等下一轮；
 * - 有人在人行横道上时，穿过这条横道的车道登记为障碍物，转弯车辆停下让行。
 * 背景效果，和背景车流一样按画面时间推进（不随仿真结果变化）。
 */

interface Node {
  x: number;
  z: number;
}

interface Edge {
  a: number;
  b: number;
  len: number;
  /** 人行横道：信号灯、放行的相位组、横道编号 */
  cross?: { signal: number; group: SignalGroup; id: number };
}

export interface Walker {
  id: number;
  path: number[];
  /** 正在走的边（path 下标） */
  leg: number;
  s: number;
  speed: number;
  /** 偏离中线的横向距离，避免排成一条线 */
  offset: number;
  waiting: boolean;
  x: number;
  z: number;
  heading: number;
  shirt: string;
  pants: string;
  scale: number;
  seed: number;
  /** 带着孩子 */
  kid: boolean;
}

/** 一条人行横道：位置与穿过它的车道（车道下标、车道坐标 d） */
export interface Crosswalk {
  id: number;
  x: number;
  z: number;
  lanes: Array<{ lane: number; d: number }>;
}

const SHIRTS = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#2c3e50', '#e8e3d9', '#d35400', '#16a085', '#7f8c8d', '#c39bd3', '#f4d03f'];
const PANTS = ['#2f3640', '#3b4250', '#4a3b2f', '#1e272e', '#6d6875', '#30475e'];

export class PedestrianSim {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  readonly crosswalks: Crosswalk[] = [];
  readonly walkers: Walker[] = [];
  /** 当前有人的人行横道 */
  occupied = new Set<number>();
  private adj: number[][] = [];
  private ends: number[] = [];
  private readonly rng: Rng;
  private seq = 0;
  private readonly rate: number;
  private readonly cap: number;

  constructor(
    readonly site: SiteLayout,
    seed: number,
  ) {
    this.rng = createRng(seed * 7727 + 31);
    this.rate = site.style === 'urban' ? 0.5 : site.style === 'suburban' ? 0.14 : 0.08;
    this.cap = site.style === 'urban' ? 60 : site.style === 'suburban' ? 24 : 14;
    this.build();
  }

  private node(x: number, z: number): number {
    const i = this.nodes.findIndex((n) => Math.abs(n.x - x) < 0.01 && Math.abs(n.z - z) < 0.01);
    if (i >= 0) return i;
    this.nodes.push({ x, z });
    return this.nodes.length - 1;
  }

  private edge(a: number, b: number, cross?: Edge['cross']): void {
    const na = this.nodes[a] as Node;
    const nb = this.nodes[b] as Node;
    this.edges.push({ a, b, len: Math.hypot(nb.x - na.x, nb.z - na.z), cross });
  }

  private build(): void {
    const s = this.site;
    const g = s.ground;
    const minX = g.x - g.w / 2 + 2;
    const maxX = g.x + g.w / 2 - 2;
    const minZ = g.z - g.d / 2 + 2;
    const maxZ = g.z + g.d / 2 - 2;
    const zN = s.roadTopZ + 1.2;
    const zS = s.roadBottomZ - 1.2;
    const xs = [...s.intersections].sort((a, b) => a.x - b.x);
    // 主路两侧人行道：端点 + 每个路口的两个角
    for (const z of [zN, zS]) {
      const stops = [minX, ...xs.flatMap((k) => [k.x - k.half - 1.2, k.x + k.half + 1.2]), maxX];
      const ids = stops.map((x) => this.node(x, z));
      this.ends.push(ids[0] as number, ids[ids.length - 1] as number);
      for (let i = 1; i < ids.length; i++) {
        // 同一路口两角之间是横过支路的人行横道
        const k = xs[Math.floor((i - 1) / 2)];
        const isCross = i % 2 === 0 && k !== undefined;
        if (isCross) {
          const id = this.crosswalks.length;
          this.edge(ids[i - 1] as number, ids[i] as number, { signal: k.signal, group: 0, id });
          this.crosswalks.push({ id, x: k.x, z, lanes: [] });
        } else this.edge(ids[i - 1] as number, ids[i] as number);
      }
    }
    // 支路两侧人行道与横过主路的人行横道
    for (const k of xs) {
      for (const x of [k.x - k.half - 1.2, k.x + k.half + 1.2]) {
        const n = this.node(x, zN);
        const sN = this.node(x, zS);
        const top = this.node(x, maxZ);
        const bottom = this.node(x, minZ);
        this.edge(n, top);
        this.edge(sN, bottom);
        this.ends.push(top, bottom);
        const id = this.crosswalks.length;
        this.edge(sN, n, { signal: k.signal, group: 1, id });
        this.crosswalks.push({ id, x, z: (zN + zS) / 2, lanes: [] });
      }
    }
    this.adj = this.nodes.map(() => []);
    this.edges.forEach((e, i) => {
      (this.adj[e.a] as number[]).push(i);
      (this.adj[e.b] as number[]).push(i);
    });
    // 穿过各人行横道的车道
    for (const c of this.crosswalks) {
      const e = this.edges.find((x) => x.cross?.id === c.id) as Edge;
      const a = this.nodes[e.a] as Node;
      const b = this.nodes[e.b] as Node;
      s.lanes.forEach((lane, li) => {
        const p = lane.pts[0];
        // 车道与横道正交：车道方向沿横道的法线
        const alongX = Math.abs(lane.dir.x) > 0.5;
        const crossesX = Math.abs(a.x - b.x) < 0.01;
        if (alongX !== crossesX) return;
        if (alongX) {
          const z = p.z;
          if (z < Math.min(a.z, b.z) || z > Math.max(a.z, b.z)) return;
          c.lanes.push({ lane: li, d: (a.x - p.x) * lane.dir.x });
        } else {
          const x = p.x;
          if (x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) return;
          c.lanes.push({ lane: li, d: (a.z - p.z) * lane.dir.z });
        }
      });
    }
  }

  /** 两个端点之间的最短路径（节点序列），走不到时返回 undefined */
  private route(from: number, to: number): number[] | undefined {
    const n = this.nodes.length;
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[from] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || (dist[i] as number) < (dist[u] as number))) u = i;
      if (u < 0 || !Number.isFinite(dist[u] as number)) break;
      if (u === to) break;
      done[u] = true;
      for (const ei of this.adj[u] as number[]) {
        const e = this.edges[ei] as Edge;
        const v = e.a === u ? e.b : e.a;
        // 过马路多算一点代价，行人不会无故来回横穿
        const w = e.len + (e.cross ? 25 : 0);
        if ((dist[u] as number) + w < (dist[v] as number)) {
          dist[v] = (dist[u] as number) + w;
          prev[v] = u;
        }
      }
    }
    if (!Number.isFinite(dist[to] as number)) return undefined;
    const path = [to];
    while (path[0] !== from) path.unshift(prev[path[0] as number] as number);
    return path;
  }

  private edgeBetween(a: number, b: number): Edge | undefined {
    return (this.adj[a] ?? []).map((i) => this.edges[i] as Edge).find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  }

  private spawn(): void {
    if (this.ends.length < 2) return;
    const from = this.rng.pick(this.ends);
    let to = this.rng.pick(this.ends);
    for (let k = 0; k < 4 && to === from; k++) to = this.rng.pick(this.ends);
    if (to === from) return;
    const path = this.route(from, to);
    if (!path || path.length < 2) return;
    const n = this.nodes[from] as Node;
    this.walkers.push({
      id: ++this.seq,
      path,
      leg: 0,
      s: 0,
      speed: this.rng.uniform(1.1, 1.55),
      offset: this.rng.uniform(-0.55, 0.55),
      waiting: false,
      x: n.x,
      z: n.z,
      heading: 0,
      shirt: this.rng.pick(SHIRTS),
      pants: this.rng.pick(PANTS),
      scale: this.rng.uniform(0.92, 1.08),
      seed: this.rng.uniform(0, 100),
      kid: this.rng.chance(0.12),
    });
  }

  /** 推进 dt 秒；time 为信号灯时钟；busy 为人流强度（0…1，夜间低） */
  step(dt: number, time: number, busy: number): void {
    if (dt <= 0) return;
    const rate = this.rate * Math.max(0.05, busy);
    if (this.walkers.length < this.cap && this.rng.next() < 1 - Math.exp(-rate * dt)) this.spawn();
    this.occupied.clear();
    for (let i = 0; i < this.walkers.length; i++) {
      const w = this.walkers[i] as Walker;
      const a = w.path[w.leg] as number;
      const b = w.path[w.leg + 1];
      if (b === undefined) {
        this.walkers.splice(i--, 1);
        continue;
      }
      const e = this.edgeBetween(a, b);
      if (!e) {
        this.walkers.splice(i--, 1);
        continue;
      }
      // 路口：等行人绿灯，而且剩余时间要够走完
      if (e.cross && w.s === 0) {
        const sig = this.site.signals[e.cross.signal];
        const ok = sig && signalLight(sig, time, e.cross.group) === 'G' && greenRemaining(sig, time, e.cross.group) > e.len / w.speed + 1;
        w.waiting = !ok;
        if (!ok) {
          this.place(w, a, b, 0);
          continue;
        }
      }
      w.waiting = false;
      w.s += w.speed * dt;
      if (e.cross) this.occupied.add(e.cross.id);
      if (w.s >= e.len) {
        w.s = 0;
        w.leg++;
        const nb = this.nodes[b] as Node;
        w.x = nb.x;
        w.z = nb.z;
        continue;
      }
      this.place(w, a, b, w.s / e.len);
    }
  }

  private place(w: Walker, a: number, b: number, k: number): void {
    const na = this.nodes[a] as Node;
    const nb = this.nodes[b] as Node;
    const dx = nb.x - na.x;
    const dz = nb.z - na.z;
    const len = Math.hypot(dx, dz) || 1;
    // 靠右走：沿前进方向的右侧偏移
    const rx = -dz / len;
    const rz = dx / len;
    w.x = na.x + dx * k + rx * w.offset;
    w.z = na.z + dz * k + rz * w.offset;
    w.heading = Math.atan2(dx, dz);
  }

  /** 有人的人行横道对应的车道障碍（车辆停在横道前） */
  obstacles(): Array<{ lane: number; d: number; len: number; v: number }> {
    const out: Array<{ lane: number; d: number; len: number; v: number }> = [];
    for (const id of this.occupied) {
      const c = this.crosswalks[id];
      if (!c) continue;
      for (const l of c.lanes) out.push({ lane: l.lane, d: l.d, len: 3.4, v: 0 });
    }
    return out;
  }
}
