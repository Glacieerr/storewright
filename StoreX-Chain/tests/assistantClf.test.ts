import { describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant';
import { CLASSIFIER, classify, classifyBy, EXTRA_HOLDOUT, ruleIntent, TEMP, unsure } from '../src/assistant/intent';
import { calibrated, softmaxLogits, trainSoftmax } from '../src/assistant/softmax';
import { buildEvalContexts } from '../src/cli/assistantEval';

/** 意图分类器：逻辑回归（确定性）、温度校准、拿不准时问一句 */
const rows = [
  { y: 'a', f: ['c:冷', 'c:链', 'b:冷链'], w: 1 },
  { y: 'a', f: ['c:冷', 'b:冷库'], w: 1 },
  { y: 'b', f: ['c:港', 'c:口', 'b:港口'], w: 1 },
  { y: 'b', f: ['c:港', 'b:码头'], w: 2 },
];
const opts = { epochs: 30, lr: 1, l2: 1e-5, minCount: 1, seed: 3 };

describe('逻辑回归和校准', () => {
  it('同一份语料、同一组参数，训练两遍一模一样，能分开两类', () => {
    const m1 = trainSoftmax(rows, opts);
    const m2 = trainSoftmax(rows, opts);
    expect([...m1.w]).toEqual([...m2.w]);
    expect([...m1.b]).toEqual([...m2.b]);
    const top = (f: string[]) => calibrated(m1.classes, softmaxLogits(m1, f), 1)[0]?.intent;
    expect(top(['c:冷', 'b:冷链'])).toBe('a');
    expect(top(['c:港', 'b:港口'])).toBe('b');
  });
  it('温度：概率加起来是 1，温度越高越平', () => {
    const s = [2, 1, 0];
    const p1 = calibrated(['x', 'y', 'z'], s, 1);
    const p3 = calibrated(['x', 'y', 'z'], s, 3);
    expect(p1.reduce((a, x) => a + x.p, 0)).toBeCloseTo(1, 10);
    expect((p3[0] as { p: number }).p).toBeLessThan((p1[0] as { p: number }).p);
    expect(TEMP.nb).toBeGreaterThan(0);
    expect(TEMP.lr).toBeGreaterThan(0);
  });
  it('在用的分类器是逻辑回归，概率加起来是 1；三种分类器都能用', () => {
    expect(CLASSIFIER).toBe('lr');
    for (const kind of ['nb', 'lr', 'ens'] as const) {
      const r = classifyBy(kind, '现在整体情况怎么样');
      expect(r.reduce((a, x) => a + x.p, 0)).toBeCloseTo(1, 6);
    }
  });
});

describe('拿不准时问一句', () => {
  it('概率平的时候给两种理解，尖的时候不问', () => {
    expect(
      unsure(
        [
          { intent: 'late', p: 0.3 },
          { intent: 'kpi', p: 0.28 },
        ],
        '到现在迟到了几分钟',
      ),
    ).toMatchObject({ a: { intent: 'late' }, b: { intent: 'kpi' } });
    expect(
      unsure(
        [
          { intent: 'late', p: 0.9 },
          { intent: 'kpi', p: 0.05 },
        ],
        '现在有哪些车晚点',
      ),
    ).toBeUndefined();
  });
  it('值班助手拿不准时问一句、给两个按钮；认出了车的不问', () => {
    const ctxs = buildEvalContexts();
    const ctx = { ...ctxs.card };
    const qs = EXTRA_HOLDOUT.map(([, x]) => x).filter((x) => !/[<>]/.test(x) && ruleIntent(x) === undefined && unsure(classify(x), x));
    expect(qs.length).toBeGreaterThan(0);
    const ab = qs.map((x) => new Assistant().ask(x, ctx)).filter((a) => a.data.some((d) => d.abstain === true));
    expect(ab.length).toBeGreaterThan(0);
    for (const a of ab) {
      expect(a.clarify?.options).toHaveLength(2);
      expect(a.proposals).toHaveLength(0);
    }
    const anchored = new Assistant().ask('M05 那边咋样了', ctx);
    expect(anchored.data.some((d) => d.abstain === true)).toBe(false);
  });
});
