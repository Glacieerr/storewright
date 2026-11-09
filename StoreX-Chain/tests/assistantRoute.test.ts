import { describe, expect, it } from 'vitest';
import { Assistant } from '../src/assistant';
import type { AssistCtx } from '../src/assistant/types';
import { buildEvalContexts } from '../src/cli/assistantEval';
import { ROUTE_EXAMPLES, ROUTE_MIN, routeEnglish } from '../web/src/assistantText';
import { lookup } from '../web/src/i18n';
import { EN } from '../web/src/i18n/en';

/**
 * 英文问题路由（英文界面）：内置助手只懂中文，随手打的英文问题按词的重合换成最像的示例问句，编号放回去；
 * 把握不够时不乱猜（面板用英文说明内置助手懂什么）。
 * English router: free English questions go to the closest Chinese example question, IDs included; low confidence → no guess.
 */
const en = (s: string) => lookup(EN, s) ?? s;

describe('English question router', () => {
  it('maps the exact English examples back to the Chinese question', () => {
    expect(routeEnglish('What are the risks now', en)?.zh).toBe('现在有什么风险');
    expect(routeEnglish('where is m02?', en)?.zh).toBe('M02 在哪');
  });

  it('routes free English questions by token overlap and puts the IDs back', () => {
    expect(['哪些车会晚', '现在有哪些车晚点']).toContain(routeEnglish('which trucks are late today?', en)?.zh);
    expect(routeEnglish('where is truck m2', en)?.zh).toBe('M2 在哪');
    expect(routeEnglish('Where is DS-BEV-1?', en)?.zh).toBe('DS-BEV-1 在哪');
    expect(routeEnglish('why is TR0527 delayed', en)?.zh).toBe('TR0527 为什么晚');
    expect(routeEnglish('when will door c05 be free', en)?.zh).toBe('C05 什么时候空');
    expect(routeEnglish('what should I do about the cold-chain doors', en)?.zh).toBe('冷链门不够用怎么办');
    expect(routeEnglish('how is the airport doing', en)?.zh).toBe('机场货站怎么样');
    expect(routeEnglish('has the flight FL1100 landed', en)?.zh).toBe('航班到了吗');
    expect(routeEnglish('show me pending recommendations', en)?.zh).toBe('有什么待处理的建议');
    expect(routeEnglish('approve the first one', en)?.zh).toBe('批准第一条');
    const r = routeEnglish('where is truck m2', en);
    expect(r?.via).toBe('Where is M2');
    expect(r?.score).toBeGreaterThanOrEqual(ROUTE_MIN);
  });

  it('does not guess below the threshold, and leaves Chinese input alone', () => {
    for (const q of ['tell me a joke', 'what is the weather on mars', 'hello', 'what time is it']) {
      const r = routeEnglish(q, en);
      expect(r?.zh, q).toBeUndefined();
      expect(r?.score ?? 0).toBeLessThan(ROUTE_MIN);
    }
    expect(routeEnglish('M02 在哪', en)).toBeUndefined();
    expect(routeEnglish('12:30', en)).toBeUndefined();
    expect(ROUTE_EXAMPLES.every((q) => !/[a-z]{3}/i.test(q))).toBe(true);
  });

  it('only sends questions the built-in assistant answers (no decline)', () => {
    const ctxs = buildEvalContexts();
    const ctx: AssistCtx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
    const qs = ['which trucks are late today?', 'any risks right now?', 'where is truck m03', 'when is door c05 free', 'how is the port doing', 'how much dairy is left', 'write the shift handover report', 'why is the store late today', 'are there accidents on the road', 'where are our containers', 'how are the hubs', 'give me an overview'];
    for (const q of qs) {
      const zh = routeEnglish(q, en)?.zh;
      expect(zh, q).toBeTruthy();
      const a = new Assistant().ask(zh as string, ctx);
      expect(a.declined, `${q} → ${zh}`).toBeFalsy();
    }
  });
});
