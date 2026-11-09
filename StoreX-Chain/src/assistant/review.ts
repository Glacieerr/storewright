import type { LoopResult } from '../twin/loop';
import { clock } from '../twin/twin';
import { ISSUE_LABEL, type IssueKind, type Option, type Rec } from '../twin/types';
import { noAction } from './brief';

/**
 * 建议复盘：每张处理完的建议卡，孪生当时预测的结果和事后现场实际发生的比。
 *
 * - 预测：实际做了的那个做法的推演结果（执行了 → 选的做法；否决、没处理 → 「不处理」的做法；问题自己没了 → 「不处理」）；
 * - 实际：卡片出来以后这个问题实际的结果（迟到看这辆车和它的救援车在那家店晚了多少，超温看这辆车，缺货看这个商品族，等门看这辆车）；
 * - 命中：差在 10 分钟以内，或者在预测的 30% 以内；
 * - 按类别统计：多少张、执行了几张（自动 / 人工）、否了几张、平均误差、命中率。
 * 现实里只能这样比（没有「如果当时不这么做」的现场）；想看某张卡当时不处理会怎样，可以在网页里单独推演一遍。
 */
export interface ReviewRow {
  key: string;
  kind: IssueKind;
  title: string;
  t: number;
  status: Rec['status'];
  by?: 'auto' | 'user';
  /** 实际做了的做法 */
  did: string;
  metric: string;
  predicted: number;
  actual: number;
  hit: boolean;
  /** 推荐的做法比不处理预计少的合计分 */
  saving: number;
  /** 把决定反过来会不会不一样（执行了的要有指令；没执行的推荐做法要有指令） */
  flippable: boolean;
}
export interface ReviewStats {
  label: string;
  n: number;
  done: number;
  auto: number;
  user: number;
  rejected: number;
  expired: number;
  resolved: number;
  mae: number;
  hitRate: number;
}
export interface Review {
  rows: ReviewRow[];
  byKind: ReviewStats[];
  total: ReviewStats;
  notes: string[];
}

const METRIC: Record<IssueKind, string> = { late: '迟到分钟', breakdown: '迟到分钟', temp: '超温分钟', stockout: '缺货分钟', door: '等门分钟', dock: '等收货口分钟' };
const score = (o: Option) => o.late + o.hot * 2 + o.short * 1.5 + o.cost / 12;
const sumFrom = (a: Float32Array | undefined, t: number) => {
  if (!a) return 0;
  let s = 0;
  for (let k = Math.max(0, Math.floor(t / 300)); k < a.length; k++) s += a[k] as number;
  return s;
};

function predicted(r: Rec, o: Option | undefined): number {
  if (!o) return 0;
  return r.kind === 'temp' ? o.hot : r.kind === 'stockout' ? o.short : o.late;
}

function actual(r: Rec, res: LoopResult): number {
  const vid = r.vid;
  const helpers = new Set(res.extras.filter((x) => x.of !== undefined && x.of === vid).map((x) => x.vid));
  const mine = (v: number) => v === vid || helpers.has(v);
  switch (r.kind) {
    case 'late':
      return res.stops.filter((s) => mine(s.vid) && (!r.store || s.store === r.store) && s.t >= r.t).reduce((a, s) => a + s.late, 0);
    case 'breakdown':
      return res.stops.filter((s) => mine(s.vid) && s.t >= r.t).reduce((a, s) => a + s.late, 0);
    case 'temp':
      return vid === undefined ? 0 : sumFrom(res.by.hot.get(vid), r.t) + [...helpers].reduce((a, h) => a + sumFrom(res.by.hot.get(h), r.t), 0);
    case 'stockout':
      return sumFrom(res.by.short.get(r.key.split(':')[1] as string), r.t);
    case 'door':
      return vid === undefined ? 0 : (res.by.door.get(vid) ?? 0);
    case 'dock':
      return vid === undefined ? 0 : (res.by.dock.get(vid) ?? 0);
  }
}

function stats(label: string, rows: readonly ReviewRow[]): ReviewStats {
  const n = rows.length;
  const err = rows.reduce((a, x) => a + Math.abs(x.actual - x.predicted), 0);
  return {
    label,
    n,
    done: rows.filter((x) => x.status === 'done').length,
    auto: rows.filter((x) => x.status === 'done' && x.by === 'auto').length,
    user: rows.filter((x) => x.status === 'done' && x.by === 'user').length,
    rejected: rows.filter((x) => x.status === 'rejected').length,
    expired: rows.filter((x) => x.status === 'expired').length,
    resolved: rows.filter((x) => x.status === 'resolved').length,
    mae: n ? err / n : 0,
    hitRate: n ? rows.filter((x) => x.hit).length / n : 0,
  };
}

/** 复盘到 t 为止已经有结论的建议卡（t 默认整天；还待处理的不算） */
export function review(res: LoopResult, t = Infinity): Review {
  const rows: ReviewRow[] = [];
  for (const r of res.recs) {
    if (r.status === 'proposed' || r.t > t || (r.doneAt ?? r.t) > t) continue;
    const best = r.options[r.best] as Option;
    const none = noAction(r);
    const o = r.status === 'done' ? r.options.find((x) => x.key === r.chosen) : none;
    const p = predicted(r, o);
    const a = actual(r, res);
    rows.push({
      key: r.key,
      kind: r.kind,
      title: r.title,
      t: r.t,
      status: r.status,
      ...(r.by ? { by: r.by } : {}),
      did: r.status === 'done' ? (o?.label ?? r.chosen ?? '') : '不处理',
      metric: METRIC[r.kind],
      predicted: p,
      actual: a,
      hit: Math.abs(a - p) <= Math.max(10, 0.3 * Math.max(p, a)),
      saving: none && none !== best ? score(none) - score(best) : 0,
      flippable: r.status === 'done' ? !!o?.cmds.length : best.cmds.length > 0,
    });
  }
  const kinds = [...new Set(rows.map((x) => x.kind))];
  const byKind = kinds.map((k) => stats(ISSUE_LABEL[k], rows.filter((x) => x.kind === k)));
  const total = stats('全部', rows);
  const notes: string[] = [];
  if (!rows.length) notes.push('到此刻还没有处理完的建议卡。');
  else {
    notes.push(`${total.n} 张建议卡有了结论：执行 ${total.done} 张（自动 ${total.auto}、人工 ${total.user}），否决 ${total.rejected} 张，没处理而问题发生了 ${total.expired} 张，问题自己没了 ${total.resolved} 张。`);
    notes.push(`预测和实际平均差 ${total.mae.toFixed(1)} 分钟，命中 ${Math.round(total.hitRate * 100)}%（差 10 分钟以内或 30% 以内算命中）。`);
    const miss = rows.filter((x) => !x.hit).sort((a, b) => Math.abs(b.actual - b.predicted) - Math.abs(a.actual - a.predicted))[0];
    if (miss) notes.push(`差得最多的是 ${clock(miss.t)}「${miss.title}」：预测${miss.metric.replace('分钟', '')} ${Math.round(miss.predicted)} 分钟，实际 ${Math.round(miss.actual)} 分钟。`);
    const bad = rows.filter((x) => (x.status === 'rejected' || x.status === 'expired') && x.actual > 5);
    if (bad.length) notes.push(`${bad.length} 张没执行的卡问题真的发生了（合计 ${Math.round(bad.reduce((a, x) => a + x.actual, 0))} 分钟），可以看看当时为什么没处理。`);
  }
  return { rows, byKind, total, notes };
}
