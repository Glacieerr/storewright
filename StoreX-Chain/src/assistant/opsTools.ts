import type { HubDay, HubKey } from '../hub/types';
import { STORE } from '../region/network';
import { clock } from '../twin/twin';
import { detectAnomalies } from './anomaly';
import { dailyPlan } from './dailyPlan';
import { bottlenecks, HUB_FAC, HUB_LABEL, ownStates, planAppointments, zonesNow } from './hubs';
import { HARD, RULES } from './policy';
import { yardAppointments } from './yardAppt';
import { dataQuality } from './quality';
import { explainStore, explainVehicle } from './rca';
import { LIMIT, ROLE_LABEL } from './roles';
import type { Memory, ToolDef } from './tools';
import type { AssistCtx, Link, Proposal, ToolResult } from './types';

/**
 * 值班助手的第二批工具：晚点归因、异常检测、仓储中心（占用、本店的货、瓶颈、预约错峰）、今日计划、数据质量、规则表。
 * 和第一批一样只读；要改的只给提议（预约错峰是通知承运商，孪生里不改数据）。数字都放进结构化结果（data），
 * 回答里的每个数字都能在 data 里找到出处（grounding.ts 核对）。
 */
type Args = Record<string, unknown>;
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const TWIN_CITE = '闭环孪生（现场的感知数据和孪生的估计）';
const HUB_CITE = '仓储中心的作业计划（设施作业模型，和三维画面同一份）';
const noTwin = '闭环孪生还没跑完，这里先按计划回答。';
const result = (tool: string, args: Args, text: string, cite: string, extra: Partial<ToolResult> = {}, data: Record<string, unknown> = {}): ToolResult => ({ tool, args, data, text, cite, ...extra });
const vehLink = (vid: number, label: string): Link => ({ kind: 'vehicle', vid, label });
const HUB_KEYS: HubKey[] = ['port', 'airport', 'park', 'store'];
const hubName = (k: HubKey, d?: HubDay) => d?.label ?? HUB_LABEL[k];
const missingHubs = '仓储中心的作业计划没接上（这个设施的作业计划没接上），';

// —— 晚点归因 ——

function explainDelay(ctx: AssistCtx, args: Args, mem: Memory): ToolResult {
  const vid = args.vid !== undefined ? Number(args.vid) : undefined;
  if (vid === undefined || Number.isNaN(vid)) return storeDelay(ctx, args);
  mem.vehicles = [vid];
  const row = ctx.rows.find((r) => r.vid === vid);
  const op = ctx.board.ops.find((o) => o.vehicle === vid);
  const id = row?.id ?? op?.id ?? String(args.id ?? '');
  if (!ctx.twin) {
    const issues = (op?.issues ?? []).filter((i) => i.level !== 'info');
    return result('explain_delay', args, `${noTwin}${id}：${issues.length ? issues.map((i) => `${i.title}，${i.text}`).join('；') : '按计划没有晚点的问题'}。现场为什么晚要等闭环孪生的数据。`, '调度台（当天的计划）', {}, { id, issues: issues.map((i) => i.text) });
  }
  const x = explainVehicle(ctx, vid);
  if (!x) return result('explain_delay', args, `${id} 还没有现场记录（还没出发，或者不在跟踪的车里），说不了晚在哪里。`, TWIN_CITE, { links: [vehLink(vid, `看 ${id}`)] }, { id });
  const lines: string[] = [];
  const at = x.store ? `到店开始卸货时（${clock(x.asOf)}）` : `到此刻（${clock(x.asOf)}）`;
  if (x.delayMin < 1) lines.push(`${id} ${at}按计划在走，没有晚（比计划${x.delayMin < -0.5 ? `早 ${n0(-x.delayMin)} 分钟` : '差不到 1 分钟'}）。`);
  else {
    lines.push(`${id} ${at}比计划晚了 ${n0(x.delayMin)} 分钟，原因（逐分钟归因，加起来等于总数）：`);
    for (const p of [...x.parts].sort((a, b) => b.min - a.min)) lines.push(`- ${p.label}：${p.min < 0 ? '−' : ''}${n0(Math.abs(p.min))} 分钟${p.detail ? `（${p.detail}）` : ''}`);
  }
  if (x.store) lines.push(`到店：${clock(x.store.t)} 开始卸货，收货截止 ${clock(x.store.close)}，${x.store.late > 0.5 ? `晚 ${n0(x.store.late)} 分钟` : '没晚'}；${x.store.slackMin >= 0 ? `计划离截止有 ${n0(x.store.slackMin)} 分钟余量` : `计划本身就晚 ${n0(-x.store.slackMin)} 分钟`}。`);
  if (x.rescuedBy !== undefined) lines.push(`车上的货改由救援车 ${ctx.rows.find((r) => r.vid === x.rescuedBy)?.id ?? `车 ${x.rescuedBy}`} 送。`);
  lines.push(...x.notes);
  const top = [...x.parts].sort((a, b) => b.min - a.min)[0];
  return result(
    'explain_delay',
    args,
    lines.join('\n'),
    `${TWIN_CITE}：每分钟的延误、车载终端事件、路况、调度指令`,
    { links: [vehLink(vid, `看 ${id}`), { kind: 'time', t: x.asOf, label: `跳到 ${clock(x.asOf)}` }], followups: ['现在有什么风险', '门店今天为什么晚'], ...(top && x.delayMin >= 1 ? { conclusion: `${id} 比计划晚 ${n0(x.delayMin)} 分钟，主要是${top.label}（${n0(top.min)} 分钟）。` } : {}) },
    { ...x, id },
  );
}

function storeDelay(ctx: AssistCtx, args: Args): ToolResult {
  if (!ctx.twin) return result('explain_delay', args, `${noTwin}按计划，${STORE.name}今天${ctx.board.kpi.late ? `有 ${ctx.board.kpi.late} 站赶不上收货截止` : '的到货都赶得上收货截止'}。现场为什么晚要等闭环孪生的数据。`, '调度台（当天的计划）', {}, { late: ctx.board.kpi.late });
  const s = explainStore(ctx);
  if (!s || !s.stops.length) return result('explain_delay', args, `到此刻（${clock(ctx.t)}）${STORE.name}没有车到店晚了（按收货截止算）。`, TWIN_CITE, { followups: ['哪些车会晚'] }, { lateMin: 0 });
  const absorbed = s.delayMin - s.lateMin;
  const lines = [`到此刻（${clock(ctx.t)}）${STORE.name}有 ${s.stops.length} 车到店晚了，按收货截止合计晚 ${n0(s.lateMin)} 分钟（比计划合计晚 ${n0(s.delayMin)} 分钟${absorbed >= 1 ? `，计划里的余量吸收了 ${n0(absorbed)} 分钟` : absorbed <= -1 ? `，另外 ${n0(-absorbed)} 分钟是计划本身就排晚了` : ''}）。原因合计：`];
  for (const p of s.total) lines.push(`- ${p.label}：${p.min < 0 ? '−' : ''}${n0(Math.abs(p.min))} 分钟`);
  const worst = [...s.stops].sort((a, b) => (b.store?.late ?? 0) - (a.store?.late ?? 0)).slice(0, 3);
  lines.push(`晚得最多的：${worst.map((x) => { const top = [...x.parts].sort((a, b) => b.min - a.min)[0]; return `${x.id} 晚 ${n0(x.store?.late ?? 0)} 分钟${top ? `（主要是${top.label} ${n0(top.min)} 分钟）` : ''}`; }).join('；')}。`);
  const top = s.total[0];
  return result('explain_delay', args, lines.join('\n'), `${TWIN_CITE}：每分钟的延误、车载终端事件、路况、调度指令`, { links: worst.map((x) => vehLink(x.vid, `看 ${x.id}`)), followups: worst[0] ? [`${worst[0].id} 为什么晚`] : [], ...(top ? { conclusion: `${STORE.name}到此刻 ${s.stops.length} 车晚到、合计 ${n0(s.lateMin)} 分钟，最大的原因是${top.label}（${n0(top.min)} 分钟）。` } : {}) }, { count: s.stops.length, stops: s.stops.map((x) => ({ id: x.id, delayMin: x.delayMin, late: x.store?.late, parts: x.parts })), total: s.total, lateMin: s.lateMin, delayMin: s.delayMin, absorbed });
}

// —— 异常检测 ——

function anomalies(ctx: AssistCtx, args: Args): ToolResult {
  const hub = args.hub as HubKey | undefined;
  const list = detectAnomalies(ctx, hub);
  const dq = dataQuality(ctx);
  const scope = hub ? hubName(hub, ctx.hubs?.().find((d) => d.key === hub)) : '链路';
  if (!list.length) {
    const why = !ctx.twin && !hub ? noTwin : hub && !ctx.hubs ? missingHubs : '';
    return result('detect_anomalies', args, `${why}到此刻（${clock(ctx.t)}）${scope}没有发现明显的异常：${hub ? '各个区的占用都在容量的 85% 以下，也没有突然涨' : '各项指标每 15 分钟和前 3 小时比都在平时的范围里'}。${dq.level === 'poor' ? dq.text : ''}`, ctx.twin ? TWIN_CITE : '调度台（当天的计划）', { followups: ['现在有什么风险'] }, { anomalies: [], constants: [15, 3, 85] });
  }
  const lines = [`到此刻（${clock(ctx.t)}）${scope}发现 ${list.length} 处异常（只用此刻以前的数据，严重的在前）：`];
  for (const a of list) {
    const val = Number.isFinite(a.value) ? `：${a.unit === '%' ? `${Math.round(a.value)}%` : `${n0(a.value)} ${a.unit}`}${Number.isFinite(a.baseline) ? `（平时约 ${a.unit === '%' ? `${Math.round(a.baseline)}%` : `${n0(a.baseline)} ${a.unit}`}）` : ''}` : '';
    lines.push(`- 【${a.severity}】${a.source === 'board' ? '' : `${clock(a.t0)}–${clock(a.t1)} `}${a.label}${val}。${a.cause}`);
  }
  if (dq.level === 'poor' || dq.level === 'fair') lines.push(dq.text);
  return result('detect_anomalies', args, lines.join('\n'), `${ctx.twin ? `${TWIN_CITE}的累计指标` : ''}${ctx.hubs ? `${ctx.twin ? '、' : ''}${HUB_CITE}` : ''}${ctx.alerts ? '、分层看板' : ''}` || '调度台（当天的计划）', { links: list.flatMap((a) => a.links).slice(0, 5), followups: ['为什么晚', '现在有什么风险'] }, { anomalies: list.map((a) => ({ ...a, z: Number.isFinite(a.z) ? Math.round(a.z * 10) / 10 : undefined })) });
}

// —— 仓储中心 ——

function hubOf(ctx: AssistCtx, key: HubKey | undefined): HubDay | undefined {
  return key ? ctx.hubs?.().find((d) => d.key === key) : undefined;
}

function getHub(ctx: AssistCtx, args: Args): ToolResult {
  const key = args.hub as HubKey | undefined;
  if (!key) {
    // 没说是哪个：每个仓储中心列最满的三个区（要看全部区和指标再问那一个）
    const days = ctx.hubs?.() ?? [];
    if (!days.length) return result('get_hub', args, `${missingHubs}各个仓储中心的区、库位和排队现在查不到。`, HUB_CITE);
    const lines = [`各个仓储中心（${clock(ctx.t)}，每个列最满的几个区）：`];
    const hubs = days.map((d) => {
      const top = zonesNow(d, ctx.t).filter((z) => z.zone.capacity > 0).sort((a, b) => b.util - a.util || a.zone.key.localeCompare(b.zone.key)).slice(0, 3);
      lines.push(`- ${d.label}：${top.map((z) => `${z.zone.label} ${n0(z.now)} / ${n0(z.zone.capacity)} ${z.zone.unit}（${pct(z.util)}）`).join('；') || '没有容量数据'}`);
      return { hub: d.key, zones: top.map((z) => ({ key: z.zone.key, label: z.zone.label, capacity: z.zone.capacity, now: z.now, util: z.util })) };
    });
    lines.push('要看某一个的全部区、指标和本店的货，问「港口物流中心怎么样」这样的。');
    return result('get_hub', args, lines.join('\n'), HUB_CITE, { followups: days.slice(0, 4).map((d) => `${d.label}怎么样`) }, { hubs });
  }
  const d = hubOf(ctx, key);
  if (!d) {
    const snap = ctx.fac?.()[key === 'park' ? 'dc' : key];
    return result('get_hub', args, `${missingHubs}${snap ? `先按设施监控说：\n${snap.lines.map((l) => `- ${l}`).join('\n')}` : `${HUB_LABEL[key]}的区、库位和排队现在查不到。`}`, snap ? '设施监控' : HUB_CITE, { links: [{ kind: 'facility', fac: HUB_FAC[key], label: `打开${HUB_LABEL[key]}监控` }] }, { hub: key, lines: snap?.lines ?? [] });
  }
  const t = ctx.t;
  const zs = zonesNow(d, t);
  const lines = [`${d.label}（${clock(t)}）：`];
  for (const z of zs) lines.push(`- ${z.zone.label}：${z.zone.capacity > 0 ? `${n0(z.now)} / ${n0(z.zone.capacity)} ${z.zone.unit}（${pct(z.util)}）` : `${n0(z.now)} ${z.zone.unit}`}${z.zone.kind === 'queue' && z.flows ? `，${z.flows} 辆在排` : ''}`);
  if (d.kpi.length) lines.push(`指标：${d.kpi.map((k) => `${k.label} ${Number.isInteger(k.value) ? n0(k.value) : k.value.toFixed(1)} ${k.unit}`).join('；')}。`);
  const own = ownStates([d], t).filter((x) => x.state === 'in' || (x.state === 'coming' && x.next && x.next.t0 < t + 3 * 3600));
  if (own.length) {
    lines.push(`本店的货在这里 ${own.filter((x) => x.state === 'in').length} 件、3 小时内要来 ${own.filter((x) => x.state === 'coming').length} 件：`);
    for (const o of own.slice(0, 4)) lines.push(`- ${o.flow.label}：${o.cur ? `在${d.zones.find((z) => z.key === o.cur?.zone)?.label ?? o.cur.zone}（${clock(o.cur.t0)} 起，${o.cur.act}）` : '还没到'}${o.next ? `，下一步 ${clock(o.next.t0)} ${o.next.act}` : ''}`);
  }
  const full = zs.filter((z) => z.zone.capacity > 0 && z.util >= 0.85);
  if (full.length) lines.push(`接近满的：${full.map((z) => `${z.zone.label} ${pct(z.util)}`).join('、')}。`);
  return result('get_hub', args, lines.join('\n'), HUB_CITE, { links: [{ kind: 'facility', fac: HUB_FAC[key], label: `打开${d.label}监控` }], followups: [`${d.label}的瓶颈在哪`, '本店的货在哪'] }, { hub: key, zones: zs.map((z) => ({ key: z.zone.key, label: z.zone.label, capacity: z.zone.capacity, now: z.now, util: z.util, flows: z.flows })), kpi: d.kpi, own: own.map((o) => ({ label: o.flow.label, cur: o.cur, next: o.next })), constants: [85, 3] });
}

function traceOwn(ctx: AssistCtx, args: Args): ToolResult {
  const days = ctx.hubs?.();
  const q = args.id ? String(args.id) : undefined;
  if (!days?.length) {
    const boxes = ctx.containers?.() ?? [];
    if (boxes.length) return result('trace_own_cargo', args, `${missingHubs}按港口 EDI：${boxes.slice(0, 6).map((b) => `${b.id} ${b.state}（${clock(b.since)} 起${b.vehicle ? `，${b.vehicle}` : ''}）`).join('；')}。`, '港口 EDI', {}, { containers: boxes });
    return result('trace_own_cargo', args, `${missingHubs}本店的货在港口、机场、物流园的哪一步现在查不到；可以问「港口怎么样」「航班到了吗」看计划。`, HUB_CITE, { followups: ['港口怎么样', '航班到了吗'] });
  }
  const t = ctx.t;
  const list = ownStates(days, t, q);
  if (!list.length) return result('trace_own_cargo', args, q ? `没找到「${q}」：仓储中心的作业计划里没有这个编号或载具。` : `今天的作业计划里没有本店的货经过仓储中心。`, HUB_CITE);
  const lines = [`${q ? `「${q}」` : '本店的货'}在各个仓储中心（${clock(t)}）：`];
  const order = { in: 0, coming: 1, left: 2 } as const;
  const links: Link[] = [];
  for (const o of [...list].sort((a, b) => order[a.state] - order[b.state] || HUB_KEYS.indexOf(a.hub) - HUB_KEYS.indexOf(b.hub)).slice(0, 8)) {
    const zl = (k: string) => days.find((d) => d.key === o.hub)?.zones.find((z) => z.key === k)?.label ?? k;
    let s: string;
    if (o.state === 'in') s = `${o.cur ? `在${zl(o.cur.zone)}（${clock(o.cur.t0)} 起，${o.cur.act}）` : '在两步之间'}${o.next ? `，下一步 ${clock(o.next.t0)} ${zl(o.next.zone)}（${o.next.act}）` : '，接下来离开'}`;
    else if (o.state === 'coming') s = `还没到，${o.next ? `${clock(o.next.t0)} 进${zl(o.next.zone)}（${o.next.act}）` : ''}${o.flow.carrierIn ? `，从 ${o.flow.carrierIn} 卸下` : ''}`;
    else s = `已经离开（${clock((o.flow.steps[o.flow.steps.length - 1] as { t1: number }).t1)}${o.flow.carrierOut ? `，装上 ${o.flow.carrierOut}` : ''}）`;
    const after = o.flow.carrierOut ? ctx.board.byId.get(o.flow.carrierOut) : undefined;
    const chain = after ? `；接着 ${after.id} ${after.label.replace(/ · .*$/, '')}，${clock(after.depart ?? after.t0)} 出发${(after.stops ?? []).some((x) => x.key === STORE.key) ? `、${clock((after.stops ?? []).find((x) => x.key === STORE.key)?.arrive ?? after.t1)} 到${STORE.name}` : ''}` : '';
    if (after && after.vehicle >= 0 && links.length < 4) links.push(vehLink(after.vehicle, `看 ${after.id}`));
    lines.push(`- ${o.hubLabel} · ${o.flow.label}（${o.flow.units} ${o.flow.unit}）：${s}${chain}`);
  }
  if (list.length > 8) lines.push(`……还有 ${list.length - 8} 件。`);
  return result('trace_own_cargo', args, lines.join('\n'), `${HUB_CITE}、调度台`, { links, followups: ['哪里是瓶颈', '现在有什么风险'] }, { flows: list.map((o) => ({ hub: o.hub, id: o.flow.id, label: o.flow.label, units: o.flow.units, state: o.state, steps: o.flow.steps, carrierIn: o.flow.carrierIn, carrierOut: o.flow.carrierOut, next: o.flow.carrierOut ? ctx.board.byId.get(o.flow.carrierOut) && { id: o.flow.carrierOut, depart: ctx.board.byId.get(o.flow.carrierOut)?.depart, t0: ctx.board.byId.get(o.flow.carrierOut)?.t0, t1: ctx.board.byId.get(o.flow.carrierOut)?.t1, stops: ctx.board.byId.get(o.flow.carrierOut)?.stops?.map((x) => ({ key: x.key, arrive: x.arrive })) } : undefined })), count: list.length });
}

function hubBottlenecks(ctx: AssistCtx, args: Args): ToolResult {
  const days = ctx.hubs?.();
  const key = args.hub as HubKey | undefined;
  if (!days?.length) return result('hub_bottlenecks', args, `${missingHubs}瓶颈要按各个区的占用算，现在算不了；可以先看「现在有什么风险」。`, HUB_CITE, { followups: ['现在有什么风险'] });
  const t = ctx.t;
  const pick = key ? days.filter((d) => d.key === key) : days;
  if (!pick.length) return result('hub_bottlenecks', args, `${missingHubs}${HUB_LABEL[key as HubKey]}的作业计划现在查不到。`, HUB_CITE);
  const lines: string[] = [];
  const data: Record<string, unknown>[] = [];
  const proposals: Proposal[] = [];
  const when = (w: [number, number]) => (w[1] <= t ? '已经过去' : w[0] <= t ? '正在' : '还没到');
  for (const d of pick) {
    const b = bottlenecks(d, t);
    const top = b.zones.filter((z) => z.peakUtil >= 0.7).slice(0, 3);
    lines.push(`${d.label}（按整天的计划，${clock(t)}）：`);
    if (!top.length) lines.push('- 各个区最满也不到容量的 70%，没有瓶颈。');
    for (const z of top) lines.push(`- ${z.zone.label}：最满在 ${clock(z.peakAt)}（容量的 ${pct(z.peakUtil)}，此刻 ${pct(z.nowUtil)}）${z.windows.length ? `；超过 85% 的时段 ${z.windows.slice(0, 2).map((w) => `${clock(w[0])}–${clock(w[1])}（${when(w)}）`).join('、')}` : ''}`);
    for (const w of b.dwell.slice(0, 2)) lines.push(`- 停留最久：${w.flow.label}${w.flow.own ? '（本店）' : ''} 在${d.zones.find((z) => z.key === w.zone)?.label ?? w.zone}一共 ${(w.min / 60).toFixed(1)} 小时`);
    for (const q of b.queues.filter((x) => x.peak >= 1)) lines.push(`- ${q.zone.label}：最多同时 ${n0(q.peak)} 辆（${clock(q.at)}）`);
    const plan = b.queues.some((x) => x.peak >= 2) ? planAppointments(d, t) : undefined;
    if (plan && plan.moves.length && plan.after.peak < plan.before.peak) {
      lines.push(`- 预约错峰能把排队最多 ${plan.before.peak} 辆降到 ${plan.after.peak} 辆（挪 ${plan.moves.length} 车），问我「${d.label}预约错峰」看明细。`);
      data.push({ hub: d.key, before: plan.before, after: plan.after, moves: plan.moves.length });
    }
    data.push({ hub: d.key, zones: top.map((z) => ({ label: z.zone.label, peakUtil: z.peakUtil, peakAt: z.peakAt, nowUtil: z.nowUtil, windows: z.windows })), dwell: b.dwell.map((w) => ({ label: w.flow.label, min: w.min, hours: w.min / 60 })), queues: b.queues.map((q) => ({ label: q.zone.label, peak: q.peak, at: q.at })) });
  }
  return result('hub_bottlenecks', args, lines.join('\n'), HUB_CITE, { links: pick.map((d) => ({ kind: 'facility', fac: HUB_FAC[d.key], label: `打开${d.label}监控` }) as Link), proposals, followups: pick.map((d) => `${d.label}预约错峰`).slice(0, 2) }, { hubs: data, constants: [70, 85] });
}

/** 预约错峰的数是哪个模型算的（回答里写明） */
const QUEUE_MODEL = '先到先服务的排队模型估的（近似：只按月台数和每车占门的时间排，不排场内的进场、倒车）';
const YARD_MODEL = '场地排程器排出来的（按收货场的布置逐辆排场外等候、待命车道、进场调车、倒车靠台、拉出，和三维里的车走的同一份排程）';

function appointments(ctx: AssistCtx, args: Args): ToolResult {
  const key = args.hub as HubKey | undefined;
  const days = ctx.hubs?.();
  if (!days?.length) return result('plan_appointments', args, `${missingHubs}预约错峰要用车辆到达和月台的计划，现在算不了。`, HUB_CITE);
  const cands = key ? days.filter((d) => d.key === key) : days;
  // 没说是哪个：挑排队最长的那个
  const plans = cands.flatMap((d) => {
    const p = planAppointments(d, ctx.t);
    return p ? [p] : [];
  });
  if (!plans.length) return result('plan_appointments', args, `${key ? HUB_LABEL[key] : '各个仓储中心'}的作业计划里没有月台和排队车辆的数据，算不了预约错峰。`, HUB_CITE);
  const p = plans.sort((a, b) => b.before.peak - a.before.peak || b.before.waitMin - a.before.waitMin)[0] as (typeof plans)[number];
  // 有这个设施的场地布置（门店收货场）：挪之前、挪之后用场地排程器排；没有才用排队模型的数
  const yard = ctx.yards?.()[p.hub];
  const ya = yard ? yardAppointments(yard, p, ctx.t) : undefined;
  const before = ya?.before ?? p.before;
  const after = ya?.after ?? p.after;
  const moves = ya ? ya.moves : p.moves;
  const how = `数是${ya ? YARD_MODEL : QUEUE_MODEL}。`;
  const cite = `${HUB_CITE}；${ya ? '收货场的场地排程器（逐辆排进场、倒车、靠台）' : '先到先服务的排队模型（近似）'}`;
  const data = { ...p, model: ya ? 'yard' : 'queue', before, after, moves, ...(ya ? { queueModel: { before: p.before, after: p.after, moves: p.moves.length }, dropped: ya.dropped, yardTrucks: ya.trucks } : {}), constants: [HARD.apptLeadMin, HARD.reeferShiftMin, HARD.truckShiftMin, HARD.reeferWaitMin] };
  const head = `${p.label}的预约错峰（月台 ${p.doors} 樘；今天 ${p.trucks} 车，其中 ${p.movable} 车在 ${HARD.apptLeadMin} 分钟以后才到、还能改；排队只算此刻以后才到的车）：`;
  const stat = (a: number, b: number, unit: string) => `${n0(a)} → ${n0(b)} ${unit}`;
  if (!moves.length) {
    const text =
      ya && p.moves.length
        ? `${head}\n排队模型挑了 ${p.moves.length} 车可以挪，但按场地排程器逐辆排，挪了都不会更好（后面最多同时排 ${before.peak} 辆、合计等 ${n0(before.waitMin)} 分钟），不提议改预约；要临时多开月台或加人。`
        : before.peak < 2
          ? `${head}\n后面的车已经排得开：最多同时排 ${before.peak} 辆、合计等 ${n0(before.waitMin)} 分钟，不用挪。`
          : `${head}\n后面最多同时排 ${before.peak} 辆、合计等 ${n0(before.waitMin)} 分钟；在挪动的限度内（冷链车 ${HARD.reeferShiftMin} 分钟、普通车 ${HARD.truckShiftMin} 分钟）挪谁都不会更好，要临时多开月台或加人。`;
    return result('plan_appointments', args, `${text}\n${how}`, cite, {}, data);
  }
  const lines = [
    head,
    `- 排队最多同时 ${stat(before.peak, after.peak, '辆')}；合计等 ${stat(before.waitMin, after.waitMin, '分钟')}；最长等 ${stat(before.maxMin, after.maxMin, '分钟')}${before.coldMaxMin > 0 || after.coldMaxMin > 0 ? `；冷链车最长等 ${stat(before.coldMaxMin, after.coldMaxMin, '分钟')}` : ''}`,
    `- 挪 ${moves.length} 车：${moves.map((m) => `${m.label} ${clock(m.from)} → ${clock(m.to)}`).join('；')}`,
    ...(ya && ya.dropped ? [`- 排队模型还挑了 ${ya.dropped} 车，场地排程器排出来挪了不更好，没放进提议`] : []),
    `约束：只改 ${HARD.apptLeadMin} 分钟以后才到的车，冷链车最多挪 ${HARD.reeferShiftMin} 分钟、普通车 ${HARD.truckShiftMin} 分钟，冷链车挪完等待不超过 ${HARD.reeferWaitMin} 分钟。确认后把新的时段记进操作记录、通知承运商；孪生里不改到达时刻。`,
    how,
  ];
  const prop: Proposal = { id: `appt-${p.hub}-${ctx.t}`, title: `按错峰结果通知承运商改预约（${p.label}，${moves.length} 车）`, effect: `排队最多同时 ${before.peak} → ${after.peak} 辆，合计等 ${n0(before.waitMin)} → ${n0(after.waitMin)} 分钟（${ya ? '场地排程器' : '先到先服务的排队模型'}）`, actions: [{ kind: 'notify', to: '承运商（预约系统）', text: moves.map((m) => `${m.label}：${clock(m.from)} 改到 ${clock(m.to)}`).join('；'), hub: p.hub, moves }], risk: 'low', cost: 0 };
  return result('plan_appointments', args, lines.join('\n'), cite, { proposals: [prop], links: [{ kind: 'facility', fac: HUB_FAC[p.hub], label: `打开${p.label}监控` }] }, data);
}

// —— 今日计划、数据质量、规则表 ——

function daily(ctx: AssistCtx, args: Args): ToolResult {
  const p = dailyPlan(ctx);
  const lines = [p.summary, ...p.sections.map((s) => `${s.title}：${s.lines.slice(0, 2).join('')}`)];
  return result('daily_plan', args, lines.join('\n'), `调度台（当天的计划）${ctx.twin ? `、${TWIN_CITE}` : ''}${ctx.hubs ? `、${HUB_CITE}` : ''}、预测模型`, { links: [{ kind: 'panel', panel: 'dailyplan', label: '打开完整的今日计划' }], followups: ['现在有什么风险', '写交接班报告'], conclusion: p.summary }, { markdown: p.markdown, nums: p.nums, sections: p.sections, constants: [40, 1] });
}

function quality(ctx: AssistCtx, args: Args): ToolResult {
  const dq = dataQuality(ctx);
  const res = ctx.twin?.result;
  const lines = [`数据质量（${clock(ctx.t)}）：${dq.text}`];
  const eta = res?.fidelitySeries.filter((x) => x.t <= ctx.t && Number.isFinite(x.eta)).pop();
  if (eta) lines.push(`孪生的到店预测：到 ${clock(eta.t)}，提前一小时估计到店时刻的平均误差 ${eta.eta.toFixed(1)} 分钟。`);
  if (dq.level === 'poor') lines.push('对回答的影响：位置和到店时刻按孪生推算，误差会大一些；提议要先核实（问司机、看监控）再执行，只能逐条确认，不批量。');
  else if (dq.level === 'fair') lines.push('对回答的影响：偶尔丢点、晚到，孪生会按计划补上；到店时刻的误差略大。');
  else if (dq.level === 'plan') lines.push('对回答的影响：只能按调度台的计划回答，现场的晚点、货温、库存要等闭环孪生跑完。');
  else lines.push('对回答的影响：没有，回答按现场数据。');
  const q = res?.quality;
  return result('get_data_quality', args, lines.join('\n'), res ? `${TWIN_CITE}的数据通道统计` : '调度台（当天的计划）', { followups: ['现在有什么风险'] }, { level: dq.level, factor: dq.factor, drop: dq.drop, lateShare: q && q.sent ? q.late / q.sent : undefined, lateSec: dq.lateSec, maxGap: dq.maxGap, quality: q, eta: eta ? { t: eta.t, eta: eta.eta } : undefined });
}

function policy(ctx: AssistCtx, args: Args): ToolResult {
  const role = ctx.role ?? 'dispatcher';
  const can = role === 'viewer' ? '只能看和问，不能执行' : role === 'regional' ? '都能执行和审批' : `低风险的和多花不超过 $${LIMIT[role].toLocaleString('en-US')} 的可以直接执行，更贵的提交${role === 'dispatcher' ? '站长' : '区域经理'}审批`;
  const lines = [`你现在的角色是${ROLE_LABEL[role]}：${can}。规则表（每条提议显示之前都按它检查）：`, ...RULES.map((r) => `- ${r.label}：${r.text}`)];
  return result('get_policy', args, lines.join('\n'), '规则表（值班助手的护栏）', { followups: ['有什么待处理的建议'] }, { role, limits: LIMIT, hard: HARD, rules: RULES.map((r) => r.text) });
}

export const OPS_TOOLS: ToolDef[] = [
  { name: 'explain_delay', description: 'Root cause of lateness: for one vehicle, how many minutes behind plan it is and why (departure, door wait at the distribution center, loading, breakdown, road incidents, slower traffic, dwell, store dock wait, dispatch holds, warehouse queues), minute by minute so the parts add up; without a vehicle, the store-level breakdown of late arrivals so far.', parameters: { type: 'object', properties: { vid: { type: 'integer' }, id: { type: 'string' } } }, run: (c, a, m) => explainDelay(c, a, m) },
  { name: 'detect_anomalies', description: 'Anomalies so far (only data up to now): 15-minute increments of late, over-temperature, stock-out, door-wait, dock-wait minutes and twin cost compared with the previous 3 hours (EWMA baseline, robust z-score), twin ETA error, warehouse zone occupancy over 85% or sudden jumps, and open KPI board alerts, each with a time window and likely cause.', parameters: { type: 'object', properties: { hub: { type: 'string', enum: ['port', 'airport', 'park', 'store'] } } }, run: (c, a) => anomalies(c, a) },
  { name: 'get_hub', description: 'One warehousing hub now (port logistics center, airport cargo terminal, logistics park, store parking and receiving yard): every zone with occupancy versus capacity, queues, KPIs and our own cargo in it.', parameters: { type: 'object', properties: { hub: { type: 'string', enum: ['port', 'airport', 'park', 'store'] } }, required: ['hub'] }, run: (c, a) => getHub(c, a) },
  { name: 'trace_own_cargo', description: "Where our own cargo (containers, ULDs, pallets) is across the hubs: steps done, current step, next step, and the onward job from the dispatch board.", parameters: { type: 'object', properties: { id: { type: 'string', description: 'Container, ULD or job id; empty = all of our cargo' } } }, run: (c, a) => traceOwn(c, a) },
  { name: 'hub_bottlenecks', description: 'Bottlenecks of one or all hubs over the day plan: fullest zones with the windows over 85% of capacity, longest dwell, queue peaks, and whether appointment smoothing would help.', parameters: { type: 'object', properties: { hub: { type: 'string', enum: ['port', 'airport', 'park', 'store'] } } }, run: (c, a) => hubBottlenecks(c, a) },
  { name: 'plan_appointments', description: 'Appointment smoothing for a hub: shift arrival windows of trucks that arrive later than the lead time (reefer at most 30 minutes, others 60) to flatten the dock queue under door capacity and cold-chain limits; returns a proposal to notify carriers (a person confirms) with before/after queue peak and waiting minutes, computed with the yard scheduler when the site yard plan is available (store receiving yard), otherwise with the first-come-first-served queue model; the answer names the model.', parameters: { type: 'object', properties: { hub: { type: 'string', enum: ['port', 'airport', 'park', 'store'] } } }, run: (c, a) => appointments(c, a) },
  { name: 'daily_plan', description: "Today's plan for the morning meeting: store arrivals, vessels/flights/trains, busiest door and dock hours, staffing hint, risks with forecasts, and known open issues.", parameters: { type: 'object', properties: {} }, run: (c, a) => daily(c, a) },
  { name: 'get_data_quality', description: 'Data channel quality now (drop rate, late messages, longest gap), twin ETA error, and what that means for the answers and proposals.', parameters: { type: 'object', properties: {} }, run: (c, a) => quality(c, a) },
  { name: 'get_policy', description: "The guardrails: who may execute or approve what (by role and cost), hard constraints (cold chain, batch size, appointments) and the human-confirmation rule.", parameters: { type: 'object', properties: {} }, run: (c, a) => policy(c, a) },
];
