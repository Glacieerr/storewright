import { rankReasons } from '@storewright/ai';
import type { InboundLab, InboundRun } from './inbound';
import { avg, confidenceOf, type Advice } from './types';

/**
 * 后仓与补货的建议（决策记录 0020 · 方向 2）：
 * - 今晚后仓放不下：几个托盘只能经连通通道送到暂存区的溢流位；夜班多一两个人（边补货边腾出货位）能不能解决；
 * - 夜班人数：开门前能不能补齐，最少几个人就够（人多了也提醒可以减）；
 * - 货位：按走得快慢分货位（快的放低层、靠主通道），夜班能不能更早补完、叉车少放几次高层托盘；
 * - 两层的门店：二楼的托盘先送二楼走得快的货架的，紧缺的货架能不能更早补上。
 */

/** 后仓的实验台在到货实验台之外还要知道的：现在采纳了哪些后仓改动、夜班补货组没开时开几个人 */
export interface BackroomLab extends InboundLab {
  slotting: 'default' | 'velocity';
  liftOrder: 'fifo' | 'urgency';
  /** 夜班补货组没开时，按门店规模的默认人数 */
  defaultNightCrew: number;
  /** 叉车台数（加人也补不完时，瓶颈常在叉车） */
  forklifts: number;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
export const overflowPallets = (r: InboundRun): number => r.pallets.filter((p) => p.overflowAt !== undefined).length;
/** 叉车把高层托盘放到地面的次数（夜班补货要先等叉车） */
export const lowerings = (r: InboundRun): number => r.equipment.reduce((n, e) => n + e.segments.filter((s) => s.lift?.mode === 'down').length, 0);

export function adviseBackroom(lab: BackroomLab, runs: readonly InboundRun[]): Advice[] {
  const base = runs[0];
  if (!base) return [];
  const out: Advice[] = [];
  const two = lab.seeds.slice(0, Math.min(2, lab.seeds.length));
  const baseOf = (i: number) => runs[i] as InboundRun;
  const nightHoursEach = lab.nightCrew > 0 ? base.metrics.nightHours / lab.nightCrew : 8;

  // ---------- 1. 今晚后仓放不下 ----------
  const ov = overflowPallets(base);
  if (ov > 0) {
    const recur = runs.filter((r) => overflowPallets(r) > 0).length;
    const firstAt = Math.min(...base.pallets.filter((p) => p.overflowAt !== undefined).map((p) => p.overflowAt as number));
    const before = avg(two.map((_, i) => overflowPallets(baseOf(i))));
    const cur = lab.nightCrew;
    const options = cur > 0 ? [cur + 1, cur + 2] : [lab.defaultNightCrew, lab.defaultNightCrew + 1];
    let pick: { crew: number; after: number; consistent: boolean } | undefined;
    for (const crew of options) {
      const rs = two.map((s) => lab.run({ nightCrew: crew }, s));
      const after = avg(rs.map(overflowPallets));
      if (after <= before * 0.5) {
        pick = { crew, after, consistent: rs.every((r, i) => overflowPallets(r) <= overflowPallets(baseOf(i))) };
        break;
      }
    }
    const reasons = rankReasons(
      [
        { factor: 'RACK_CAPACITY', value: base.metrics.rackCapacity, weight: 0.35 },
        { factor: 'PALLETS_TODAY', value: base.metrics.palletsReceived, weight: 0.3 },
        { factor: 'OVERFLOW_PALLETS', value: ov, weight: 0.35 },
      ],
      3,
    );
    const params = { pallets: ov, firstAt: Math.round(firstAt), capacity: base.metrics.rackCapacity, received: base.metrics.palletsReceived };
    // 划不划算：每多 4 个工时至少少放 1 托才建议加夜班；溢流不多时溢流位够用，不必加人
    const worth = pick ? (before - pick.after) / Math.max(1, (pick.crew - cur) * nightHoursEach) >= 0.25 : false;
    if (!worth && ov <= 4) {
      out.push({ id: 'BACKROOM:OVERFLOW', area: 'BACKROOM', code: 'OVERFLOW_OK', severity: 'info', from: firstAt, params, reasons, confidence: confidenceOf(recur / runs.length, false), recur: { days: recur, of: runs.length }, focus: { t: firstAt, kind: 'rack' } });
    } else if (pick && worth) {
      out.push({
        id: 'BACKROOM:OVERFLOW',
        area: 'BACKROOM',
        code: 'OVERFLOW',
        severity: 'warn',
        from: firstAt,
        params: { ...params, crewFrom: cur, crewTo: pick.crew },
        reasons,
        action: { kind: 'NIGHT_CREW', from: cur, to: pick.crew },
        effect: [
          { metric: 'OVERFLOW', unit: 'PALLETS', before: round1(before), after: round1(pick.after), better: 'lower' },
          { metric: 'LABOR_HOURS', unit: 'HOURS', before: 0, after: round1((pick.crew - cur) * nightHoursEach), better: 'lower' },
        ],
        confidence: confidenceOf(recur / runs.length, pick.consistent),
        recur: { days: recur, of: runs.length },
        focus: { t: firstAt, kind: 'rack' },
      });
    } else {
      out.push({ id: 'BACKROOM:OVERFLOW', area: 'BACKROOM', code: 'OVERFLOW_NO_FIX', severity: 'warn', from: firstAt, params, reasons, confidence: confidenceOf(recur / runs.length, false), recur: { days: recur, of: runs.length }, focus: { t: firstAt, kind: 'rack' } });
    }
  }

  // ---------- 2. 夜班人数：开门前补齐 ----------
  const backlog = (r: InboundRun) => r.metrics.backlogCases;
  const cur = lab.nightCrew;
  if (cur > 0) {
    let nMin: number | undefined;
    for (let n = Math.max(1, cur - 2); n <= cur + 3; n++) {
      if (backlog(n === cur ? base : lab.run({ nightCrew: n }, lab.seeds[0] as number)) === 0) {
        nMin = n;
        break;
      }
    }
    const reasons = rankReasons(
      [
        { factor: 'CASES_TONIGHT', value: base.metrics.totalCases, weight: 0.45 },
        { factor: 'NIGHT_CREW', value: cur, weight: 0.3 },
        { factor: 'BACKLOG_CASES', value: backlog(base), weight: backlog(base) > 0 ? 0.25 : 0.0001 },
      ],
      3,
    );
    if (backlog(base) > 0 && nMin !== undefined && nMin > cur) {
      const rs = two.map((s) => lab.run({ nightCrew: nMin as number }, s));
      out.push({
        id: 'BACKROOM:NIGHT_CREW',
        area: 'BACKROOM',
        code: 'NIGHT_CREW_ADD',
        severity: 'warn',
        params: { from: cur, to: nMin, backlog: backlog(base), cases: base.metrics.totalCases },
        reasons,
        action: { kind: 'NIGHT_CREW', from: cur, to: nMin },
        effect: [
          { metric: 'BACKLOG', unit: 'CASES', before: round1(avg(two.map((_, i) => backlog(baseOf(i))))), after: round1(avg(rs.map(backlog))), better: 'lower' },
          { metric: 'LABOR_HOURS', unit: 'HOURS', before: 0, after: round1((nMin - cur) * nightHoursEach), better: 'lower' },
        ],
        confidence: confidenceOf(runs.filter((r) => backlog(r) > 0).length / runs.length, rs.every((r) => backlog(r) === 0)),
        recur: { days: runs.filter((r) => backlog(r) > 0).length, of: runs.length },
        focus: { t: base.metrics.finishAt ?? 0, kind: 'rack' },
      });
    } else if (backlog(base) > 0 && nMin === undefined) {
      // 多加 3 个人也补不完：瓶颈不在人数（叉车放下高层托盘、后到的长途车）。剩得很少时只提醒
      const share = backlog(base) / Math.max(1, base.metrics.totalCases);
      out.push({
        id: 'BACKROOM:NIGHT_CREW',
        area: 'BACKROOM',
        code: 'NIGHT_CREW_SHORT',
        severity: share >= 0.03 ? 'critical' : 'info',
        params: { from: cur, to: cur + 3, backlog: backlog(base), share: Math.round(share * 1000) / 10, forklifts: lab.forklifts },
        reasons: rankReasons([...reasons, { factor: 'FORKLIFTS', value: lab.forklifts, weight: 0.3 }], 4),
        confidence: confidenceOf(runs.filter((r) => backlog(r) > 0).length / runs.length, false),
        recur: { days: runs.filter((r) => backlog(r) > 0).length, of: runs.length },
      });
    } else if (backlog(base) === 0 && nMin !== undefined && nMin < cur) {
      const rs = two.map((s) => lab.run({ nightCrew: nMin as number }, s));
      if (rs.every((r) => backlog(r) === 0))
        out.push({
          id: 'BACKROOM:NIGHT_CREW',
          area: 'BACKROOM',
          code: 'NIGHT_CREW_REDUCE',
          severity: 'info',
          params: { from: cur, to: nMin, cases: base.metrics.totalCases },
          reasons,
          action: { kind: 'NIGHT_CREW', from: cur, to: nMin },
          effect: [
            { metric: 'BACKLOG', unit: 'CASES', before: 0, after: 0, better: 'lower' },
            { metric: 'LABOR_HOURS', unit: 'HOURS', before: round1((cur - nMin) * nightHoursEach), after: 0, better: 'lower' },
          ],
          confidence: 0.7,
        });
    }
  } else if (backlog(base) > 0) {
    // 夜班补货组没开：开门时还有货没上架
    const rs = two.map((s) => lab.run({ nightCrew: lab.defaultNightCrew }, s));
    out.push({
      id: 'BACKROOM:NIGHT_CREW',
      area: 'BACKROOM',
      code: 'NIGHT_CREW_ENABLE',
      severity: 'warn',
      params: { to: lab.defaultNightCrew, backlog: backlog(base) },
      reasons: rankReasons([{ factor: 'BACKLOG_CASES', value: backlog(base), weight: 0.6 }, { factor: 'CASES_TONIGHT', value: base.metrics.totalCases, weight: 0.4 }], 2),
      action: { kind: 'NIGHT_CREW', from: 0, to: lab.defaultNightCrew },
      effect: [{ metric: 'BACKLOG', unit: 'CASES', before: round1(avg(two.map((_, i) => backlog(baseOf(i))))), after: round1(avg(rs.map(backlog))), better: 'lower' }],
      confidence: 0.8,
    });
  }

  // ---------- 3. 货位：走得快的放低层、靠主通道 ----------
  if (lab.slotting === 'default') {
    const rs = two.map((s) => lab.run({ slotting: 'velocity' }, s));
    const finish = (r: InboundRun) => r.metrics.finishAt ?? Infinity;
    const lowBefore = avg(two.map((_, i) => lowerings(baseOf(i))));
    const lowAfter = avg(rs.map(lowerings));
    const finBefore = two.map((_, i) => finish(baseOf(i)));
    const finAfter = rs.map(finish);
    const earlier = finBefore.every((f, i) => Number.isFinite(f) && Number.isFinite(finAfter[i] as number)) ? avg(finBefore) - avg(finAfter) : 0;
    const backlogGain = avg(two.map((_, i) => backlog(baseOf(i)))) - avg(rs.map(backlog));
    if (earlier >= 10 * 60 || backlogGain >= 5 || lowBefore - lowAfter >= 3) {
      const effect: Advice['effect'] = [{ metric: 'LOWERINGS', unit: 'COUNT', before: round1(lowBefore), after: round1(lowAfter), better: 'lower' }];
      if (Number.isFinite(avg(finBefore)) && Number.isFinite(avg(finAfter))) effect.unshift({ metric: 'NIGHT_FINISH', unit: 'CLOCK', before: Math.round(avg(finBefore)), after: Math.round(avg(finAfter)), better: 'lower' });
      if (backlogGain > 0) effect.push({ metric: 'BACKLOG', unit: 'CASES', before: round1(avg(two.map((_, i) => backlog(baseOf(i))))), after: round1(avg(rs.map(backlog))), better: 'lower' });
      out.push({
        id: 'BACKROOM:SLOTTING',
        area: 'BACKROOM',
        code: 'SLOTTING',
        severity: 'info',
        params: { lowerings: Math.round(lowBefore) },
        reasons: rankReasons([{ factor: 'LOWERINGS', value: Math.round(lowBefore), weight: 0.5 }, { factor: 'FAST_RUNS_HIGH', weight: 0.5 }], 2),
        action: { kind: 'SLOTTING', policy: 'velocity' },
        effect,
        confidence: confidenceOf(1, rs.every((r, i) => lowerings(r) <= lowerings(baseOf(i)))),
        focus: { t: base.metrics.finishAt ?? 0, kind: 'rack' },
      });
    }
  }

  // ---------- 4. 两层的门店：二楼的托盘先送紧缺的 ----------
  if (lab.twoFloor && lab.liftOrder === 'fifo') {
    // 二楼走得快的货架（今天送上楼的托盘最多的三分之一）的托盘平均什么时候送上楼
    const urgentUp = (r: InboundRun) => r.pallets.filter((p) => p.upAt !== undefined);
    const rs = two.map((s) => lab.run({ liftOrder: 'urgency' }, s));
    const topRuns = (r: InboundRun) => {
      const count = new Map<string, number>();
      for (const p of urgentUp(r)) count.set(p.runId, (count.get(p.runId) ?? 0) + 1);
      return new Set([...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.ceil(count.size / 3))).map(([k]) => k));
    };
    const meanUp = (r: InboundRun, keep: Set<string>) => avg(urgentUp(r).filter((p) => keep.has(p.runId)).map((p) => p.upAt as number));
    const keep = topRuns(base);
    if (keep.size && urgentUp(base).length >= 4) {
      const before = avg(two.map((_, i) => meanUp(baseOf(i), keep)));
      const after = avg(rs.map((r) => meanUp(r, keep)));
      if (before - after >= 10 * 60)
        out.push({
          id: 'BACKROOM:LIFT_ORDER',
          area: 'BACKROOM',
          code: 'LIFT_ORDER',
          severity: 'info',
          params: { pallets: urgentUp(base).length },
          reasons: rankReasons([{ factor: 'UP_PALLETS', value: urgentUp(base).length, weight: 0.5 }, { factor: 'LIFT_FIFO', weight: 0.5 }], 2),
          action: { kind: 'LIFT_ORDER', policy: 'urgency' },
          effect: [{ metric: 'URGENT_UP', unit: 'CLOCK', before: Math.round(before), after: Math.round(after), better: 'lower' }],
          confidence: confidenceOf(1, rs.every((r, i) => meanUp(r, keep) <= meanUp(baseOf(i), keep))),
          focus: { t: Math.round(before), kind: 'lift' },
        });
    }
  }
  return out;
}
