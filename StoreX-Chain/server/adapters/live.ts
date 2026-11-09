import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { adapterOf, fromTs } from './common';
import { ediComplete, ediSplit, ediWrap } from './edi';
import { csvSplit, WMS_HEADER } from './wms';

/**
 * 实时接入：外部系统把数据推给孪生服务（POST /api/ingest/tms|wms|edi、WebSocket 的 ingest 消息），
 * 或者让孪生服务盯着一个目录（--source watch:<目录>，新文件从头读、已有的文件读追加的部分）。
 * 换算和检查和读文件时是同一套接口（tms.ts、wms.ts、edi.ts）；进来的数据按数据自己的时刻交给孪生，
 * 晚到的、顺序乱的、过时的定位怎么处理见 observed.ts。
 *
 * 安全：孪生服务默认只听本机（127.0.0.1）。要让别的机器推数据，最低限度是 --ingest-token <一长串随机字符>
 * （或环境变量 STOREX_INGEST_TOKEN），推数据的请求带请求头 x-ingest-token（或 Authorization: Bearer …），
 * WebSocket 的 ingest 消息带 token 字段；最好再放到有 HTTPS 的反向代理后面，密钥不要写进网址。
 */
export const INGEST_ADAPTERS = ['tms', 'wms', 'edi'] as const;
export type IngestAdapter = (typeof INGEST_ADAPTERS)[number];
export const isIngestAdapter = (s: unknown): s is IngestAdapter => typeof s === 'string' && (INGEST_ADAPTERS as readonly string[]).includes(s);
/** 一次最多收多少字节（一整天的样例三个文件合计不到 300 KB） */
export const INGEST_LIMIT = 16 * 1024 * 1024;
/** 孪生跑的是当天 0 点到第二天 2 点：数据的时刻早于前一天 18 点、晚于第二天 2 点的不收 */
export const DAY_WINDOW: readonly [number, number] = [-6 * 3600, 26 * 3600];

/** 推一批数据的结果 */
export interface IngestResult {
  adapter: IngestAdapter;
  accepted: number;
  rejected: number;
  /** 拒掉的记录和原因（最多 20 条） */
  reasons: { at: string; reason: string }[];
  /** 孪生还没走到、排着队的数据 */
  queued: number;
  /** 收到的数据里最新的时刻（秒） */
  newest?: number;
}

/** 孪生服务这边：收不收（数据来源是 live / watch 才收）、密钥、交给数据来源 */
export interface IngestHost {
  accepting: boolean;
  mode: string;
  token: string | undefined;
  ingest(adapter: IngestAdapter, text: string): IngestResult;
}

/** 密钥对不对（没设密钥都放行）：按摘要定长比较，不因为长度、前缀不同而快慢不同 */
export function tokenOk(given: unknown, token: string | undefined): boolean {
  if (!token) return true;
  if (typeof given !== 'string' || !given) return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(token).digest());
}

/** 请求带的密钥：请求头 x-ingest-token，或者 Authorization: Bearer … */
export function tokenOf(headers: IncomingHttpHeaders): string | undefined {
  const h = headers['x-ingest-token'];
  if (typeof h === 'string') return h;
  const m = typeof headers.authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(headers.authorization.trim()) : null;
  return m?.[1];
}

/** 读请求体（UTF-8 文本）；超过上限的读完丢掉，返回 undefined */
export function readText(req: IncomingMessage, limit = INGEST_LIMIT): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= limit) chunks.push(c);
      else chunks.length = 0;
    });
    req.on('end', () => resolve(n <= limit ? Buffer.concat(chunks).toString('utf8') : undefined));
    req.on('error', reject);
  });
}

const DENIED = '密钥不对：要和孪生服务的 --ingest-token 一致（HTTP 用请求头 x-ingest-token，WebSocket 的 ingest 消息用 token 字段）';
const notLive = (mode: string) => `数据来源是 ${mode}：实时接入要用 --source live（或 live:<meta.json>）、--source watch:<目录> 启动孪生服务`;

/** POST /api/ingest/<接口>：返回状态码和回复 */
export async function handleIngest(req: IncomingMessage, adapter: string, host: IngestHost): Promise<{ code: number; body: Record<string, unknown> }> {
  if (!isIngestAdapter(adapter)) return { code: 404, body: { ok: false, error: `没有这个接口：${adapter}（tms、wms、edi）` } };
  if (!tokenOk(tokenOf(req.headers), host.token)) return { code: 401, body: { ok: false, error: DENIED } };
  if (!host.accepting) return { code: 409, body: { ok: false, error: notLive(host.mode) } };
  const text = await readText(req);
  if (text === undefined) return { code: 413, body: { ok: false, error: `一次最多 ${INGEST_LIMIT / 1024 / 1024} MB，分几次推` } };
  return { code: 200, body: { ok: true, ...host.ingest(adapter, text) } };
}

/** WebSocket 的 ingest 消息：{ type: 'ingest', adapter, data（文本，运输管理和仓储系统也可以是 JSON）, token? }；authed = 连接时请求头带了对的密钥 */
export function ingestMessage(msg: Record<string, unknown>, authed: boolean, host: IngestHost): Record<string, unknown> {
  if (!authed && !tokenOk(msg.token, host.token)) return { ok: false, error: DENIED };
  if (!host.accepting) return { ok: false, error: notLive(host.mode) };
  if (!isIngestAdapter(msg.adapter)) return { ok: false, error: `没有这个接口：${String(msg.adapter)}（tms、wms、edi）` };
  const data = msg.data;
  if (typeof data !== 'string' && (msg.adapter === 'edi' || data === undefined || data === null)) return { ok: false, error: msg.adapter === 'edi' ? '港口 EDI 要发 EDIFACT 文本' : '没有 data' };
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (Buffer.byteLength(text) > INGEST_LIMIT) return { ok: false, error: `一次最多 ${INGEST_LIMIT / 1024 / 1024} MB，分几次推` };
  return { ok: true, ...host.ingest(msg.adapter, text) };
}

// —— 盯着一个目录 ——

interface TailFile {
  adapter: IngestAdapter;
  ino: number;
  offset: number;
  dec: StringDecoder;
  /** 读进来还不完整的尾巴（半行、半个报文） */
  rest: string;
  /** 文件开头的表头（CSV）、服务字符串（EDI）：接着读的部分补上 */
  head?: string;
  /** 整个文件只读一次的（*.json 数组）读过了 */
  done?: boolean;
  chunks: number;
}

/**
 * 盯着一个目录：新出现的文件从头读，读过的文件只读追加的部分（tail）；只交出完整的记录（整行、整个 EDIFACT 报文），
 * 半行、半个报文留到下次。文件被截短或换掉了从头再读；*.json（一个数组）整个文件读一次，之后的改动不读。
 */
export class DirTail {
  private readonly files = new Map<string, TailFile>();

  constructor(readonly dir: string) {}

  /** 读一遍：每个有新内容的文件交出一批 */
  poll(): { name: string; adapter: IngestAdapter; text: string }[] {
    const out: { name: string; adapter: IngestAdapter; text: string }[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir).sort();
    } catch {
      return out;
    }
    for (const name of names) {
      const adapter = adapterOf(name);
      if (!adapter) continue;
      const path = join(this.dir, name);
      let size: number;
      let ino: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        size = st.size;
        ino = st.ino;
      } catch {
        continue;
      }
      let f = this.files.get(name);
      if (!f || f.ino !== ino || size < f.offset) {
        f = { adapter, ino, offset: 0, dec: new StringDecoder('utf8'), rest: '', chunks: 0 };
        this.files.set(name, f);
      }
      if (size === f.offset || f.done) continue;
      const buf = Buffer.alloc(size - f.offset);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, buf.length, f.offset);
      } finally {
        closeSync(fd);
      }
      f.offset = size;
      const text = f.rest + f.dec.write(buf);
      let cut: number;
      if (/\.json$/i.test(name)) {
        try {
          JSON.parse(text);
          cut = text.length;
          f.done = true;
        } catch {
          cut = 0;
        }
      } else cut = adapter === 'edi' ? ediComplete(text) : text.lastIndexOf('\n') + 1;
      f.rest = text.slice(cut);
      let chunk = text.slice(0, cut);
      if (!chunk.trim()) continue;
      const s = chunk.replace(/^﻿/, '');
      if (adapter === 'wms') {
        const first = s.split('\n', 1)[0]?.trim() ?? '';
        if (first.startsWith('ts,')) f.head = first;
        else if (f.head) chunk = `${f.head}\n${chunk}`;
      } else if (adapter === 'edi') {
        if (s.startsWith('UNA')) f.head = s.slice(0, 9);
        else if (f.head) chunk = `${f.head}\n${chunk}`;
      }
      f.chunks++;
      out.push({ name, adapter, text: chunk });
    }
    return out;
  }

  /** 每个文件读了多少字节、交出了几批 */
  list(): { name: string; adapter: IngestAdapter; bytes: number; chunks: number }[] {
    return [...this.files].map(([name, f]) => ({ name, adapter: f.adapter, bytes: f.offset - Buffer.byteLength(f.rest), chunks: f.chunks }));
  }
}

// —— 发送脚本、测试用：文件拆成带时刻的记录，再按接口拼成要推的正文 ——

export interface SendRecord {
  t: number;
  adapter: IngestAdapter;
  /** 一行 JSON、一行 CSV 或一个 EDIFACT 报文 */
  text: string;
  /** 这个文件的表头（CSV）或服务字符串（EDI） */
  head?: string;
}

const RANK: Record<IngestAdapter, number> = { tms: 0, wms: 1, edi: 2 };

/** 外部系统的文件拆成一条条带时刻的记录，按时刻排好；同一时刻运输管理在前（它登记的新车，仓储系统和港口的记录要用）。坏记录跟着前一条 */
export function splitRecords(files: readonly { name: string; text: string }[]): SendRecord[] {
  const out: (SendRecord & { k: number })[] = [];
  const push = (r: SendRecord) => out.push({ ...r, k: out.length });
  for (const f of files) {
    const adapter = adapterOf(f.name);
    let last = -Infinity;
    const at = (t: number | undefined) => (last = t ?? last);
    if (adapter === 'tms') {
      const trimmed = f.text.trim();
      let lines: string[];
      try {
        lines = trimmed.startsWith('[')
          ? (JSON.parse(trimmed) as unknown[]).map((x) => JSON.stringify(x))
          : trimmed
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith('//'));
      } catch {
        lines = [trimmed];
      }
      for (const line of lines) {
        let ts: unknown;
        try {
          ts = (JSON.parse(line) as { ts?: unknown }).ts;
        } catch {
          ts = undefined;
        }
        push({ t: at(fromTs(ts)), adapter, text: line });
      }
    } else if (adapter === 'wms') {
      let head = WMS_HEADER;
      for (const raw of f.text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/^﻿/, '').trim();
        if (!line || line.startsWith('#')) continue;
        const cells = csvSplit(line);
        if (cells[0] === 'ts') head = line;
        else push({ t: at(fromTs(cells[0]?.trim())), adapter, text: line, head });
      }
    } else if (adapter === 'edi') {
      const { una, messages } = ediSplit(f.text);
      for (const m of messages) push({ t: at(m.t), adapter, text: m.text, head: una });
    }
  }
  return out.sort((a, b) => a.t - b.t || RANK[a.adapter] - RANK[b.adapter] || a.k - b.k).map((r) => ({ t: r.t, adapter: r.adapter, text: r.text, ...(r.head !== undefined ? { head: r.head } : {}) }));
}

/** 按接口（和表头）分组，运输管理在前 */
function byAdapter(records: readonly SendRecord[]): SendRecord[][] {
  const groups = new Map<string, SendRecord[]>();
  for (const r of records) {
    const key = `${r.adapter} ${r.head ?? ''}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => RANK[(a[0] as SendRecord).adapter] - RANK[(b[0] as SendRecord).adapter]);
}

/**
 * 一批记录（按时刻排好的）拼成要推的几次正文：运输管理一行一条、仓储系统带表头的 CSV、港口一份交换文件。
 * 先按时间切成不超过 window 秒的段，每段按接口分开推（运输管理在前），前后相邻的同一个接口合成一次（最多 max 条）。
 * 这样后推的那次里最早的数据，不会比先推的那次里最晚的数据早 window 秒以上：window 不超过孪生服务允许的晚到（--lateness），
 * 孪生在两次推送之间往前走也走不过还没推的数据。
 */
export function postsOf(records: readonly SendRecord[], window = Infinity, max = Infinity): { adapter: IngestAdapter; text: string; n: number; t0: number; t1: number }[] {
  const groups: SendRecord[][] = [];
  for (let i = 0; i < records.length; ) {
    const w0 = (records[i] as SendRecord).t;
    const slice: SendRecord[] = [];
    while (i < records.length && (slice.length === 0 || (records[i] as SendRecord).t < w0 + window)) slice.push(records[i++] as SendRecord);
    for (const g of byAdapter(slice)) {
      const last = groups[groups.length - 1];
      const a = last?.[0];
      if (last && a && a.adapter === (g[0] as SendRecord).adapter && a.head === (g[0] as SendRecord).head && last.length + g.length <= max) last.push(...g);
      else groups.push(g);
    }
  }
  return groups.flatMap((g) => {
    const out: { adapter: IngestAdapter; text: string; n: number; t0: number; t1: number }[] = [];
    for (let k = 0; k < g.length; k += Math.min(g.length, max)) {
      const part = g.slice(k, k + Math.min(g.length, max));
      const { adapter, head } = part[0] as SendRecord;
      const lines = part.map((r) => r.text);
      const times = part.map((r) => r.t);
      out.push({ adapter, text: adapter === 'edi' ? ediWrap(lines, head) : adapter === 'wms' ? `${head ?? WMS_HEADER}\n${lines.join('\n')}\n` : `${lines.join('\n')}\n`, n: part.length, t0: Math.min(...times), t1: Math.max(...times) });
    }
    return out;
  });
}
