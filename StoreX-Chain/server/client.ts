import { request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

/**
 * 孪生服务的测试客户端（不依赖第三方库）：查健康、模型、此刻的状态和建议卡，用 WebSocket 收几帧，
 * 有待处理的建议卡就批准推荐的做法，最后看数据来源和各个接口的统计。用法：npx tsx server/client.ts [端口]
 * 孪生服务设了令牌时（--token），把同一个令牌放进环境变量 STOREX_TOKEN，客户端会带上它。
 */
const PORT = Number(process.argv[2] ?? 8787);
const HOST = '127.0.0.1';
const TOKEN = process.env.STOREX_TOKEN;
const AUTH: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

function http(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: HOST, port: PORT, method, path, headers: { ...AUTH, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 最小的 WebSocket 客户端：握手、收文本帧（服务端不加掩码），发带掩码的文本帧 */
function ws(path: string, onText: (t: string) => void): Promise<{ send: (o: unknown) => void; close: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, HOST);
    const key = randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let open = false;
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${TOKEN ? `Authorization: Bearer ${TOKEN}\r\n` : ''}\r\n`));
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        const want = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (!head.includes('101') || !head.includes(want)) return reject(new Error(`握手失败：${head}`));
        open = true;
        buf = buf.subarray(end + 4);
        resolve({
          send: (o) => {
            const p = Buffer.from(JSON.stringify(o));
            const mask = randomBytes(4);
            const head2 = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
            const body = Buffer.from(p.map((b, i) => b ^ (mask[i % 4] as number)));
            sock.write(Buffer.concat([head2, mask, body]));
          },
          close: () => sock.end(),
        });
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = (buf[1] as number) & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        if (((buf[0] as number) & 0x0f) === 1) onText(buf.subarray(off, off + len).toString());
        buf = buf.subarray(off + len);
      }
    });
  });
}

const health = (await http('GET', '/api/health')) as { clock: string };
console.log('健康：', JSON.stringify(health));
const model = (await http('GET', '/api/model')) as { store?: { name: string; docks: unknown[] }; coordinates: { unreal: string }; vehicles?: unknown[] };
console.log('模型：门店', model.store?.name, '收货口', model.store?.docks.length, '· 车辆', model.vehicles?.length, '· 虚幻引擎坐标', model.coordinates.unreal);
const st = (await http('GET', '/api/state')) as { clock: string; vehicles: { id: string; x: number; z: number; heading: number; delayMin: number; act: string }[]; kpi: unknown };
console.log('状态：', st.clock, '路上', st.vehicles.length, '辆 · 例如', JSON.stringify(st.vehicles[0]), '· 指标', JSON.stringify(st.kpi));
let ticks = 0;
let hello = false;
const conn = await ws('/ws', (text) => {
  const m = JSON.parse(text) as { type: string; clock?: string; vehicles?: unknown[]; msgs?: unknown[]; cards?: { title: string; status: string }[]; ok?: boolean; error?: string };
  if (m.type === 'hello') hello = true;
  if (m.type === 'tick') ticks++;
  if (m.type === 'tick' && ticks <= 3) console.log('WebSocket tick', m.clock, '车辆', m.vehicles?.length);
  if (m.type === 'msgs') console.log('WebSocket 数据', m.msgs?.length, '条');
  if (m.type === 'cards') console.log('WebSocket 建议卡', m.cards?.map((c) => `${c.title}（${c.status}）`).join('；'));
  if (m.type === 'reply') console.log('WebSocket 回复', JSON.stringify(m));
});
await new Promise((r) => setTimeout(r, 2500));
const cards = (await http('GET', '/api/recommendations')) as { key: string; title: string; status: string; best?: string; options: { key: string; hasCommands: boolean }[] }[];
const open = cards.find((c) => c.status === 'proposed' && c.options.some((o) => o.hasCommands));
console.log('建议卡', cards.length, '张，待处理', cards.filter((c) => c.status === 'proposed').length, '张');
if (open) {
  const opt = open.options.find((o) => o.key === open.best && o.hasCommands) ?? open.options.find((o) => o.hasCommands);
  conn.send({ type: 'approve', key: open.key, option: opt?.key });
  await new Promise((r) => setTimeout(r, 600));
}
const after = (await http('GET', '/api/messages?since=0&limit=5')) as { total: number };
console.log('现场共发出', after.total, '条数据');
const ad = (await http('GET', '/api/adapters')) as { source: { mode: string }; adapters: { name: string; accepted: number; rejected: number; sent: number }[]; outbox: number };
console.log('数据来源', ad.source.mode, '· 接口', ad.adapters.map((a) => `${a.name} 收 ${a.accepted} 拒 ${a.rejected} 发 ${a.sent}`).join('，'), '· 发件箱', ad.outbox, '条');
conn.close();
console.log(hello && ticks > 0 ? '通过：REST 和 WebSocket 都通' : '没收到 WebSocket 数据');
process.exit(hello && ticks > 0 ? 0 : 1);
