import { STORE, STORES } from '../region/network';
import { whatIfDisruption } from './disrupt';
import { FAMILIES } from '../region/products';
import type { BoardOp } from '../sim/board';
import { clock, sumScore } from '../twin/twin';
import { ISSUE_LABEL, POLICY_LABEL, type Option, type Rec } from '../twin/types';
import { cardProposal, noAction, outcome, pendingCards, statusAt, watchList } from './brief';
import { handover, reportShift, SHIFTS } from './handover';
import { buildIndex, playbookPassages, search, snippet, SOP, splitDoc } from './knowledge';
import { PLAYBOOKS } from '../analysis/drill';
import { review } from './review';
import { dayClock, soldOutAt } from './context';
import { forecastDelay, forecastDemand, forecastReport, selectedModel } from '../analysis/forecast';
import { TRACE_DAY } from '../analysis/studies';
import { DEFAULT_OPTIONS, planName, planNetwork } from '../network';
import { crossBorder } from '../analysis/crossBorder';
import { solveDoors, solveFleet } from '../sim/optimize';
import type { AssistCtx, FacKey, Link, Proposal, ToolResult } from './types';
import { OPS_TOOLS } from './opsTools';

/**
 * 值班助手的查询工具。每个工具只读数据，返回结构化结果和一段写好的回答；要改东西的只返回「提议」，由人确认后执行。
 * 说明（description）和参数（parameters）按语言模型调用工具的格式写好：以后接语言模型时，模型选工具、组织语言，
 * 数字仍然全部来自这些工具的结果。
 */
export interface Memory {
  /** 最近提到的车、最近列出来的建议卡（按显示的顺序，「第一条」就是它的第一个） */
  vehicles: number[];
  cards: string[];
  /** 最近单独说到的那张卡（「这张」「它」「上一张」按它）、最近问到的门（「这个门」按它） */
  focusCard?: string;
  doors?: string[];
}
type Args = Record<string, unknown>;
export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(ctx: AssistCtx, args: Args, mem: Memory): ToolResult;
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const PLACE: Record<string, string> = { DC: '配送中心', PORT: '港口', AIR: '机场货运区', AIR_IN: '航线', SEA: '外海', ANCHORAGE: '锚地', RAIL_EAST: '洲际铁路', RAIL_DC: '物流园货运站', NORTH: '北高速口', EAST: '东高速口（跨境）', BAKERY: '中央面包房' };
export const placeOf = (k: string): string => STORES.find((s) => s.key === k)?.name ?? PLACE[k] ?? k;
const famLabel = (k: string) => FAMILIES.find((f) => f.key === k)?.label ?? k;
const TWIN_CITE = '闭环孪生（现场的感知数据和孪生的估计）';
const BOARD_CITE = '调度台（当天的计划）';
const LEVEL = ['', '留意', '重要', '紧急'];

const result = (tool: string, args: Args, text: string, cite: string, extra: Partial<ToolResult> = {}, data: Record<string, unknown> = {}): ToolResult => ({ tool, args, data, text, cite, ...extra });
const vehLink = (vid: number, label = '看车'): Link => ({ kind: 'vehicle', vid, label });
const noTwin = '闭环孪生还没跑完，这里先按计划回答。';

/** 这张卡此刻的状态写成一句话 */
function cardLine(r: Rec, t: number, n?: number): string {
  const st = statusAt(r, t);
  const best = r.options[r.best] as Option;
  const head = `${n !== undefined ? `${n}. ` : ''}${clock(r.t)} ${ISSUE_LABEL[r.kind]}：${r.title}`;
  if (st === 'proposed') return `${head}。${best.cmds.length ? `推荐「${best.label}」（${outcome(best)}）` : `推荐不处理（${outcome(best)}）`}${r.interim ? '；低风险的措施已经先自动做了' : ''}`;
  const done = st === 'done' ? `${r.by === 'user' ? '调度员' : '自动'}执行了「${r.options.find((o) => o.key === r.chosen)?.label ?? r.chosen ?? ''}」` : st === 'rejected' ? '调度员否了' : st === 'resolved' ? '问题自己没了' : '没处理，问题发生了';
  return `${head} → ${done}`;
}

function overview(ctx: AssistCtx): ToolResult {
  const t = ctx.t;
  const by = (s: string) => ctx.rows.filter((r) => r.status === s).length;
  const stops = ctx.board.ops.flatMap((o) => (o.stops ?? []).filter((s) => s.key === STORE.key));
  const res = ctx.twin?.result;
  const realized = res ? res.stops.filter((s) => s.store === STORE.key && s.t <= t) : [];
  const arrived = res ? realized.length : stops.filter((s) => s.arrive <= t).length;
  const late = res ? realized.filter((s) => s.late > 0.5).length : stops.filter((s) => s.arrive <= t && !s.onTime).length;
  const lines = [`现在 ${clock(t)}。在途 ${by('moving')} 辆、作业中 ${by('working')} 辆、已收车 ${by('done')} 辆、还没出发 ${by('pending')} 辆。`];
  const extra: Record<string, unknown> = { pending: by('pending'), stops: stops.length };
  lines.push(`${STORE.name}今天计划到货 ${stops.length} 车次，已经到了 ${arrived} 车次${arrived ? (late ? `，晚了 ${late} 车次` : '，都准点') : ''}。`);
  const tw = ctx.twin;
  if (tw) {
    const pend = pendingCards(ctx).length;
    const inc = tw.incidents.filter((x) => x.t0 <= t && x.t1 > t).length;
    Object.assign(extra, { pendingCards: pend, incidents: inc, kpi: tw.kpi });
    lines.push(`闭环孪生（${POLICY_LABEL[tw.policy]}）：待处理的建议 ${pend} 张${inc ? `，路况 ${inc} 处` : ''}。`);
    if (tw.kpi) {
      const k = tw.kpi;
      lines.push(`到此刻：迟到 ${n0(k.late)} 分钟、超温 ${n0(k.hot)} 分钟、缺货 ${n0(k.short)} 分钟、措施多花 $${n0(k.cost)}。`);
      if (tw.openKpi) {
        const d = tw.openKpi.late + tw.openKpi.hot * 2 + tw.openKpi.short * 1.5 + tw.openKpi.cost / 12 - (k.late + k.hot * 2 + k.short * 1.5 + k.cost / 12);
        extra.scoreDiff = d;
        if (d > 0.5) lines.push(`同样的现场不用孪生的话，合计分要多 ${n0(d)}。`);
      }
    }
  } else lines.push(noTwin);
  if (ctx.drill) {
    const pb = PLAYBOOKS.find((p) => p.covers === ctx.drill?.key);
    lines.push(`今天在演练「${ctx.drill.label}」：${ctx.drill.detail}。${pb ? `对应的预案是「${pb.title}」（触发：${pb.trigger}），问我「${ctx.drill.label}怎么办」看步骤和负责人。` : ''}`);
  }
  const top = watchList(ctx, 3);
  if (top.length) {
    lines.push('最要关注：');
    for (const w of top) lines.push(`- 【${LEVEL[w.level]}】${w.text}`);
  } else lines.push('眼下没有要特别关注的事。');
  return result('get_overview', {}, lines.join('\n'), tw ? `${TWIN_CITE}、${BOARD_CITE}` : BOARD_CITE, { links: top.flatMap((w) => w.links).slice(0, 4), followups: ['有什么待处理的建议', '哪些车会晚', '门店会缺货吗'] }, { moving: by('moving'), working: by('working'), done: by('done'), arrived, late, ...extra, watch: top.map((w) => w.text), drill: ctx.drill });
}

function risks(ctx: AssistCtx, args: Args): ToolResult {
  const list = watchList(ctx, Number(args.limit ?? 8));
  if (!list.length && !(ctx.alerts?.() ?? []).length) return result('list_risks', args, `现在 ${clock(ctx.t)}，没有要特别关注的事：没有待处理的建议，车都没明显晚点，接下来两小时调度台也没有问题。`, ctx.twin ? TWIN_CITE : BOARD_CITE, { followups: ['整体情况怎么样', '接下来两小时有什么作业'] });
  const lines = [`现在 ${clock(ctx.t)}，要关注 ${list.length} 件事（紧急的在前）：`, ...list.map((w) => `- 【${LEVEL[w.level]}】${w.text}`)];
  const alerts = ctx.alerts?.() ?? [];
  if (alerts.length) {
    lines.push(`分层看板上还开着 ${alerts.length} 条告警（红色 ${alerts.filter((a) => a.state === 'alarm').length} 条）：`);
    for (const a of alerts.slice(0, 5)) lines.push(`- ${a.state === 'alarm' ? '【告警】' : '【注意】'}${a.level} · ${a.label}（${clock(a.since)} 起，归${a.owner}）`);
  }
  const proposals = list.flatMap((w) => (w.proposal ? [w.proposal] : [])).slice(0, 3);
  if (proposals.length) lines.push(`其中 ${proposals.length} 件可以直接处理，下面列出了提议，确认后执行。`);
  const cardsNow = pendingCards(ctx).length;
  return result('list_risks', args, lines.join('\n'), ctx.twin ? `${TWIN_CITE}、${BOARD_CITE}` : BOARD_CITE, { links: list.flatMap((w) => w.links).slice(0, 6), proposals, followups: cardsNow ? ['有什么待处理的建议', '把低风险的都批了'] : ['哪些车会晚', '接下来两小时有什么作业'] }, { items: list.map((w) => ({ level: w.level, text: w.text })) });
}

function vehicle(ctx: AssistCtx, args: Args, mem: Memory): ToolResult {
  const vid = Number(args.vid);
  const v = ctx.rows.find((r) => r.vid === vid);
  const op = ctx.board.ops.find((o) => o.vehicle === vid) ?? ctx.board.ops.find((o) => o.id === args.id);
  mem.vehicles = [vid];
  if (!v) {
    if (!op) {
      const eg = ctx.board.ops.find((o) => o.kind === 'delivery')?.id ?? 'M01';
      return result('get_vehicle', args, `没找到「${String(args.id ?? '')}」这辆车。可以说作业编号，比如 ${eg}。`, BOARD_CITE, {}, { example: eg });
    }
    const at = op.depart ?? op.t0;
    return result('get_vehicle', args, `${op.id}（${op.label}）：计划 ${clock(at)} 从${placeOf(op.from)}出发，${clock(op.t1)} 收车${ctx.t < at ? '，还没出发' : ''}。`, BOARD_CITE, { links: [{ kind: 'op', id: op.id, label: `看 ${op.id}` }, { kind: 'time', t: at, label: `跳到 ${clock(at)}` }] }, { op: { id: op.id, label: op.label, at, t1: op.t1 } });
  }
  const lines: string[] = [];
  const st = { pending: '还没出发', moving: '在途', working: '在作业', done: '已收车' }[v.status];
  // 跟踪行的「在哪」可能是路名，也可能是「距某地多少公里」
  const near = v.where?.startsWith('距');
  if (v.status === 'done') lines.push(`${v.id}（${v.type}）已收车${v.end !== undefined ? `（${dayClock(v.end)}）` : ''}。`);
  else if (v.status === 'pending') lines.push(`${v.id}（${v.type}）还没出发${v.depart !== undefined ? `，计划 ${dayClock(v.depart)} 从${v.origin}出发` : ''}。`);
  else lines.push(`${v.id}（${v.type}）${st}：${v.act}${v.where && v.where !== v.act ? `，${near ? v.where : `在${v.where}`}` : ''}。`);
  if (v.status !== 'done') {
    const eta = v.nextEta;
    const route = v.origin === v.dest ? `从${v.origin}出发，送完回${v.dest}` : `从${v.origin}到${v.dest}`;
    lines.push(`${route}；下一站${v.next || v.dest}${v.nextPlan !== undefined ? `，计划 ${clock(v.nextPlan)}` : ''}${eta !== undefined && v.nextPlan !== undefined && Math.abs(eta - v.nextPlan) >= 60 ? `，预计 ${clock(eta)}` : ''}${v.remainKm !== undefined && !near ? `，还有约 ${v.remainKm.toFixed(0)} 公里` : ''}。`);
  }
  if ((v.delayMin ?? 0) >= 1) lines.push(`比计划晚了 ${v.delayMin} 分钟。`);
  else if (v.status === 'moving') lines.push('按计划在走。');
  if (v.temp) lines.push(`货温 ${v.temp.value.toFixed(1)} °C（上限 ${v.temp.limit} °C）${v.temp.value > v.temp.limit ? '，已经超了' : ''}。`);
  if (v.load) lines.push(`装载：${v.load}${v.cargo ? `；货物：${v.cargo}` : ''}。`);
  const cards = pendingCards(ctx).filter((r) => r.vid === vid);
  for (const r of cards) lines.push(`有一张待处理的建议：${cardLine(r, ctx.t)}`);
  if (op) for (const i of op.issues) if (i.level !== 'info') lines.push(`调度台：${i.title}，${i.text}`);
  const links: Link[] = [vehLink(vid, '看车并跟随')];
  if (v.nextEta ?? v.nextPlan) links.push({ kind: 'time', t: (v.nextEta ?? v.nextPlan) as number, label: `跳到到达时刻 ${clock((v.nextEta ?? v.nextPlan) as number)}` });
  if (op) links.push({ kind: 'op', id: op.id, label: '在调度台里看' });
  for (const r of cards) links.push({ kind: 'card', key: r.key, label: '看建议卡' });
  mem.cards = cards.map((r) => r.key);
  mem.focusCard = undefined;
  return result('get_vehicle', args, lines.join('\n'), ctx.twin ? TWIN_CITE : BOARD_CITE, { links, proposals: cards.map((r) => cardProposal(r)), followups: cards.length ? ['为什么这么推荐', '如果不处理会怎样'] : [`${v.id} 装的什么`, '哪些车会晚'] }, { row: v, cards: cards.map((r) => cardLine(r, ctx.t)), issues: (op?.issues ?? []).map((i) => `${i.title}，${i.text}`) });
}

function lateList(ctx: AssistCtx): ToolResult {
  const late = ctx.rows.filter((r) => (r.status === 'moving' || r.status === 'working') && (r.delayMin ?? 0) >= 5).sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0));
  const cards = pendingCards(ctx).filter((r) => r.kind === 'late' || r.kind === 'breakdown');
  const planned = ctx.board.issues.filter((i) => (i.code === 'late' || i.code === 'cutoff') && i.at >= ctx.t);
  const lines: string[] = [];
  if (!late.length && !cards.length && !planned.length) return result('list_late', {}, `现在 ${clock(ctx.t)}，路上的车都没明显晚点，按计划后面也没有赶不上收货截止的。`, ctx.twin ? TWIN_CITE : BOARD_CITE, { followups: ['整体情况怎么样'] }, { late: [] });
  if (late.length) {
    lines.push(`路上晚了 5 分钟以上的 ${late.length} 辆：`);
    for (const v of late.slice(0, 8)) lines.push(`- ${v.id} 晚 ${v.delayMin} 分钟，下一站${v.next || v.dest}${(v.nextEta ?? v.nextPlan) !== undefined ? `，预计 ${clock((v.nextEta ?? v.nextPlan) as number)}` : ''}`);
  }
  if (cards.length) {
    lines.push('孪生预计会迟到、待处理的：');
    for (const r of cards) lines.push(`- ${cardLine(r, ctx.t)}`);
  }
  if (planned.length) {
    lines.push('按计划会迟到的（调度台）：');
    for (const i of planned.slice(0, 5)) lines.push(`- ${clock(i.at)} ${i.title}：${i.text}${i.fix ? `（可以「${i.fix.text}」）` : ''}`);
  }
  return result('list_late', {}, lines.join('\n'), ctx.twin ? `${TWIN_CITE}、${BOARD_CITE}` : BOARD_CITE, { links: late.slice(0, 4).map((v) => vehLink(v.vid, `看 ${v.id}`)), proposals: cards.slice(0, 3).map((r) => cardProposal(r)), followups: ['为什么推荐这样处理', '准点率多少'] }, { late: late.map((v) => ({ id: v.id, delayMin: v.delayMin, next: v.next, eta: v.nextEta ?? v.nextPlan })), count: late.length, cards: cards.map((r) => cardLine(r, ctx.t)), planned: planned.slice(0, 5).map((i) => ({ at: i.at, text: `${i.title}：${i.text}${i.fix ? `（可以「${i.fix.text}」）` : ''}` })), constants: [5] });
}

function stock(ctx: AssistCtx, args: Args): ToolResult {
  const tw = ctx.twin;
  const fams = (args.fams as string[] | undefined) ?? [];
  if (!tw?.stock.length) return result('get_stock', args, `${noTwin}门店的库存要等闭环孪生跑完（它按收银和盘点数据估计）。`, BOARD_CITE);
  const open = ctx.t >= 7 * 3600 && ctx.t < 22 * 3600;
  const out = (s: (typeof tw.stock)[number]) => soldOutAt(s.est ?? s.units, s.daily, ctx.t);
  const pick = fams.length ? tw.stock.filter((s) => fams.includes(s.fam)) : tw.stock.filter((s) => (out(s) ?? Infinity) < ctx.t + 6 * 3600);
  const cards = pendingCards(ctx).filter((r) => r.kind === 'stockout' && (!fams.length || fams.includes(r.key.split(':')[1] as string)));
  const lines: string[] = [];
  if (!pick.length && !cards.length) lines.push(`门店各商品族按现在的卖法都够卖 6 小时以上，没有缺货风险。`);
  const outs = pick.slice(0, 8).map((x) => ({ fam: x.fam, at: out(x) }));
  for (const s of pick.slice(0, 8)) {
    const have = s.est ?? s.units;
    const at = out(s);
    const when = at === undefined ? '够卖两天以上' : at < 24 * 3600 ? `按每小时的卖货曲线约 ${clock(at)} 卖空` : `够卖到明天${at < 48 * 3600 ? ` ${clock(at)}` : ''}`;
    lines.push(`- ${s.label}：孪生估计 ${n0(have)} 件（现场 ${n0(s.units)} 件），${open ? `这个钟点每小时卖 ${n0(s.perHour)} 件，` : ''}${when}`);
  }
  for (const r of cards) lines.push(`- 待处理：${cardLine(r, ctx.t)}`);
  return result('get_stock', args, lines.join('\n'), TWIN_CITE, { links: [{ kind: 'facility', fac: 'store', label: `看${STORE.name}` }], proposals: cards.map((r) => cardProposal(r)), followups: cards.length ? ['为什么推荐追加补货', '如果不处理会怎样'] : ['哪些车会晚'] }, { stock: pick, soldOut: outs, cards: cards.map((r) => cardLine(r, ctx.t)), constants: [6] });
}

function doors(ctx: AssistCtx, args: Args): ToolResult {
  const t = ctx.t;
  const door = args.door as string | undefined;
  const lines: string[] = [];
  const name = (id: string) => ctx.board.byId.get(id)?.id ?? id;
  if (door) {
    const d = ctx.board.doors.find((x) => x.id === door);
    if (!d) return result('get_doors', args, `没有 ${door} 这樘门。配送中心有冷链门 ${ctx.board.doors.find((x) => x.group === 'cold')?.id ?? ''}–${[...ctx.board.doors].reverse().find((x) => x.group === 'cold')?.id ?? ''}、干货门 ${ctx.board.doors.find((x) => x.group === 'dry')?.id ?? ''}–${[...ctx.board.doors].reverse().find((x) => x.group === 'dry')?.id ?? ''}。`, BOARD_CITE, {}, { doors: ctx.board.doors.map((x) => x.id) });
    const now = d.bookings.find((b) => b.t0 <= t && t < b.t1);
    const next = d.bookings.filter((b) => b.t0 > t).sort((a, b) => a.t0 - b.t0)[0];
    lines.push(`${door}（${d.group === 'cold' ? '冷链' : '干货'}门）今天排了 ${d.bookings.length} 次。${now ? `现在 ${name(now.op)} 在${now.mode === 'load' ? '装车' : '卸货'}（到 ${clock(now.t1)}）。` : '现在空着。'}${next ? `下一次 ${clock(next.t0)}–${clock(next.t1)} ${name(next.op)} ${next.mode === 'load' ? '装车' : '卸货'}。` : '今天后面没有安排了。'}`);
    for (const b of d.bookings.slice(0, 10)) lines.push(`- ${clock(b.t0)}–${clock(b.t1)} ${name(b.op)} ${b.mode === 'load' ? '装车' : '卸货'}${b.fixed ? '（调度员指定）' : ''}`);
  } else {
    for (const g of ['cold', 'dry'] as const) {
      const ds = ctx.board.doors.filter((x) => x.group === g);
      const busy = ds.filter((x) => x.bookings.some((b) => b.t0 <= t && t < b.t1)).length;
      const soon = ds.filter((x) => x.bookings.some((b) => b.t0 > t && b.t0 < t + 3600)).length;
      lines.push(`${g === 'cold' ? '冷链门' : '干货门'}：${ds.length} 樘，现在在用 ${busy} 樘，一小时内还要用 ${soon} 樘；全天占用 ${Math.round((ctx.board.kpi.doorUse[g] ?? 0) * 100)}%，最多同时 ${ctx.board.kpi.doorPeak[g]} 樘。`);
    }
    const waits = ctx.board.ops.filter((o) => (o.yardWait ?? 0) > 60 && o.dockAt && o.dockAt[0] >= t - 3600 && o.dockAt[0] < t + 2 * 3600);
    if (waits.length) lines.push(`前后两小时有 ${waits.length} 辆车要在场地等门：${waits.map((o) => `${o.id} 等 ${Math.round((o.yardWait ?? 0) / 60)} 分钟`).join('、')}`);
    for (const i of ctx.board.issues.filter((x) => x.code.startsWith('door') && x.at >= t - 600)) lines.push(`- ${clock(i.at)} ${i.title}：${i.text}`);
  }
  const cards = pendingCards(ctx).filter((r) => r.kind === 'door');
  for (const r of cards) lines.push(`- 待处理：${cardLine(r, t)}`);
  const dc = ctx.fac?.().dc;
  if (dc && !door) lines.push(...dc.lines.slice(0, 2));
  const groups = (['cold', 'dry'] as const).map((g) => {
    const ds = ctx.board.doors.filter((x) => x.group === g);
    return { g, n: ds.length, busy: ds.filter((x) => x.bookings.some((b) => b.t0 <= t && t < b.t1)).length, soon: ds.filter((x) => x.bookings.some((b) => b.t0 > t && b.t0 < t + 3600)).length, use: ctx.board.kpi.doorUse[g] ?? 0, peak: ctx.board.kpi.doorPeak[g] };
  });
  const booked = door ? (ctx.board.doors.find((x) => x.id === door)?.bookings ?? []).map((b) => ({ t0: b.t0, t1: b.t1, op: name(b.op) })) : [];
  const waitOps = ctx.board.ops.filter((o) => (o.yardWait ?? 0) > 60).map((o) => ({ id: o.id, wait: o.yardWait }));
  return result('get_doors', args, lines.join('\n'), dc ? `${BOARD_CITE}、设施监控` : BOARD_CITE, { links: [{ kind: 'facility', fac: 'dc', label: '看物流园' }], proposals: cards.map((r) => cardProposal(r)), followups: ['冷链门不够用怎么办'] }, { groups, booked, waits: waitOps, issues: ctx.board.issues.filter((x) => x.code.startsWith('door')).map((i) => ({ at: i.at, text: `${i.title}：${i.text}` })), cards: cards.map((r) => cardLine(r, t)), dc: dc?.lines ?? [] });
}

const FAC_NAME: Record<FacKey, string> = { port: '港口', airport: '机场', dc: '物流园', store: STORE.name };
const FAC_LINK: Record<FacKey, 'port' | 'air' | 'dc' | 'store'> = { port: 'port', airport: 'air', dc: 'dc', store: 'store' };
function facility(ctx: AssistCtx, args: Args): ToolResult {
  const key = (args.facility as FacKey | undefined) ?? 'dc';
  const snap = ctx.fac?.()[key];
  const lines: string[] = [];
  if (snap) {
    lines.push(`${snap.name}（${clock(ctx.t)}）：`);
    for (const l of snap.lines) lines.push(`- ${l}`);
    const bad = snap.kpi.filter((k) => k.bad);
    if (bad.length) lines.push(`异常：${bad.map((k) => `${k.label} ${k.value}`).join('；')}`);
  }
  // 计划里和这个设施有关的作业（孪生服务没有设施监控时只有这一部分）
  const at = (o: BoardOp) => o.arrive ?? o.depart ?? o.t0;
  const rel = ctx.board.ops.filter((o) => (key === 'port' ? o.kind === 'vessel' || o.kind === 'drayage' || o.from === 'PORT' : key === 'airport' ? o.kind === 'flight' || o.kind === 'airTruck' : key === 'dc' ? o.kind === 'train' || o.kind === 'rail' || o.from === 'DC' || o.to === 'DC' : (o.stops ?? []).some((s) => s.key === STORE.key)));
  const now = rel.filter((o) => o.t0 <= ctx.t && ctx.t < o.t1);
  const upcoming = rel.filter((o) => o.t0 > ctx.t).sort((a, b) => at(a) - at(b));
  if (!snap || key === 'port' || key === 'airport') {
    if (now.length) {
      lines.push(`正在进行的：`);
      for (const o of now.slice(0, 6)) lines.push(`- ${o.id} ${o.label}${o.dock ? `：${o.dock[0] <= ctx.t && ctx.t < o.dock[1] ? `${key === 'port' ? '靠泊作业中' : '作业中'}，预计 ${dayClock(o.dock[1])} 完工` : o.dock[0] > ctx.t ? `，预计 ${dayClock(o.dock[0])} 开始作业` : `，作业已完成，${dayClock(o.t1)} 离开`}` : `（到 ${dayClock(o.t1)}）`}`);
    }
    if (upcoming.length) {
      lines.push(`接下来和${FAC_NAME[key]}有关的作业：`);
      for (const o of upcoming.slice(0, 6)) lines.push(`- ${dayClock(at(o))} ${o.id} ${o.label}`);
    } else if (!snap && !now.length) lines.push(`今天后面没有和${FAC_NAME[key]}有关的作业了。`);
  }
  const cam = ctx.cams?.().find((c) => c.kind === (key === 'airport' ? '' : key));
  if (cam) lines.push(`监控识别（${cam.label}）：画面里 ${cam.vehicles} 个目标${cam.docked ? `，${cam.docked} 辆已靠好` : ''}${cam.misaligned ? `，${cam.misaligned} 辆没对准` : ''}${cam.queued ? `，${cam.queued} 辆在排队` : ''}。`);
  const boxes = key === 'port' ? (ctx.containers?.() ?? []) : [];
  const recent = boxes.reduce<(typeof boxes)[number] | undefined>((a, b) => (!a || b.since > a.since ? b : a), undefined);
  if (recent) lines.push(`本店的箱（港口 EDI）：${boxes.length} 个——${[...new Set(boxes.map((b) => b.state))].map((st) => `${st} ${boxes.filter((b) => b.state === st).length} 个`).join('；')}。最近一次是 ${clock(recent.since)} ${recent.id}${recent.vehicle ? `（${recent.vehicle}）` : ''}：${recent.state}。`);
  const opData = (o: BoardOp) => ({ id: o.id, label: o.label, dock: o.dock, t0: o.t0, t1: o.t1, at: at(o) });
  return result('get_facility', args, lines.join('\n'), snap ? `设施监控${cam ? '、监控识别' : ''}、${BOARD_CITE}` : `${BOARD_CITE}${boxes.length ? '、港口 EDI' : ''}`, { links: [{ kind: 'facility', fac: FAC_LINK[key], label: `打开${FAC_NAME[key]}监控` }] }, { facility: key, lines: snap?.lines ?? [], kpi: snap?.kpi ?? [], now: now.slice(0, 6).map(opData), upcoming: upcoming.slice(0, 6).map(opData), ...(cam ? { cam } : {}), ...(boxes.length ? { containers: boxes } : {}) });
}

function cards(ctx: AssistCtx, _args: Args, mem: Memory): ToolResult {
  const pend = pendingCards(ctx);
  if (!ctx.twin) return result('list_cards', {}, `${noTwin}建议卡由闭环孪生给出。`, BOARD_CITE);
  const handled = (ctx.twin.recs ?? []).filter((r) => r.t <= ctx.t && statusAt(r, ctx.t) !== 'proposed').slice(-3);
  // 「第一条」按显示的顺序：先待处理的，再最近处理过的
  mem.cards = [...pend, ...handled].map((r) => r.key);
  mem.focusCard = undefined;
  const lines: string[] = [];
  if (pend.length) {
    lines.push(`待处理的建议 ${pend.length} 张（${POLICY_LABEL[ctx.twin.policy]}）：`);
    pend.forEach((r, i) => lines.push(`- ${cardLine(r, ctx.t, i + 1)}`));
  } else lines.push(`现在没有待处理的建议（${POLICY_LABEL[ctx.twin.policy]}）。`);
  if (handled.length) {
    lines.push('最近处理过的：');
    handled.forEach((r, i) => lines.push(`- ${cardLine(r, ctx.t, pend.length + i + 1)}`));
  }
  return result('list_cards', {}, lines.join('\n'), TWIN_CITE, { links: pend.slice(0, 4).map((r) => ({ kind: 'card', key: r.key, label: `看第 ${pend.indexOf(r) + 1} 张` }) as Link), proposals: pend.slice(0, 3).map((r) => cardProposal(r)), followups: pend.length ? ['为什么推荐第一条', '如果不处理第一条会怎样', '把低风险的都批了'] : handled.length ? ['为什么那样处理第一条', '复盘一下今天的建议'] : ['复盘一下今天的建议'] }, { pending: pend.map((r) => r.key), count: pend.length, lines: [...pend, ...handled].map((r) => cardLine(r, ctx.t)) });
}

/** 合计分的权重、门店顺延的加班费（规则常数） */
const SCORE_WEIGHTS = [2, 1.5, 12, 25];
/** 每类问题推荐的理由（按推演结果写，不编造） */
function why(r: Rec): string {
  const best = r.options[r.best] as Option;
  const none = noAction(r);
  const ranked = [...r.options].sort((a, b) => sumScore(a) - sumScore(b));
  const second = ranked.find((o) => o !== best);
  const parts: string[] = [];
  if (!best.cmds.length) parts.push(`处理的代价比问题本身大：不处理的合计分 ${sumScore(best).toFixed(0)}${second ? `，最好的处理办法「${second.label}」是 ${sumScore(second).toFixed(0)}` : ''}。`);
  else if (none && none !== best) parts.push(`「${best.label}」的合计分 ${sumScore(best).toFixed(0)}，不处理是 ${sumScore(none).toFixed(0)}，少 ${(sumScore(none) - sumScore(best)).toFixed(0)}。`);
  if (second && second !== none && best.cmds.length) parts.push(`第二好的是「${second.label}」（合计分 ${sumScore(second).toFixed(0)}：${outcome(second)}）。`);
  if (r.kind === 'breakdown') parts.push(best.key === 'rescue' ? '等修好会让后面的门店晚到或断货，派救援车多花的钱换来准时。' : '离门店收货截止还有余量，等修好不耽误，就不用花救援车的钱。');
  if (r.kind === 'late') parts.push(best.key === 'notify' ? '晚得多，通知门店顺延（约 $25 的加班）比让门店错过收货划算。' : '晚得不多，顺延要多排人手，不划算。');
  if (r.kind === 'temp') parts.push('先让司机停车检查车门密封最省事；压缩机满负荷时调低设定温度帮助不大；压缩机坏了才派冷藏车。');
  if (r.kind === 'door') parts.push('有空闲的门时改门不花钱、不耽误；没有空门只能等。');
  if (r.kind === 'stockout') parts.push('缺货分钟按 1.5 倍计入合计分；追加补货、改直送都要花钱，按能挽回的缺货时间选。');
  parts.push(`合计分 = 迟到 + 超温 × 2 + 缺货 × 1.5 + 多花的钱 ÷ 12；${best.auto ? '这个做法是低风险的' : '这个做法要花钱或改计划，需要人确认'}。`);
  return parts.join('');
}

function explain(ctx: AssistCtx, args: Args): ToolResult {
  const r = (ctx.twin?.recs ?? []).find((x) => x.key === args.key);
  if (!r) return result('explain_card', args, '没找到这张建议卡。', TWIN_CITE);
  const lines = [`${r.title}（${clock(r.t)}）：${r.text}`, '孪生逐个推演了这几个做法：'];
  for (const o of [...r.options].sort((a, b) => sumScore(a) - sumScore(b))) lines.push(`- ${o === r.options[r.best] ? '★ ' : ''}${o.label}：${outcome(o)}，合计分 ${sumScore(o).toFixed(0)}。${o.note}`);
  lines.push(`推荐的理由：${why(r)}`);
  return result('explain_card', args, lines.join('\n'), TWIN_CITE, { links: [{ kind: 'card', key: r.key, label: '看建议卡' }, ...(r.vid !== undefined ? [vehLink(r.vid)] : [])], ...(statusAt(r, ctx.t) === 'proposed' ? { proposals: [cardProposal(r)] } : {}), followups: ['如果不处理会怎样'] }, { t: r.t, title: r.title, text: r.text, options: r.options.map((o) => ({ key: o.key, label: o.label, late: o.late, hot: o.hot, short: o.short, cost: o.cost, score: sumScore(o), note: o.note })), best: r.options[r.best]?.key, saving: (() => { const none = noAction(r); const best = r.options[r.best] as Option; return none && none !== best ? sumScore(none) - sumScore(best) : 0; })(), constants: SCORE_WEIGHTS });
}

function whatIf(ctx: AssistCtx, args: Args): ToolResult {
  if (args.disruption) return whatIfDisruption(ctx, args);
  const r = (ctx.twin?.recs ?? []).find((x) => x.key === args.key);
  if (!r) {
    const tw = ctx.twin;
    if (tw?.kpi && tw.openKpi) {
      const a = tw.kpi;
      const b = tw.openKpi;
      return result('what_if', args, [`同样的现场，到此刻（${clock(ctx.t)}）用孪生和不用孪生比：`, `- 迟到：${n0(a.late)} 分钟 / 不用 ${n0(b.late)} 分钟`, `- 超温：${n0(a.hot)} 分钟 / 不用 ${n0(b.hot)} 分钟`, `- 缺货：${n0(a.short)} 分钟 / 不用 ${n0(b.short)} 分钟`, `- 等月台门：${n0(a.door)} 分钟 / 不用 ${n0(b.door)} 分钟`, `- 措施多花：$${n0(a.cost)} / 不用 $${n0(b.cost)}`].join('\n'), TWIN_CITE, { followups: ['复盘一下今天的建议'] }, { twin: a, open: b });
    }
    return result('what_if', args, '说一下是哪张建议卡（比如「如果第一条不处理会怎样」），我把孪生推演的几个做法列出来比。', TWIN_CITE);
  }
  const best = r.options[r.best] as Option;
  const none = noAction(r);
  const o = r.options.find((x) => x.key === args.option) ?? none ?? best;
  const name = o === none && o.label !== '不处理' ? `不处理（${o.label}）` : `「${o.label}」`;
  const lines = [`${r.title}：`, `- 如果${name}：${outcome(o)}，合计分 ${sumScore(o).toFixed(0)}。${o.note}`];
  if (o !== best) lines.push(`- 推荐的「${best.label}」：${outcome(best)}，合计分 ${sumScore(best).toFixed(0)}。`);
  lines.push(o === best ? '这正是推荐的做法。' : `差别：合计分${sumScore(o) > sumScore(best) ? '多' : '少'} ${Math.abs(sumScore(o) - sumScore(best)).toFixed(0)}。`);
  lines.push('（这是孪生出卡时按当时的感知数据推演的结果。）');
  return result('what_if', args, lines.join('\n'), TWIN_CITE, { links: [{ kind: 'card', key: r.key, label: '看建议卡' }], ...(statusAt(r, ctx.t) === 'proposed' ? { proposals: [cardProposal(r, o.key), ...(o !== best ? [cardProposal(r)] : [])] } : {}) }, { t: r.t, title: r.title, options: r.options.map((x) => ({ key: x.key, label: x.label, late: x.late, hot: x.hot, short: x.short, cost: x.cost, score: sumScore(x), note: x.note })), diff: Math.abs(sumScore(o) - sumScore(best)) });
}

function decide(ctx: AssistCtx, args: Args): ToolResult {
  const keys = (args.keys as string[] | undefined) ?? [];
  const reject = args.action === 'reject';
  const recs = keys.map((k) => (ctx.twin?.recs ?? []).find((x) => x.key === k)).filter((x): x is Rec => !!x && statusAt(x, ctx.t) === 'proposed');
  if (!recs.length) return result('propose_decision', args, keys.length ? '这张建议卡已经处理过了（或者还没出来）。' : '现在没有待处理的建议卡。', TWIN_CITE);
  if (recs.length === 1) {
    const r = recs[0] as Rec;
    const p = cardProposal(r, args.option as string | undefined, reject);
    return result('propose_decision', args, `${reject ? '要否决' : '要执行'}的是：${p.title}。\n${p.effect}\n确认后在此刻（${clock(ctx.t)}）生效，孪生从头再推演一遍。`, TWIN_CITE, { proposals: [p], links: [{ kind: 'card', key: r.key, label: '看建议卡' }] }, { proposals: [{ title: p.title, effect: p.effect, cost: p.cost }] });
  }
  const props = recs.map((r) => cardProposal(r, undefined, reject));
  const batch: Proposal = { id: `batch-${props.map((p) => p.id).join('-')}`, title: `${reject ? '否决' : '执行推荐的做法'}：${recs.length} 张建议卡`, effect: props.map((p) => p.title).join('；'), actions: props.flatMap((p) => p.actions), risk: props.every((p) => p.risk === 'low') ? 'low' : 'high', cost: props.reduce((a, p) => a + p.cost, 0) };
  return result('propose_decision', args, [`一起${reject ? '否决' : '执行'}这 ${recs.length} 张：`, ...props.map((p) => `- ${p.title}：${p.effect}`)].join('\n'), TWIN_CITE, { proposals: [batch] }, { count: recs.length, proposals: props.map((p) => ({ title: p.title, effect: p.effect, cost: p.cost })) });
}

function kpi(ctx: AssistCtx): ToolResult {
  const k = ctx.board.kpi;
  const lines = [`计划（调度台）：今天 ${k.ops} 个作业、${k.trips} 车次配送、门店到货 ${k.stops} 站，准点 ${k.onTime} 站、迟到 ${k.late} 站；用车 ${k.units} 辆、司机 ${k.driverHours.toFixed(0)} 小时、${n0(k.km)} 公里。`];
  const tw = ctx.twin;
  if (tw?.kpi) {
    const a = tw.kpi;
    lines.push(`现场到此刻（${clock(ctx.t)}，用孪生）：迟到 ${a.lateStops} 站 ${n0(a.late)} 分钟、超温 ${n0(a.hot)} 分钟、缺货 ${n0(a.short)} 分钟、等月台门 ${n0(a.door)} 分钟、等收货口 ${n0(a.dock)} 分钟、措施多花 $${n0(a.cost)}。`);
    if (tw.openKpi) {
      const b = tw.openKpi;
      const s = (x: typeof a) => x.late + x.hot * 2 + x.short * 1.5 + x.cost / 12;
      lines.push(`同样的现场不用孪生：迟到 ${n0(b.late)} 分钟、超温 ${n0(b.hot)} 分钟、缺货 ${n0(b.short)} 分钟；合计分 ${n0(s(b))}，用孪生 ${n0(s(a))}。`);
    }
  } else lines.push(noTwin);
  const sc = (x: { late: number; hot: number; short: number; cost: number } | undefined) => (x ? x.late + x.hot * 2 + x.short * 1.5 + x.cost / 12 : undefined);
  return result('get_kpi', {}, lines.join('\n'), tw ? `${BOARD_CITE}、${TWIN_CITE}` : BOARD_CITE, { followups: ['复盘一下今天的建议', '写交接班报告'] }, { board: k, twin: tw?.kpi, open: tw?.openKpi, score: sc(tw?.kpi), openScore: sc(tw?.openKpi) });
}

function incidents(ctx: AssistCtx): ToolResult {
  const t = ctx.t;
  const tw = ctx.twin;
  const lines: string[] = [];
  const active = (tw?.incidents ?? []).filter((x) => x.t0 <= t && x.t1 > t);
  const coming = (tw?.incidents ?? []).filter((x) => x.t0 > t && x.t0 < t + 3600);
  // f 是慢了几倍（经过这一段的用时是平时的 f 倍）
  for (const x of active) lines.push(`- 路况：${x.text}（${clock(x.t0)} 起，预计到 ${clock(x.t1)}，经过那一段车速只有平时的 ${Math.round(100 / x.f)}% 左右）`);
  void coming;
  const faults = (tw?.events ?? []).filter((e) => (e.ev === 'fault' || e.ev === 'fixed') && e.t > t - 3 * 3600 && e.t <= t);
  for (const e of faults) lines.push(`- ${clock(e.t)} ${ctx.board.ops.find((o) => o.vehicle === e.vid)?.id ?? `车 ${e.vid}`}：${e.note ?? e.ev}`);
  for (const r of pendingCards(ctx).filter((x) => x.kind === 'breakdown' || x.kind === 'temp')) lines.push(`- 待处理：${cardLine(r, t)}`);
  if (!tw) lines.unshift(noTwin);
  return result('list_incidents', {}, lines.length ? [`现在 ${clock(t)}：`, ...lines].join('\n') : `现在 ${clock(t)} 路上没有事故和施工，车辆也没有报故障。`, tw ? TWIN_CITE : BOARD_CITE, { proposals: pendingCards(ctx).filter((x) => x.kind === 'breakdown' || x.kind === 'temp').map((r) => cardProposal(r)) }, { active: active.map((x) => ({ text: x.text, t0: x.t0, t1: x.t1, speedPct: Math.round(100 / x.f) })), faults: faults.map((e) => ({ t: e.t, id: ctx.board.ops.find((o) => o.vehicle === e.vid)?.id ?? `车 ${e.vid}`, note: e.note })), cards: pendingCards(ctx).filter((x) => x.kind === 'breakdown' || x.kind === 'temp').map((r) => cardLine(r, t)) });
}

function schedule(ctx: AssistCtx, args: Args): ToolResult {
  const from = Number(args.from ?? ctx.t);
  const to = Number(args.to ?? ctx.t + 2 * 3600);
  const at = (o: BoardOp) => o.depart ?? o.t0;
  const list = ctx.board.ops.filter((o) => (at(o) >= from && at(o) < to) || (o.arrive !== undefined && o.arrive >= from && o.arrive < to)).sort((a, b) => at(a) - at(b));
  if (!list.length) return result('get_schedule', args, `${clock(from)}–${clock(to)} 没有作业。`, BOARD_CITE);
  const lines = [`${clock(from)}–${clock(to)} 有 ${list.length} 个作业：`];
  for (const o of list.slice(0, 12)) {
    const st = (o.stops ?? []).find((s) => s.key === STORE.key);
    lines.push(`- ${clock(at(o))} ${o.id} ${o.label.replace(/ · .*$/, '')}：${placeOf(o.from)} → ${placeOf(o.to)}${st ? `，${clock(st.arrive)} 到${STORE.name}` : o.arrive !== undefined ? `，${clock(o.arrive)} 到` : ''}${o.door ? `，${o.door} 门` : ''}`);
  }
  if (list.length > 12) lines.push(`……还有 ${list.length - 12} 个，在调度台的作业清单里看。`);
  return result('get_schedule', args, lines.join('\n'), BOARD_CITE, { links: [{ kind: 'time', t: from, label: `跳到 ${clock(from)}` }] }, { from, to, count: list.length, ops: list.slice(0, 12).map((o) => ({ id: o.id, at: at(o), arrive: o.arrive, store: (o.stops ?? []).find((s) => s.key === STORE.key)?.arrive, door: o.door, label: o.label })), constants: [12] });
}

function shift(ctx: AssistCtx, args: Args): ToolResult {
  const s = SHIFTS.find((x) => x.key === args.shift) ?? reportShift(ctx.t);
  const h = handover(ctx, s);
  const lines = [h.summary];
  for (const sec of h.sections.slice(1)) lines.push(`${sec.title}：${sec.lines.slice(0, 2).join('；')}${sec.lines.length > 2 ? '……' : ''}`);
  return result('shift_handover', args, lines.join('\n'), ctx.twin ? `${TWIN_CITE}、${BOARD_CITE}` : BOARD_CITE, { links: [{ kind: 'panel', panel: 'handover', label: '打开完整的交接班报告' }] }, { markdown: h.markdown });
}

function reviewTool(ctx: AssistCtx): ToolResult {
  const res = ctx.twin?.result;
  if (!res) return result('review_recommendations', {}, `${noTwin}复盘要用闭环孪生的结果。`, BOARD_CITE);
  const rv = review(res, ctx.t);
  const lines = [...rv.notes];
  for (const k of rv.byKind) lines.push(`- ${k.label}：${k.n} 张，执行 ${k.done}、否决 ${k.rejected}、发生了 ${k.expired}、自己没了 ${k.resolved}；平均差 ${k.mae.toFixed(1)} 分钟`);
  return result('review_recommendations', {}, lines.join('\n'), `${TWIN_CITE}（事后的现场结果）`, { links: [{ kind: 'panel', panel: 'review', label: '打开建议复盘' }] }, { total: rv.total, byKind: rv.byKind, notes: rv.notes });
}

let index: { docs: AssistCtx['docs']; idx: ReturnType<typeof buildIndex> } | undefined;
function knowledge(ctx: AssistCtx, args: Args): ToolResult {
  const q = String(args.query ?? '');
  if (!index || index.docs !== ctx.docs) index = { docs: ctx.docs, idx: buildIndex([...SOP, ...playbookPassages(PLAYBOOKS), ...(ctx.docs ?? []).flatMap((d) => splitDoc(d.title, d.text))]) };
  const hits = search(index.idx, q, 3);
  if (!hits.length) return result('search_knowledge', args, '资料库里没找到相关的内容。可以换个说法，或者问具体的车、门、商品族、建议卡。', '资料库');
  const lines = hits.map((h, i) => `${i === 0 ? '' : '- '}**${h.p.title}**（${h.p.source}）：${snippet(h.p, q, i === 0 ? 260 : 120)}`);
  return result('search_knowledge', args, lines.join('\n'), `资料库：${[...new Set(hits.map((h) => h.p.source.split(' · ')[0]))].join('、')}`, {}, { hits: hits.map((h) => ({ title: h.p.title, source: h.p.source, score: h.score, text: h.p.text })) });
}

function forecast(ctx: AssistCtx, args: Args): ToolResult {
  const r = forecastReport();
  if (!r) return result('get_forecast', args, '预测模型还没训练：打开「对比与报告」页的「预测」一节训练一次（约 2 秒），回来再问，我就按选中的模型回答。', '预测模型', {}, { constants: [2] });
  const fams = ((args.fams as string[] | undefined) ?? []).length ? (args.fams as string[]) : ['DAIRY', 'PROD_LOCAL', 'MEAT', 'BAKERY', 'AMB_A'];
  const tomorrow = args.tomorrow !== false;
  const day = TRACE_DAY + (tomorrow ? 1 : 0);
  const lines: string[] = [`${tomorrow ? '明天' : '今天'}${STORE.name}的销量预测（按每个商品族选中的模型）：`];
  for (const f of fams) {
    const n = forecastDemand(f, day);
    const m = selectedModel('demand', f);
    if (n !== undefined) lines.push(`- ${famLabel(f)}：约 ${n0(n)} 件（${m?.label ?? ''}；${m?.reason ?? ''}）`);
  }
  if (args.delays !== false) {
    const v = forecastDelay('vessel');
    const tr = forecastDelay('train');
    if (v) lines.push(`本店班轮：预计比船期晚 ${v.hours.toFixed(1)} 小时，九成的情况下不超过 ${v.p90.toFixed(1)} 小时（${v.model}）`);
    if (tr) lines.push(`洲际班列：预计晚 ${tr.hours.toFixed(1)} 小时，九成的情况下不超过 ${tr.p90.toFixed(1)} 小时（${tr.model}）`);
    const road = selectedModel('road');
    if (road) lines.push(`路上用时：${road.label}（${road.reason}）`);
  }
  void ctx;
  return result('get_forecast', args, lines.join('\n'), '预测模型（对比与报告页训练的，规则和学到的模型并排比、哪个准用哪个）', {}, { lines });
}

function network(_ctx: AssistCtx, args: Args): ToolResult {
  const n = Math.max(1, Math.min(12, Number(args.stores ?? DEFAULT_OPTIONS.n)));
  const plan = planNetwork({ ...DEFAULT_OPTIONS, n });
  const b = plan.best.eval;
  const td = plan.today.eval;
  const m = (x: number) => `$${(x / 1e6).toFixed(2)}M`;
  const lines = [`按网络规划的默认设定（${n} 家店、需求比现在多 ${Math.round((DEFAULT_OPTIONS.params.growth - 1) * 100)}%）：最好的是「${planName(plan, plan.best)}」，每年 ${m(b.costs.total)}；今天的网络（只有物流园、不扩建，装不下的交第三方仓）每年 ${m(td.costs.total)}，${b.costs.total < td.costs.total ? `省 ${m(td.costs.total - b.costs.total)}` : '一样'}。`, `每天 ${b.vehicles} 辆车、${Math.round(b.kmDay).toLocaleString('en-US')} 公里，最远的店 ${b.maxHours.hours.toFixed(1)} 小时车程${b.overflowPallets > 0 ? `；每天还有 ${Math.round(b.overflowPallets)} 托要交第三方仓` : ''}。`, ...plan.explain.slice(0, 3).map((x) => `- ${x}`)];
  return result('plan_network', args, lines.join('\n'), '网络规划（选址模型精确求解 + 按线路核算）', {}, { best: planName(plan, plan.best), stores: n, growth: DEFAULT_OPTIONS.params.growth - 1, total: b.costs.total, today: td.costs.total, saved: td.costs.total - b.costs.total, vehicles: b.vehicles, km: b.kmDay, maxHours: b.maxHours.hours, overflow: b.overflowPallets, explain: plan.explain.slice(0, 3) });
}

function border(ctx: AssistCtx, args: Args): ToolResult {
  const cb = crossBorder(ctx.gen ?? 'g3');
  const lines = ['跨境进来的货（示例汇率 1 美元 = ' + cb.rate.toFixed(2) + ' 本币）：'];
  for (const f of cb.flows) {
    const docs = f.docs.map((d) => d.label).join('、');
    lines.push(`- ${f.label}：清关和口岸约 ${f.totalHours >= 24 ? `${(f.totalHours / 24).toFixed(1)} 天` : `${f.totalHours.toFixed(1)} 小时`}（和仿真用的「${f.sim.label}」一致），开箱查验概率 ${Math.round(f.inspection.physical * 100)}%；要的单证：${docs}；每年报关约 ${n0(f.declarations)} 次`);
  }
  lines.push(`汇率每变 1%，每年到岸成本变 ${(cb.perPoint / 1e4).toFixed(0)} 万本币（进口增值税可以抵扣，不算进成本）。`);
  return result('get_crossborder', args, lines.join('\n'), '跨境（清关步骤、单证、关税和汇率；税率、汇率是示例）', {}, { rate: cb.rate, perPoint: cb.perPoint, flows: cb.flows.map((f) => ({ label: f.label, hours: f.totalHours, physical: f.inspection.physical, declarations: f.declarations, sim: f.sim.label })) });
}

function optimize(ctx: AssistCtx, args: Args): ToolResult {
  if (!ctx.day || ctx.allocation === undefined) return result('optimize_dispatch', args, '调度台的数据还没准备好，稍等再问。', BOARD_CITE);
  const want = String(args.what ?? 'both');
  const lines: string[] = [];
  const proposals: Proposal[] = [];
  const solved: Record<string, unknown> = {};
  if (want !== 'fleet') {
    const d = solveDoors(ctx.board, ctx.day, ctx.allocation);
    const m = (x: typeof d.stats) => x.waitMin + x.preloadMin + x.overlapMin;
    const proven = d.groups.every((g) => g.optimal);
    const gap = d.groups.reduce((a, g) => a + Math.max(0, m(g.stats) - g.lowerBoundMin), 0);
    Object.assign(solved, { doorsBefore: m(d.baseline), doorsAfter: m(d.realized), gap, ms: d.ms, changes: d.changes.slice(0, 5) });
    if (m(d.realized) < m(d.baseline) - 0.5) {
      lines.push(`月台门：排队 + 提前装车 + 两车挤一樘门 合计 ${n0(m(d.baseline))} → ${n0(m(d.realized))} 分钟（${proven ? '已证明是最优' : `离最优最多 ${n0(gap)} 分钟`}，${(d.ms / 1000).toFixed(1)} 秒算完）。`);
      for (const c of d.changes.slice(0, 5)) lines.push(`- ${c}`);
      proposals.push({ id: `opt-doors-${ctx.t}`, title: '按求解的结果重新排月台门', effect: `等门和提前装车合计少 ${n0(m(d.baseline) - m(d.realized))} 分钟；只改门，不用重新仿真`, actions: [{ kind: 'day', day: d.day }], risk: 'low', cost: 0 });
    } else lines.push(`月台门：现在的排法已经${proven ? '是最优（已证明）' : '和求解的一样好'}，排队 + 提前装车合计 ${n0(m(d.baseline))} 分钟。`);
  }
  if (want !== 'doors') {
    const f = solveFleet(ctx.board, ctx.day, ctx.allocation);
    const better = f.stats.units < f.baseline.units || f.stats.cost < f.baseline.cost - 0.5 || f.stats.idleH < f.baseline.idleH - 0.1;
    Object.assign(solved, { fleetBefore: f.baseline, fleetAfter: f.stats, lowerBound: f.lowerBound, fleetChanges: f.changes.slice(0, 5) });
    if (better) {
      lines.push(`派车：用车 ${f.baseline.units} → ${f.stats.units} 辆，空闲 ${f.baseline.idleH.toFixed(1)} → ${f.stats.idleH.toFixed(1)} 小时，每天 $${n0(f.baseline.cost)} → $${n0(f.stats.cost)}（${f.optimal ? '已证明是最优' : `用车的下界 ${f.lowerBound} 辆`}）。`);
      for (const c of f.changes.slice(0, 5)) lines.push(`- ${c}`);
      proposals.push({ id: `opt-fleet-${ctx.t}`, title: '按求解的结果重新派车', effect: `用车 ${f.baseline.units} → ${f.stats.units} 辆、每天少花 $${n0(f.baseline.cost - f.stats.cost)}；只改派车，不用重新仿真`, actions: [{ kind: 'day', day: f.day }], risk: 'low', cost: 0 });
    } else lines.push(`派车：现在的派法已经${f.optimal ? '是最优（已证明）' : '和求解的一样好'}：${f.baseline.units} 辆车、空闲 ${f.baseline.idleH.toFixed(1)} 小时。`);
  }
  lines.push('补货批量和按作业量排班在调度台的「求解」页和管理台里，可以改约束再算。');
  return result('optimize_dispatch', args, lines.join('\n'), '调度台的求解器（分支定界，精确或给出离最优的上限）', { proposals, links: [{ kind: 'op', id: ctx.board.ops[0]?.id ?? '', label: '看调度台' }] }, { solved });
}

function help(): ToolResult {
  const lines = [
    '我是值班助手，读调度台、闭环孪生和设施监控的数据回答问题，数字都来自这些数据。可以这样问：',
    '- 「现在有什么风险」「整体情况怎么样」',
    '- 「M02 在哪」「哪些车会晚」「乳品还剩多少」「D05 什么时候空」',
    '- 「港口怎么样」「航班到了吗」「下午有几趟去门店」',
    '- 「有什么待处理的建议」「为什么推荐第一条」「如果不处理会怎样」',
    '- 「批准第一条」「把低风险的都批了」——我先列出推演结果，你确认后才执行，并记进操作记录',
    '- 「写交接班报告」「今日计划」「复盘一下今天的建议」「冷链门不够用怎么办」',
    '- 「M02 为什么晚」「门店今天为什么晚」「有没有异常的指标」——按现场记录逐分钟归因、和平时比',
    '- 「港口物流中心怎么样」「本店的货在哪」「哪里是瓶颈」「机场货站预约错峰」——仓储中心的库区、排队和本店的货',
    '- 「数据靠谱吗」「我能批多少」——数据质量和规则表；每个回答下面写着依据、把握和下一步',
  ];
  return result('help', {}, lines.join('\n'), '值班助手', { followups: ['现在有什么风险', '有什么待处理的建议', '写交接班报告'] }, { examples: lines });
}

export const TOOLS: ToolDef[] = [
  { name: 'get_overview', description: 'Overall status now: vehicles by state, store deliveries so far, pending twin recommendations, active incidents, KPIs and the top things to watch.', parameters: { type: 'object', properties: {} }, run: (c) => overview(c) },
  { name: 'list_risks', description: 'Ranked list of what needs attention now (pending recommendations, late or over-temperature vehicles, dispatch issues in the next two hours, incidents, stock running out, facility alarms), with proposals where something can be done.', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 12 } } }, run: (c, a) => risks(c, a) },
  { name: 'get_vehicle', description: 'Where one vehicle is and what it is doing: next stop with planned and estimated arrival, delay, cargo temperature, load, related recommendations and dispatch issues.', parameters: { type: 'object', properties: { vid: { type: 'integer', description: 'Vehicle index' }, id: { type: 'string', description: 'Job or vehicle id such as M02 or DS-BEV-1' } } }, run: (c, a, m) => vehicle(c, a, m) },
  { name: 'list_late', description: 'Vehicles running late now, recommendations about predicted late arrivals, and planned late arrivals from the dispatch board.', parameters: { type: 'object', properties: {} }, run: (c) => lateList(c) },
  { name: 'get_stock', description: 'Store stock per product family (twin estimate and actual), sales per hour, hours until sold out, and stock-out recommendations.', parameters: { type: 'object', properties: { fams: { type: 'array', items: { type: 'string' }, description: 'Product family keys; empty = families at risk' } } }, run: (c, a) => stock(c, a) },
  { name: 'get_doors', description: 'Distribution center dock doors: usage now and in the next hour, yard waits, door conflicts, or the bookings of one door.', parameters: { type: 'object', properties: { door: { type: 'string', description: 'Door id such as C05 or D12' } } }, run: (c, a) => doors(c, a) },
  { name: 'get_facility', description: 'Status of one facility (port, airport, distribution center, store receiving) from the facility monitor, plus its upcoming jobs.', parameters: { type: 'object', properties: { facility: { type: 'string', enum: ['port', 'airport', 'dc', 'store'] } }, required: ['facility'] }, run: (c, a) => facility(c, a) },
  { name: 'list_cards', description: 'Pending twin recommendation cards with the recommended option and its simulated outcome, and recently handled cards.', parameters: { type: 'object', properties: {} }, run: (c, a, m) => cards(c, a, m) },
  { name: 'explain_card', description: 'Explain why the twin recommends an option: every option with its simulated late, over-temperature and stock-out minutes, extra cost and total score.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }, run: (c, a) => explain(c, a) },
  { name: 'what_if', description: 'Simulated outcome of a different option for a recommendation card (default: doing nothing), the twin versus no twin comparison so far, or an ad-hoc disruption (a vehicle, liner, train or flight late by N minutes, a dock door closed for a period, a road closed) run through the field model against the same day without it: late, over-temperature, stock-out and door-wait minutes and cost; read-only.', parameters: { type: 'object', properties: { key: { type: 'string' }, option: { type: 'string' } } }, run: (c, a) => whatIf(c, a) },
  { name: 'propose_decision', description: 'Prepare approving (with an option) or rejecting one or more recommendation cards. Returns a proposal that a person must confirm; nothing is executed by this tool.', parameters: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['approve', 'reject'] }, option: { type: 'string' } }, required: ['keys', 'action'] }, run: (c, a) => decide(c, a) },
  { name: 'get_kpi', description: 'Planned KPIs from the dispatch board and field results so far with and without the twin.', parameters: { type: 'object', properties: {} }, run: (c) => kpi(c) },
  { name: 'list_incidents', description: 'Active road incidents, recent vehicle faults and pending breakdown or temperature recommendations.', parameters: { type: 'object', properties: {} }, run: (c) => incidents(c) },
  { name: 'get_schedule', description: 'Jobs departing or arriving in a time window (seconds since midnight).', parameters: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' } } }, run: (c, a) => schedule(c, a) },
  { name: 'shift_handover', description: 'Shift handover report: results, what happened, open items and what the next shift should watch.', parameters: { type: 'object', properties: { shift: { type: 'string', enum: ['dawn', 'day', 'mid', 'night'] } } }, run: (c, a) => shift(c, a) },
  { name: 'review_recommendations', description: 'Review of handled recommendations: predicted versus actual outcome, adoption and hit rate by kind.', parameters: { type: 'object', properties: {} }, run: (c) => reviewTool(c) },
  { name: 'get_forecast', description: 'Forecasts from the selected models (rule versus learned, picked by validation error): store demand per product family, liner and train delays, road travel time.', parameters: { type: 'object', properties: { fams: { type: 'array', items: { type: 'string' } }, tomorrow: { type: 'boolean' }, delays: { type: 'boolean' } } }, run: (c, a) => forecast(c, a) },
  { name: 'plan_network', description: 'Multi-store network plan for the current region: which distribution centers to open or expand, cost per year versus today, vehicles and km per day, with the reasons.', parameters: { type: 'object', properties: { stores: { type: 'integer', minimum: 1, maximum: 12 } } }, run: (c, a) => network(c, a) },
  { name: 'get_crossborder', description: 'Cross-border inbound flows: clearance time per mode consistent with the simulation, inspection rates, required documents, declarations per year and exchange-rate sensitivity of landed cost.', parameters: { type: 'object', properties: {} }, run: (c, a) => border(c, a) },
  { name: 'optimize_dispatch', description: 'Solve dock-door assignment and vehicle scheduling for the day (exact branch and bound or a proven bound) and propose applying the solution to the dispatch board.', parameters: { type: 'object', properties: { what: { type: 'string', enum: ['doors', 'fleet', 'both'] } } }, run: (c, a) => optimize(c, a) },
  { name: 'search_knowledge', description: 'Search the procedures and design documents and return matching passages with their source.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, run: (c, a) => knowledge(c, a) },
  { name: 'help', description: 'What the assistant can do, with example questions.', parameters: { type: 'object', properties: {} }, run: () => help() },
  ...OPS_TOOLS,
];
export const tool = (name: string): ToolDef => TOOLS.find((x) => x.name === name) as ToolDef;
export { famLabel };
