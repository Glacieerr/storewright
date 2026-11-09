import { forEachCandidatePair } from './grid';
import { shapeAabb, shapesOverlap, type OverlapOptions, type Shape } from './geom';

/**
 * Pair-seconds tally and the per-step auditor.
 * 「车对 × 秒」的统计和每个时刻的审计。
 *
 * The unit is pair-seconds: two bodies overlapping for 10 s add 10; three mutually overlapping bodies for 1 s add 3.
 * Every overlap is filed under an area (from your classifier), a pair label (by default the two body types, sorted and
 * joined with " × ") and static or moving (both bodies still = static: parked or queued vehicles drawn inside each other;
 * otherwise moving: a vehicle driving through another).
 * 单位是「车对 × 秒」；每次重叠记在一个区域（由你的分类函数给）、一个车型对（默认两种车型排序后用 " × " 连起来）、
 * 静止或行驶（两辆都没动 = 静止：停着、排队的车画到了一起；否则是行驶：一辆车开过另一辆）下面。
 */

export interface Counts {
  static: number;
  moving: number;
}

/** area → pair label → counts. 区域 → 车型对 → 静止 / 行驶。 */
export class OverlapTally {
  private readonly areas = new Map<string, Map<string, Counts>>();

  /** Add `seconds` of overlap. 记一笔。 */
  add(area: string, pair: string, isStatic: boolean, seconds: number): void {
    let a = this.areas.get(area);
    if (!a) this.areas.set(area, (a = new Map()));
    let p = a.get(pair);
    if (!p) a.set(pair, (p = { static: 0, moving: 0 }));
    p[isStatic ? 'static' : 'moving'] += seconds;
  }

  /** Areas in first-seen order. 出现过的区域（按第一次出现的顺序）。 */
  areaNames(): string[] {
    return [...this.areas.keys()];
  }

  has(area: string): boolean {
    return this.areas.has(area);
  }

  /** Totals of one area (zeros if never seen). 一个区域的合计。 */
  total(area: string): Counts {
    const out = { static: 0, moving: 0 };
    for (const p of this.areas.get(area)?.values() ?? []) {
      out.static += p.static;
      out.moving += p.moving;
    }
    return out;
  }

  /** Pairs of one area, largest first. 一个区域的车型对，从多到少。 */
  pairs(area: string): { pair: string; static: number; moving: number }[] {
    return [...(this.areas.get(area) ?? new Map<string, Counts>())].map(([pair, c]) => ({ pair, ...c })).sort((x, y) => y.static + y.moving - (x.static + x.moving));
  }

  /** Plain-object copy (for JSON output). 转成普通对象（输出 JSON 用）。 */
  toJSON(): Record<string, Record<string, Counts>> {
    const out: Record<string, Record<string, Counts>> = {};
    for (const [a, m] of this.areas) {
      out[a] = {};
      for (const [p, c] of m) (out[a] as Record<string, Counts>)[p] = { ...c };
    }
    return out;
  }
}

/** One body at one moment. 某一时刻的一个车身。 */
export interface Body<D = unknown> {
  /** Vehicle (or vehicle-part) type, used in pair labels. 车型（或车的一部分），车型对的名字用它。 */
  type: string;
  /** Footprint, quad or oriented box. 车身矩形。 */
  shape: Shape;
  /** Did it stay put since the previous sample? 和上一次取样比没动。 */
  still?: boolean;
  /** Your own payload (layer, name, id …), passed back to the hooks. 你自己的数据，原样传给钩子。 */
  data?: D;
}

export interface Overlap<D = unknown> {
  t: number;
  a: Body<D>;
  b: Body<D>;
  area: string;
  pair: string;
  isStatic: boolean;
}

export interface AuditorOptions<D = unknown> extends OverlapOptions {
  /** Add into this tally (to combine several auditors in one report). Default: a new tally. 记进这份统计（几个审计合成一份报告）。 */
  tally?: OverlapTally;
  /** Grid cell size in metres for the broad phase (speed only; default 30). 粗筛的格子大小（只影响快慢）。 */
  cell?: number;
  /** Skip a pair before the exact test (cheap filters, e.g. two parts of one vehicle). 精确检验之前就跳过的对。 */
  skip?: (a: Body<D>, b: Body<D>) => boolean;
  /** Skip an overlapping pair after the exact test (e.g. a tractor and its own trailer). 确认重叠以后再忽略的对（如牵引车和自己的挂车）。 */
  ignore?: (a: Body<D>, b: Body<D>) => boolean;
  /** Area of an overlapping pair; return `undefined` to leave it out. Default: "all". 重叠记在哪个区域；返回 undefined 不记。 */
  area?: (a: Body<D>, b: Body<D>) => string | undefined;
  /** Pair label. Default: the two types sorted and joined with " × ". 车型对的名字。 */
  pair?: (a: Body<D>, b: Body<D>) => string;
  /** Called for every counted overlap (for tracing examples or hot spots). 每记一次重叠调用一次（打印例子、找热点用）。 */
  onOverlap?: (o: Overlap<D>) => void;
}

export const defaultPair = (a: Body, b: Body): string => [a.type, b.type].sort().join(' × ');

/**
 * Feeds samples into a tally. Call `step(t, bodies, seconds)` once per sample time; `seconds` is how long each sample stands
 * for (your sampling step).
 * 把每个时刻的车身喂进统计：每个取样时刻调一次 step(t, bodies, seconds)，seconds 是一次取样代表多少秒（取样间隔）。
 */
export class OverlapAuditor<D = unknown> {
  readonly tally: OverlapTally;
  private readonly opts: AuditorOptions<D>;

  constructor(opts: AuditorOptions<D> = {}) {
    this.opts = opts;
    this.tally = opts.tally ?? new OverlapTally();
  }

  /** Audit one sample. Returns how many overlapping pairs were counted. 审计一个时刻，返回记了几对。 */
  step(t: number, bodies: readonly Body<D>[], seconds: number): number {
    const o = this.opts;
    let n = 0;
    forEachCandidatePair(bodies.map((b) => shapeAabb(b.shape)), o.cell ?? 30, (i, j) => {
      const a = bodies[i] as Body<D>;
      const b = bodies[j] as Body<D>;
      if (o.skip?.(a, b)) return;
      if (!shapesOverlap(a.shape, b.shape, o)) return;
      if (o.ignore?.(a, b)) return;
      const area = o.area ? o.area(a, b) : 'all';
      if (area === undefined) return;
      const pair = (o.pair ?? defaultPair)(a, b);
      const isStatic = !!a.still && !!b.still;
      this.tally.add(area, pair, isStatic, seconds);
      o.onOverlap?.({ t, a, b, area, pair, isStatic });
      n++;
    });
    return n;
  }
}

/**
 * Tracks which bodies did not move between samples, by a pose key you build (for example the body's name plus its corners
 * rounded to 10 cm). Call `next()` after each sample.
 * 判断「没动」：每个车身给一个位姿键（如名字 + 角点取到 10 厘米），和上一次取样比；每次取样完调 next()。
 */
export class StillTracker {
  private prev = new Set<string>();
  private cur = new Set<string>();

  /** Register a body's key for this sample; returns true if the same key was seen in the previous sample. 登记，并返回上一次有没有同样的键。 */
  mark(key: string): boolean {
    this.cur.add(key);
    return this.prev.has(key);
  }

  /** Close the sample. 结束这次取样。 */
  next(): void {
    this.prev = this.cur;
    this.cur = new Set();
  }
}

/**
 * Pose key for a quad: a name plus corners 0 and 2 rounded to `1 / precision` metres (default 10 cm).
 * 四边形的位姿键：名字 + 角 0 和角 2（默认取到 10 厘米）。
 */
export function quadKey(name: string, q: ArrayLike<number>, precision = 10): string {
  return `${name}:${Math.round((q[0] as number) * precision)},${Math.round((q[1] as number) * precision)},${Math.round((q[4] as number) * precision)},${Math.round((q[5] as number) * precision)}`;
}
