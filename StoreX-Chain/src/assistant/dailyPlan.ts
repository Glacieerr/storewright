import { forecastDelay, forecastDemand, forecastReport } from '../analysis/forecast';
import { TRACE_DAY } from '../analysis/studies';
import { activityFromBoard } from '../facility/staffing';
import { STORE } from '../region/network';
import { FAMILIES } from '../region/products';
import { clock } from '../twin/twin';
import { pendingCards } from './brief';
import { bottlenecks } from './hubs';
import { dataQuality } from './quality';
import type { AssistCtx } from './types';

/**
 * 今日计划（早会用）：今天到店的车、港口 / 机场 / 班列、月台门和收货口最忙的时段、人手提示、风险和预测、已经知道的问题。
 * 和交接班报告放在一起：交接班看「发生了什么」，今日计划看「今天会怎样」。只用计划、预测和此刻以前的现场数据。
 */
export interface DailyPlan {
  title: string;
  asOf: number;
  summary: string;
  sections: { title: string; lines: string[] }[];
  markdown: string;
  /** 回答里用到的数字（核对数字的出处用） */
  nums: Record<string, number>;
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const peakOf = (xs: readonly number[]) => xs.reduce((best, v, h) => (v > (xs[best] ?? -Infinity) ? h : best), 0);
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function dailyPlan(ctx: AssistCtx): DailyPlan {
  const t = ctx.t;
  const nums: Record<string, number> = { t };
  const sections: DailyPlan['sections'] = [];

  // —— 到店 ——
  const stops = ctx.board.ops.flatMap((o) => (o.stops ?? []).filter((s) => s.key === STORE.key).map((s) => ({ o, s })));
  const byHour = new Array<number>(24).fill(0);
  for (const { s } of stops) {
    const h = Math.min(23, Math.max(0, Math.floor(s.arrive / 3600)));
    byHour[h] = (byHour[h] as number) + 1;
  }
  const ph = peakOf(byHour);
  const direct = stops.filter((x) => x.o.kind === 'direct');
  const planLate = stops.filter((x) => !x.s.onTime);
  Object.assign(nums, { stops: stops.length, peakHour: ph, peakStops: byHour[ph] ?? 0, direct: direct.length, planLate: planLate.length });
  const arrive: string[] = [`今天计划到${STORE.name} ${stops.length} 车次，最集中的是 ${hh(ph)}–${hh(ph + 1)}（${byHour[ph]} 车）；其中长途直送 ${direct.length} 车。`];
  if (stops.length) arrive.push(`第一车 ${clock(Math.min(...stops.map((x) => x.s.arrive)))} 到，最后一车 ${clock(Math.max(...stops.map((x) => x.s.arrive)))} 到。`);
  if (planLate.length) arrive.push(`按计划有 ${planLate.length} 车赶不上收货截止：${planLate.slice(0, 3).map((x) => `${x.o.id}（${clock(x.s.arrive)} 到）`).join('、')}。`);
  sections.push({ title: '今天到店的车', lines: arrive });

  // —— 港口、机场、班列 ——
  const big = ctx.board.ops.filter((o) => o.kind === 'vessel' || o.kind === 'flight' || o.kind === 'train').sort((a, b) => (a.arrive ?? a.t0) - (b.arrive ?? b.t0));
  const KIND: Record<string, string> = { vessel: '班轮', flight: '货运航班', train: '班列' };
  sections.push({ title: '港口、机场、班列', lines: big.length ? big.slice(0, 6).map((o) => `${clock(o.arrive ?? o.t0)} ${KIND[o.kind]} ${o.id}：${o.label}${o.dock ? `，${clock(o.dock[0])}–${clock(o.dock[1])} 作业` : ''}`) : ['今天没有本店的班轮、航班、班列。'] });

  // —— 月台门、收货口、仓储中心 ——
  const act = activityFromBoard(ctx.board, STORE.key, 0);
  const dc = act.dc as NonNullable<typeof act.dc>;
  const st = act.store as NonNullable<typeof act.store>;
  const dh = peakOf(dc.doors);
  const sh = peakOf(st.pallets);
  Object.assign(nums, { dcPeakHour: dh, dcPeakDoors: dc.doors[dh] ?? 0, dcPeakPallets: dc.pallets[dh] ?? 0, storePeakHour: sh, storePeakPallets: st.pallets[sh] ?? 0, coldPeak: ctx.board.kpi.doorPeak.cold ?? 0, dryPeak: ctx.board.kpi.doorPeak.dry ?? 0 });
  const load = [`配送中心月台 ${hh(dh)} 最忙：同时 ${dc.doors[dh]} 樘门在作业、这一小时进出 ${n0(dc.pallets[dh] ?? 0)} 托；全天最多同时用冷链门 ${ctx.board.kpi.doorPeak.cold} 樘、干货门 ${ctx.board.kpi.doorPeak.dry} 樘。`, `${STORE.name}收货 ${hh(sh)} 最忙：这一小时到店 ${n0(st.pallets[sh] ?? 0)} 托。`];
  for (const d of ctx.hubs?.() ?? []) {
    const b = bottlenecks(d, t).zones[0];
    if (b && b.peakUtil >= 0.7) {
      load.push(`${d.label}：${b.zone.label}最满在 ${clock(b.peakAt)}（容量的 ${Math.round(b.peakUtil * 100)}%）。`);
      nums[`hub_${d.key}`] = b.peakUtil;
    }
  }
  sections.push({ title: '月台门、收货口和仓储中心', lines: load });

  // —— 人手提示（和管理台按作业量排班同一套算法：同时作业的门每樘 1 人 + 每 40 托 1 人） ——
  const fork = dc.doors.map((d, h) => d + Math.ceil((dc.pallets[h] as number) / 40 - 1e-9));
  const fh = peakOf(fork);
  const recv = st.docks;
  const rh = peakOf(recv);
  Object.assign(nums, { forkPeak: fork[fh] ?? 0, forkHour: fh, recvPeak: recv[rh] ?? 0, recvHour: rh });
  sections.push({ title: '人手提示', lines: [`配送中心叉车 ${hh(fh)} 最多要 ${fork[fh]} 人（同时作业的门每樘 1 人，每小时每 40 托再加 1 人）。`, `${STORE.name}收货 ${hh(rh)} 最多同时卸 ${recv[rh]} 车，收货口每辆车 1 人。`, '具体的班次人数在管理台「按作业量排班」里求解（三班人数和交接加班一起算）。'] });

  // —— 风险和预测 ——
  const risk: string[] = [];
  if (forecastReport()) {
    const v = forecastDelay('vessel');
    const tr = forecastDelay('train');
    if (v) {
      risk.push(`本店班轮预计比船期晚 ${v.hours.toFixed(1)} 小时（九成不超过 ${v.p90.toFixed(1)} 小时，${v.model}）。`);
      Object.assign(nums, { vesselH: v.hours, vesselP90: v.p90 });
    }
    if (tr) {
      risk.push(`洲际班列预计晚 ${tr.hours.toFixed(1)} 小时（九成不超过 ${tr.p90.toFixed(1)} 小时，${tr.model}）。`);
      Object.assign(nums, { trainH: tr.hours, trainP90: tr.p90 });
    }
    const fams = ['DAIRY', 'PROD_LOCAL', 'MEAT'];
    const f = fams.flatMap((k) => {
      const n = forecastDemand(k, TRACE_DAY);
      if (n !== undefined) nums[`dem_${k}`] = n;
      return n !== undefined ? [`${FAMILIES.find((x) => x.key === k)?.label ?? k} 约 ${n0(n)} 件`] : [];
    });
    if (f.length) risk.push(`今天的销量预测：${f.join('、')}。`);
  } else risk.push('预测模型还没训练（「对比与报告」页的「预测」一节），这里先不给班轮、班列的晚点预测。');
  const errs = ctx.board.issues.filter((i) => i.level === 'error');
  nums.errors = errs.length;
  if (errs.length) risk.push(`调度台有 ${errs.length} 个要处理的问题：${errs.slice(0, 3).map((i) => `${clock(i.at)} ${i.title}`).join('；')}。`);
  if (ctx.drill) risk.push(`今天在演练「${ctx.drill.label}」：${ctx.drill.detail}。`);
  const dq = dataQuality(ctx);
  if (dq.level === 'fair' || dq.level === 'poor') risk.push(dq.text);
  sections.push({ title: '风险和预测', lines: risk.length ? risk : ['眼下没有特别的风险。'] });

  // —— 已经知道的问题 ——
  const pend = pendingCards(ctx);
  const inc = (ctx.twin?.incidents ?? []).filter((x) => x.t0 <= t && x.t1 > t);
  nums.pending = pend.length;
  nums.incidents = inc.length;
  const known: string[] = [];
  if (pend.length) known.push(`待处理的建议 ${pend.length} 张：${pend.slice(0, 3).map((r) => r.title).join('；')}。`);
  if (inc.length) known.push(`进行中的路况 ${inc.length} 处：${inc.map((x) => x.text).join('；')}。`);
  sections.push({ title: '已经知道的问题', lines: known.length ? known : [ctx.twin ? '此刻没有待处理的建议和路况。' : '闭环孪生还没跑，现场的问题要等它跑完。'] });

  const title = `今日计划 · ${STORE.name}（${clock(t)}）`;
  const summary = `今天计划到店 ${stops.length} 车次，${hh(ph)} 最集中；配送中心月台 ${hh(dh)} 最忙、门店收货 ${hh(sh)} 最忙${pend.length ? `；此刻有 ${pend.length} 张待处理的建议` : ''}。`;
  const markdown = [`# ${title}`, '', ...sections.flatMap((s) => [`## ${s.title}`, ...s.lines.map((l) => `- ${l}`), ''])].join('\n');
  return { title, asOf: t, summary, sections, markdown, nums };
}
