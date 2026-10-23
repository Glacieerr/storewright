import { createTemplate, type TemplateName } from '@storewright/store-config';
import { handoffBoard, recentNotes, roleOf, sellableCases, shelfNow, stagingOccupancy, type LiveRec, type OpsState, type PlanogramEntry, type StoreStatic } from '@storewright/ops';
import type { Policy, SimScenario } from '@storewright/sim-engine';
import type { AiService } from '../ai';
import type { DemoStore } from '../demo';
import type { StoreRuntime } from '../runtime';
import { searchKnowledge } from './knowledge';

/**
 * 本地助手的查询工具（Phase 5d）。每个工具只读门店数据，返回结构化结果和一段按语言写好的回答。
 * 模板模式直接拼接这些回答；本地语言模型模式把结构化结果交给模型组织语言，模型不能凭空给出数字。
 */

export type Lang = 'zh' | 'en';

export interface ToolContext {
  rt: StoreRuntime;
  demo: DemoStore;
  ai: AiService;
  now: number;
  lang: Lang;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  data: Record<string, unknown>;
  /** 按语言写好的回答 */
  text: string;
  /** 出处（界面显示「数据来自……」） */
  cite: string;
}

export interface ToolDef {
  name: string;
  /** 给语言模型看的说明（英文） */
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(ctx: ToolContext, args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export const L = (lang: Lang, zh: string, en: string) => (lang === 'zh' ? zh : en);
const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

const ROLE: Record<string, [string, string]> = {
  PICK: ['拣货', 'picking'],
  STAGE: ['暂存', 'staging'],
  HANDOFF: ['交付', 'handoff'],
  LEAD: ['带班负责人', 'team lead'],
  BACKROOM: ['后仓', 'backroom'],
  RESTOCK: ['补货', 'restocking'],
};
const roleText = (lang: Lang, r: string) => (ROLE[r] ? ROLE[r][lang === 'zh' ? 0 : 1] : r);

/**
 * 在问题里找商品：SKU 编号，或商品名里的词（至少 2 个词匹配、或整个名字出现）。
 * 返回得分最高的全部商品（同名的不同规格 / 口味会一起返回），销量高的在前。
 */
export function matchItems(question: string, planogram: readonly PlanogramEntry[]): PlanogramEntry[] {
  const q = question.toLowerCase();
  const sku = /sku-\d{5}/i.exec(question)?.[0]?.toUpperCase();
  if (sku) return planogram.filter((p) => p.itemId === sku);
  const words = new Set(q.match(/[a-z0-9&]+/g) ?? []);
  let bestScore = 0;
  let best: PlanogramEntry[] = [];
  for (const p of planogram) {
    const name = p.name.toLowerCase();
    const tokens = name.match(/[a-z0-9&]+/g) ?? [];
    let score = tokens.filter((t) => t.length >= 3 && words.has(t)).length;
    if (q.includes(name)) score += 10;
    if (score < 2) continue;
    if (score > bestScore) {
      bestScore = score;
      best = [p];
    } else if (score === bestScore) best.push(p);
  }
  return best.sort((a, b) => b.baseVelocity - a.baseVelocity || a.itemId.localeCompare(b.itemId));
}

export function matchItem(question: string, planogram: readonly PlanogramEntry[]): PlanogramEntry | undefined {
  return matchItems(question, planogram)[0];
}

function statusData(s: OpsState, st: StoreStatic, now: number) {
  const rows = handoffBoard(s, st, now);
  const waitingRows = rows.filter((r) => r.arrivedAt !== undefined && !r.session);
  const avgWaitMin = waitingRows.length ? waitingRows.reduce((a, r) => a + r.waitSec, 0) / waitingRows.length / 60 : 0;
  const orders = Object.values(s.orders);
  const late = orders.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.slotStart + o.slotLengthMin * 60_000 < now).length;
  const occ = stagingOccupancy(s, st);
  const used = occ.reduce((a, z) => a + z.used, 0);
  const cap = occ.reduce((a, z) => a + z.capacity, 0);
  const notFound = Object.values(s.orders).reduce((a, o) => a + Object.values(o.lineResults).filter((r) => r.short > 0 || r.substituted > 0 || r.exception).length, 0);
  return {
    orders: orders.length,
    completed: orders.filter((o) => o.status === 'COMPLETED').length,
    waiting: waitingRows.length,
    avgWaitMin: r1(avgWaitMin),
    approaching: rows.filter((r) => r.color === 'YELLOW').length,
    late,
    stagingRate: cap ? used / cap : 0,
    openWalks: Object.values(s.walks).filter((w) => w.status === 'OPEN').length,
    openTasks: {
      restock: Object.values(s.repl).filter((x) => x.status === 'OPEN' || x.status === 'CLAIMED').length,
      exceptions: Object.values(s.exceptions).filter((x) => x.status === 'OPEN' || x.status === 'ASSIGNED').length,
      checks: Object.values(s.checks).filter((x) => x.status === 'OPEN').length,
      counts: Object.values(s.counts).filter((x) => x.status !== 'DONE').length,
    },
    missingLines: notFound,
    openRecs: Object.values(s.recs).filter((r) => r.status === 'OPEN').length,
  };
}

const store_status: ToolDef = {
  name: 'store_status',
  description: 'Current store overview: customers waiting and their average wait, orders today and completed, late orders, staging occupancy, open pick walks, open tasks, open AI recommendations.',
  parameters: { type: 'object', properties: {} },
  run(ctx) {
    const d = statusData(ctx.rt.state, ctx.rt.statics, ctx.now);
    const t = d.openTasks;
    const text = L(
      ctx.lang,
      `现在有 ${d.waiting} 位顾客在等${d.waiting ? `，平均已等 ${d.avgWaitMin} 分钟` : ''}，${d.approaching} 位即将到达。今天共 ${d.orders} 单，已完成 ${d.completed} 单，超过时段还没交付的 ${d.late} 单。暂存占用 ${pct(d.stagingRate)}，待领取的拣货批次 ${d.openWalks} 个；未完成任务：补货 ${t.restock}、后仓补取 ${t.exceptions}、核对货架 ${t.checks}、盘点 ${t.counts}；待处理的 AI 建议 ${d.openRecs} 条。`,
      `${d.waiting} customers are waiting${d.waiting ? ` (average ${d.avgWaitMin} min so far)` : ''} and ${d.approaching} are approaching. ${d.orders} orders today, ${d.completed} completed, ${d.late} past their slot and not handed off. Staging is ${pct(d.stagingRate)} full, ${d.openWalks} pick walks are unclaimed; open tasks: ${t.restock} restocks, ${t.exceptions} backroom picks, ${t.checks} shelf checks, ${t.counts} counts; ${d.openRecs} open AI recommendations.`,
    );
    return { tool: 'store_status', args: {}, data: d, text, cite: L(ctx.lang, '门店实时状态', 'live store status') };
  },
};

const find_item: ToolDef = {
  name: 'find_item',
  description: 'Find an item by name or SKU: shelf location, estimated units on the shelf and confidence, backroom cases and bins, open restock or check tasks, and store notes about it.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'Item name words or SKU id' } }, required: ['query'] },
  run(ctx, args) {
    const st = ctx.rt.statics;
    const s = ctx.rt.state;
    const query = String(args.query ?? '');
    const all = matchItems(query, st.planogram);
    const p = all[0];
    const others = all.slice(1, 4);
    if (!p) return { tool: 'find_item', args, data: { found: false }, text: L(ctx.lang, '没有找到这个商品，可以说出商品名里的两个词或 SKU 编号。', 'I could not find that item; try two words from its name or the SKU id.'), cite: L(ctx.lang, '陈列表', 'planogram') };
    const sh = shelfNow(s, p);
    const cases = sellableCases(s, p.itemId);
    const bins = [...new Set(cases.map((c) => c.binCode).filter(Boolean))];
    const repl = Object.values(s.repl).find((x) => x.itemId === p.itemId && (x.status === 'OPEN' || x.status === 'CLAIMED'));
    const check = Object.values(s.checks).find((x) => x.itemId === p.itemId && x.status === 'OPEN');
    // 同名商品的经验也一起显示（员工记经验时不一定选对规格）
    const ids = new Set(all.filter((x) => x.name === p.name).map((x) => x.itemId));
    const notes = recentNotes(s, 200).filter((n) => n.itemId !== undefined && ids.has(n.itemId));
    const data = { found: true, itemId: p.itemId, name: p.name, locationId: p.locationId, shelfEst: Math.round(sh.est), confidence: Math.round(sh.conf * 100) / 100, capacity: p.capacity, backroomCases: cases.length, bins, restockTask: repl?.id, shelfCheck: check?.id, notes: notes.map((n) => n.text), others: others.map((o) => ({ itemId: o.itemId, locationId: o.locationId })) };
    const otherText = others.length ? L(ctx.lang, `另有 ${others.length} 个同名或相近的商品：${others.map((o) => `${o.itemId}（${o.locationId}）`).join('、')}。`, ` ${others.length} similar items: ${others.map((o) => `${o.itemId} (${o.locationId})`).join(', ')}.`) : '';
    const text = L(
      ctx.lang,
      `${p.name}（${p.itemId}）在货位 ${p.locationId}。系统估算货架上约 ${data.shelfEst} 件（容量 ${p.capacity}，可信度 ${pct(sh.conf)}）；后仓有 ${cases.length} 箱${bins.length ? `，在 ${bins.join('、')}` : ''}。${repl ? `已有补货任务 ${repl.id}。` : ''}${check ? `已有核对任务 ${check.id}。` : ''}${notes.length ? `门店经验：${notes.map((n) => n.text).join('；')}。` : ''}${otherText}`,
      `${p.name} (${p.itemId}) is at ${p.locationId}. The system estimates about ${data.shelfEst} on the shelf (capacity ${p.capacity}, confidence ${pct(sh.conf)}); the backroom has ${cases.length} cases${bins.length ? ` in ${bins.join(', ')}` : ''}.${repl ? ` Restock task ${repl.id} is open.` : ''}${check ? ` Shelf check ${check.id} is open.` : ''}${notes.length ? ` Store notes: ${notes.map((n) => n.text).join('; ')}.` : ''}${otherText}`,
    );
    return { tool: 'find_item', args, data, text, cite: L(ctx.lang, '陈列表、货架估算、后仓记录', 'planogram, shelf estimate, backroom records') };
  },
};

const forecast: ToolDef = {
  name: 'forecast',
  description: 'Order forecast for the next business hours (by pickup slot), with the 80% range, comparison with the usual level, the main reasons, and expected item lines by temperature zone.',
  parameters: { type: 'object', properties: {} },
  run(ctx) {
    const d = ctx.ai.forecastDraft(ctx.now);
    if (!d?.prediction) return { tool: 'forecast', args: {}, data: { available: false }, text: L(ctx.lang, '现在还没有可用的预测模型。', 'No forecast model is available yet.'), cite: L(ctx.lang, '订单量预测模型', 'order forecast model') };
    const p = d.prediction;
    const usual = p.baseline ? (p.value - p.baseline) / p.baseline : 0;
    const reasons = d.reasons.filter((r) => r.factor !== 'BASE_LEVEL').map((r) => factorPhrase(ctx.lang, r)).filter(Boolean);
    const zones = p.breakdown ? Object.entries(p.breakdown.values).map(([z, n]) => `${zoneText(ctx.lang, z)} ${n}`).join(ctx.lang === 'zh' ? '、' : ', ') : '';
    const data = { value: Math.round(p.value), low: Math.round(p.low ?? p.value), high: Math.round(p.high ?? p.value), from: p.from, to: p.to, vsUsual: Math.round(usual * 100), reasons, zones, model: `${d.model.id} v${d.model.version}` };
    const text = L(
      ctx.lang,
      `${hhmm(p.from ?? ctx.now)}–${hhmm(p.to ?? ctx.now)} 预计 ${data.value} 单（80% 区间 ${data.low}–${data.high}），比近 4 周同时段${usual >= 0 ? '高' : '低'} ${Math.abs(data.vsUsual)}%。主要因素：${reasons.join('；') || '无特殊因素'}。${zones ? `预计商品行：${zones}。` : ''}`,
      `${hhmm(p.from ?? ctx.now)}–${hhmm(p.to ?? ctx.now)}: about ${data.value} orders (80% range ${data.low}–${data.high}), ${Math.abs(data.vsUsual)}% ${usual >= 0 ? 'above' : 'below'} the last 4 weeks. Main factors: ${reasons.join('; ') || 'nothing unusual'}.${zones ? ` Expected item lines: ${zones}.` : ''}`,
    );
    return { tool: 'forecast', args: {}, data, text, cite: L(ctx.lang, `订单量预测模型 v${d.model.version}`, `order forecast model v${d.model.version}`) };
  },
};

const staff_status: ToolDef = {
  name: 'staff_status',
  description: 'Who is in which role right now (including temporary moves), who is busy with a task, and who is pinned to the fixed roster.',
  parameters: { type: 'object', properties: { role: { type: 'string', description: 'Optional role filter: PICK, STAGE, HANDOFF, BACKROOM, RESTOCK, LEAD' } } },
  run(ctx, args) {
    const st = ctx.rt.statics;
    const s = ctx.rt.state;
    const filter = typeof args.role === 'string' ? args.role.toUpperCase() : undefined;
    const byRole: Record<string, string[]> = {};
    for (const a of st.roster) {
      const r = roleOf(st, s, a.id) ?? a.role;
      if (filter && r !== filter) continue;
      const tags = [s.roles[a.id] ? L(ctx.lang, '临时', 'temporary') : '', s.staffLocks[a.id] ? L(ctx.lang, '固定', 'pinned') : ''].filter(Boolean);
      (byRole[r] ??= []).push(tags.length ? L(ctx.lang, `${a.name}（${tags.join('、')}）`, `${a.name} (${tags.join(', ')})`) : a.name);
    }
    const parts = Object.entries(byRole).map(([r, names]) => L(ctx.lang, `${roleText(ctx.lang, r)}：${names.join('、')}`, `${roleText(ctx.lang, r)}: ${names.join(', ')}`));
    const text = parts.length ? L(ctx.lang, `现在的岗位安排——${parts.join('；')}。`, `Current roles — ${parts.join('; ')}.`) : L(ctx.lang, '没有符合条件的员工。', 'No matching staff.');
    return { tool: 'staff_status', args, data: { byRole }, text, cite: L(ctx.lang, '员工名单与岗位', 'roster and roles') };
  },
};

function recTitle(lang: Lang, r: LiveRec, st: StoreStatic, s: OpsState): string {
  switch (r.module) {
    case 'FORECAST':
      return L(lang, '订单量预测', 'order forecast');
    case 'ETA': {
      const o = s.orders[r.target];
      return L(lang, `${o ? o.firstName : r.target} 的到店时间`, `arrival time for ${o ? o.firstName : r.target}`);
    }
    case 'AVAILABILITY':
      return L(lang, `${st.planogram.find((p) => p.itemId === r.target)?.name ?? r.target} 可能不在货架上`, `${st.planogram.find((p) => p.itemId === r.target)?.name ?? r.target} may not be on the shelf`);
    case 'COUNT':
      return L(lang, `盘点库位 ${r.target}`, `count bin ${r.target}`);
    case 'STAFFING':
      if (r.action.kind === 'MOVE_ASSOCIATE') {
        const name = st.roster.find((a) => a.id === r.target)?.name ?? r.target;
        return L(lang, `把 ${name} 从${roleText(lang, String(r.action.params?.from ?? '').toUpperCase())}调到${roleText(lang, String(r.action.params?.to ?? ''))}`, `move ${name} from ${roleText(lang, String(r.action.params?.from ?? '').toUpperCase())} to ${roleText(lang, String(r.action.params?.to ?? ''))}`);
      }
      return L(lang, '排班建议', 'staffing plan');
    default:
      return r.module;
  }
}

const explain_recommendation: ToolDef = {
  name: 'explain_recommendation',
  description: 'Explain an AI recommendation: what it suggests, the confidence, the main reasons, the model version and its status. Without an id, explains the newest open recommendation (optionally of a module).',
  parameters: { type: 'object', properties: { recId: { type: 'string' }, module: { type: 'string', description: 'FORECAST, ETA, AVAILABILITY, COUNT, STAFFING' } } },
  run(ctx, args) {
    const s = ctx.rt.state;
    const st = ctx.rt.statics;
    const mod = typeof args.module === 'string' ? args.module.toUpperCase() : undefined;
    const r =
      (typeof args.recId === 'string' ? s.recs[args.recId] : undefined) ??
      Object.values(s.recs)
        .filter((x) => (!mod || x.module === mod) && x.status === 'OPEN')
        .sort((a, b) => b.issuedAt - a.issuedAt)[0] ??
      Object.values(s.recs)
        .filter((x) => !mod || x.module === mod)
        .sort((a, b) => b.issuedAt - a.issuedAt)[0];
    if (!r) return { tool: 'explain_recommendation', args, data: { found: false }, text: L(ctx.lang, '还没有相关的 AI 建议。', 'There is no matching AI recommendation yet.'), cite: L(ctx.lang, 'AI 建议记录', 'AI recommendation log') };
    const reasons = r.reasons.map((x) => factorPhrase(ctx.lang, x)).filter(Boolean);
    const data = { recId: r.id, module: r.module, title: recTitle(ctx.lang, r, st, s), confidence: r.confidence, reasons, status: r.status, model: `${r.model.id} v${r.model.version} (${r.model.kind})`, mode: r.mode };
    const text = L(
      ctx.lang,
      `建议「${data.title}」（${r.id}，置信度 ${pct(r.confidence)}，状态 ${statusText('zh', r.status)}）。主要理由：${reasons.join('；') || '—'}。模型 ${data.model}。`,
      `Recommendation “${data.title}” (${r.id}, confidence ${pct(r.confidence)}, status ${statusText('en', r.status)}). Main reasons: ${reasons.join('; ') || '—'}. Model ${data.model}.`,
    );
    return { tool: 'explain_recommendation', args, data, text, cite: L(ctx.lang, `AI 建议 ${r.id}`, `AI recommendation ${r.id}`) };
  },
};

const wait_analysis: ToolDef = {
  name: 'wait_analysis',
  description: 'Why customers are waiting: arrivals in the last hour versus handoff staff, orders that arrived before they were staged, busy handoff sessions, and whether moving someone would help.',
  parameters: { type: 'object', properties: {} },
  run(ctx) {
    const s = ctx.rt.state;
    const st = ctx.rt.statics;
    const now = ctx.now;
    const rows = handoffBoard(s, st, now);
    const waiting = rows.filter((r) => r.arrivedAt !== undefined && !r.session);
    const notReady = waiting.filter((r) => !r.ready).length;
    const arrivedLastHour = Object.values(s.orders).filter((o) => o.arrivedAt !== undefined && now - o.arrivedAt <= 3_600_000).length;
    const handoffStaff = st.roster.filter((a) => (roleOf(st, s, a.id) ?? a.role) === 'HANDOFF').length;
    const sessions = Object.values(s.sessions).filter((x) => x.status !== 'COMPLETED').length;
    const longest = waiting.reduce((m, r) => Math.max(m, r.waitSec), 0);
    const move = Object.values(s.recs).find((r) => r.status === 'OPEN' && r.module === 'STAFFING' && r.action.kind === 'MOVE_ASSOCIATE');
    const data = { waiting: waiting.length, notReady, arrivedLastHour, handoffStaff, activeSessions: sessions, longestWaitMin: r1(longest / 60), openMoveRec: move?.id };
    const causes: string[] = [];
    if (handoffStaff && arrivedLastHour / handoffStaff > 12) causes.push(L(ctx.lang, `过去一小时到了 ${arrivedLastHour} 位顾客，交付只有 ${handoffStaff} 人`, `${arrivedLastHour} arrivals in the last hour with only ${handoffStaff} on handoff`));
    if (notReady) causes.push(L(ctx.lang, `${notReady} 位在等的顾客订单还没暂存完`, `${notReady} waiting customers’ orders are not fully staged yet`));
    if (sessions >= handoffStaff && handoffStaff > 0) causes.push(L(ctx.lang, `交付员都在服务中（${sessions} 个会话）`, `all handoff staff are busy (${sessions} sessions)`));
    const text = waiting.length
      ? L(
          ctx.lang,
          `现在 ${waiting.length} 位顾客在等，最长已等 ${data.longestWaitMin} 分钟。${causes.length ? `可能的原因：${causes.join('；')}。` : '没有发现明显的瓶颈。'}${move ? `AI 已建议调动人手（${move.id}）。` : ''}`,
          `${waiting.length} customers are waiting, the longest for ${data.longestWaitMin} min. ${causes.length ? `Likely causes: ${causes.join('; ')}.` : 'No obvious bottleneck.'}${move ? ` The AI has suggested a staff move (${move.id}).` : ''}`,
        )
      : L(ctx.lang, '现在没有顾客在等。', 'No customers are waiting right now.');
    return { tool: 'wait_analysis', args: {}, data, text, cite: L(ctx.lang, '交付看板与员工岗位', 'handoff board and roles') };
  },
};

/**
 * 推演结果几乎没变时说明原因（全流程走查发现：只给出「4 → 4 分钟」看不出为什么）。
 * 只用仿真里的数据：这个时段排了几个人、每人每小时摊到几单、这个岗位全天的忙碌比例；
 * 再找出每人负担最重的时段，供调整参考。订单按取货时段计。
 */
function explainStaffing(lang: Lang, role: 'pick' | 'stage' | 'handoff', delta: number, from: number, to: number, base: SimScenario, ordersPerDay: number, busyHours: number, d: { before: { avgWaitMin: number; p90WaitMin: number; lateOrderPct: number }; after: { avgWaitMin: number; p90WaitMin: number; lateOrderPct: number } }): { text: string; data: Record<string, unknown> } | undefined {
  const staff = base.staffing[role];
  const name = L(lang, { pick: '拣货员', stage: '暂存员', handoff: '交付员' }[role], { pick: 'pickers', stage: 'stagers', handoff: 'handoff associates' }[role]);
  const one = { pick: 'picker', stage: 'stager', handoff: 'handoff associate' }[role];
  const hours = Array.from({ length: to - from }, (_, i) => from + i).filter((h) => (staff[h] ?? 0) > 0);
  if (!hours.length) return { text: L(lang, `这个时段本来没有排${name}，推演没有改变排班。`, ` No ${name} is scheduled in those hours, so the plan did not change.`), data: { scheduled: false } };
  const small = Math.abs(d.after.avgWaitMin - d.before.avgWaitMin) < 0.5 && Math.abs(d.after.p90WaitMin - d.before.p90WaitMin) < 1 && Math.abs(d.after.lateOrderPct - d.before.lateOrderPct) < 0.5;
  if (!small) return undefined;
  const prof = base.demand.hourlyProfile;
  const total = prof.reduce((x, y) => x + y, 0) || 1;
  const orders = (h: number) => (ordersPerDay * (prof[h] ?? 0)) / total;
  const load = (h: number) => ((staff[h] ?? 0) > 0 ? orders(h) / (staff[h] ?? 1) : 0);
  const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
  const people = r1(avg(hours.map((h) => staff[h] ?? 0)));
  const perHour = r1(avg(hours.map(orders)));
  const perPerson = r1(avg(hours.map(load)));
  const staffed = staff.reduce((x, y) => x + y, 0);
  const util = staffed > 0 ? Math.round((busyHours / staffed) * 100) : 0;
  // 同样长度（全天时按 3 小时）里每人负担最重的时段
  const len = Math.min(to - from, 3, 24);
  let best = from;
  let bestLoad = -1;
  for (let h0 = 0; h0 + len <= 24; h0++) {
    const hs = Array.from({ length: len }, (_, i) => h0 + i).filter((h) => (staff[h] ?? 0) > 0);
    if (hs.length < len) continue;
    const v = avg(hs.map(load));
    if (v > bestLoad + 1e-9) {
      bestLoad = v;
      best = h0;
    }
  }
  const suggest = best !== from && bestLoad > perPerson * 1.2;
  const lead = delta > 0
    ? L(lang, `加人几乎没有改变结果：`, ` Adding people barely changes the result: `)
    : L(lang, `减人几乎没有影响：`, ` Removing people barely matters: `);
  const facts = L(
    lang,
    `${from}–${to} 点平均排了 ${people} 名${name}，每小时约 ${perHour} 单（每人约 ${perPerson} 单，按取货时段计）；${name}全天的忙碌时间约占排班的 ${util}%。从推演结果看，这个时段人手不是瓶颈。`,
    `${from}:00–${to}:00 already has ${people} ${people === 1 ? one : name} on average for about ${perHour} orders an hour (${perPerson} per person, by pickup slot); over the day ${name} are busy about ${util}% of their scheduled time. The result suggests staffing is not the bottleneck then.`,
  );
  const hint = suggest
    ? L(lang, `每人负担最重的是 ${best}–${best + len} 点（每人每小时约 ${r1(bestLoad)} 单），在那时调整更可能有用。`, ` The heaviest load per person is ${best}:00–${best + len}:00 (about ${r1(bestLoad)} orders per person per hour); a change there is more likely to help.`)
    : '';
  return { text: `${lead}${facts}${hint}`, data: { scheduled: true, people, ordersPerHour: perHour, ordersPerPerson: perPerson, utilizationPct: util, busiestWindow: suggest ? [best, best + len] : undefined } };
}

const whatif: ToolDef = {
  name: 'whatif',
  description: 'Simulate a what-if on this store (3 simulated days, same orders and random events): change the headcount of a role during some hours, or scale demand. Returns average and 90th-percentile wait, late orders, door dwell and labor hours, before and after.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'pick, stage or handoff' },
      delta: { type: 'number', description: 'Headcount change, e.g. 1 or -1' },
      fromHour: { type: 'number' },
      toHour: { type: 'number' },
      demandFactor: { type: 'number', description: 'Demand multiplier, e.g. 1.2 for +20%' },
    },
  },
  async run(ctx, args) {
    // 仿真引擎只在问「如果……会怎样」时才加载（浏览器里的门店中枢因此小一些，决策记录 0015）
    const { aiAblationPolicies, defaultScenario, OPTIMIZED, runExperiment } = await import('@storewright/sim-engine');
    const role = (['pick', 'stage', 'handoff'] as const).find((r) => r === String(args.role ?? '').toLowerCase());
    const delta = Number.isFinite(Number(args.delta)) ? Math.round(Number(args.delta)) : 0;
    const factor = Number.isFinite(Number(args.demandFactor)) && Number(args.demandFactor) > 0 ? Number(args.demandFactor) : 1;
    // 按本店的模板（建材店和超市的需求、排班不同）
    const tpl: TemplateName = ctx.demo.ctx.model.config.template === 'custom' ? 'medium' : ctx.demo.ctx.model.config.template;
    const base = defaultScenario(tpl);
    const from = Number.isFinite(Number(args.fromHour)) ? Math.max(0, Math.min(23, Math.round(Number(args.fromHour)))) : 0;
    const to = Number.isFinite(Number(args.toHour)) ? Math.max(from + 1, Math.min(24, Math.round(Number(args.toHour)))) : 24;
    const changed: SimScenario = { ...base, demand: { ...base.demand, ordersPerDay: Math.round(base.demand.ordersPerDay * factor) }, staffing: { ...base.staffing } };
    if (role && delta) changed.staffing[role] = base.staffing[role].map((n, h) => (h >= from && h < to && n > 0 ? Math.max(1, n + delta) : n));
    const policy: Policy = aiAblationPolicies(OPTIMIZED).at(-1) as Policy;
    const config = ctx.demo.ctx.model.config ?? createTemplate(tpl);
    const run = (scenario: SimScenario) => runExperiment({ template: tpl, config, reps: 3, baseSeed: 401, policies: [policy], scenario }).policies[0]?.summary;
    const a = run(factor !== 1 ? { ...base, demand: changed.demand } : base);
    const b = run(changed);
    if (!a || !b) return { tool: 'whatif', args, data: {}, text: '', cite: '' };
    const m = (x: typeof a, k: keyof typeof a) => r1((x[k] as { mean: number }).mean);
    const data = {
      change: { role, delta, from, to, demandFactor: factor },
      before: { avgWaitMin: m(a, 'avgWaitMin'), p90WaitMin: m(a, 'p90WaitMin'), lateOrderPct: m(a, 'lateOrderPct'), readyDwellMin: m(a, 'avgReadyDwellMin'), staffedHours: m(a, 'staffedHoursTotal') },
      after: { avgWaitMin: m(b, 'avgWaitMin'), p90WaitMin: m(b, 'p90WaitMin'), lateOrderPct: m(b, 'lateOrderPct'), readyDwellMin: m(b, 'avgReadyDwellMin'), staffedHours: m(b, 'staffedHoursTotal') },
    };
    const what =
      role && delta
        ? L(ctx.lang, `${roleText('zh', role.toUpperCase())}${delta > 0 ? '多' : '少'} ${Math.abs(delta)} 人（${from}–${to} 点）`, `${delta > 0 ? '+' : ''}${delta} on ${roleText('en', role.toUpperCase())} (${from}:00–${to}:00)`)
        : '';
    const dem = factor !== 1 ? L(ctx.lang, `订单${factor > 1 ? '多' : '少'} ${Math.round(Math.abs(factor - 1) * 100)}%`, `orders ${factor > 1 ? '+' : '−'}${Math.round(Math.abs(factor - 1) * 100)}%`) : '';
    const B = data.before;
    const A = data.after;
    const text = L(
      ctx.lang,
      `按 3 天仿真（同样的订单和随机事件）${[what, dem].filter(Boolean).join('、') || '保持现状'}：平均等待 ${B.avgWaitMin} → ${A.avgWaitMin} 分钟，90% 的顾客等待不超过 ${B.p90WaitMin} → ${A.p90WaitMin} 分钟，迟到订单 ${B.lateOrderPct}% → ${A.lateOrderPct}%，门口停留 ${B.readyDwellMin} → ${A.readyDwellMin} 分钟，排班工时 ${B.staffedHours} → ${A.staffedHours}。`,
      `Over 3 simulated days (same orders and random events) with ${[what, dem].filter(Boolean).join(', ') || 'no change'}: average wait ${B.avgWaitMin} → ${A.avgWaitMin} min, 90th-percentile wait ${B.p90WaitMin} → ${A.p90WaitMin} min, late orders ${B.lateOrderPct}% → ${A.lateOrderPct}%, door dwell ${B.readyDwellMin} → ${A.readyDwellMin} min, staffed hours ${B.staffedHours} → ${A.staffedHours}.`,
    );
    const why = role && delta ? explainStaffing(ctx.lang, role, delta, from, to, base, changed.demand.ordersPerDay, m(a, `${role}BusyHours` as keyof typeof a), data) : undefined;
    return { tool: 'whatif', args, data: why ? { ...data, explanation: why.data } : data, text: why ? `${text}${why.text}` : text, cite: L(ctx.lang, '运营仿真（3 天，公共随机数）', 'operations simulation (3 days, common random numbers)') };
  },
};

const knowledge: ToolDef = {
  name: 'knowledge',
  description: 'Search the store’s operating procedures and staff notes (experience captured on the floor). Use for “how do I…”, “what should I do when…”, and tips about items or locations.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  run(ctx, args) {
    const s = ctx.rt.state;
    const names = new Map(ctx.rt.statics.planogram.map((p) => [p.itemId, p.name]));
    const hits = searchKnowledge(String(args.query ?? ''), recentNotes(s, 500), ctx.lang, 3, (id) => names.get(id));
    if (!hits.length) return { tool: 'knowledge', args, data: { hits: [] }, text: L(ctx.lang, '操作规范和门店经验里没有找到相关内容。', 'Nothing relevant in the procedures or store notes.'), cite: L(ctx.lang, '操作规范与门店经验', 'procedures and store notes') };
    const top = hits[0] as (typeof hits)[number];
    const more = hits.slice(1).filter((h) => h.score >= top.score * 0.6);
    const text = L(
      ctx.lang,
      `${top.kind === 'SOP' ? `【${top.title}】` : '【门店经验】'}${top.text}${more.length ? ` 相关：${more.map((h) => (h.kind === 'SOP' ? h.title : h.text)).join('；')}` : ''}`,
      `${top.kind === 'SOP' ? `[${top.title}] ` : '[Store note] '}${top.text}${more.length ? ` Related: ${more.map((h) => (h.kind === 'SOP' ? h.title : h.text)).join('; ')}` : ''}`,
    );
    return { tool: 'knowledge', args, data: { hits }, text, cite: hits.map((h) => (h.kind === 'SOP' ? L(ctx.lang, `操作规范：${h.title}`, `procedure: ${h.title}`) : L(ctx.lang, `门店经验 ${h.id}`, `store note ${h.id}`))).join(ctx.lang === 'zh' ? '、' : ', ') };
  },
};

const shift_summary: ToolDef = {
  name: 'shift_summary',
  description: 'A handover summary since a given hour (default: the start of today): orders handed off and average wait, missing lines and backroom picks, cold-chain alerts, AI recommendations and how many were adopted, and what is still open for the next shift.',
  parameters: { type: 'object', properties: { sinceHour: { type: 'number' } } },
  run(ctx, args) {
    const s = ctx.rt.state;
    const t = new Date(ctx.now);
    const sinceHour = Number.isFinite(Number(args.sinceHour)) ? Math.max(0, Math.min(23, Math.round(Number(args.sinceHour)))) : 0;
    const since = new Date(t.getFullYear(), t.getMonth(), t.getDate(), sinceHour).getTime();
    const done = Object.values(s.orders).filter((o) => o.completedAt !== undefined && o.completedAt >= since);
    const waits = done.filter((o) => o.arrivedAt !== undefined).map((o) => ((o.completedAt as number) - (o.arrivedAt as number)) / 60_000);
    const avgWait = waits.length ? r1(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
    const longWaits = waits.filter((w) => w >= ctx.rt.statics.rules.longWaitMin).length;
    const missing = done.reduce((a, o) => a + Object.values(o.lineResults).filter((r) => r.short > 0).length, 0);
    const subs = done.reduce((a, o) => a + Object.values(o.lineResults).filter((r) => r.substituted > 0).length, 0);
    const cold = Object.values(s.walks).filter((w) => w.coldAlerted && (w.startedAt ?? 0) >= since).length;
    const recs = Object.values(s.recs).filter((r) => r.issuedAt >= since);
    const adopted = recs.filter((r) => r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED').length;
    const handled = recs.filter((r) => r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED' || r.status === 'OVERRIDDEN' || r.status === 'DISMISSED').length;
    const st = statusData(s, ctx.rt.statics, ctx.now);
    const data = { since: hhmm(since), handedOff: done.length, avgWaitMin: avgWait, longWaits, missingLines: missing, substitutions: subs, coldAlerts: cold, aiIssued: recs.length, aiAdopted: adopted, aiHandled: handled, open: st.openTasks, waiting: st.waiting, openWalks: st.openWalks };
    const o = st.openTasks;
    const text = L(
      ctx.lang,
      `交接班摘要（${data.since} 以来）：交付 ${done.length} 单，平均等待 ${avgWait} 分钟，${longWaits} 单等待过久；缺货 ${missing} 行、替代 ${subs} 行；冷链提醒 ${cold} 次。AI 发出 ${recs.length} 条建议，处理了 ${handled} 条，其中采纳 ${adopted} 条。留给下一班：${st.waiting} 位顾客在等，待领取拣货批次 ${st.openWalks} 个，补货 ${o.restock}、后仓补取 ${o.exceptions}、核对货架 ${o.checks}、盘点 ${o.counts}。`,
      `Handover summary (since ${data.since}): ${done.length} orders handed off, average wait ${avgWait} min, ${longWaits} long waits; ${missing} short lines and ${subs} substitutions; ${cold} cold-chain alerts. The AI issued ${recs.length} recommendations, ${handled} were handled and ${adopted} adopted. For the next shift: ${st.waiting} customers waiting, ${st.openWalks} unclaimed pick walks, ${o.restock} restocks, ${o.exceptions} backroom picks, ${o.checks} shelf checks, ${o.counts} counts.`,
    );
    return { tool: 'shift_summary', args, data, text, cite: L(ctx.lang, '今天的事件记录', "today's event log") };
  },
};

export const TOOLS: ToolDef[] = [store_status, find_item, forecast, staff_status, explain_recommendation, wait_analysis, whatif, knowledge, shift_summary];
export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// —— 理由与状态的文字（与员工端一致的简短版本）——

function zoneText(lang: Lang, z: string): string {
  const m: Record<string, [string, string]> = { AMBIENT: ['常温', 'ambient'], CHILLED: ['冷藏', 'chilled'], FROZEN: ['冷冻', 'frozen'], HOT: ['热食', 'hot'] };
  return m[z] ? m[z][lang === 'zh' ? 0 : 1] : z;
}

function statusText(lang: Lang, st: string): string {
  const m: Record<string, [string, string]> = {
    OPEN: ['待处理', 'open'],
    ACCEPTED: ['已采纳', 'accepted'],
    OVERRIDDEN: ['已否决', 'overridden'],
    DISMISSED: ['已忽略', 'dismissed'],
    EXPIRED: ['已过期', 'expired'],
    SUPERSEDED: ['已被取代', 'superseded'],
    AUTO_APPLIED: ['已自动执行', 'applied automatically'],
  };
  return m[st] ? m[st][lang === 'zh' ? 0 : 1] : st;
}

const WEEKDAY: [string, string][] = [
  ['星期日', 'Sunday'],
  ['星期一', 'Monday'],
  ['星期二', 'Tuesday'],
  ['星期三', 'Wednesday'],
  ['星期四', 'Thursday'],
  ['星期五', 'Friday'],
  ['星期六', 'Saturday'],
];

/** 理由的简短文字（服务端回答用） */
export function factorPhrase(lang: Lang, r: { factor: string; value?: number; effect?: { kind: string; amount: number }; params?: Record<string, string | number> }): string {
  const eff = r.effect ? (r.effect.kind === 'MULTIPLY' ? `${r.effect.amount >= 1 ? '+' : '−'}${Math.abs(Math.round((r.effect.amount - 1) * 100))}%` : `${r.effect.amount >= 0 ? '+' : '−'}${Math.abs(r1(r.effect.amount))}`) : '';
  const v = r.value ?? 0;
  const wd = WEEKDAY[Number(r.params?.dow ?? 0)] ?? WEEKDAY[0];
  const phrases: Record<string, [string, string]> = {
    WEEKDAY_FACTOR: [`${(wd as [string, string])[0]} ${eff}`, `${(wd as [string, string])[1]} ${eff}`],
    HOUR_SHARE: [`这段时间占全天 ${Math.round(v)}%`, `these hours carry ${Math.round(v)}% of the day`],
    TREND: [`近期趋势 ${eff}`, `recent trend ${eff}`],
    HOLIDAY: [`节假日 ${eff}`, `holiday ${eff}`],
    HOLIDAY_EVE: [`节前一天 ${eff}`, `day before a holiday ${eff}`],
    DAY_AFTER_HOLIDAY: [`节后第一天 ${eff}`, `day after a holiday ${eff}`],
    PROMO: [`本周促销 ${eff}`, `this week’s promotions ${eff}`],
    STORM_WARNING_TOMORROW: [`明天有风暴预警 ${eff}`, `storm warning for tomorrow ${eff}`],
    STORM_WARNING: [`今天有风暴预警 ${eff}`, `storm warning today ${eff}`],
    HEAVY_RAIN_FORECAST: [`预报大雨 ${eff}`, `heavy rain forecast ${eff}`],
    HEAT_FORECAST: [`预报高温 ${eff}`, `heat forecast ${eff}`],
    COLD_FORECAST: [`预报严寒 ${eff}`, `cold forecast ${eff}`],
    RECENT_LEVEL: [`近期需求水平 ${eff}`, `recent demand level ${eff}`],
    REPORTED_ETA: [`导航预计 ${Math.round(v)} 分钟`, `navigation says ${Math.round(v)} min`],
    TYPICAL_DELAY: [`一般比导航多用 ${eff} 分钟`, `usually ${eff} min longer than navigation`],
    RUSH_HOUR: [`高峰 ${eff} 分钟`, `rush hour ${eff} min`],
    WEEKEND: [`周末 ${eff} 分钟`, `weekend ${eff} min`],
    CUSTOMER_HABIT: [`顾客习惯 ${eff} 分钟`, `customer habit ${eff} min`],
    NO_SALES: [`已经 ${r1(v)} 小时没有卖出（本应卖出约 ${r.params?.expected ?? '?'} 件）`, `no sales for ${r1(v)} h (about ${r.params?.expected ?? '?'} would normally sell)`],
    SUSPECT: ['后仓补取或补货没找到', 'not found during a backroom pick or restock'],
    RECEIPT_DISCREPANCY: ['最近收货有差异', 'recent receipt discrepancy'],
    DAYS_SINCE_COUNT: [`距上次盘点 ${Math.round(v)} 天`, `${Math.round(v)} days since the last count`],
    MOVES_SINCE_COUNT: [`盘点后进出 ${Math.round(v)} 次`, `${Math.round(v)} moves since the last count`],
    DAMAGED: [`${Math.round(v)} 箱损坏`, `${Math.round(v)} damaged cases`],
    HANDOFF_QUEUE: [`交付区 ${Math.round(v)} 位顾客在等`, `${Math.round(v)} customers waiting at handoff`],
    PICK_BACKLOG: [`待拣约 ${Math.round(v)} 分钟工作量`, `about ${Math.round(v)} min of picking waiting`],
    STAGE_BACKLOG: [`${Math.round(v)} 框待暂存`, `${Math.round(v)} totes waiting to be staged`],
    IDLE_IN_SOURCE: [`原岗位有 ${Math.round(v)} 人空闲`, `${Math.round(v)} free in the source role`],
    PEAK_HOUR: [`高峰在 ${r.params?.hour ?? '?'} 点`, `peak at ${r.params?.hour ?? '?'}:00`],
    SAME_TOTAL_HOURS: ['总工时不变', 'same total hours'],
  };
  const p = phrases[r.factor];
  return p ? p[lang === 'zh' ? 0 : 1] : '';
}
