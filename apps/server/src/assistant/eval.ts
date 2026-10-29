import { handoffBoard, sellableCases, shelfNow, teamBoard } from '@storewright/ops';
import type { AiService } from '../ai';
import type { DemoStore } from '../demo';
import type { StoreRuntime } from '../runtime';
import type { Assistant } from './index';
import type { Lang } from './tools';

/**
 * 本地助手的问答评测集（Phase 5d）：从门店当前的数据自动生成问题和标准答案。
 * 每类问题有中英文、不同说法的多个版本，用来衡量「换个说法还能不能答对」。
 * 判分：工具选对了（toolOk），回答里包含标准答案（answerOk；知识类问题看检索到的第一条是不是对应的操作规范）。
 * 同一套评测集可以分别跑模板模式和本地语言模型，比较准确率与耗时。
 */

export interface EvalCase {
  q: string;
  lang: Lang;
  kind: string;
  expectTool: string;
  /** 回答里应包含其中任意一个 */
  expect?: string[];
  /** 知识类：检索到的第一条应该是这条规范 */
  expectSop?: string;
  /** 推演类：参数应包含 */
  expectArgs?: Record<string, unknown>;
}

export function buildEvalSet(rt: StoreRuntime, demo: DemoStore, ai: AiService, now = Date.now()): EvalCase[] {
  void demo;
  const s = rt.state;
  const st = rt.statics;
  const cases: EvalCase[] = [];
  const add = (c: EvalCase) => cases.push(c);
  // 门店状态
  const waiting = handoffBoard(s, st, now).filter((r) => r.arrivedAt !== undefined && !r.session).length;
  for (const q of ['现在有几位顾客在等？', '门口等着取货的顾客有多少？', '目前门店的情况怎么样？']) add({ q, lang: 'zh', kind: 'status', expectTool: 'store_status', expect: [`${waiting} 位顾客`] });
  for (const q of ['How many customers are waiting right now?', 'What is the status of the store?', 'Give me an overview of how we are doing.']) add({ q, lang: 'en', kind: 'status', expectTool: 'store_status', expect: [`${waiting} customers`] });
  // 商品
  const items = [...st.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity || a.itemId.localeCompare(b.itemId)).slice(0, 3);
  for (const p of items) {
    const est = Math.round(shelfNow(s, p).est);
    const cs = sellableCases(s, p.itemId).length;
    add({ q: `${p.name} 在哪里？`, lang: 'zh', kind: 'item', expectTool: 'find_item', expect: [p.locationId] });
    add({ q: `${p.name} 货架上还有多少？`, lang: 'zh', kind: 'item', expectTool: 'find_item', expect: [`约 ${est} 件`] });
    add({ q: `后仓还有 ${p.name} 吗？`, lang: 'zh', kind: 'item', expectTool: 'find_item', expect: [`后仓有 ${cs} 箱`] });
    add({ q: `Where is ${p.name}?`, lang: 'en', kind: 'item', expectTool: 'find_item', expect: [p.locationId] });
    add({ q: `How many ${p.name} are left on the shelf?`, lang: 'en', kind: 'item', expectTool: 'find_item', expect: [`about ${est} on the shelf`] });
    add({ q: `Do we have any ${p.name} in the backroom?`, lang: 'en', kind: 'item', expectTool: 'find_item', expect: [`${cs} cases`] });
  }
  // 预测
  const f = ai.forecastDraft(now);
  const fv = f?.prediction ? String(Math.round(f.prediction.value)) : undefined;
  for (const q of ['接下来三个小时预计有多少单？', '未来几个小时会来多少订单？']) add({ q, lang: 'zh', kind: 'forecast', expectTool: 'forecast', ...(fv ? { expect: [`预计 ${fv} 单`] } : {}) });
  for (const q of ['How many orders are expected in the next few hours?', 'What is the forecast for the coming hours?']) add({ q, lang: 'en', kind: 'forecast', expectTool: 'forecast', ...(fv ? { expect: [`about ${fv} orders`] } : {}) });
  // 人员
  // 在岗的人（此刻的岗位）；在岗人员页按名字排序
  const team = teamBoard(st, s, now).members.filter((m) => m.on);
  const pickers = team.filter((m) => m.role === 'PICK').map((m) => m.name);
  const handoff = team.filter((m) => m.role === 'HANDOFF').map((m) => m.name);
  add({ q: '谁在拣货？', lang: 'zh', kind: 'staff', expectTool: 'staff_status', expect: pickers.slice(0, 1) });
  add({ q: '现在交付岗有哪些人？', lang: 'zh', kind: 'staff', expectTool: 'staff_status', expect: handoff.slice(0, 1) });
  add({ q: 'Who is picking right now?', lang: 'en', kind: 'staff', expectTool: 'staff_status', expect: pickers.slice(0, 1) });
  add({ q: 'Who is on handoff?', lang: 'en', kind: 'staff', expectTool: 'staff_status', expect: handoff.slice(0, 1) });
  // 解释建议、等待原因
  add({ q: '为什么 AI 给出这条建议？', lang: 'zh', kind: 'explain', expectTool: 'explain_recommendation' });
  add({ q: '最新的调人建议是什么原因？', lang: 'zh', kind: 'explain', expectTool: 'explain_recommendation' });
  add({ q: 'Why did the AI recommend that?', lang: 'en', kind: 'explain', expectTool: 'explain_recommendation' });
  add({ q: '为什么顾客等这么久？', lang: 'zh', kind: 'wait', expectTool: 'wait_analysis' });
  add({ q: '排队怎么这么长？', lang: 'zh', kind: 'wait', expectTool: 'wait_analysis' });
  add({ q: 'Why are customers waiting so long?', lang: 'en', kind: 'wait', expectTool: 'wait_analysis' });
  // 推演
  add({ q: '如果 16 到 19 点多一个交付员会怎样？', lang: 'zh', kind: 'whatif', expectTool: 'whatif', expectArgs: { role: 'handoff', delta: 1, fromHour: 16, toHour: 19 } });
  add({ q: '要是订单多 20% 会怎么样？', lang: 'zh', kind: 'whatif', expectTool: 'whatif', expectArgs: { demandFactor: 1.2 } });
  add({ q: 'What if we add one more handoff associate from 16 to 19?', lang: 'en', kind: 'whatif', expectTool: 'whatif', expectArgs: { role: 'handoff', delta: 1, fromHour: 16, toHour: 19 } });
  add({ q: 'What happens if orders go up 20%?', lang: 'en', kind: 'whatif', expectTool: 'whatif', expectArgs: { demandFactor: 1.2 } });
  // 操作规范
  const sop: Array<[string, Lang, string]> = [
    ['冷冻暂存格位满了怎么办？', 'zh', 'staging-full'],
    ['验证码输错三次怎么处理？', 'zh', 'code-failed'],
    ['顾客买了酒，交付时要怎么做？', 'zh', 'age-check'],
    ['标签坏了怎么办？', 'zh', 'label-reprint'],
    ['What should I do when frozen staging is full?', 'en', 'staging-full'],
    ['The pickup code failed three times, what now?', 'en', 'code-failed'],
    ['How do I handle age-restricted items at handoff?', 'en', 'age-check'],
    ['How do I reprint a damaged label?', 'en', 'label-reprint'],
  ];
  for (const [q, lang, id] of sop) add({ q, lang, kind: 'knowledge', expectTool: 'knowledge', expectSop: id });
  // 交接班
  for (const q of ['帮我做一个交接班摘要', '今天到现在的总结']) add({ q, lang: 'zh', kind: 'summary', expectTool: 'shift_summary' });
  for (const q of ['Give me a handover summary.', 'Recap of today so far, please.']) add({ q, lang: 'en', kind: 'summary', expectTool: 'shift_summary' });
  // 问数 2.0、复盘、周报（决策记录 0024）
  for (const [q, lang, tool] of [
    ['今天为什么迟到了这么多？', 'zh', 'closing_review'],
    ['做一下打烊复盘', 'zh', 'closing_review'],
    ['Why were orders late today?', 'en', 'closing_review'],
    ['给我这周的周报', 'zh', 'weekly_report'],
    ['How did this week go? Give me the weekly report.', 'en', 'weekly_report'],
    ['今天每小时的单量和迟到', 'zh', 'metrics_by_hour'],
    ['Show me today hour by hour.', 'en', 'metrics_by_hour'],
    ['今天和昨天比怎么样？', 'zh', 'compare_days'],
    ['Compare today with yesterday.', 'en', 'compare_days'],
  ] as const)
    add({ q, lang, kind: 'analysis', expectTool: tool });
  // 开店简报（决策记录 0022 · F1）
  for (const q of ['给我今天的开店简报', '今天要注意什么？']) add({ q, lang: 'zh', kind: 'brief', expectTool: 'opening_brief' });
  for (const q of ['Give me the opening brief.', 'What should we watch out for today?']) add({ q, lang: 'en', kind: 'brief', expectTool: 'opening_brief' });
  return cases;
}

export interface EvalReport {
  source: 'LLM' | 'TEMPLATE';
  n: number;
  toolAccuracy: number;
  answerAccuracy: number;
  avgMs: number;
  byKind: Record<string, { n: number; toolOk: number; answerOk: number }>;
  failures: Array<{ q: string; expectTool: string; got: string[]; answer: string }>;
}

export async function runEval(assistant: Assistant, cases: readonly EvalCase[], mode: 'TEMPLATE' | 'RULES' | 'AUTO' = 'TEMPLATE'): Promise<EvalReport> {
  let toolOk = 0;
  let answerOk = 0;
  let ms = 0;
  let source: 'LLM' | 'TEMPLATE' = 'TEMPLATE';
  const byKind: EvalReport['byKind'] = {};
  const failures: EvalReport['failures'] = [];
  for (const c of cases) {
    const r = mode === 'AUTO' ? await assistant.ask(c.q, c.lang) : await assistant.template(c.q, c.lang, Date.now(), mode === 'RULES' ? 'rules' : 'hybrid');
    source = r.source;
    ms += r.ms;
    const names = r.tools.map((t) => t.name);
    const tOk = names.includes(c.expectTool);
    let aOk = tOk;
    if (tOk && c.expect?.length) aOk = c.expect.some((e) => r.answer.includes(e));
    if (tOk && c.expectSop) aOk = (r.results.find((x) => x.tool === 'knowledge')?.data.hits as Array<{ id: string }> | undefined)?.[0]?.id === c.expectSop;
    if (tOk && c.expectArgs) {
      const args = r.tools.find((t) => t.name === c.expectTool)?.args ?? {};
      aOk = Object.entries(c.expectArgs).every(([k, v]) => (typeof v === 'number' ? Math.abs(Number(args[k]) - v) < 1e-6 : args[k] === v));
    }
    if (tOk) toolOk++;
    if (aOk) answerOk++;
    const k = (byKind[c.kind] ??= { n: 0, toolOk: 0, answerOk: 0 });
    k.n++;
    if (tOk) k.toolOk++;
    if (aOk) k.answerOk++;
    if (!aOk) failures.push({ q: c.q, expectTool: c.expectTool, got: names, answer: r.answer.slice(0, 160) });
  }
  const n = cases.length;
  return { source, n, toolAccuracy: Math.round((toolOk / Math.max(1, n)) * 1000) / 1000, answerAccuracy: Math.round((answerOk / Math.max(1, n)) * 1000) / 1000, avgMs: Math.round(ms / Math.max(1, n)), byKind, failures };
}

/**
 * 留出集：换成更口语、更随意的说法，写好后不再按它调整识别规则（第一次运行的成绩如实记录在文档里），
 * 用来估计「没见过的说法」能答对多少。只判断工具是否选对（以及能直接核对的商品位置）。
 */
export function buildHeldOutSet(rt: StoreRuntime): EvalCase[] {
  const st = rt.statics;
  const p = [...st.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity || a.itemId.localeCompare(b.itemId))[3] ?? st.planogram[0];
  const name = p?.name ?? '';
  const c = (q: string, lang: Lang, kind: string, expectTool: string, expect?: string[]): EvalCase => ({ q, lang, kind, expectTool, ...(expect ? { expect } : {}) });
  return [
    c('门口排了几个人？', 'zh', 'status', 'store_status'),
    c('现在忙不忙？', 'zh', 'status', 'store_status'),
    c(`${name} 放哪儿了？`, 'zh', 'item', 'find_item', p ? [p.locationId] : undefined),
    c(`${name} 还剩几件？`, 'zh', 'item', 'find_item'),
    c(`库房还有 ${name} 没？`, 'zh', 'item', 'find_item'),
    c('晚上会不会很忙？', 'zh', 'forecast', 'forecast'),
    c('下午大概来多少单？', 'zh', 'forecast', 'forecast'),
    c('现在谁负责交付？', 'zh', 'staff', 'staff_status'),
    c('AI 为啥让我调人？', 'zh', 'explain', 'explain_recommendation'),
    c('顾客为啥一直在等？', 'zh', 'wait', 'wait_analysis'),
    c('16 点到 19 点交付加两个人效果如何？', 'zh', 'whatif', 'whatif'),
    c('冻品暂存放不下了', 'zh', 'knowledge', 'knowledge'),
    c('条码标签撕坏了', 'zh', 'knowledge', 'knowledge'),
    c('今天做个小结', 'zh', 'summary', 'shift_summary'),
    c('How long is the line at pickup?', 'en', 'status', 'store_status'),
    c('Are we busy?', 'en', 'status', 'store_status'),
    c(`Where can I find ${name}?`, 'en', 'item', 'find_item', p ? [p.locationId] : undefined),
    c(`Any ${name} left?`, 'en', 'item', 'find_item'),
    c(`Is there ${name} in the stockroom?`, 'en', 'item', 'find_item'),
    c('Will it be busy this evening?', 'en', 'forecast', 'forecast'),
    c("Who's working handoff?", 'en', 'staff', 'staff_status'),
    c('Why does the AI want to move someone?', 'en', 'explain', 'explain_recommendation'),
    c('Why is the queue so long?', 'en', 'wait', 'wait_analysis'),
    c('Add two people to handoff from 16 to 19 — what changes?', 'en', 'whatif', 'whatif'),
    c('Frozen staging has no room', 'en', 'knowledge', 'knowledge'),
    c('The label is torn', 'en', 'knowledge', 'knowledge'),
    c('Summarize the day', 'en', 'summary', 'shift_summary'),
  ];
}

/**
 * 留出集 B：在意图分类器写好之后另写的一组说法，与训练语料、评测集、留出集 A 都不重复；写好后只运行一次，成绩如实记录。
 */
export function buildHeldOutSetB(rt: StoreRuntime): EvalCase[] {
  const st = rt.statics;
  const p = [...st.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity || a.itemId.localeCompare(b.itemId))[5] ?? st.planogram[0];
  const name = p?.name ?? '';
  const c = (q: string, lang: Lang, kind: string, expectTool: string, expect?: string[]): EvalCase => ({ q, lang, kind, expectTool, ...(expect ? { expect } : {}) });
  return [
    c('取货区那边压了多少单？', 'zh', 'status', 'store_status'),
    c('给我说说现在店里的整体情况', 'zh', 'status', 'store_status'),
    c(`我想找 ${name}`, 'zh', 'item', 'find_item', p ? [p.locationId] : undefined),
    c(`${name} 是不是卖完了？`, 'zh', 'item', 'find_item'),
    c('一会儿订单会多起来吗？', 'zh', 'forecast', 'forecast'),
    c('今天傍晚的单量大概多少？', 'zh', 'forecast', 'forecast'),
    c('暂存那边是谁？', 'zh', 'staff', 'staff_status'),
    c('这个调动建议是根据什么算的？', 'zh', 'explain', 'explain_recommendation'),
    c('怎么取货的顾客都在等啊？', 'zh', 'wait', 'wait_analysis'),
    c('把拣货的人减掉一个会有什么影响？', 'zh', 'whatif', 'whatif'),
    c('顾客不肯给看身份证，酒还能给他吗？', 'zh', 'knowledge', 'knowledge'),
    c('有个箱子被压扁了', 'zh', 'knowledge', 'knowledge'),
    c('下班前帮我把今天的情况整理一下', 'zh', 'summary', 'shift_summary'),
    c('今天下来大家干得怎么样？', 'zh', 'summary', 'shift_summary'),
    c('How many orders are piling up at pickup?', 'en', 'status', 'store_status'),
    c('Quick snapshot of the store, please.', 'en', 'status', 'store_status'),
    c(`I'm looking for ${name}.`, 'en', 'item', 'find_item', p ? [p.locationId] : undefined),
    c(`Did we sell out of ${name}?`, 'en', 'item', 'find_item'),
    c('Is a rush coming soon?', 'en', 'forecast', 'forecast'),
    c('Roughly how many orders around dinner time?', 'en', 'forecast', 'forecast'),
    c("Who's on staging today?", 'en', 'staff', 'staff_status'),
    c('What is the reasoning behind that staffing suggestion?', 'en', 'explain', 'explain_recommendation'),
    c('How come pickup customers are stuck waiting?', 'en', 'wait', 'wait_analysis'),
    c('What would happen with one fewer picker?', 'en', 'whatif', 'whatif'),
    c('Customer refuses to show ID for beer — can I still give it?', 'en', 'knowledge', 'knowledge'),
    c('A case got crushed.', 'en', 'knowledge', 'knowledge'),
    c('Before I leave, sum up how today went.', 'en', 'summary', 'shift_summary'),
    c('How did the team do today?', 'en', 'summary', 'shift_summary'),
  ];
}
