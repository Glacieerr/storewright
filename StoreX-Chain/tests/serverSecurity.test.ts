import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 孪生服务的访问控制：访问密钥、浏览器来源、请求体上限、数字参数、不只听本机又没有密钥时拒绝启动。
 * 起一个带密钥和允许来源的服务（只听本机），按 HTTP 和 WebSocket 一项项试。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18900 + (process.pid % 90);
const TOKEN = 'test-token-0123456789';
const OK_ORIGIN = 'http://ok.example';
let child: ChildProcess | undefined;

function call(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ code: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** 发一个 WebSocket 升级请求，看服务回的状态（101 = 接受） */
function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port: PORT,
      path: '/ws',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', () => resolve(0));
    req.end();
  });
}

beforeAll(async () => {
  child = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/twinServer.ts', '--port', String(PORT), '--speed', '0', '--token', TOKEN, '--allow-origin', OK_ORIGIN],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr?.on('data', (d) => (err += String(d)));
  await new Promise<void>((resolve, reject) => {
    child?.stdout?.on('data', (d) => {
      if (String(d).includes('孪生服务')) resolve();
    });
    child?.on('exit', (code) => reject(new Error(`孪生服务没起来（${code}）：${err}`)));
  });
}, 120_000);

afterAll(() => {
  child?.kill();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('孪生服务 · 访问控制', () => {
  it('默认不回跨域头；改状态要带访问密钥', async () => {
    const h = await call('GET', '/api/health');
    expect(h.code).toBe(200);
    expect(h.headers['access-control-allow-origin']).toBeUndefined();
    expect((await call('POST', '/api/control', { body: '{"paused":true}' })).code).toBe(401);
    expect((await call('POST', '/api/control', { body: '{"paused":true}', headers: { authorization: 'Bearer wrong' } })).code).toBe(401);
    expect((await call('POST', '/api/control', { body: '{"paused":true}', headers: auth })).code).toBe(200);
    expect((await call('POST', '/api/control', { body: '{"paused":true}', headers: { 'x-ingest-token': TOKEN } })).code).toBe(200);
  });

  it('不认识的浏览器来源不能改状态、不能连 WebSocket；允许的来源回跨域头', async () => {
    expect((await call('POST', '/api/control', { body: '{"paused":true}', headers: { ...auth, origin: 'https://evil.example' } })).code).toBe(403);
    const ok = await call('POST', '/api/control', { body: '{"paused":true}', headers: { ...auth, origin: OK_ORIGIN } });
    expect(ok.code).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(OK_ORIGIN);
    expect((await call('OPTIONS', '/api/control', { headers: { origin: 'https://evil.example' } })).code).toBe(403);
    expect((await call('OPTIONS', '/api/control', { headers: { origin: OK_ORIGIN } })).code).toBe(204);
    expect(await upgrade({ origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade({ origin: OK_ORIGIN })).toBe(101);
    expect(await upgrade({})).toBe(101);
  });

  it('请求体超过 64 KB 回 413，不是 JSON 回 400；数字参数不是数回 400', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    expect((await call('POST', '/api/control', { body: big, headers: auth })).code).toBe(413);
    expect((await call('POST', '/api/control', { body: 'not json', headers: auth })).code).toBe(400);
    expect((await call('GET', '/api/messages?limit=abc')).code).toBe(400);
    expect((await call('GET', '/api/vehicle?vid=1.5')).code).toBe(400);
    expect((await call('GET', '/api/messages?limit=10')).code).toBe(200);
  });

  it('WebSocket 指令要密钥：连接时没带的，指令被拒；网址里带了的照常', async () => {
    const reply = (url: string, msg: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m.type === 'hello') ws.send(JSON.stringify(msg));
          else if (m.type === 'reply') {
            ws.close();
            resolve(m);
          }
        };
        ws.onerror = () => reject(new Error('WebSocket 连不上'));
      });
    expect((await reply(`ws://127.0.0.1:${PORT}/ws`, { type: 'control', paused: true })).ok).toBe(false);
    expect((await reply(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`, { type: 'control', paused: true })).ok).toBe(true);
    expect((await reply(`ws://127.0.0.1:${PORT}/ws`, { type: 'control', paused: true, token: TOKEN })).ok).toBe(true);
  });

  it('不只听本机又没有访问密钥：拒绝启动', async () => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'server/twinServer.ts', '--port', String(PORT + 1), '--host', '0.0.0.0'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    p.stderr?.on('data', (d) => (err += String(d)));
    const code = await new Promise<number | null>((resolve) => p.on('exit', resolve));
    expect(code).toBe(1);
    expect(err).toContain('拒绝启动');
  }, 60_000);
});
