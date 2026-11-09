import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromTrack, twinSnap } from '../assistant/context';
import { BLIND2_ACCEPT, BLIND3_ACCEPT, BLIND4_ACCEPT, blind4Markdown, blind2Markdown, blind3Markdown, blindMarkdown, reportMarkdown, runBlind, runEval, type EvalCtxs } from '../assistant/eval';
import { BLIND_SET3 } from '../assistant/evalBlind3';
import { BLIND_SET4 } from '../assistant/evalBlind4';
import { BLIND_SET } from '../assistant/evalBlind';
import { BLIND_SET2 } from '../assistant/evalBlind2';
import { fixtureHubs } from '../assistant/evalFixtures';
import { EVAL_SET } from '../assistant/evalSet';
import type { AssistCtx } from '../assistant/types';
import { buildBoard } from '../sim/board';
import { g3 } from '../sim/config';
import { runChain } from '../sim/engine';
import { allocationHour, emptyDay } from '../sim/plan';
import { runLoop, type LoopResult } from '../twin/loop';
import type { Policy } from '../twin/types';
import { trackRow, type TrackCtx } from '../../web/src/tracking';

/**
 * 值班助手评测：按默认区域第 86 天的仿真和闭环孪生搭几个时刻的数据，跑一遍标准问题，写 docs/results/assistant-eval.md。
 *   npx tsx src/cli/assistantEval.ts          # 写报告
 *   npx tsx src/cli/assistantEval.ts --check  # 只打印总体结果
 * 测试（tests/assistantEval.test.ts）用同一份数据和门槛。
 */
/** 盲测第一次跑（还没修任何问题）的结果：意图、工具、形态、安全、四项都对（报告里和现在的结果并排列） */
export const BLIND_FIRST = { intent: 52, tool: 61, behavior: 65, safety: 80, all: 46 };
/** 第二套盲测第一次跑（通用改进以后、修五处回退以前）的结果：第二套的正式成绩 */
export const BLIND2_FIRST = { intent: 54, tool: 59, behavior: 66, safety: 80, all: 48 };
/** 第三套盲测第一次跑（重新训练以后、第十轮改动以前）的结果：第三套的正式成绩 */
export const BLIND3_FIRST = { intent: 60, tool: 59, behavior: 68, safety: 80, all: 50 };

export function buildEvalContexts(): EvalCtxs {
  const s = g3(1);
  s.traceDay = 86;
  const trace = runChain(s).trace!;
  const board = buildBoard(trace.ops, emptyDay(), { allocation: allocationHour(s), crossDock: s.dc.crossDock });
  const input = (level: 'normal' | 'rough') => ({ vehicles: trace.vehicles, ops: board.ops, board, seed: 1, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: s.flow.direct, level });
  const normal = runLoop(input('normal'), { closed: true, policy: 'manual', decisions: [] });
  const normalOpen = runLoop(input('normal'), { closed: false, policy: 'manual', decisions: [] });
  const rough = runLoop(input('rough'), { closed: true, policy: 'safe', decisions: [] });
  const roughOpen = runLoop(input('rough'), { closed: false, policy: 'manual', decisions: [] });
  const poor = runLoop(input('normal'), { closed: true, policy: 'manual', decisions: [], quality: 'poor' });
  const at = (t: number, res?: LoopResult, open?: LoopResult, policy: Policy = 'manual'): AssistCtx => {
    const tctx: TrackCtx = { list: trace.vehicles, tracked: (i) => board.ops.some((o) => o.vehicle === i), opOf: (i) => board.ops.find((o) => o.vehicle === i), pose: () => undefined, roadAt: () => undefined, ...(res ? { field: { result: res, vidOf: (i: number) => i } } : {}) };
    const rows = trace.vehicles.flatMap((_, i) => {
      const r = trackRow(tctx, i, t);
      return r ? [fromTrack(r)] : [];
    });
    const sim = { input: input(policy === 'safe' ? 'rough' : 'normal') };
    return { t, gen: 'g3', board, day: emptyDay(), allocation: allocationHour(s), rows, sim: () => sim, ...(res ? { twin: twinSnap(res, open, t, policy, [], trace.storeDemand) } : {}) };
  };
  const card = (normal.recs.find((r) => r.kind === 'late')?.t ?? 5 * 3600) + 60;
  const brk = (normal.recs.find((r) => r.kind === 'breakdown')?.t ?? 4.5 * 3600) + 60;
  const noon = at(13 * 3600, normal, normalOpen);
  const hubs = fixtureHubs(board);
  return {
    base: at(9 * 3600, normal, normalOpen),
    card: at(card, normal, normalOpen),
    brk: at(brk, normal, normalOpen),
    noon,
    rough: at(14 * 3600, rough, roughOpen, 'safe'),
    plan: at(10 * 3600),
    poor: at(card, poor, normalOpen),
    hubs: { ...noon, hubs: () => hubs },
    hubam: { ...at(7 * 3600, normal, normalOpen), hubs: () => hubs },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--llm')) {
  // 可选：四套盲测题交给大模型答一遍（只在明确加 --llm 时跑；先打印估计的调用次数；内置的报告不动）
  void import('./assistantEvalLlm').then((m) => m.runLlmEval(buildEvalContexts(), process.argv.includes('--dry-run')));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ctxs = buildEvalContexts();
  const r = runEval(ctxs, EVAL_SET);
  // 盲测：「建议卡」那个时刻 + 合成的仓储中心作业计划
  const blindCtx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
  const blind = runBlind(blindCtx, BLIND_SET);
  // 第二套盲测：同样的数据和规则，出题人标为「也可以」的做法算对
  const blind2 = runBlind(blindCtx, BLIND_SET2, BLIND2_ACCEPT);
  // 第三套盲测：这一轮的标题成绩，放在报告开头
  const blind3 = runBlind(blindCtx, BLIND_SET3, BLIND3_ACCEPT);
  // 第四套盲测：这一轮的标题成绩，放在最前面
  const blind4 = runBlind(blindCtx, BLIND_SET4, BLIND4_ACCEPT);
  const head = `${blind4Markdown(blind4, BLIND4_ACCEPT, BLIND_FIRST, BLIND2_FIRST, BLIND3_FIRST, r)}\n${blind3Markdown(blind3, BLIND3_ACCEPT, BLIND_FIRST, BLIND2_FIRST, r, BLIND3_FIRST)}`;
  const md = `${reportMarkdown(r).replace('# 值班助手评测\n', `# 值班助手评测\n\n${head}\n`)}\n${blind2Markdown(blind2, BLIND2_ACCEPT, BLIND_FIRST, BLIND_SET.length, BLIND2_FIRST)}\n${blindMarkdown(blind, BLIND_FIRST)}`;
  const p = (x: { ok: number; n: number }) => `${x.ok}/${x.n}`;
  process.stdout.write(`通过 ${p(r.metrics.pass)}；意图 ${p(r.metrics.intent)}；参数 ${p(r.metrics.entity)}；工具 ${p(r.metrics.tool)}；事实 ${p(r.metrics.fact)}；数字核对 ${p(r.metrics.grounding)}；澄清 ${p(r.metrics.clarify)}；拒答 ${p(r.metrics.decline)}；安全 ${p(r.metrics.safety)}；没改数据 ${p(r.metrics.unchanged)}；留出集 ${p(r.holdout)}；新语料留出集 ${p(r.holdout2)}${r.holdout3.n ? `；第二批语料留出集 ${p(r.holdout3)}` : ''}\n`);
  process.stdout.write(`弃答：${r.clf.abstain.map((a) => `${a.set} ${a.n}（原来对 ${a.right}、原来错 ${a.wrong}）`).join('；')}；分类器 ${r.clf.compare.map((x) => `${x.kind} ${x.h1}/${x.h2}/${x.h3}`).join('、')}\n`);
  process.stdout.write(`第四套盲测（新分类器 + 没把握先问，首次运行）：意图 ${p(blind4.metrics.intent)}；工具 ${p(blind4.metrics.tool)}；形态 ${p(blind4.metrics.behavior)}；安全 ${p(blind4.metrics.safety)}；四项都对 ${p(blind4.metrics.all)}；正常回答题里问了一句 ${blind4.items.filter((x) => x.want.behavior === 'answer' && x.abstained).length}（第一理解对 ${blind4.items.filter((x) => x.want.behavior === 'answer' && x.topRight).length}）\n`);
  process.stdout.write(`第三套盲测（现在，不再是盲测；正式成绩是首次运行 60/59/68/80/50）：意图 ${p(blind3.metrics.intent)}；工具 ${p(blind3.metrics.tool)}；形态 ${p(blind3.metrics.behavior)}；安全 ${p(blind3.metrics.safety)}；四项都对 ${p(blind3.metrics.all)}\n`);
  process.stdout.write(`第二套盲测（部分已见；正式成绩是首次运行 54/59/66/80/48）：意图 ${p(blind2.metrics.intent)}；工具 ${p(blind2.metrics.tool)}；形态 ${p(blind2.metrics.behavior)}；安全 ${p(blind2.metrics.safety)}；四项都对 ${p(blind2.metrics.all)}\n`);
  process.stdout.write(`第一套盲测题（回归，不再是盲测）：意图 ${p(blind.metrics.intent)}；工具 ${p(blind.metrics.tool)}；形态 ${p(blind.metrics.behavior)}；安全 ${p(blind.metrics.safety)}；四项都对 ${p(blind.metrics.all)}\n`);
  if (!process.argv.includes('--check')) writeFileSync(fileURLToPath(new URL('../../docs/results/assistant-eval.md', import.meta.url)), md);
  else {
    for (const x of r.items.filter((i) => !i.pass)) process.stdout.write(`× ${x.id} ${x.q}：${x.why.join('；')}\n`);
    for (const x of blind4.items.filter((i) => !(i.intentOk && i.toolOk && i.behaviorOk && i.safetyOk))) process.stdout.write(`第四套 × ${x.id} ${x.q}（${x.role}）：期望 ${x.want.intent}/${x.want.tools.join(',')}/${x.want.behavior}，实际 ${x.intent}/${x.tools.join(',')}/${x.behavior}${x.abstained ? '/先问' : ''}${x.safetyOk ? '' : '/不安全'}「${x.said}」\n`);
    for (const x of blind3.items.filter((i) => !(i.intentOk && i.toolOk && i.behaviorOk && i.safetyOk))) process.stdout.write(`第三套 × ${x.id} ${x.q}（${x.role}）：期望 ${x.want.intent}/${x.want.tools.join(',')}/${x.want.behavior}，实际 ${x.intent}/${x.tools.join(',')}/${x.behavior}${x.safetyOk ? '' : '/不安全'}「${x.said}」\n`);
    for (const x of blind2.items.filter((i) => !(i.intentOk && i.toolOk && i.behaviorOk && i.safetyOk))) process.stdout.write(`第二套 × ${x.id} ${x.q}（${x.role}）：期望 ${x.want.intent}/${x.want.tools.join(',')}/${x.want.behavior}，实际 ${x.intent}/${x.tools.join(',')}/${x.behavior}${x.safetyOk ? '' : '/不安全'}「${x.said}」\n`);
    for (const x of blind.items.filter((i) => !(i.intentOk && i.toolOk && i.behaviorOk && i.safetyOk))) process.stdout.write(`盲测 × ${x.id} ${x.q}（${x.role}）：期望 ${x.want.intent}/${x.want.tools.join(',')}/${x.want.behavior}，实际 ${x.intent}/${x.tools.join(',')}/${x.behavior}${x.safetyOk ? '' : '/不安全'}「${x.said}」\n`);
  }
}
