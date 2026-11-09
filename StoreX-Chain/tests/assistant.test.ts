import { describe, expect, it } from 'vitest';
import { Assistant, handover, review, SHIFTS, watchList } from '../src/assistant';
import { fromTrack, twinSnap } from '../src/assistant/context';
import { extract } from '../src/assistant/entities';
import { classify, corpus, HOLDOUT, predict, ruleIntent } from '../src/assistant/intent';
import { buildIndex, search, SOP } from '../src/assistant/knowledge';
import type { AssistCtx } from '../src/assistant/types';
import { buildBoard } from '../src/sim/board';
import { g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import { allocationHour, emptyDay } from '../src/sim/plan';
import { runLoop, type LoopResult } from '../src/twin/loop';
import type { Policy } from '../src/twin/types';
import { trackRow, type TrackCtx } from '../web/src/tracking';

/** 值班助手：意图分类、参数识别、查询工具、提议（只读）、交接班报告、建议复盘、资料库 */
const s = g3(1);
s.traceDay = 86;
const chain = runChain(s);
const trace = chain.trace!;
const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
const loop = (level: 'normal' | 'rough', policy: Policy): LoopResult => runLoop({ vehicles: trace.vehicles, ops: board.ops, board, seed: 1, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level }, { closed: true, policy, decisions: [] });
const open = (level: 'normal' | 'rough'): LoopResult => runLoop({ vehicles: trace.vehicles, ops: board.ops, board, seed: 1, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level }, { closed: false, policy: 'manual', decisions: [] });

function ctxAt(t: number, res?: LoopResult, openRes?: LoopResult, policy: Policy = 'manual'): AssistCtx {
  const tctx: TrackCtx = { list: trace.vehicles, tracked: (i) => board.ops.some((o) => o.vehicle === i), opOf: (i) => board.ops.find((o) => o.vehicle === i), pose: () => undefined, roadAt: () => undefined, ...(res ? { field: { result: res, vidOf: (i: number) => i } } : {}) };
  const rows = trace.vehicles.flatMap((_, i) => {
    const r = trackRow(tctx, i, t);
    return r ? [fromTrack(r)] : [];
  });
  return { t, board, rows, ...(res ? { twin: twinSnap(res, openRes, t, policy, [], trace.storeDemand) } : {}) };
}

describe('意图分类', () => {
  it('训练语料够多，每类意图都有', () => {
    const c = corpus();
    expect(c.length).toBeGreaterThan(800);
    expect(new Set(c.map((x) => x[0])).size).toBe(35);
  });

  it('留出集（另外写的说法，不在训练语料里）准确率不低于 94%', () => {
    const train = new Set(corpus().map((x) => x[1]));
    let ok = 0;
    for (const [want, q] of HOLDOUT) {
      expect(train.has(q)).toBe(false);
      if (predict(q) === want) ok++;
    }
    expect(ok / HOLDOUT.length).toBeGreaterThanOrEqual(0.94);
  });

  it('模型排第一的意图没有对应的说法时往下取：「M02 预计几点到」不是问晚点原因', () => {
    expect(classify('<VEH>预计几点到门店')[0]?.intent).toBeDefined();
    expect(predict('<VEH>预计几点到门店')).not.toBe('rootcause');
    expect(ruleIntent('M02 为什么晚了')).toBe('rootcause');
    expect(ruleIntent('为什么推荐等修好')).toBe('explain');
  });
});

describe('参数识别', () => {
  const ctx = ctxAt(9 * 3600);
  it('时刻：10:30、下午3点半、接下来两小时；「慢一点」不是时刻', () => {
    expect(extract('10:30 有哪些车', ctx).time).toEqual({ at: 10.5 * 3600 });
    expect(extract('下午3点半以后有什么', ctx).time).toEqual({ from: 15.5 * 3600, to: 19.5 * 3600 });
    expect(extract('接下来两小时有什么作业', ctx).time).toEqual({ from: 9 * 3600, to: 11 * 3600 });
    expect(extract('让它慢一点', ctx).time).toBeUndefined();
  });
  it('车、商品族、月台门、第几条', () => {
    const m02 = board.ops.find((o) => o.id === 'M02');
    expect(m02).toBeDefined();
    const e = extract('m02 现在在哪', ctx);
    expect(e.vehicles[0]?.vid).toBe(m02?.vehicle);
    expect(e.masked).toBe('<VEH> 现在在哪');
    expect(extract('牛奶还剩多少', ctx).fams).toEqual(['DAIRY']);
    expect(extract('D05 什么时候空', ctx).doors).toEqual(['D05']);
    expect(extract('批准第二条', ctx).card).toEqual({ index: 1 });
  });
});

describe('回答和提议', () => {
  const res = loop('normal', 'manual');
  const resOpen = open('normal');
  const late = res.recs.find((r) => r.kind === 'late');

  it('风险清单：待处理的建议卡排在前面，附带确认后执行的提议', () => {
    expect(late).toBeDefined();
    const ctx = ctxAt((late?.t ?? 0) + 60, res, resOpen);
    const list = watchList(ctx);
    expect(list.some((w) => w.key === `card:${late?.key}`)).toBe(true);
    const a = new Assistant().ask('现在有什么风险？', ctx);
    expect(a.intent).toBe('risks');
    expect(a.text).toContain(late?.title as string);
    expect(a.proposals.length).toBeGreaterThan(0);
  });

  it('问车：位置、下一站、晚点；「它」接着问同一辆车', () => {
    const ctx = ctxAt(9 * 3600, res, resOpen);
    const bot = new Assistant();
    const a = bot.ask('M02 到哪了', ctx);
    expect(a.intent).toBe('vehicle');
    expect(a.text).toContain('M02');
    expect(a.links.some((l) => l.kind === 'vehicle')).toBe(true);
    const b = bot.ask('它现在在哪', ctx);
    expect(b.text).toContain('M02');
  });

  it('批准、否决只给提议，不改任何数据；批准低风险的只挑低风险的', () => {
    const t = (late?.t ?? 0) + 60;
    const ctx = ctxAt(t, res, resOpen);
    const before = JSON.stringify(res.recs);
    const bot = new Assistant();
    bot.ask('有什么待处理的建议', ctx);
    const a = bot.ask('批准第一条', ctx);
    expect(a.intent).toBe('approve');
    expect(a.proposals).toHaveLength(1);
    expect(a.proposals[0]?.actions[0]).toMatchObject({ kind: 'decide', action: 'approve' });
    const r = bot.ask('否决第一条', ctx);
    expect(r.proposals[0]?.actions[0]).toMatchObject({ kind: 'decide', action: 'reject' });
    const low = bot.ask('把低风险的都批了', ctx);
    for (const p of low.proposals) for (const act of p.actions) if (act.kind === 'decide') expect(res.recs.find((x) => x.key === act.key)?.options[res.recs.find((x) => x.key === act.key)?.best ?? 0]?.auto).toBe(true);
    expect(JSON.stringify(res.recs)).toBe(before);
  });

  it('为什么推荐、如果不处理会怎样：按孪生推演的结果回答', () => {
    const ctx = ctxAt((late?.t ?? 0) + 60, res, resOpen);
    const bot = new Assistant();
    bot.ask('有什么待处理的建议', ctx);
    const why = bot.ask('为什么推荐第一条', ctx);
    expect(why.intent).toBe('explain');
    expect(why.text).toContain('合计分');
    const wi = bot.ask('如果第一条不处理会怎样', ctx);
    expect(wi.intent).toBe('whatif');
    expect(wi.text).toContain('不处理');
  });

  it('资料库：问处理办法返回对应的流程和出处', async () => {
    const a = new Assistant().ask('冷链门不够用怎么办', ctxAt(9 * 3600, res, resOpen));
    expect(a.intent).toBe('knowledge');
    expect(a.text).toContain('冷链门不够用怎么办');
    const idx = buildIndex([...SOP]);
    expect(search(idx, '车抛锚了怎么处理')[0]?.p.id).toBe('sop-breakdown');
    expect(search(idx, '温度超标')[0]?.p.id).toBe('sop-temp');
    const { PLAYBOOKS } = await import('../src/analysis/drill');
    const { playbookPassages } = await import('../src/assistant/knowledge');
    const idx2 = buildIndex([...SOP, ...playbookPassages(PLAYBOOKS)]);
    expect(search(idx2, '码头罢工停工了谁负责')[0]?.p.source).toBe('韧性预案库');
  });

  it('没跑闭环孪生时也能按计划回答', () => {
    const a = new Assistant().ask('整体情况怎么样', ctxAt(10 * 3600));
    expect(a.intent).toBe('overview');
    expect(a.text).toContain('闭环孪生还没跑完');
  });
});

describe('交接班报告和建议复盘', () => {
  it('交接班报告：四个部分，只用报告时刻以前的事', () => {
    const res = loop('rough', 'safe');
    const ctx = ctxAt(14 * 3600, res, open('rough'), 'safe');
    const h = handover(ctx, SHIFTS[1]);
    expect(h.sections.map((x) => x.title.slice(0, 4))).toEqual(['概况', '本班发生', '交给下一', '下一班要']);
    expect(h.markdown).toContain('# 交接班报告 · 早班');
    for (const r of res.recs.filter((x) => x.t >= 14 * 3600)) expect(h.markdown).not.toContain(r.title);
  });

  it('复盘：执行了的按选的做法比，没处理的按不处理比；迟到的实际值等于这辆车在那家店晚的分钟', () => {
    const res = loop('normal', 'safe');
    const rv = review(res);
    expect(rv.total.n).toBe(res.recs.filter((r) => r.status !== 'proposed').length);
    for (const row of rv.rows.filter((x) => x.kind === 'late')) {
      const r = res.recs.find((x) => x.key === row.key);
      const actual = res.stops.filter((s) => s.vid === r?.vid && s.store === r?.store && s.t >= (r?.t ?? 0)).reduce((a, s) => a + s.late, 0);
      expect(row.actual).toBeCloseTo(actual, 5);
    }
    expect(rv.notes.length).toBeGreaterThan(0);
  });
});

describe('角色和审批', () => {
  it('只读不能执行；调度员能执行低风险的和 $100 以内的，更贵的交站长；站长 $1,000 以内', async () => {
    const { canExecute, approverOf, canApprove } = await import('../src/assistant/roles');
    expect(canExecute('viewer', { risk: 'low', cost: 0 })).toBe(false);
    expect(canExecute('dispatcher', { risk: 'low', cost: 0 })).toBe(true);
    expect(canExecute('dispatcher', { risk: 'high', cost: 25 })).toBe(true);
    expect(canExecute('dispatcher', { risk: 'high', cost: 238 })).toBe(false);
    expect(canExecute('manager', { risk: 'high', cost: 238 })).toBe(true);
    expect(approverOf({ cost: 238 })).toBe('manager');
    expect(approverOf({ cost: 5000 })).toBe('regional');
    expect(canApprove('dispatcher', 'manager')).toBe(false);
    expect(canApprove('regional', 'manager')).toBe(true);
  });

  it('审批单 20 分钟没人批报区域经理；批准、驳回、往上报都记进操作记录', async () => {
    const { Approvals } = await import('../src/assistant/roles');
    const ap = new Approvals();
    const p = { id: 'p1', title: '派救援车', effect: '迟到 0 分钟', actions: [], risk: 'high' as const, cost: 238 };
    const a = ap.request(p, 'dispatcher', 8 * 3600, '测试');
    expect(a.need).toBe('manager');
    expect(ap.decide(a.id, true, 'dispatcher', 8 * 3600 + 60)).toBeUndefined();
    expect(ap.escalate(8 * 3600 + 10 * 60)).toHaveLength(0);
    expect(ap.escalate(8 * 3600 + 21 * 60)).toHaveLength(1);
    expect(a.need).toBe('regional');
    expect(ap.decide(a.id, true, 'manager', 8 * 3600 + 22 * 60)).toBeUndefined();
    expect(ap.decide(a.id, true, 'regional', 8 * 3600 + 23 * 60)?.status).toBe('approved');
    expect(ap.log.map((e) => e.act)).toEqual(['request', 'escalate', 'approve']);
    expect(ap.csv((t) => String(t)).split('\n')).toHaveLength(4);
  });
});

describe('指令跟踪', () => {
  it('每条指令对上现场的回执；只用到此刻为止的事', async () => {
    const { commandTrail } = await import('../src/assistant/trail');
    const res = loop('rough', 'auto');
    const label = (vid: number) => board.ops.find((o) => o.vehicle === vid)?.id ?? `车 ${vid}`;
    const all = commandTrail(res, 26 * 3600, label);
    expect(all).toHaveLength(res.cmds.length);
    // 要回执的指令（除了调设定温度、改门）大多有回执
    const need = all.filter((x) => x.kind !== 'setpoint' && x.kind !== 'reassignDoor');
    if (need.length) expect(need.filter((x) => x.ack).length / need.length).toBeGreaterThan(0.6);
    const first = res.cmds[0];
    if (first) {
      const early = commandTrail(res, first.t, label);
      expect(early).toHaveLength(1);
      expect(early[0]?.effect).toBeUndefined();
    }
  });
});

describe('数据质量', () => {
  it('良好（默认）和不设一样；较差时丢点、晚到、断线，孪生按计划推算位置，照样能出建议', () => {
    const input = { vehicles: trace.vehicles, ops: board.ops, board, seed: 2, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level: 'rough' as const };
    const a = runLoop(input, { closed: true, policy: 'safe', decisions: [] });
    const b = runLoop(input, { closed: true, policy: 'safe', decisions: [], quality: 'good' });
    expect(JSON.stringify(b.kpi)).toBe(JSON.stringify(a.kpi));
    expect(b.recs.map((r) => r.key)).toEqual(a.recs.map((r) => r.key));
    expect(a.quality).toBeUndefined();
    const p = runLoop(input, { closed: true, policy: 'safe', decisions: [], quality: 'poor' });
    const q = p.quality!;
    expect(q.sent).toBe(a.msgCount);
    expect(q.dropped / q.sent).toBeGreaterThan(0.03);
    expect(q.late).toBeGreaterThan(0);
    expect(q.reckoned).toBeGreaterThan(0);
    expect(q.delivered + q.dropped + q.stale).toBeLessThanOrEqual(q.sent);
    // 现场一样（数据通道只影响孪生看到的），孪生照样出建议
    expect(p.recs.length).toBeGreaterThan(0);
  });
});

describe('分层看板', () => {
  it('四层指标按阈值分绿黄红；相对指标和基准比', async () => {
    const { evaluate, KPI_DEFS } = await import('../src/assistant/kpiBoard');
    const res = loop('rough', 'manual');
    const ctx = ctxAt(12 * 3600, res, open('rough'));
    const v = evaluate({ ctx, summary: { service: 99, costPerCase: 1.2 }, base: { service: 99.5, costPerCase: 1.0 }, approvals: 2 });
    expect(v).toHaveLength(KPI_DEFS.length);
    expect(new Set(v.map((x) => x.def.level)).size).toBe(4);
    const by = (k: string) => v.find((x) => x.def.key === k);
    expect(by('costPerCase')?.state).toBe('alarm');
    expect(by('service')?.state).toBe('warn');
    expect(by('approvals')?.state).toBe('warn');
    expect(by('pending')?.value).toBe(res.recs.filter((r) => r.t <= 12 * 3600 && (r.doneAt === undefined || r.doneAt > 12 * 3600 || r.status === 'proposed')).length);
  });

  it('告警没人确认按时往上报；恢复正常就关掉；往回拖时间重新开始', async () => {
    const { AlertBook, KPI_DEFS } = await import('../src/assistant/kpiBoard');
    const def = KPI_DEFS.find((d) => d.key === 'late20')!;
    const book = new AlertBook();
    const at = (state: 'ok' | 'alarm', value: number) => [{ def, value, state }] as const;
    book.update(8 * 3600, at('ok', 0));
    expect(book.update(8 * 3600 + 60, at('alarm', 3))).toHaveLength(1);
    book.update(8 * 3600 + 16 * 60, at('alarm', 3));
    expect(book.open()[0]?.owner).toBe('manager');
    book.update(8 * 3600 + 31 * 60, at('alarm', 3));
    expect(book.open()[0]?.owner).toBe('regional');
    expect(book.ack('late20', 'viewer', 0)).toBeUndefined();
    book.update(8 * 3600 + 40 * 60, at('ok', 0));
    expect(book.open()).toHaveLength(0);
    book.update(7 * 3600, at('alarm', 3));
    expect(book.alerts).toHaveLength(1);
  });
});

describe('网络规划、跨境、预测也能问', () => {
  it('问开仓、清关：按网络规划和跨境模块回答', () => {
    const ctx = { ...ctxAt(10 * 3600), gen: 'g3' as const };
    const bot = new Assistant();
    const n = bot.ask('要不要再开一个配送中心', ctx);
    expect(n.intent).toBe('network');
    expect(n.text).toContain('物流园');
    const c = bot.ask('海运进口清关要多久，要哪些单证', ctx);
    expect(c.intent).toBe('crossborder');
    expect(c.text).toContain('海运');
    const f = bot.ask('明天乳品能卖多少', ctx);
    expect(f.intent).toBe('forecast');
  });
});

describe('求解', () => {
  it('问「优化月台门和派车」：调求解器，对比现在的排法，能改进的给出提议', () => {
    const ctx = { ...ctxAt(8 * 3600), day: emptyDay(), allocation: allocationHour(s) };
    const a = new Assistant().ask('帮我优化一下月台门和派车', ctx);
    expect(a.intent).toBe('optimize');
    expect(a.text).toContain('月台门');
    expect(a.text).toContain('派车');
    for (const p of a.proposals) expect(p.actions[0]?.kind).toBe('day');
  });
});
