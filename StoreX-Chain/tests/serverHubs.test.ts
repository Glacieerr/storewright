import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 孪生服务的值班助手查四个仓储中心：起一个服务（默认区域、第 1 组、平常负荷），按 /api/assistant 问，
 * 港口物流中心、机场货站、物流园、门店都要有作业计划（不能回「作业计划没接上」），门店的预约错峰用场地排程器。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18700 + (process.pid % 200);
let child: ChildProcess | undefined;
let errText = '';

interface Reply {
  engine?: string;
  engineNote?: string;
  intent: string;
  text: string;
  tools: { name: string; args: Record<string, unknown> }[];
  entities: { hub?: string };
  data: Record<string, unknown>[];
}
const ask = async (q: string): Promise<Reply> => (await fetch(`http://127.0.0.1:${PORT}/api/assistant?q=${encodeURIComponent(q)}`)).json() as Promise<Reply>;

beforeAll(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/twinServer.ts', '--port', String(PORT), '--speed', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => (errText += String(d)));
  await new Promise<void>((resolve, reject) => {
    child?.stdout?.on('data', (d) => {
      if (String(d).includes('孪生服务')) resolve();
    });
    child?.on('exit', (code) => reject(new Error(`孪生服务没起来（${code}）：${errText}`)));
  });
}, 120_000);

afterAll(() => {
  child?.kill();
});

describe('孪生服务 · 值班助手查仓储中心', () => {
  it('四个仓储中心都有作业计划：概况按各自的区回答', async () => {
    const cases: [string, string, string][] = [
      ['港口物流中心的作业计划怎么样', 'port', '港口物流中心'],
      ['机场货站现在怎么样', 'airport', '机场货站'],
      ['物流园的仓储中心概况', 'park', '物流园'],
      ['门店收货场现在怎么样', 'store', '停车场与收货场'],
    ];
    for (const [q, hub, label] of cases) {
      const a = await ask(q);
      expect(
        a.tools.map((t) => t.name),
        q,
      ).toContain('get_hub');
      expect(a.entities.hub, q).toBe(hub);
      expect(a.text, q).toContain(label);
      expect(a.text, q).not.toContain('没接上');
      expect(a.text, q).toMatch(/\d+ \/ \d+/);
    }
    expect(errText).not.toContain('没排出来');
    // 没设 STOREX_LLM：内置引擎答
    expect((await ask('现在有什么风险')).engine).toBe('builtin');
  });

  it('瓶颈、本店的货、预约错峰也按四个仓储中心的计划回答；门店的预约错峰数是场地排程器排的', async () => {
    const b = await ask('物流园的瓶颈在哪');
    expect(b.tools.map((t) => t.name)).toContain('hub_bottlenecks');
    expect(b.text).toContain('物流园');
    expect(b.text).not.toContain('没接上');
    const c = await ask('本店的货在哪个仓储中心');
    expect(c.tools.map((t) => t.name)).toContain('trace_own_cargo');
    expect(c.text).not.toContain('没接上');
    const s = await ask('门店预约错峰');
    expect(s.tools.map((t) => t.name)).toContain('plan_appointments');
    expect(s.text).toContain('场地排程器排出来的');
    expect(s.data.some((d) => d.model === 'yard')).toBe(true);
    const air = await ask('机场货站预约错峰');
    expect(air.text).toContain('排队模型估的');
    // 临时扰动的推演：服务里有现场模型的输入
    const w = await ask('如果 M05 晚 2 个小时出发会怎样');
    expect(w.tools.map((t) => t.name)).toEqual(['what_if']);
    expect(w.data.some((d) => d.base !== undefined && d.alt !== undefined)).toBe(true);
  });
});

describe('孪生服务 · 可选的大模型模式出错时退回内置', () => {
  it('设了本机模型但连不上：回答由内置助手给，写明原因', async () => {
    const port = PORT + 7;
    const p = spawn(process.execPath, ['--import', 'tsx', 'server/twinServer.ts', '--port', String(port), '--speed', '0'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STOREX_LLM: 'local', STOREX_LLM_BASE_URL: 'http://127.0.0.1:9/v1', STOREX_LLM_TIMEOUT_MS: '8000' },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        p.stdout?.on('data', (d) => {
          if (String(d).includes('孪生服务：')) resolve();
        });
        p.on('exit', (code) => reject(new Error(`没起来（${code}）`)));
      });
      const r = (await (await fetch(`http://127.0.0.1:${port}/api/assistant?q=${encodeURIComponent('现在有哪些车晚点')}`)).json()) as Reply;
      expect(r.engine).toBe('builtin');
      expect(r.engineNote).toContain('连不上');
      expect(r.text).toContain('晚');
    } finally {
      p.kill();
    }
  }, 120_000);
});
