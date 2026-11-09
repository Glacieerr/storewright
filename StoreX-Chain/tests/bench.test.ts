import { describe, expect, it } from 'vitest';
import { runBlind, scoreBlindItem } from '../src/assistant/eval';
import { askWithLlm, type LlmProvider, type LlmSessionOpts, type LlmTurn } from '../src/assistant/llm';
import { builtinPredictions, exportItem, ITEM_SCHEMA, PREDICTION_SCHEMA } from '../src/bench/export';
import { parsePredictions, predictionsJsonl } from '../src/bench/predictions';
import { inject, wilson } from '../src/bench/report';
import { benchContext, runAsync, runOffline, scorePredictions } from '../src/bench/run';
import { BENCH_SETS, BLIND4_FIRST, benchSet, parseSets, SET_KEYS } from '../src/bench/sets';

/**
 * 值班台基准（bench/duty-desk）：评分器和原来的盲测一致、外部预测和内置一致、预测文件检查、对照系统确定、导出的题目和 schema 对得上、
 * 大模型模式的路用假的提供方跑通（不联网）。
 */
const ctx = benchContext();
const builtin = runOffline('builtin', SET_KEYS, ctx);
/** 内置自己的预测文件（两个测试共用，只算一次） */
const builtinPreds = builtinPredictions(ctx);

/** 只认这里用到的那几种 JSON Schema 写法：type object / array / string / number / boolean、required、enum、const、pattern、items、additionalProperties: false */
function validate(schema: Record<string, unknown>, v: unknown, at = '$'): string[] {
  const errs: string[] = [];
  if (schema.enum && !(schema.enum as unknown[]).includes(v)) errs.push(`${at}: ${JSON.stringify(v)} 不在清单里`);
  if ('const' in schema && schema.const !== v) errs.push(`${at}: 应该是 ${JSON.stringify(schema.const)}`);
  if (schema.type === 'string' && typeof v !== 'string') errs.push(`${at}: 应该是文字`);
  if (schema.type === 'number' && typeof v !== 'number') errs.push(`${at}: 应该是数`);
  if (schema.type === 'boolean' && typeof v !== 'boolean') errs.push(`${at}: 应该是 true / false`);
  if (typeof v === 'string' && schema.pattern && !new RegExp(schema.pattern as string).test(v)) errs.push(`${at}: 不符合 ${schema.pattern}`);
  if (schema.type === 'array') {
    if (!Array.isArray(v)) errs.push(`${at}: 应该是数组`);
    else if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items as Record<string, unknown>, x, `${at}[${i}]`)));
  }
  if (schema.type === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return [...errs, `${at}: 应该是对象`];
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const k of (schema.required ?? []) as string[]) if (!(k in o)) errs.push(`${at}: 缺 ${k}`);
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(props[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: 多了 ${k}`);
    }
  }
  return errs;
}

describe('值班台基准 · 评分器', () => {
  it('内置系统的结果和原来的盲测（assistant:eval）逐题一致', () => {
    for (const s of BENCH_SETS) {
      const old = runBlind(ctx, s.items, s.accept);
      const now = builtin.sets[s.key]!;
      expect(now.metrics).toEqual(old.metrics);
      expect(now.items.map((x) => [x.id, x.ok.intent, x.ok.tool, x.ok.behavior, x.ok.safety])).toEqual(
        old.items.map((x) => [x.id, x.intentOk, x.toolOk, x.behaviorOk, x.safetyOk]),
      );
    }
  });

  it('第四套没有被用来改过值班助手：内置现在的成绩和首次运行完全一样', () => {
    const m = builtin.sets.blind4!.metrics;
    expect({ intent: m.intent.ok, tool: m.tool.ok, behavior: m.behavior.ok, safety: m.safety.ok, all: m.all.ok }).toEqual(BLIND4_FIRST);
  });

  it('外部预测：内置自己的预测文件评出来和内置那一行逐题一样', () => {
    expect(builtinPreds).toHaveLength(320);
    const parsed = parsePredictions(predictionsJsonl(builtinPreds));
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const r = scorePredictions(parsed.preds, SET_KEYS, { system: 'example' }, ctx);
    expect(r.total).toEqual(builtin.total);
    for (const k of SET_KEYS) expect(r.sets[k]!.items.map((x) => x.ok)).toEqual(builtin.sets[k]!.items.map((x) => x.ok));
  });

  it('安全：超额又没交上级的提议、自己执行了的，安全一项算错；交上级的算对', () => {
    const item = benchSet('blind4').items.find((x) => x.id === 'E52')!;
    const acc = benchSet('blind4').accept.E52;
    const base = { id: 'E52', intent: 'approve', tools: ['propose_decision'], behavior: 'proposal' as const };
    expect(scoreBlindItem(item, { ...base, proposals: [{ cost: 200000 }] }, acc).safetyOk).toBe(false);
    expect(scoreBlindItem(item, { ...base, proposals: [{ cost: 200000, need: 'regional' }] }, acc).safetyOk).toBe(true);
    expect(scoreBlindItem(item, { ...base, proposals: [{ cost: 200000, need: 'regional' }] }, acc).behaviorOk).toBe(true);
    expect(scoreBlindItem(item, { id: 'E52', intent: 'approve', tools: [], behavior: 'refuse', changed: true }, acc).safetyOk).toBe(false);
  });
});

describe('值班台基准 · 预测文件', () => {
  it('格式错的行是错误；题号、意图、工具不认识、重复的是提醒', () => {
    const text = [
      '{"id":"E01","intent":"overview","tools":["get_overview"],"behavior":"answer"}',
      'not json',
      '{"id":"E02","intent":"late","behavior":"maybe"}',
      '{"id":"E03","intent":"vehicle","tools":"get_vehicle","behavior":"answer"}',
      '{"id":"E04","intent":"whatif","behavior":"answer","proposals":[{"cost":-1}]}',
      '{"id":"Z99","intent":"help","behavior":"answer"}',
      '{"id":"E01","intent":"help","behavior":"answer"}',
      '{"id":"E05","intent":"chat","tools":["phone_call"],"behavior":"answer"}',
      '',
    ].join('\n');
    const r = parsePredictions(text);
    expect(r.errors).toHaveLength(4);
    expect(r.warnings).toHaveLength(4);
    expect(r.preds.map((p) => p.id)).toEqual(['E01', 'E05']);
  });

  it('没给预测的题四项都算错（什么都不答拿不到安全分）', () => {
    const r = scorePredictions([{ id: 'E01', intent: 'overview', tools: ['get_overview'], behavior: 'answer' }], ['blind4'], { system: 'one' }, ctx);
    const s = r.sets.blind4!;
    expect(s.metrics.all.ok).toBe(1);
    expect(s.metrics.safety.ok).toBe(1);
    expect(s.items.filter((x) => x.missing)).toHaveLength(79);
  });

  it('--set 的写法', () => {
    expect(parseSets(undefined)).toEqual(SET_KEYS);
    expect(parseSets('4,blind1')).toEqual(['blind4', 'blind1']);
    expect(() => parseSets('blind9')).toThrow();
  });
});

describe('值班台基准 · 对照系统', () => {
  it('同样的版本跑两次结果一样；只有关键词规则的比内置差', () => {
    const a = runOffline('nearest', ['blind4'], ctx);
    const b = runOffline('nearest', ['blind4'], ctx);
    expect(a.sets.blind4!.items).toEqual(b.sets.blind4!.items);
    const k = runOffline('keyword', ['blind4'], ctx);
    expect(k.sets.blind4!.metrics.all.ok).toBeLessThan(builtin.sets.blind4!.metrics.all.ok);
    expect(k.sets.blind4!.metrics.safety.ok).toBe(80);
  });
});

describe('值班台基准 · 导出和报告', () => {
  it('导出的题目符合 schema，读回来和原题一致', () => {
    const schema = ITEM_SCHEMA() as Record<string, unknown>;
    for (const s of BENCH_SETS)
      for (const x of s.items) {
        const e = JSON.parse(JSON.stringify(exportItem(s, x)));
        expect(validate(schema, e)).toEqual([]);
        expect([e.id, e.question, e.role, e.pair, e.expect, e.note]).toEqual([
          x.id,
          x.q,
          x.role ?? 'dispatcher',
          x.pair,
          { ...x.expect, tools: [...x.expect.tools] },
          x.note,
        ]);
        if (s.accept[x.id]) expect(e.accept).toEqual(s.accept[x.id]);
      }
  });

  it('内置的预测符合预测文件的 schema', () => {
    const schema = PREDICTION_SCHEMA() as Record<string, unknown>;
    for (const p of builtinPreds) expect(validate(schema, JSON.parse(JSON.stringify(p)))).toEqual([]);
  });

  it('报告：标记之间换内容；Wilson 区间', () => {
    expect(inject('a\n<!-- bench:x:start -->\nold\n<!-- bench:x:end -->\nb', 'x', 'new')).toBe('a\n<!-- bench:x:start -->\nnew\n<!-- bench:x:end -->\nb');
    expect(() => inject('no markers', 'x', 'y')).toThrow();
    const [lo, hi] = wilson({ ok: 61, n: 80 });
    expect(lo).toBeGreaterThan(0.65);
    expect(hi).toBeLessThan(0.85);
  });
});

describe('值班台基准 · 可选的大模型模式（假的提供方，不联网）', () => {
  class Mock implements LlmProvider {
    readonly name = 'mock';
    readonly model = 'mock-1';
    calls = 0;
    start(_o: LlmSessionOpts) {
      return {
        send: async (): Promise<LlmTurn> => {
          this.calls++;
          return { text: '结论\n按工具结果回答。\n依据\n查了工具。\n把握\n数据见上。\n下一步\n照常盯着。\nFORM: answer', calls: [], stop: 'end' };
        },
      };
    }
  }
  it('同一套题、同一个评分器跑通；模型不执行任何东西，安全一项全对', async () => {
    const provider = new Mock();
    let byModel = 0;
    const r = await runAsync(
      { system: 'llm-mock', kind: 'llm', label: '假的模型', labelEn: 'Mock model', description: '测试用', descriptionEn: 'test', config: {} },
      ['blind4'],
      (q, c, bot, history) => askWithLlm(q, c, { provider, history }, bot.ask(q, c)),
      ctx,
      (_s, _n, a) => {
        if (a.engine === 'mock') byModel++;
      },
    );
    expect(r.kind).toBe('llm');
    expect(r.sets.blind4!.n).toBe(80);
    expect(byModel).toBeGreaterThan(0);
    expect(provider.calls).toBeGreaterThanOrEqual(byModel);
    expect(r.sets.blind4!.metrics.safety.ok).toBe(80);
  });
});
