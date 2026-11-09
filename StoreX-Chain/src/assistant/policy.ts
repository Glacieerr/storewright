import type { Option, Rec } from '../twin/types';
import { clock } from '../twin/twin';
import { statusAt } from './brief';
import { dataQuality } from './quality';
import { approverOf, canExecute, ESCALATE_AFTER, LIMIT, ROLE_LABEL, type Role } from './roles';
import type { AssistCtx, PolicyCheck, Proposal } from './types';

/**
 * 规则表（护栏）：值班助手给出的每条提议，在显示之前都按这张表检查一遍。
 *
 * - 违反硬性规定的（block）不给出，回答里说明为什么、有什么别的做法；
 * - 要特别留意的（warn）照样给出，在提议上标明；数据较差时只能人工逐条核实后执行（不批量、不自动）；
 * - 说明（info）：这条要谁执行、要谁批。
 * 执行、提交审批时，检查结果一起记进操作记录。值班助手自己从不执行任何东西：执行一律要人点「确认执行」。
 */
export const HARD = {
  /** 冷链货（冷藏车、多温车）在月台、场地或路边等待的上限（分钟） */
  reeferWaitMin: 30,
  /** 预计让冷链货超温这么多分钟、而别的做法不超温的，不提议（分钟） */
  reeferHotMin: 30,
  /** 预约时段最多挪多少分钟：冷链车、普通车 */
  reeferShiftMin: 30,
  truckShiftMin: 60,
  /** 只改这么久以后才到的车的预约（分钟）：快到的车来不及通知 */
  apptLeadMin: 30,
  /** 一次批量执行最多几条 */
  maxBatch: 6,
};

export interface RuleRow {
  key: string;
  label: string;
  text: string;
}
/** 规则表（「我能批多少」「有哪些规定」按它回答；资料库里也有一份） */
export const RULES: RuleRow[] = [
  { key: 'confirm', label: '人确认', text: '值班助手只读数据、只给提议；每条提议先给人看推演结果，点「确认执行」才执行，问题里要求跳过确认、审批的不理会。' },
  { key: 'role', label: '角色权限', text: `只读不能执行；调度员能直接执行低风险的和多花不超过 $${LIMIT.dispatcher} 的；站长 $${LIMIT.manager.toLocaleString('en-US')} 以内；区域经理不限。超出的提交上一级审批，审批单 ${ESCALATE_AFTER / 60} 分钟没人批往上报。` },
  { key: 'state', label: '建议卡状态', text: '只对此刻还待处理的建议卡提议；已经处理过的（执行、否决、问题自己没了）不再提议。' },
  { key: 'twin', label: '要有现场数据', text: '对建议卡做决定要闭环孪生在跑；只有计划数据时不提议。' },
  { key: 'quality', label: '数据质量', text: '数据通道较差（丢点、晚到多）时，提议只能人工逐条核实后执行：不批量、不自动。' },
  { key: 'cold', label: '冷链', text: `冷链货在月台、场地或路边等待不超过 ${HARD.reeferWaitMin} 分钟；会让冷链货超温 ${HARD.reeferHotMin} 分钟以上、而有别的做法不超温的，不提议。` },
  { key: 'batch', label: '批量', text: `一次最多批量执行 ${HARD.maxBatch} 条，超过的分开确认。` },
  { key: 'appt', label: '预约', text: `只改 ${HARD.apptLeadMin} 分钟以后才到的车；冷链车最多挪 ${HARD.reeferShiftMin} 分钟，普通车 ${HARD.truckShiftMin} 分钟；新的时段通知承运商，孪生里不改到达时刻。` },
];

const COLD = /(冷|冻|reefer|chill|frozen)/i;
/** 这张卡涉及的车是不是冷链车（冷藏车、多温车，或者超温卡） */
function isCold(ctx: AssistCtx, r: Rec): boolean {
  if (r.kind === 'temp') return true;
  const op = r.vid !== undefined ? ctx.board.ops.find((o) => o.vehicle === r.vid) : undefined;
  return !!op && (op.unit === 'reefer' || op.unit === 'multi' || COLD.test(op.zone ?? ''));
}

/** 一个做法让车等多久（分钟）：等这樘门、让车路边晚点进、等收货口 */
function waitOf(r: Rec, o: Option, t: number): number {
  const hold = o.cmds.find((c) => c.kind === 'hold');
  if (hold && hold.kind === 'hold') return Math.max(0, (hold.until - t) / 60);
  if ((r.kind === 'door' || r.kind === 'dock') && o.key === 'accept') return o.late;
  return 0;
}

export interface PolicyResult {
  checks: PolicyCheck[];
  need: Role;
  manualOnly: boolean;
  /** 违反硬性规定的原因（有就不给出这条提议） */
  blocked?: string;
}

/** 检查一条提议（按提问人的角色；不给就按调度员） */
export function checkProposal(p: Proposal, ctx: AssistCtx): PolicyResult {
  const role: Role = ctx.role ?? 'dispatcher';
  const checks: PolicyCheck[] = [];
  const add = (rule: string, level: PolicyCheck['level'], ok: boolean, text: string) => checks.push({ rule, label: RULES.find((x) => x.key === rule)?.label ?? rule, level, ok, text });
  let manualOnly = false;

  // —— 角色 ——
  const need: Role = role !== 'viewer' && canExecute(role, p) ? role : role === 'viewer' && canExecute('dispatcher', p) ? 'dispatcher' : approverOf(p);
  if (role === 'viewer') add('role', 'info', false, `只读角色不能执行；这条要${ROLE_LABEL[need]}确认${need === 'dispatcher' ? '' : '或审批'}。`);
  else if (need !== role) add('role', 'info', false, `多花 $${Math.round(p.cost)}，超过${ROLE_LABEL[role]}能直接执行的上限（$${LIMIT[role].toLocaleString('en-US')}），确认后提交${ROLE_LABEL[need]}审批。`);
  else add('role', 'info', true, `${ROLE_LABEL[role]}可以直接确认执行。`);

  // —— 建议卡：要有孪生、此刻还待处理；冷链 ——
  const decides = p.actions.flatMap((a) => (a.kind === 'decide' ? [a] : []));
  let blocked: string | undefined;
  if (decides.length && !ctx.twin) blocked = '闭环孪生还没跑完，不能对建议卡做决定。';
  for (const a of decides) {
    const r = ctx.twin?.recs.find((x) => x.key === a.key);
    if (!r || r.t > ctx.t || statusAt(r, ctx.t) !== 'proposed') {
      blocked ??= `建议卡「${r?.title ?? a.key}」此刻已经不是待处理的了。`;
      continue;
    }
    if (a.action !== 'approve' || !isCold(ctx, r)) continue;
    const o = r.options.find((x) => x.key === a.option) ?? (r.options[r.best] as Option);
    const others = r.options.filter((x) => x !== o);
    const wait = waitOf(r, o, ctx.t);
    const shorter = others.find((x) => waitOf(r, x, ctx.t) < HARD.reeferWaitMin && x.hot <= o.hot + 0.5);
    if (wait > HARD.reeferWaitMin && shorter) blocked ??= `「${o.label}」要让冷链车等约 ${Math.round(wait)} 分钟，超过 ${HARD.reeferWaitMin} 分钟的上限；可以选「${shorter.label}」。`;
    else if (wait > HARD.reeferWaitMin) add('cold', 'warn', false, `冷链车要等约 ${Math.round(wait)} 分钟（上限 ${HARD.reeferWaitMin} 分钟），但没有更短的做法；执行时盯住货温。`);
    const cooler = others.find((x) => x.hot < 5);
    if (o.hot >= HARD.reeferHotMin && cooler) blocked ??= `「${o.label}」预计让冷链货超温 ${Math.round(o.hot)} 分钟，而「${cooler.label}」不超温（超温 ${Math.round(cooler.hot)} 分钟）。`;
    else if (o.hot >= 0.5) add('cold', 'warn', false, `预计冷链货仍会超温 ${Math.round(o.hot)} 分钟：到店单独验收，记下货温和超温时长。`);
    else add('cold', 'info', true, '冷链：不让货等太久、不超温。');
  }

  // —— 预约 ——
  for (const a of p.actions) {
    if (a.kind !== 'notify' || !a.moves) continue;
    for (const m of a.moves) {
      const cold = m.cold ?? COLD.test(m.label);
      const lim = (cold ? HARD.reeferShiftMin : HARD.truckShiftMin) * 60;
      if (Math.abs(m.to - m.from) > lim + 1) blocked ??= `${m.label} 的预约挪了 ${Math.round(Math.abs(m.to - m.from) / 60)} 分钟，超过${cold ? '冷链车' : '普通车'}的上限 ${lim / 60} 分钟。`;
      if (m.from < ctx.t + HARD.apptLeadMin * 60 - 1) blocked ??= `${m.label} 原定 ${clock(m.from)} 到，不到 ${HARD.apptLeadMin} 分钟，来不及通知。`;
    }
    add('appt', 'info', true, `只改 ${HARD.apptLeadMin} 分钟以后才到的车；冷链车最多挪 ${HARD.reeferShiftMin} 分钟、普通车 ${HARD.truckShiftMin} 分钟。`);
  }

  // —— 数据质量、批量 ——
  const dq = dataQuality(ctx);
  if (dq.level === 'poor' && (decides.length || p.actions.some((a) => a.kind === 'fix' || a.kind === 'day'))) {
    manualOnly = true;
    add('quality', 'warn', false, `数据通道较差：先核实（问司机、看监控）再执行，只能逐条人工确认。${dq.text}`);
  }
  if (decides.length > HARD.maxBatch) {
    manualOnly = true;
    add('batch', 'warn', false, `一次 ${decides.length} 条，超过 ${HARD.maxBatch} 条的上限，分开确认。`);
  }
  return { checks, need, manualOnly, ...(blocked ? { blocked } : {}) };
}

/** 检查结果写成一句话（操作记录用） */
export function policySummary(p: Proposal): string {
  const c = p.checks ?? [];
  const bad = c.filter((x) => !x.ok && x.level !== 'info');
  const who = c.find((x) => x.rule === 'role');
  const parts = [bad.length ? `留意：${bad.map((x) => x.label).join('、')}` : '规则检查通过'];
  if (who && !who.ok) parts.push(who.text);
  if (p.manualOnly) parts.push('人工逐条核实');
  return parts.join('；');
}

/** 按规则表检查一批提议：违反硬性规定的拿掉（返回原因），其余附上检查结果 */
export function applyPolicy(list: readonly Proposal[], ctx: AssistCtx): { kept: Proposal[]; blocked: { title: string; why: string }[] } {
  const kept: Proposal[] = [];
  const blocked: { title: string; why: string }[] = [];
  for (const p of list) {
    const r = checkProposal(p, ctx);
    if (r.blocked) blocked.push({ title: p.title, why: r.blocked });
    else kept.push({ ...p, checks: r.checks, need: r.need, ...(r.manualOnly ? { manualOnly: true } : {}) });
  }
  return { kept, blocked };
}
