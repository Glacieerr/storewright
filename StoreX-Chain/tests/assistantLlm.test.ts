import { describe, expect, it } from 'vitest';
import { pendingCards } from '../src/assistant/brief';
import { askWithLlm, isEnglish, llmConfig, LlmError, type LlmProvider, type LlmSessionOpts, type LlmTurn } from '../src/assistant/llm';
import { LocalProvider } from '../src/assistant/llm/local';
import type { AssistCtx } from '../src/assistant/types';
import { buildEvalContexts } from '../src/cli/assistantEval';

/**
 * 可选的大模型模式：全部用假的提供方测（不联网、不花钱）——工具循环、工具在本地执行、提议不执行且按规则表检查、
 * 数字核对、出错和超时改用内置助手、英文问题走英文、本机模型接口的请求和回包格式。
 */
const ctxs = buildEvalContexts();
const ctx: AssistCtx = { ...ctxs.card, ...(ctxs.hubs.hubs ? { hubs: ctxs.hubs.hubs } : {}) };
const snap = (c: AssistCtx) =>
  JSON.stringify([
    (c.twin?.recs ?? []).map((r) => [r.key, r.status, r.chosen ?? '']),
    c.board.ops.map((o) => [o.id, o.door ?? '', o.depart ?? '']),
    (c.twin?.decisions ?? []).length,
  ]);

type Results = { id: string; content: string; isError?: boolean }[];
class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-1';
  system = '';
  received: Results[] = [];
  constructor(private readonly script: (step: number, last?: Results) => LlmTurn | Promise<LlmTurn>) {}
  start(o: LlmSessionOpts) {
    this.system = o.system;
    let step = 0;
    return {
      send: async (input: { user?: string; toolResults?: Results }) => {
        if (input.toolResults) this.received.push(input.toolResults);
        return this.script(step++, input.toolResults);
      },
    };
  }
}
const call = (name: string, input: Record<string, unknown> = {}, id = 't1'): LlmTurn => ({ text: '', calls: [{ id, name, input }], stop: 'tool' });
const done = (text: string): LlmTurn => ({ text, calls: [], stop: 'end' });
const ZH = '结论\n按工具结果回答。\n依据\n查了工具。\n把握\n数据见上。\n下一步\n照常盯着。\nFORM: answer';

describe('大模型模式 · 工具循环', () => {
  it('模型要的工具在本地执行，结果交回给模型；回答写明是哪个引擎答的', async () => {
    const p = new MockProvider((step) => (step === 0 ? call('list_late') : done(ZH)));
    const a = await askWithLlm('现在有哪些车晚点', ctx, { provider: p });
    expect(a.engine).toBe('mock');
    expect(a.tools.map((t) => t.name)).toEqual(['list_late']);
    expect(p.received[0]?.[0]?.isError).toBe(false);
    expect(JSON.parse(p.received[0]?.[0]?.content ?? '{}')).toHaveProperty('text');
    expect(a.text).not.toContain('FORM:');
    expect(a.conclusion).toBe('按工具结果回答。');
    expect(p.system).toContain('propose_decision');
  });

  it('不认识的工具、参数不对的，交回错误；超过轮数改用内置助手', async () => {
    const p = new MockProvider((step) =>
      step === 0
        ? {
            text: '',
            calls: [
              { id: 'a', name: 'execute_everything', input: {} },
              { id: 'b', name: 'get_hub', input: { hub: 'moon' } },
            ],
            stop: 'tool',
          }
        : done(ZH),
    );
    await askWithLlm('仓储中心怎么样', ctx, { provider: p });
    expect(p.received[0]?.map((r) => r.isError)).toEqual([true, true]);
    const loop = new MockProvider(() => call('get_overview'));
    const a = await askWithLlm('现在整体情况怎么样', ctx, { provider: loop, maxRounds: 2 });
    expect(a.engine).toBe('builtin');
    expect(a.engineNote).toContain('超过 2 轮');
  });

  it('提议只生成、不执行，按规则表检查；问完建议卡和调度台一点没变', async () => {
    const key = pendingCards(ctx)[0]?.key as string;
    const before = snap(ctx);
    const p = new MockProvider((step) => (step === 0 ? call('propose_decision', { keys: [key], action: 'approve' }) : done(ZH)));
    const a = await askWithLlm('批准第一张建议卡', { ...ctx, role: 'manager' }, { provider: p });
    expect(a.engine).toBe('mock');
    expect(a.proposals.length).toBeGreaterThan(0);
    for (const pr of a.proposals) expect(pr.checks?.length).toBeGreaterThan(0);
    expect(a.next.some((n) => n.proposal !== undefined)).toBe(true);
    expect(snap(ctx)).toBe(before);
  });
});

describe('大模型模式 · 数字核对和兜底', () => {
  it('找不到出处的数多：改给内置助手的回答；少：照样给，标出来', async () => {
    const bad = new MockProvider((step) =>
      step === 0
        ? call('get_overview')
        : done('结论\n现在有 123457 辆车在路上、晚了 98761 分钟、多花 55553 美元。\n依据\n概况。\n把握\n高。\n下一步\n无。\nFORM: answer'),
    );
    const a = await askWithLlm('现在整体情况怎么样', ctx, { provider: bad });
    expect(a.engine).toBe('builtin');
    expect(a.engineNote).toContain('找不到出处');
    const mild = new MockProvider((step) =>
      step === 0 ? call('get_overview') : done('结论\n大约 777771 件事要盯。\n依据\n概况。\n把握\n中。\n下一步\n无。\nFORM: answer'),
    );
    const b = await askWithLlm('现在整体情况怎么样', ctx, { provider: mild });
    expect(b.engine).toBe('mock');
    expect(b.grounding.missing).toContain('777771');
    expect(b.text).toContain('找不到出处');
  });

  it('提供方出错、超时：改用内置助手并说明原因', async () => {
    const err = new MockProvider(() => {
      throw new LlmError('network', 'offline');
    });
    const a = await askWithLlm('现在有哪些车晚点', ctx, { provider: err });
    expect(a.engine).toBe('builtin');
    expect(a.engineNote).toContain('连不上');
    expect(a.text).toContain('路上晚了');
    const slow = new MockProvider(() => new Promise<LlmTurn>(() => undefined));
    const b = await askWithLlm('现在有哪些车晚点', ctx, { provider: slow, timeoutMs: 50 });
    expect(b.engine).toBe('builtin');
    expect(b.engineNote).toContain('超时');
  });

  it('模型标了形态（问一句、超出范围、拒绝）：回答带上对应的标记', async () => {
    const clar = new MockProvider(() => done('结论\n问的是哪辆车？\n依据\n没说车。\n把握\n—\n下一步\n说车号。\nFORM: clarify'));
    expect((await askWithLlm('那辆车到哪了', ctx, { provider: clar })).clarify).toBeDefined();
    const dec = new MockProvider(() => done('结论\n这超出了值班助手的范围。\n依据\n—\n把握\n—\n下一步\n问运营的事。\nFORM: decline'));
    expect((await askWithLlm('帮我订机票', ctx, { provider: dec })).declined).toBe(true);
  });
});

describe('大模型模式 · 语言和设置', () => {
  it('英文问题：提示词要求英文四段，说明也是英文', async () => {
    expect(isEnglish('How many vehicles are late right now?')).toBe(true);
    expect(isEnglish('M05 到哪了')).toBe(false);
    const p = new MockProvider((step) =>
      step === 0
        ? call('list_late')
        : done('Conclusion\nSee the late list.\nBasis\nlist_late.\nConfidence\nFrom the tools.\nNext steps\nKeep watching.\nFORM: answer'),
    );
    const a = await askWithLlm('How many vehicles are late right now?', ctx, { provider: p });
    expect(p.system).toContain('Answer in English');
    expect(a.conclusion).toBe('See the late list.');
    expect(a.certainty.notes[0]).toContain('Written by the language model');
  });

  it('默认关；环境变量打开；本机模型要地址', () => {
    expect(llmConfig({}).mode).toBe('off');
    const c = llmConfig({ STOREX_LLM: 'claude' });
    expect(c).toMatchObject({ mode: 'claude', model: 'claude-opus-5-5', maxTokens: 16000, maxRounds: 6 });
    expect(llmConfig({ STOREX_LLM: 'local', STOREX_LLM_BASE_URL: 'http://127.0.0.1:11434/v1', STOREX_LLM_MODEL: 'm' })).toMatchObject({
      mode: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      maxTokens: 2048,
    });
    expect(llmConfig({ STOREX_LLM: 'bogus' }).mode).toBe('off');
  });

  it('本机模型接口：按 /v1/chat/completions 发请求、读 tool_calls', async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const msg = n++ === 0 ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_late', arguments: '{}' } }] } : { content: ZH };
      return new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: n === 1 ? 'tool_calls' : 'stop' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const p = new LocalProvider('m', 'http://127.0.0.1:9/v1/', fakeFetch);
    const a = await askWithLlm('现在有哪些车晚点', ctx, { provider: p });
    expect(a.engine).toBe('local');
    expect(a.tools.map((t) => t.name)).toEqual(['list_late']);
    expect(bodies[0]).toMatchObject({ model: 'm' });
    expect((bodies[0]?.tools as { type: string }[])[0]?.type).toBe('function');
    expect((bodies[1]?.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });
});
