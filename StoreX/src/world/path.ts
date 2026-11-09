import { walkable, type Layout, type Pt } from './layout';

/**
 * 栅格上的最短路：八方向（斜着走不能穿过货架角），代价 10 / 14（分米），用桶队列（Dial 算法）。
 * 每个起点的距离表缓存起来（最近用过的 2000 个，16 位整数），拣货路线、补货、交付都从这里取距离和路径。
 */
const ORTHO = 10;
const DIAG = 14;
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, ORTHO],
  [-1, 0, ORTHO],
  [0, 1, ORTHO],
  [0, -1, ORTHO],
  [1, 1, DIAG],
  [1, -1, DIAG],
  [-1, 1, DIAG],
  [-1, -1, DIAG],
];
const UNREACHED = 32767;

export class Router {
  private cache = new Map<number, Int16Array>();
  private readonly limit: number;

  constructor(
    readonly layout: Layout,
    limit = 2000,
  ) {
    this.limit = limit;
  }

  /** 从 from 出发到所有格子的距离（分米）；outdoors 为 false 时只走室内 */
  field(from: Pt, outdoors = false): Int16Array {
    const l = this.layout;
    const key = (from.y * l.width + from.x) * 2 + (outdoors ? 1 : 0);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const dist = new Int16Array(l.width * l.height).fill(UNREACHED);
    const start = from.y * l.width + from.x;
    dist[start] = 0;
    // 桶队列：代价 ≤ 14，环形桶即可
    const buckets: number[][] = Array.from({ length: DIAG + 1 }, () => []);
    (buckets[0] as number[]).push(start);
    let pending = 1;
    let d = 0;
    while (pending > 0) {
      const bucket = buckets[d % (DIAG + 1)] as number[];
      while (bucket.length) {
        const idx = bucket.pop() as number;
        pending--;
        if ((dist[idx] as number) !== d) continue;
        const x = idx % l.width;
        const y = (idx - x) / l.width;
        for (const [dx, dy, c] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (!walkable(l, nx, ny, outdoors)) continue;
          if (dx !== 0 && dy !== 0 && (!walkable(l, x + dx, y, outdoors) || !walkable(l, x, y + dy, outdoors))) continue;
          const ni = ny * l.width + nx;
          const nd = d + c;
          if (nd < (dist[ni] as number)) {
            dist[ni] = nd;
            (buckets[nd % (DIAG + 1)] as number[]).push(ni);
            pending++;
          }
        }
      }
      d++;
      if (d > 4_000_000) break;
    }
    this.cache.set(key, dist);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value as number);
    return dist;
  }

  /** 两点间步行距离（米）；不通时返回直线距离的 1.5 倍（不应发生，测试里检查连通性） */
  distance(a: Pt, b: Pt, outdoors = false): number {
    if (a.x === b.x && a.y === b.y) return 0;
    const f = this.field(a, outdoors);
    const v = f[b.y * this.layout.width + b.x] as number;
    if (v >= UNREACHED) return 1.5 * Math.hypot(a.x - b.x, a.y - b.y);
    return v / 10;
  }

  reachable(a: Pt, b: Pt, outdoors = false): boolean {
    const f = this.field(a, outdoors);
    return (f[b.y * this.layout.width + b.x] as number) < UNREACHED;
  }

  /** 路径的拐点（含起点和终点），画动画用 */
  path(a: Pt, b: Pt, outdoors = false): Pt[] {
    const l = this.layout;
    const f = this.field(a, outdoors);
    let cur = b.y * l.width + b.x;
    if ((f[cur] as number) >= UNREACHED) return [a, b];
    const cells: Pt[] = [];
    let guard = 0;
    while ((f[cur] as number) > 0 && guard++ < 10000) {
      const x = cur % l.width;
      const y = (cur - x) / l.width;
      cells.push({ x, y });
      let next = -1;
      for (const [dx, dy, c] of NEIGHBORS) {
        const nx = x - dx;
        const ny = y - dy;
        if (nx < 0 || ny < 0 || nx >= l.width || ny >= l.height) continue;
        const ni = ny * l.width + nx;
        if ((f[ni] as number) + c === f[cur]) {
          if (dx !== 0 && dy !== 0 && (!walkable(l, x - dx, y, outdoors) || !walkable(l, x, y - dy, outdoors))) continue;
          next = ni;
          break;
        }
      }
      if (next < 0) break;
      cur = next;
    }
    cells.push(a);
    cells.reverse();
    return simplify(cells);
  }
}

/** 去掉直线上的中间点，只留拐点 */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0] as Pt];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x)) out.push(b);
  }
  out.push(pts[pts.length - 1] as Pt);
  return out;
}

/** 拣货路线：最近邻起步 + 2-opt 改进（从 start 出发，经过所有点，到 end 结束） */
export function routeOrder(router: Router, start: Pt, stops: readonly Pt[], end: Pt): { order: number[]; meters: number } {
  const n = stops.length;
  if (n === 0) return { order: [], meters: router.distance(start, end) };
  const pts = [start, ...stops, end];
  const m = pts.length;
  const d: number[][] = pts.map((p) => pts.map((q) => router.distance(p, q)));
  // 最近邻
  const used = new Array<boolean>(m).fill(false);
  const tour = [0];
  used[0] = true;
  used[m - 1] = true;
  for (let k = 0; k < n; k++) {
    const last = tour[tour.length - 1] as number;
    let best = -1;
    let bd = Infinity;
    for (let j = 1; j < m - 1; j++) {
      if (used[j]) continue;
      const v = (d[last] as number[])[j] as number;
      if (v < bd) {
        bd = v;
        best = j;
      }
    }
    used[best] = true;
    tour.push(best);
  }
  tour.push(m - 1);
  // 2-opt（起点、终点固定）
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 30) {
    improved = false;
    for (let i = 1; i < tour.length - 2; i++) {
      for (let j = i + 1; j < tour.length - 1; j++) {
        const a = tour[i - 1] as number;
        const b = tour[i] as number;
        const c = tour[j] as number;
        const e = tour[j + 1] as number;
        const delta = ((d[a] as number[])[c] as number) + ((d[b] as number[])[e] as number) - ((d[a] as number[])[b] as number) - ((d[c] as number[])[e] as number);
        if (delta < -1e-6) {
          tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  let meters = 0;
  for (let i = 0; i < tour.length - 1; i++) meters += (d[tour[i] as number] as number[])[tour[i + 1] as number] as number;
  return { order: tour.slice(1, -1).map((i) => i - 1), meters };
}
