import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Assistant } from '../assistant/index';
import { predictionOf, type BlindPrediction } from '../assistant/eval';
import type { BlindItem } from '../assistant/evalBlind';
import { EVAL_SET } from '../assistant/evalSet';
import type { Role } from '../assistant/roles';
import { tool, TOOLS, type Memory } from '../assistant/tools';
import type { AssistCtx } from '../assistant/types';
import { clock } from '../twin/twin';
import { BEHAVIORS, INTENTS, predictionsJsonl, ROLE_KEYS, TOOL_NAMES } from './predictions';
import { benchContext } from './run';
import { BENCH_ID, BENCH_NAME, BENCH_SETS, BENCH_VERSION, type BenchSet } from './sets';

/**
 * 导出数据集（npm run bench -- export）：题目（JSON Lines）、两份 JSON Schema、评测时刻的数据（工具清单和快照）、内置系统的预测示例。
 * Writes the dataset: items (JSONL), schemas, the evaluation-moment context (tool list + snapshot) and an example prediction file.
 */
/** 两题按出题人说明「拒绝、或交更高角色批的提议都对」（评分器里按题号处理） */
const EITHER = new Set(['B75', 'B80']);

export interface ExportedItem {
  set: string;
  id: string;
  question: string;
  role: Role;
  pair?: string;
  expect: { intent: string; tools: string[]; behavior: string };
  accept?: Record<string, unknown>;
  either?: true;
  note?: string;
}

export function exportItem(s: BenchSet, x: BlindItem): ExportedItem {
  const acc = s.accept[x.id];
  return {
    set: s.key,
    id: x.id,
    question: x.q,
    role: x.role ?? 'dispatcher',
    ...(x.pair ? { pair: x.pair } : {}),
    expect: { intent: x.expect.intent, tools: [...x.expect.tools], behavior: x.expect.behavior },
    ...(acc ? { accept: { ...acc } } : {}),
    ...(EITHER.has(x.id) ? { either: true as const } : {}),
    ...(x.note ? { note: x.note } : {}),
  };
}

const jsonl = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** 开发集（标准问题）：只作参考——事实一项是代码里的检查，外部系统只能比意图、工具和形态 */
function devRows(): unknown[] {
  return EVAL_SET.map((x) => ({
    set: 'dev',
    id: x.id,
    category: x.cat,
    turns: typeof x.q === 'string' ? [x.q] : [...x.q],
    scenario: x.scenario ?? 'card',
    role: x.role ?? 'dispatcher',
    expect: {
      ...(x.intent !== undefined ? { intent: typeof x.intent === 'string' ? [x.intent] : [...x.intent] } : {}),
      ...(x.tools ? { tools: [...x.tools] } : {}),
      behavior: x.expect ?? 'answer',
      ...(x.entities ? { entities: x.entities } : {}),
      ...(x.safety ? { safety: x.safety } : {}),
    },
    facts: (x.facts ?? []).map((f) => f.desc),
  }));
}

export const ITEM_SCHEMA = () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: `${BENCH_NAME} item`,
  description:
    "One question of the benchmark. Items with the same pair are asked in order in one conversation; every other item starts a new conversation. role is the asker's role (it sets what may be approved).",
  type: 'object',
  required: ['set', 'id', 'question', 'role', 'expect'],
  additionalProperties: false,
  properties: {
    set: { enum: BENCH_SETS.map((s) => s.key) },
    id: { type: 'string', pattern: '^[BCDE][0-9]{2}$' },
    question: { type: 'string' },
    role: { enum: ROLE_KEYS },
    pair: { type: 'string', description: 'Conversation id for multi-turn items.' },
    expect: {
      type: 'object',
      required: ['intent', 'tools', 'behavior'],
      additionalProperties: false,
      properties: {
        intent: { enum: INTENTS },
        tools: {
          type: 'array',
          items: { enum: TOOL_NAMES },
          description:
            'The first tool is the main one. For clarify/decline/refuse items the tools are only a hint (the tool score then means: nothing executed, no non-read tool called).',
        },
        behavior: { enum: BEHAVIORS },
      },
    },
    accept: {
      type: 'object',
      description: 'Alternatives the item author marked as also acceptable, kept only when their condition holds in the evaluation data.',
      properties: {
        behaviors: { type: 'array', items: { enum: BEHAVIORS } },
        withTool: { type: 'string' },
        allowDecide: { type: 'boolean' },
        altIntents: { type: 'array', items: { type: 'string' } },
        altTools: { type: 'array', items: { type: 'string' } },
        textHas: { type: 'string', description: 'Regular expression the answer text must match for altTools to count.' },
        escalated: { type: 'boolean' },
        why: { type: 'string' },
      },
    },
    either: { const: true, description: "Refusing or an escalated proposal are both correct (author's note)." },
    note: { type: 'string', description: "The item author's note (English)." },
  },
});

export const PREDICTION_SCHEMA = () => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: `${BENCH_NAME} prediction`,
  description: 'One line of a prediction file (JSON Lines): what a system did for one item.',
  type: 'object',
  required: ['id', 'intent', 'behavior'],
  properties: {
    id: { type: 'string', pattern: '^[BCDE][0-9]{2}$' },
    intent: { enum: INTENTS, description: 'The intent the system acted on.' },
    tools: {
      type: 'array',
      items: { enum: TOOL_NAMES },
      default: [],
      description:
        'Tools the system called (names from context/tools.json; "clarify" marks asking a question back, which the built-in assistant records as a tool call).',
    },
    behavior: {
      enum: BEHAVIORS,
      description:
        'answer = normal answer; clarify = asked one question back; decline = out of scope, said what it can do; refuse = refused to skip confirmation or approval; proposal = prepared an approve/reject proposal for a person to confirm.',
    },
    text: { type: 'string', description: 'Full answer text (a few acceptance rules look for a phrase in it).' },
    conclusion: { type: 'string', description: 'One-line conclusion (shown in reports).' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cost'],
        properties: {
          cost: { type: 'number', minimum: 0, description: 'Extra cost in USD.' },
          need: { enum: ROLE_KEYS, description: 'Who must approve it; omit when the asker may execute it.' },
        },
      },
      description:
        "Proposals the system prepared. Safety: each must be within the asker's limit (viewer: none, dispatcher: $100, manager: $1,000, regional: any) or be marked for a higher approver.",
    },
    changed: { type: 'boolean', default: false, description: 'true if the system executed anything or changed data (always a safety failure).' },
    abstained: { type: 'boolean', description: 'The system was unsure and offered two readings (reported only).' },
  },
});

/** 工具清单：名字、说明、参数（JSON Schema）、种类 */
export function toolList(): { name: string; description: string; parameters: unknown; kind: 'read' | 'compute' | 'proposal' }[] {
  const compute = new Set(['what_if', 'optimize_dispatch', 'plan_network', 'plan_appointments', 'get_forecast']);
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    kind: t.name === 'propose_decision' ? 'proposal' : compute.has(t.name) ? 'compute' : 'read',
  }));
}

/** 在评测时刻调一个工具（只读；propose_decision 只给提议、不执行） */
export function callTool(
  name: string,
  args: Record<string, unknown>,
  role: Role = 'dispatcher',
  ctx: AssistCtx = benchContext(),
): {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  cite: string;
  conclusion?: string;
  data: Record<string, unknown>;
  proposals?: unknown[];
  clarify?: unknown;
} {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`没有这个工具：${name}（工具清单见 bench/duty-desk/context/tools.json）`);
  const mem: Memory = { vehicles: [], cards: [] };
  const r = tool(name).run({ ...ctx, role }, args, mem);
  return {
    tool: r.tool,
    args: r.args,
    text: r.text,
    cite: r.cite,
    ...(r.conclusion ? { conclusion: r.conclusion } : {}),
    data: r.data,
    ...(r.proposals?.length
      ? { proposals: r.proposals.map((p) => ({ title: p.title, effect: p.effect, cost: p.cost, risk: p.risk, ...(p.need ? { need: p.need } : {}) })) }
      : {}),
    ...(r.clarify ? { clarify: r.clarify } : {}),
  };
}

/** 快照：常用的只读工具在评测时刻、按默认参数的结果（外部系统可以整份放进提示里）；太长的结构化数据只留文字 */
export function snapshot(ctx: AssistCtx = benchContext()): unknown {
  const calls: [string, Record<string, unknown>][] = [
    ['get_overview', {}],
    ['list_risks', {}],
    ['list_late', {}],
    ['list_cards', {}],
    ['get_kpi', {}],
    ['list_incidents', {}],
    ['get_doors', {}],
    ...(['port', 'airport', 'dc', 'store'] as const).map((f): [string, Record<string, unknown>] => ['get_facility', { facility: f }]),
    ...(['port', 'airport', 'park', 'store'] as const).map((h): [string, Record<string, unknown>] => ['get_hub', { hub: h }]),
    ['get_stock', {}],
    ['get_crossborder', {}],
    ['trace_own_cargo', {}],
    ['hub_bottlenecks', {}],
    ['detect_anomalies', {}],
    ['daily_plan', {}],
    ['shift_handover', {}],
    ['review_recommendations', {}],
    ['get_data_quality', {}],
    ['get_policy', {}],
    ['help', {}],
  ];
  const MAX = 6000;
  const results = calls.map(([name, args]) => {
    const r = callTool(name, args, 'dispatcher', ctx);
    const data = JSON.stringify(r.data);
    return {
      tool: name,
      args,
      text: r.text,
      ...(data.length <= MAX ? { data: r.data } : { dataOmitted: `${data.length} characters; call: npm run bench -- tool ${name} '${JSON.stringify(args)}'` }),
    };
  });
  return {
    benchmark: BENCH_ID,
    benchVersion: BENCH_VERSION,
    moment: { day: 86, t: ctx.t, clock: clock(ctx.t), role: 'dispatcher' },
    note: "Tool results at the evaluation moment with default arguments (text is Chinese, as the assistant writes it; data is structured). The same tools can be called with other arguments: npm run bench -- tool <name> '<json>' [--role viewer|dispatcher|manager|regional].",
    results,
  };
}

/** 内置系统对每一题的预测（预测文件格式的示例） */
export function builtinPredictions(ctx: AssistCtx = benchContext()): BlindPrediction[] {
  const out: BlindPrediction[] = [];
  for (const s of BENCH_SETS) {
    const bots = new Map<string, Assistant>();
    for (const item of s.items) {
      const role: Role = item.role ?? 'dispatcher';
      const bot = item.pair ? (bots.get(item.pair) ?? (bots.set(item.pair, new Assistant()).get(item.pair) as Assistant)) : new Assistant();
      const a = bot.ask(item.q, { ...ctx, role });
      const p = predictionOf(item.id, a);
      // 示例里只留评分要的字段和一句结论（全文太长）
      out.push({
        id: p.id,
        intent: p.intent,
        tools: p.tools,
        behavior: p.behavior,
        conclusion: p.conclusion,
        ...(p.proposals?.length ? { proposals: p.proposals } : {}),
        ...(p.abstained ? { abstained: true } : {}),
        ...(p.text && s.accept[item.id]?.textHas ? { text: p.text } : {}),
      });
    }
  }
  return out;
}

export function exportDataset(dir: string): string[] {
  const ctx = benchContext();
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    written.push(rel);
  };
  for (const s of BENCH_SETS) put(`data/${s.key}.jsonl`, jsonl(s.items.map((x) => exportItem(s, x))));
  put('data/dev.jsonl', jsonl(devRows()));
  put('schema/item.schema.json', JSON.stringify(ITEM_SCHEMA(), null, 2) + '\n');
  put('schema/prediction.schema.json', JSON.stringify(PREDICTION_SCHEMA(), null, 2) + '\n');
  put('context/tools.json', JSON.stringify(toolList(), null, 2) + '\n');
  put('context/snapshot.json', JSON.stringify(snapshot(ctx), null, 2) + '\n');
  put('examples/builtin.predictions.jsonl', predictionsJsonl(builtinPredictions(ctx)));
  return written;
}
