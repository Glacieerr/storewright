import { STORE } from '../region/network';
import type { BoardOp } from '../sim/board';
import type { KpiPoint } from '../twin/loop';
import { clock } from '../twin/twin';
import type { Cmd, Rec } from '../twin/types';
import { ISSUE_LABEL } from '../twin/types';
import { statusAt } from './brief';
import { soldOutAt } from './context';
import type { AssistCtx } from './types';

/**
 * 交接班报告：按班次把调度台和闭环孪生的数据整理成一页，交代本班的结果、发生的事、没处理完的、下一班要注意的。
 * 只用到报告时刻（班次结束，或者班次还没结束时的此刻）以前的数据；「下一班要注意」用的是计划（调度台和孪生的估计）。
 */
export interface Shift {
  key: 'dawn' | 'day' | 'mid' | 'night';
  name: string;
  from: number;
  to: number;
}
export const SHIFTS: Shift[] = [
  { key: 'dawn', name: '凌晨', from: 0, to: 6 * 3600 },
  { key: 'day', name: '早班', from: 6 * 3600, to: 14 * 3600 },
  { key: 'mid', name: '中班', from: 14 * 3600, to: 22 * 3600 },
  { key: 'night', name: '夜班', from: 22 * 3600, to: 26 * 3600 },
];
export const shiftAt = (t: number): Shift => SHIFTS.find((s) => t >= s.from && t < s.to) ?? (SHIFTS[3] as Shift);
/** 交接班报告默认写哪一班：班次刚开始半小时内，写刚结束的那一班 */
export const reportShift = (t: number): Shift => {
  const s = shiftAt(t);
  const i = SHIFTS.indexOf(s);
  return t - s.from < 1800 && i > 0 ? (SHIFTS[i - 1] as Shift) : s;
};

export interface Handover {
  shift: Shift;
  /** 报告截至的时刻 */
  asOf: number;
  title: string;
  /** 一句话的摘要（值班助手的回答用） */
  summary: string;
  sections: { title: string; lines: string[] }[];
  markdown: string;
}

const CMD_LABEL: Record<Cmd['kind'], string> = { notifyStore: '通知门店顺延', resequence: '调整送货顺序', rescue: '派救援车', driverCheck: '提醒司机检查', setpoint: '调冷机设定温度', reassignDoor: '改月台门', restock: '追加补货', divert: '改去处', hold: '让车晚点到' };
const STATUS_LABEL: Record<Rec['status'], string> = { proposed: '还待处理', done: '已执行', rejected: '调度员否了', resolved: '问题自己没了', expired: '没处理，问题发生了' };
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const hm = (a: number, b: number) => `${clock(a)}–${b >= 24 * 3600 ? `次日 ${clock(b)}` : clock(b)}`;

function kpiAt(series: readonly KpiPoint[] | undefined, t: number): KpiPoint | undefined {
  if (!series?.length) return undefined;
  let p: KpiPoint | undefined;
  for (const x of series) if (x.t <= t) p = x;
  return p ?? { t: 0, late: 0, hot: 0, short: 0, cost: 0, lateStops: 0, door: 0, dock: 0 };
}
const diff = (a: KpiPoint | undefined, b: KpiPoint | undefined) => (a && b ? { late: a.late - b.late, hot: a.hot - b.hot, short: a.short - b.short, cost: a.cost - b.cost, lateStops: a.lateStops - b.lateStops, door: a.door - b.door, dock: a.dock - b.dock } : undefined);
const score = (k: { late: number; hot: number; short: number; cost: number }) => k.late + k.hot * 2 + k.short * 1.5 + k.cost / 12;

export function handover(ctx: AssistCtx, shift: Shift = shiftAt(ctx.t)): Handover {
  const end = Math.min(shift.to, Math.max(shift.from, ctx.t));
  const live = ctx.t < shift.to;
  const twin = ctx.twin;
  const r = twin?.result;
  const sections: { title: string; lines: string[] }[] = [];

  // —— 概况：本班到门店的车、准点、现场的结果（用孪生），和不用孪生比 ——
  const storeStops = ctx.board.ops.flatMap((o) => (o.stops ?? []).filter((s) => s.key === STORE.key).map((s) => ({ o, s })));
  const arrived = storeStops.filter((x) => x.s.arrive >= shift.from && x.s.arrive < end);
  const field = r ? r.stops.filter((x) => x.store === STORE.key && x.t >= shift.from && x.t < end) : [];
  const late = r ? field.filter((x) => x.late > 0.5) : arrived.filter((x) => !x.s.onTime);
  const k = diff(kpiAt(r?.series, end), kpiAt(r?.series, shift.from));
  const ko = diff(kpiAt(twin?.open?.series, end), kpiAt(twin?.open?.series, shift.from));
  const head: string[] = [];
  const count = r ? field.length : arrived.length;
  head.push(count ? `${STORE.name}到货 ${count} 车次，准点 ${count - late.length} 车次（${Math.round(((count - late.length) / count) * 100)}%）${late.length ? `；晚了 ${late.length} 车次` : ''}` : `本班没有车到${STORE.name}`);
  if (k) {
    head.push(`现场结果：迟到 ${n0(k.late)} 分钟，超温 ${n0(k.hot)} 分钟，缺货 ${n0(k.short)} 分钟，等月台门 ${n0(k.door)} 分钟，等收货口 ${n0(k.dock)} 分钟，处理措施多花 $${n0(k.cost)}`);
    if (ko) {
      const d = score(ko) - score(k);
      const acted = (twin?.cmds ?? []).some((c) => c.t >= shift.from && c.t < end);
      head.push(d > 0.5 ? `和不用孪生（同样的现场）比，合计分少 ${n0(d)}（迟到少 ${n0(ko.late - k.late)} 分钟，超温少 ${n0(ko.hot - k.hot)} 分钟，缺货少 ${n0(ko.short - k.short)} 分钟）` : `和不用孪生比没有差别（${acted ? '本班执行的措施没有改变结果' : '本班没有执行孪生的建议'}）`);
    }
  } else head.push('闭环孪生还没跑，现场结果按计划算');
  const deliveries = ctx.board.ops.filter((o) => o.kind === 'delivery' && (o.depart ?? o.t0) >= shift.from && (o.depart ?? o.t0) < end).length;
  if (deliveries) head.push(`配送中心发车 ${deliveries} 车次`);
  sections.push({ title: '概况', lines: head });

  // —— 本班发生的事：建议卡（出卡时刻在本班）和处理结果、路况、发出的指令 ——
  const happened: string[] = [];
  const recs = (twin?.recs ?? []).filter((x) => x.t >= shift.from && x.t < end);
  for (const x of recs) {
    const st = statusAt(x, end);
    const chosen = st === 'done' ? x.options.find((o) => o.key === x.chosen)?.label : undefined;
    happened.push(`${clock(x.t)} ${ISSUE_LABEL[x.kind]}：${x.title} → ${st === 'done' ? `${x.by === 'user' ? '调度员' : '自动'}执行「${chosen ?? x.chosen ?? ''}」` : STATUS_LABEL[st]}`);
  }
  for (const x of twin?.incidents ?? []) if (x.t0 >= shift.from && x.t0 < end) happened.push(`${clock(x.t0)} 路况：${x.text}（到 ${clock(x.t1)}）`);
  const cmds = (twin?.cmds ?? []).filter((c) => c.t >= shift.from && c.t < end);
  if (cmds.length) {
    const by = new Map<string, number>();
    for (const c of cmds) by.set(CMD_LABEL[c.kind], (by.get(CMD_LABEL[c.kind]) ?? 0) + 1);
    const acks = (twin?.events ?? []).filter((e) => e.ev === 'ack' && e.t >= shift.from && e.t < end).length;
    happened.push(`发出指令 ${cmds.length} 条：${[...by].map(([l, n]) => `${l} ${n}`).join('、')}；现场回执 ${acks} 条`);
  }
  for (const e of twin?.events ?? []) if (e.ev === 'fault' && e.t >= shift.from && e.t < end && !recs.some((x) => x.vid === e.vid)) happened.push(`${clock(e.t)} 车载终端报故障：${e.note ?? ''}`);
  sections.push({ title: '本班发生的事', lines: happened.length ? happened.sort() : ['没有异常'] });

  // —— 交给下一班：还待处理的建议卡、还在路上晚点的车、没结束的路况 ——
  const left: string[] = [];
  for (const x of (twin?.recs ?? []).filter((y) => y.t < end && statusAt(y, end) === 'proposed')) left.push(`待处理的建议卡：${x.title}（推荐「${x.options[x.best]?.label ?? ''}」）`);
  if (r) {
    const minute = Math.floor(end / 60);
    r.vids.forEach((vid, i) => {
      const d = r.delays[i]?.[minute];
      if (d === undefined || !Number.isFinite(d) || d < 600) return;
      const op = ctx.board.ops.find((o) => o.vehicle === vid);
      left.push(`${op?.id ?? r.vehicles[i]?.label ?? `车 ${vid}`} 还在路上，晚了 ${Math.round(d / 60)} 分钟`);
    });
  } else
    for (const v of ctx.rows) if ((v.delayMin ?? 0) >= 10 && v.status === 'moving') left.push(`${v.id} 还在路上，晚了 ${v.delayMin} 分钟`);
  for (const x of twin?.incidents ?? []) if (x.t0 < end && x.t1 > end) left.push(`路况还没结束：${x.text}（预计到 ${clock(x.t1)}）`);
  sections.push({ title: '交给下一班', lines: left.length ? left : ['没有遗留的问题'] });

  // —— 下一班要注意（下一班的 8 小时，按计划）；班还没结束时先列本班剩下的时间 ——
  const watch = (n0t: number, n1t: number): string[] => {
    const next: string[] = [];
    const inNext = (o: BoardOp, at: number | undefined) => at !== undefined && at >= n0t && at < n1t;
    for (const o of ctx.board.ops) {
      if (o.kind === 'vessel' && o.dock && inNext(o, o.dock[1])) next.push(`${o.id} ${o.label} 预计 ${clock(o.dock[1])} 完工离港`);
      if (o.kind === 'vessel' && inNext(o, o.arrive ?? o.t0)) next.push(`${o.id} ${o.label} 预计 ${clock(o.arrive ?? o.t0)} 靠泊`);
      if (o.kind === 'flight' && inNext(o, o.arrive ?? o.t0)) next.push(`${o.id} ${o.label} 预计 ${clock(o.arrive ?? o.t0)} 落地`);
      if (o.kind === 'train' && inNext(o, o.arrive ?? o.t0)) next.push(`${o.id} ${o.label} 预计 ${clock(o.arrive ?? o.t0)} 到站`);
    }
    const coming = storeStops.filter((x) => x.s.arrive >= n0t && x.s.arrive < n1t);
    if (coming.length) {
      const byHour = new Map<number, number>();
      for (const x of coming) byHour.set(Math.floor(x.s.arrive / 3600), (byHour.get(Math.floor(x.s.arrive / 3600)) ?? 0) + 1);
      const [ph, pn] = [...byHour].sort((a, b) => b[1] - a[1])[0] as [number, number];
      next.push(`${STORE.name}还要到 ${coming.length} 车次（${clock((coming[0] as (typeof coming)[number]).s.arrive)} 起），${pn > 1 ? `高峰 ${clock(ph * 3600)}–${clock((ph + 1) * 3600)} 有 ${pn} 车` : '比较分散'}`);
    }
    for (const i of ctx.board.issues) if (i.level !== 'info' && i.at >= n0t && i.at < n1t) next.push(`${clock(i.at)} ${i.title}：${i.text}${i.fix ? `（可以「${i.fix.text}」）` : ''}`);
    if (r) {
      const slot = Math.max(0, Math.floor(end / 300) - 1);
      for (const s of twin?.stock ?? []) {
        const series = r.stocks.get(s.fam);
        const have = series ? (series.est[Math.min(series.est.length - 1, slot)] ?? s.units) : s.units;
        const at = soldOutAt(have, s.daily, end);
        if (at !== undefined && at >= n0t && at < n1t && at < 22 * 3600) next.push(`${s.label}按每小时的卖货曲线约 ${clock(at)} 卖空（孪生估计还有 ${n0(have)} 件），注意补货`);
      }
    }
    return next;
  };
  if (live) {
    const rest = watch(end, shift.to);
    sections.push({ title: `本班剩下的时间要注意（${hm(end, shift.to)}）`, lines: rest.length ? rest : ['按计划没有特别要注意的'] });
  }
  const next = watch(shift.to, shift.to + 8 * 3600);
  sections.push({ title: `下一班要注意（${hm(shift.to, shift.to + 8 * 3600)}）`, lines: next.length ? next : ['按计划没有特别要注意的'] });

  const title = `交接班报告 · ${shift.name}（${hm(shift.from, shift.to)}）`;
  const asOf = live ? `截至 ${clock(end)}（本班还没结束）` : `班次结束 ${clock(end)}`;
  const markdown = [`# ${title}`, '', asOf, '', ...sections.flatMap((s) => [`## ${s.title}`, '', ...s.lines.map((l) => `- ${l}`), ''])].join('\n');
  const summary = `${shift.name}${live ? `（截至 ${clock(end)}）` : ''}：${head[0]}；${recs.length ? `出了 ${recs.length} 张建议卡` : '没有建议卡'}${left.length ? `，遗留 ${left.length} 件事` : '，没有遗留'}。`;
  return { shift, asOf: end, title, summary, sections, markdown };
}
