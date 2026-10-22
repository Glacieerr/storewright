import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { openDb, type Db } from './db';
import { Assistant } from './assistant';
import { buildEvalSet, buildHeldOutSetB, runEval } from './assistant/eval';
import { searchKnowledge, tokenize } from './assistant/knowledge';
import { route } from './assistant/router';

let db: Db;
let base = '';
let close: () => Promise<void>;
let stores: Awaited<ReturnType<typeof buildApp>>['stores'];

async function session(body: Record<string, string>): Promise<string> {
  const r = await fetch(`${base}/api/stores/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return ((await r.json()) as { token: string }).token;
}

async function post(token: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/stores/demo${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

beforeAll(async () => {
  db = await openDb({});
  const built = await buildApp({ db, demo: true });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  close = built.close;
  stores = built.stores;
});

afterAll(async () => {
  await close();
  await db.close();
});

describe('local assistant (5d)', () => {
  it('answers in template mode with data and citations, in both languages', async () => {
    const picker = await session({ associateId: 'A01' });
    const zh = await post(picker, '/ai/ask', { question: '现在有几位顾客在等？', lang: 'zh' });
    expect(zh.status).toBe(200);
    expect(zh.body).toMatchObject({ source: 'TEMPLATE', tools: [{ name: 'store_status' }] });
    expect(zh.body.answer).toMatch(/位顾客在等/);
    expect(zh.body.citations[0]).toBe('门店实时状态');
    const e = stores.get('demo')!;
    const item = [...e.runtime.statics.planogram].sort((a, b) => b.baseVelocity - a.baseVelocity)[0]!;
    const en = await post(picker, '/ai/ask', { question: `Where is ${item.name}?`, lang: 'en' });
    expect(en.body.tools[0].name).toBe('find_item');
    expect(en.body.answer).toContain(item.locationId);
    const how = await post(picker, '/ai/ask', { question: '验证码输错三次怎么办？', lang: 'zh' });
    expect(how.body.tools[0].name).toBe('knowledge');
    expect(how.body.answer).toMatch(/人工核验/);
  });

  it('runs a what-if simulation from a sentence', async () => {
    const lead = await session({ associateId: 'A08' });
    const r = await post(lead, '/ai/ask', { question: '如果 16 到 19 点多一个交付员会怎样？', lang: 'zh' });
    expect(r.body.tools[0]).toMatchObject({ name: 'whatif', args: { role: 'handoff', delta: 1, fromHour: 16, toHour: 19 } });
    expect(r.body.answer).toMatch(/平均等待 .* → .* 分钟/);
  });

  it('reads afternoon and evening hours in what-if questions (found by the walkthrough)', () => {
    const plan = stores.get('demo')!.runtime.statics.planogram;
    const hours = (q: string) => {
      const a = route(q, plan)[0]?.args ?? {};
      return [a.fromHour, a.toHour];
    };
    expect(hours('如果下午3点到6点交付多一个人会怎样？')).toEqual([15, 18]);
    expect(hours('如果晚上7点到9点拣货少一个人会怎样？')).toEqual([19, 21]);
    expect(hours('如果上午10点到下午2点交付多一个人会怎样？')).toEqual([10, 14]);
    expect(hours('如果 16 到 19 点多一个交付员会怎样？')).toEqual([16, 19]);
    expect(hours('What if we add one handoff associate from 3 to 6 pm?')).toEqual([15, 18]);
    expect(hours('What if we add one picker from 11am to 2pm?')).toEqual([11, 14]);
    expect(hours('What if we add one handoff associate at 4pm?')).toEqual([16, 19]);
  });

  it('explains a what-if that barely changes anything, using the simulation data', async () => {
    const lead = await session({ associateId: 'A08' });
    const none = await post(lead, '/ai/ask', { question: '如果 3 到 6 点交付多一个人会怎样？', lang: 'zh' });
    expect(none.body.answer).toContain('这个时段本来没有排交付员');
    const quiet = await post(lead, '/ai/ask', { question: '如果 8 到 10 点交付多一个人会怎样？', lang: 'zh' });
    expect(quiet.body.answer).toMatch(/加人几乎没有改变结果：8–10 点平均排了 [\d.]+ 名交付员/);
    expect(quiet.body.answer).toMatch(/每人负担最重的是 \d+–\d+ 点/);
  });

  it('captures store notes and finds them again', async () => {
    const e = stores.get('demo')!;
    const restocker = await session({ associateId: 'A10' });
    const item = e.runtime.statics.planogram[10]!;
    const add = await post(restocker, '/commands', { cmd: { type: 'AddNote', text: '周末这个商品放在 A01 端架，不在原货位', itemId: item.itemId, tags: ['端架'] } });
    expect(add.status).toBe(200);
    const note = Object.values(e.runtime.state.notes)[0]!;
    expect(note).toMatchObject({ author: 'A10', itemId: item.itemId, tags: ['端架'] });
    const r = await post(restocker, '/ai/ask', { question: `${item.name} 在哪里？`, lang: 'zh' });
    expect(r.body.answer).toContain('端架');
    const hits = searchKnowledge('周末端架的商品', Object.values(e.runtime.state.notes), 'zh');
    expect(hits[0]).toMatchObject({ kind: 'NOTE', id: note.id });
    expect((await post(await session({ associateId: 'A01' }), '/commands', { cmd: { type: 'RemoveNote', noteId: note.id } })).body.reject.code).toBe('NOT_AUTHORIZED');
    expect((await post(restocker, '/commands', { cmd: { type: 'RemoveNote', noteId: note.id } })).status).toBe(200);
    expect(tokenize('冷冻暂存 frozen')).toEqual(expect.arrayContaining(['冷冻', '暂存', '冻暂', 'frozen', '冷']));
  });

  it('answers where an item outside the planogram is from store notes (found by the walkthrough)', async () => {
    const lead = await session({ associateId: 'A08' });
    const add = await post(lead, '/commands', { cmd: { type: 'AddNote', text: '周末烤鸡放在熟食柜旁边的冷柜，不在原货位', tags: [] } });
    expect(add.status).toBe(200);
    const r = await post(lead, '/ai/ask', { question: '周末烤鸡放在哪？', lang: 'zh' });
    expect(r.body.tools.map((t: { name: string }) => t.name)).toEqual(['find_item', 'knowledge']);
    expect(r.body.answer).toContain('陈列表里没有这个商品');
    expect(r.body.answer).toContain('熟食柜旁边的冷柜');
    // 经验库里也没有时，仍然提示没找到
    const none = await post(lead, '/ai/ask', { question: '紫色雨伞放在哪？', lang: 'zh' });
    expect(none.body.answer).toContain('没有找到这个商品');
    const noteId = Object.values(stores.get('demo')!.runtime.state.notes).find((n) => n.text.includes('烤鸡'))!.id;
    expect((await post(lead, '/commands', { cmd: { type: 'RemoveNote', noteId } })).status).toBe(200);
  });

  it('evaluation sets: rules + intent classifier answer the in-sample set and most unseen phrasings', async () => {
    const e = stores.get('demo')!;
    const inSample = await runEval(e.assistant, buildEvalSet(e.runtime, e.demo, e.ai));
    expect(inSample.n).toBeGreaterThan(40);
    expect(inSample.toolAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(inSample.answerAccuracy).toBeGreaterThanOrEqual(0.95);
    const rules = await runEval(e.assistant, buildHeldOutSetB(e.runtime), 'RULES');
    const hybrid = await runEval(e.assistant, buildHeldOutSetB(e.runtime));
    expect(hybrid.toolAccuracy).toBeGreaterThan(rules.toolAccuracy);
  });

  it('uses a local OpenAI-compatible model with tool calls, and falls back to templates on failure', async () => {
    const e = stores.get('demo')!;
    let calls = 0;
    const seen: unknown[] = [];
    const mock: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] };
        seen.push(j);
        calls++;
        res.setHeader('content-type', 'application/json');
        if (calls === 1) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'store_status', arguments: '{}' } }] } }] }));
        } else {
          const tool = j.messages.find((m) => m.role === 'tool');
          const data = JSON.parse(tool?.content ?? '{}') as { data?: { waiting?: number } };
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `There are ${data.data?.waiting ?? '?'} customers waiting (from store status).` } }] }));
        }
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    const port = (mock.address() as { port: number }).port;
    const llm = new Assistant(e.runtime, e.demo, e.ai, { url: `http://127.0.0.1:${port}/v1`, model: 'local-test', timeoutMs: 3000 });
    const r = await llm.ask('How many customers are waiting?', 'en');
    expect(r.source).toBe('LLM');
    expect(r.tools).toEqual([{ name: 'store_status', args: {} }]);
    expect(r.answer).toMatch(/There are \d+ customers waiting/);
    expect((seen[0] as { tools: unknown[] }).tools.length).toBeGreaterThan(5);
    await new Promise<void>((r2) => mock.close(() => r2()));
    // 模型不可用：退回模板，并说明原因
    const down = await llm.ask('现在有几位顾客在等？', 'zh');
    expect(down.source).toBe('TEMPLATE');
    expect(down.fallback).toBeTruthy();
    expect(down.answer).toMatch(/位顾客在等/);
  });
});
