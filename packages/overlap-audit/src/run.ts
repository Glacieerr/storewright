import { OverlapAuditor, type Overlap } from './audit';
import { checkLimits, type LimitReport, type Limits } from './limits';
import { bodiesAt, inPolygon, trajectorySpan, type TrajData, type TrajectoryFile } from './trajectory';

export interface TrajectoryAuditOptions {
  /** Sampling step in seconds (default 1). 取样间隔（秒）。 */
  step?: number;
  from?: number;
  to?: number;
  limits?: Limits;
  /** Count rectangles that only touch as overlapping. 只是贴着也算重叠。 */
  touching?: boolean;
  /** Distance (metres) under which a body counts as not having moved since the previous sample (default 0.01). 小于这个位移算没动。 */
  stillEps?: number;
  /** Keep up to this many example overlaps per area and pair (default 3). 每个区域、车型对保留几个例子。 */
  examples?: number;
}

export interface TrajectoryAuditResult extends LimitReport {
  step: number;
  t0: number;
  t1: number;
  samples: number;
  examples: { area: string; pair: string; t: number; a: string; b: string }[];
}

/**
 * Audit a trajectory file (see `trajectory.ts` for the format): sample every `step` seconds, count overlapping pairs, compare with
 * limits. Bodies in the same `group` are skipped; a body is still when it moved less than `stillEps` since the previous sample.
 * 审计一个轨迹文件：每 step 秒取样一次，统计重叠的车对，和上限比；同一个 group 的车身互不计；位移小于 stillEps 算没动。
 */
export function auditTrajectories(f: TrajectoryFile, opts: TrajectoryAuditOptions = {}): TrajectoryAuditResult {
  const step = opts.step ?? 1;
  if (!(step > 0)) throw new RangeError('step must be positive');
  const span = trajectorySpan(f);
  const t0 = opts.from ?? span.t0;
  const t1 = opts.to ?? span.t1;
  const eps = opts.stillEps ?? 0.01;
  const keep = opts.examples ?? 3;
  const areas = f.areas ?? [];
  const examples: TrajectoryAuditResult['examples'] = [];
  const count = new Map<string, number>();
  const auditor = new OverlapAuditor<TrajData>({
    touching: !!opts.touching,
    skip: (a, b) => !!a.data?.group && a.data.group === b.data?.group,
    area: (a, b) => {
      if (!areas.length) return 'all';
      const x = ((a.data?.x ?? 0) + (b.data?.x ?? 0)) / 2;
      const z = ((a.data?.z ?? 0) + (b.data?.z ?? 0)) / 2;
      return areas.find((ar) => inPolygon(x, z, ar.polygon))?.name ?? 'other';
    },
    onOverlap: (o: Overlap<TrajData>) => {
      const k = `${o.area}|${o.pair}`;
      const n = count.get(k) ?? 0;
      count.set(k, n + 1);
      if (n < keep) examples.push({ area: o.area, pair: o.pair, t: o.t, a: o.a.data?.id ?? '?', b: o.b.data?.id ?? '?' });
    },
  });
  let prev = new Map<string, { x: number; z: number }>();
  let samples = 0;
  for (let t = t0; t <= t1 + 1e-9; t += step) {
    const bodies = bodiesAt(f, t);
    const next = new Map<string, { x: number; z: number }>();
    for (const b of bodies) {
      const d = b.data as TrajData;
      const p = prev.get(d.id);
      b.still = !!p && Math.hypot(p.x - d.x, p.z - d.z) < eps;
      next.set(d.id, { x: d.x, z: d.z });
    }
    auditor.step(t, bodies, step);
    prev = next;
    samples++;
  }
  return { ...checkLimits(auditor.tally, opts.limits ?? {}), step, t0, t1, samples, examples };
}
