import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Answer, AssistCtx } from '../assistant/types';
import {
  runBlind,
  runBlindAsync,
  scoreBlindItem,
  summarizeBlind,
  type BlindPrediction,
  type BlindReport,
  type BlindResult,
  type Metric,
} from '../assistant/eval';
import type { Role } from '../assistant/roles';
import { buildEvalContexts } from '../cli/assistantEval';
import { clock } from '../twin/twin';
import { BENCH_ID, BENCH_SETS, BENCH_VERSION, benchSet, type Score, type SetKey } from './sets';
import { systemDef, type OfflineSystem, type SystemKey } from './systems';

/**
 * 跑一个系统、或者评一份预测，得到基准的结果（bench/duty-desk/results/<system>.json 的内容）。
 * 评测时刻：默认区域第 86 天、「建议卡」那个时刻（第一张迟到卡出来以后一分钟）+ 合成的仓储中心作业计划，和 npm run assistant:eval 的盲测一样。
 * Runs a system (or scores a prediction file) on the benchmark sets and returns the result document.
 */
export interface ItemRow {
  id: string;
  q: string;
  role: Role;
  pair?: string;
  want: { intent: string; tools: readonly string[]; behavior: string };
  got: { intent: string; tools: string[]; behavior: string };
  ok: { intent: boolean; tool: boolean; behavior: boolean; safety: boolean; all: boolean };
  said: string;
  abstained: boolean;
  /** 外部预测里没有这一题 */
  missing?: boolean;
}

export interface Breakdown {
  key: string;
  n: number;
  all: number;
}

export interface SetResult {
  key: SetKey;
  n: number;
  metrics: Record<keyof Score, Metric>;
  byBehavior: { behavior: string; n: number; ok: number; all: number }[];
  byRole: Breakdown[];
  byTurn: Breakdown[];
  items: ItemRow[];
}

export interface SystemResult {
  benchmark: typeof BENCH_ID;
  benchVersion: string;
  system: string;
  kind: SystemKey;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  config: Record<string, unknown>;
  /** 跑的日期（YYYY-MM-DD）和程序版本 */
  generated: string;
  software: string;
  moment: { day: number; t: number; clock: string; note: string };
  sets: Partial<Record<SetKey, SetResult>>;
  total: Record<keyof Score, Metric>;
}

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { name: string; version: string };
export const SOFTWARE = `${PKG.name}@${PKG.version}`;

let ctxMemo: AssistCtx | undefined;
/** 评测时刻的数据（只算一次）：和 assistant:eval 的盲测同一份 */
export function benchContext(): AssistCtx {
  if (!ctxMemo) {
    const ctxs = buildEvalContexts();
    ctxMemo = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
  }
  return ctxMemo;
}

export function momentOf(ctx: AssistCtx): SystemResult['moment'] {
  return {
    day: 86,
    t: ctx.t,
    clock: clock(ctx.t),
    note: 'Default region, simulated day 86, one minute after the first lateness recommendation card appears; synthetic warehousing-hub plans attached.',
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function rowOf(r: BlindResult, missing = false): ItemRow {
  return {
    id: r.id,
    q: r.q,
    role: r.role,
    ...(r.pair ? { pair: r.pair } : {}),
    want: { intent: r.want.intent, tools: [...r.want.tools], behavior: r.want.behavior },
    got: { intent: r.intent, tools: r.tools, behavior: r.behavior },
    ok: { intent: r.intentOk, tool: r.toolOk, behavior: r.behaviorOk, safety: r.safetyOk, all: r.intentOk && r.toolOk && r.behaviorOk && r.safetyOk },
    said: r.said,
    abstained: r.abstained,
    ...(missing ? { missing: true } : {}),
  };
}

const BEHAVIORS = ['answer', 'clarify', 'decline', 'refuse', 'proposal'];
const ROLES: Role[] = ['dispatcher', 'manager', 'regional', 'viewer'];

export function setResultOf(key: SetKey, rep: BlindReport, missing: ReadonlySet<string> = new Set()): SetResult {
  const items = rep.items.map((r) => rowOf(r, missing.has(r.id)));
  const group = (keys: readonly string[], f: (x: ItemRow) => string): Breakdown[] =>
    keys.map((k) => ({ key: k, n: items.filter((x) => f(x) === k).length, all: items.filter((x) => f(x) === k && x.ok.all).length })).filter((b) => b.n > 0);
  return {
    key,
    n: items.length,
    metrics: rep.metrics,
    byBehavior: BEHAVIORS.map((b) => ({
      behavior: b,
      n: items.filter((x) => x.want.behavior === b).length,
      ok: items.filter((x) => x.want.behavior === b && x.ok.behavior).length,
      all: items.filter((x) => x.want.behavior === b && x.ok.all).length,
    })).filter((b) => b.n > 0),
    byRole: group(ROLES, (x) => x.role),
    byTurn: group(['single', 'multi'], (x) => (x.pair ? 'multi' : 'single')),
    items,
  };
}

export function totalOf(sets: Partial<Record<SetKey, SetResult>>): Record<keyof Score, Metric> {
  const out = { intent: { ok: 0, n: 0 }, tool: { ok: 0, n: 0 }, behavior: { ok: 0, n: 0 }, safety: { ok: 0, n: 0 }, all: { ok: 0, n: 0 } };
  for (const s of Object.values(sets))
    for (const k of Object.keys(out) as (keyof Score)[]) {
      out[k].ok += s.metrics[k].ok;
      out[k].n += s.metrics[k].n;
    }
  return out;
}

/** 本机的对照系统（确定的：同样的版本，结果每次一样） */
export function runOffline(key: OfflineSystem, sets: readonly SetKey[], ctx: AssistCtx = benchContext()): SystemResult {
  const def = systemDef(key);
  const out: Partial<Record<SetKey, SetResult>> = {};
  for (const k of sets) {
    const s = benchSet(k);
    out[k] = setResultOf(
      k,
      runBlind(ctx, s.items, s.accept, () => def.make()),
    );
  }
  return {
    benchmark: BENCH_ID,
    benchVersion: BENCH_VERSION,
    system: key,
    kind: key,
    label: def.label,
    labelEn: def.labelEn,
    description: def.description,
    descriptionEn: def.descriptionEn,
    config: def.config,
    generated: today(),
    software: SOFTWARE,
    moment: momentOf(ctx),
    sets: out,
    total: totalOf(out),
  };
}

/** 可选的大模型模式：ask 给一题的回答（同一段对话共用一个内置助手和前面的问答）；progress 每题回来打一次 */
export async function runAsync(
  meta: { system: string; kind: SystemKey; label: string; labelEn: string; description: string; descriptionEn: string; config: Record<string, unknown> },
  sets: readonly SetKey[],
  ask: Parameters<typeof runBlindAsync>[3],
  ctx: AssistCtx = benchContext(),
  progress?: (set: SetKey, done: number, a: Answer) => void,
): Promise<SystemResult> {
  const out: Partial<Record<SetKey, SetResult>> = {};
  for (const k of sets) {
    const s = benchSet(k);
    out[k] = setResultOf(k, await runBlindAsync(ctx, s.items, s.accept, ask, (n, a) => progress?.(k, n, a)));
  }
  return {
    benchmark: BENCH_ID,
    benchVersion: BENCH_VERSION,
    ...meta,
    generated: today(),
    software: SOFTWARE,
    moment: momentOf(ctx),
    sets: out,
    total: totalOf(out),
  };
}

/** 外部系统的预测：每一套按同样的规则评；没有给预测的题四项都算错（什么都不答不能拿到安全分） */
export function scorePredictions(
  preds: readonly BlindPrediction[],
  sets: readonly SetKey[],
  meta: { system: string; label?: string; labelEn?: string; description?: string; descriptionEn?: string; config?: Record<string, unknown> },
  ctx?: AssistCtx,
): SystemResult {
  const byId = new Map(preds.map((p) => [p.id, p]));
  const out: Partial<Record<SetKey, SetResult>> = {};
  for (const k of sets) {
    const s = benchSet(k);
    const missing = new Set<string>();
    const items = s.items.map((item) => {
      const p = byId.get(item.id);
      if (p) return scoreBlindItem(item, p, s.accept[item.id]);
      missing.add(item.id);
      const r = scoreBlindItem(item, { id: item.id, intent: '', tools: [], behavior: 'answer' }, undefined);
      return {
        ...r,
        intent: '(none)',
        behavior: 'answer' as const,
        intentOk: false,
        toolOk: false,
        behaviorOk: false,
        safetyOk: false,
        said: '(no prediction)',
      };
    });
    out[k] = setResultOf(k, summarizeBlind(items), missing);
  }
  return {
    benchmark: BENCH_ID,
    benchVersion: BENCH_VERSION,
    system: meta.system,
    kind: 'external',
    label: meta.label ?? meta.system,
    labelEn: meta.labelEn ?? meta.label ?? meta.system,
    description: meta.description ?? '外部系统提交的预测（按 bench/duty-desk/schema/prediction.schema.json）。',
    descriptionEn: meta.descriptionEn ?? 'Predictions submitted by an external system (bench/duty-desk/schema/prediction.schema.json).',
    config: meta.config ?? {},
    generated: today(),
    software: SOFTWARE,
    moment: momentOf(ctx ?? benchContext()),
    sets: out,
    total: totalOf(out),
  };
}

/** 结果文件的写法：外层缩进好读，逐题结果一题一行（文件小一半，diff 也好看） */
export function resultJson(r: SystemResult): string {
  const sets = Object.fromEntries(Object.entries(r.sets).map(([k, v]) => [k, { ...v, items: `__ITEMS_${k}__` }]));
  let s = JSON.stringify({ ...r, sets }, null, 1);
  for (const [k, v] of Object.entries(r.sets)) s = s.replace(`"__ITEMS_${k}__"`, `[\n${v.items.map((x) => `   ${JSON.stringify(x)}`).join(',\n')}\n  ]`);
  return `${s}\n`;
}

/** 一套题有没有全部答完、每一项占多少（报告用） */
export const pct = (m: Metric): string => (m.n ? `${((100 * m.ok) / m.n).toFixed(1)}%` : '—');

/** 题号属于哪一套（打印用） */
export const allItemIds = (): string[] => BENCH_SETS.flatMap((s) => s.items.map((x) => x.id));
