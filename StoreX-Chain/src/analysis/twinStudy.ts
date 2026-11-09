import { buildBoard } from '../sim/board';
import { g3 } from '../sim/config';
import { allocationHour, emptyDay } from '../sim/plan';
import type { FieldLevel } from '../twin/field';
import { Loop, type LoopInput } from '../twin/loop';
import { ISSUE_LABEL, type IssueKind } from '../twin/types';
import { run } from './studies';

/**
 * 闭环孪生的实验：全链路方案某一天的计划（调度台排好的月台门、收货口和车）在现场跑一整天，
 * 同一个种子、同样的现场状况比四种做法——不用孪生；孪生只自动执行低风险的、其余的建议卡没人批；
 * 低风险的自动执行、调度员在建议卡出来 10 分钟后批准推荐的做法；全部自动执行。
 */
export type TwinArm = 'open' | 'safe' | 'dispatcher' | 'auto';
export const TWIN_ARMS: readonly { key: TwinArm; label: string; short: string }[] = [
  { key: 'open', label: '不用孪生（现场自己处理）', short: '不用孪生' },
  { key: 'safe', label: '孪生只自动执行低风险的，其余的建议卡没人批', short: '只自动执行低风险的' },
  { key: 'dispatcher', label: '低风险的自动执行，调度员在建议卡出来 10 分钟后批准推荐的做法', short: '加调度员批准' },
  { key: 'auto', label: '全部自动执行', short: '全部自动执行' },
];
export const TWIN_LEVELS: readonly { key: FieldLevel; label: string }[] = [
  { key: 'normal', label: '平常的一天' },
  { key: 'rough', label: '多事的一天' },
];
/** 调度员看到建议卡到批准的时间（秒） */
const RESPONSE = 10 * 60;

export interface TwinRun {
  seed: number;
  level: FieldLevel;
  arm: TwinArm;
  /** 现场的结果：门店收货迟到、冷链超温、门店缺货（分钟），少卖的件数，孪生的措施多花的钱（美元），多跑的里程 */
  late: number;
  hot: number;
  short: number;
  lost: number;
  cost: number;
  extraKm: number;
  /** 建议卡：张数、按种类、自动执行、调度员批准、没处理而问题真的发生了、问题自己没了 */
  cards: number;
  byKind: Record<IssueKind, number>;
  auto: number;
  user: number;
  expired: number;
  resolved: number;
  /** 孪生的保真度：提前 15–45 分钟、45–90 分钟、1.5–3 小时预测到店时间的平均误差（分钟），货温的平均误差（°C） */
  eta30: number;
  eta60: number;
  eta120: number;
  temp: number;
  /** 一天的感知数据（条） */
  msgs: number;
}

export function twinStudy(seeds: readonly number[], day = 86): TwinRun[] {
  const out: TwinRun[] = [];
  for (const seed of seeds) {
    const s = g3(seed);
    s.traceDay = day;
    const trace = run(s).trace;
    if (!trace) continue;
    const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
    for (const { key: level } of TWIN_LEVELS) {
      const input: LoopInput = { vehicles: trace.vehicles, ops: board.ops, board, seed, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level };
      for (const { key: arm } of TWIN_ARMS) {
        const loop = new Loop(input, { closed: arm !== 'open', policy: arm === 'open' ? 'manual' : arm === 'auto' ? 'auto' : 'safe', decisions: [] });
        while (!loop.done) {
          loop.step();
          if (arm === 'dispatcher') for (const c of loop.cards()) if (c.status === 'proposed' && loop.t - c.t >= RESPONSE) loop.decide(c.key, 'approve');
        }
        const res = loop.result();
        const byKind = Object.fromEntries(Object.keys(ISSUE_LABEL).map((k) => [k, 0])) as Record<IssueKind, number>;
        for (const c of res.recs) byKind[c.kind]++;
        const k = res.kpi;
        out.push({
          seed,
          level,
          arm,
          late: k.lateMin,
          hot: k.hotMin,
          short: k.shortMin,
          lost: k.lostUnits,
          cost: k.cost,
          extraKm: k.extraKm,
          cards: res.recs.length,
          byKind,
          auto: res.recs.filter((c) => c.status === 'done' && c.by === 'auto').length,
          user: res.recs.filter((c) => c.status === 'done' && c.by === 'user').length,
          expired: res.recs.filter((c) => c.status === 'expired').length,
          resolved: res.recs.filter((c) => c.status === 'resolved').length,
          eta30: res.fidelity.eta30,
          eta60: res.fidelity.eta60,
          eta120: res.fidelity.eta120,
          temp: res.fidelity.temp,
          msgs: res.msgCount,
        });
      }
    }
  }
  return out;
}

/** 某种现场状况、某种做法的平均（NaN 的不算） */
export function twinMean(runs: readonly TwinRun[], level: FieldLevel, arm: TwinArm, f: (r: TwinRun) => number): number {
  const xs = runs.filter((r) => r.level === level && r.arm === arm).map(f).filter((x) => Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
