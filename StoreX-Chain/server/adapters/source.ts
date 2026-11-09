import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Board } from '../../src/sim/board';
import type { Loop } from '../../src/twin/loop';
import type { Cmd } from '../../src/twin/types';
import { adapterOf, AdapterStats, GEO, toTs, type AdapterName, type FeedItem, type GeoOrigin, type Parsed, type Refs, type VehicleReg } from './common';
import { parseEdi, type BoxRow } from './edi';
import { DAY_WINDOW, DirTail, type IngestAdapter, type IngestResult } from './live';
import { ObservedField, swapField } from './observed';
import { Outbox } from './outbox';
import { loadRecording, recordToFile, type RecordMeta, type Recorder, type Recording } from './recording';
import { parseTms } from './tms';
import { parseWms } from './wms';

/**
 * 孪生服务的数据从哪来：
 * - sim（默认）：服务里模拟的现场，和以前完全一样；
 * - replay:<文件>：一份记录（--record 写的）；
 * - feed:<目录>：外部系统的文件（运输管理 tms*.jsonl、仓储和门店 *.csv、港口 *.edi），经过各自的接口转成感知数据；
 * - live（或 live:<meta.json>，写对应的计划）：外部系统实时推数据（POST /api/ingest/…、WebSocket 的 ingest）；
 * - watch:<目录>：盯着一个目录，新文件从头读、已有的文件读追加的部分（目录里的 meta.json 写对应的计划）。
 * live、watch 时孪生按收到的数据的时刻走（不跑到数据前面，见 ready）。
 * 另外：--record <文件> 把孪生收到的数据记下来（任何来源都可以记）；--outbox <文件> 把换算好的外部指令写出去。
 */
export type SourceSpec = { mode: 'sim' } | { mode: 'replay'; file: string } | { mode: 'feed'; dir: string } | { mode: 'live'; meta?: string } | { mode: 'watch'; dir: string };

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
export function parseSource(s: string | undefined): SourceSpec | { error: string } {
  if (!s || s === 'sim') return { mode: 'sim' };
  if (s.startsWith('replay:')) {
    const file = s.slice(7);
    return existsSync(file) ? { mode: 'replay', file } : { error: `找不到记录文件 ${file}` };
  }
  if (s.startsWith('feed:')) {
    const dir = s.slice(5);
    return isDir(dir) ? { mode: 'feed', dir } : { error: `找不到目录 ${dir}` };
  }
  if (s === 'live') return { mode: 'live' };
  if (s.startsWith('live:')) {
    const meta = s.slice(5);
    return existsSync(meta) && statSync(meta).isFile() ? { mode: 'live', meta } : { error: `找不到计划文件 ${meta}` };
  }
  if (s.startsWith('watch:')) {
    const dir = s.slice(6);
    return isDir(dir) ? { mode: 'watch', dir } : { error: `找不到目录 ${dir}` };
  }
  return { error: `不认识的数据来源 ${s}（sim、replay:<文件>、feed:<目录>、live、live:<meta.json>、watch:<目录>）` };
}

/** 外部系统文件的目录：哪个文件走哪个接口 */
export interface LoadedFeed {
  items: FeedItem[];
  vehicles: VehicleReg[];
  files: { name: string; adapter: AdapterName; accepted: number; rejected: number }[];
  parsed: { adapter: AdapterName; result: Parsed }[];
}

/** 计划文件（meta.json）：这些数据对应的计划（方案、种子、区域、负荷……），读不了是 undefined */
export function readMeta(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 目录里的 meta.json */
export const feedMeta = (dir: string): Record<string, unknown> | undefined => readMeta(join(dir, 'meta.json'));

export { adapterOf };

/** 一份外部系统的数据走对应的接口 */
export function parseAs(a: 'tms' | 'wms' | 'edi', text: string, refs: Refs, geo: GeoOrigin = GEO): Parsed {
  return a === 'tms' ? parseTms(text, refs, geo) : a === 'wms' ? parseWms(text, refs) : parseEdi(text, refs);
}

export function loadFeed(files: { name: string; text: string }[], refs: Refs, geo: GeoOrigin = GEO): LoadedFeed {
  const out: LoadedFeed = { items: [], vehicles: [], files: [], parsed: [] };
  // 运输管理先读：它登记的新行程（救援车、追加补货车）别的接口可能用到
  const order: AdapterName[] = ['tms', 'wms', 'edi'];
  const typed = files.flatMap((f) => {
    const a = adapterOf(f.name);
    return a ? [{ ...f, a }] : [];
  });
  for (const a of order)
    for (const f of typed.filter((x) => x.a === a)) {
      const r = parseAs(f.a, f.text, refs, geo);
      out.parsed.push({ adapter: a, result: r });
      out.items.push(...r.items);
      out.vehicles.push(...r.vehicles);
      out.files.push({ name: f.name, adapter: a, accepted: r.items.length + r.vehicles.length, rejected: r.rejected.length });
    }
  // 按数据自己的时刻排（同一时刻保持文件里的先后）
  out.items = out.items.map((x, i) => ({ x, i })).sort((p, q) => p.x.m.t - q.x.m.t || p.i - q.i).map((p) => p.x);
  return out;
}

export function loadFeedDir(dir: string, refs: Refs, geo: GeoOrigin = GEO): LoadedFeed {
  const files = readdirSync(dir)
    .filter((n) => adapterOf(n) && statSync(join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8') }));
  return loadFeed(files, refs, geo);
}

/** 孪生执行的做法多花的钱（给「看到的现场」的累计结果）：按建议卡里推演的；接口直接发的指令按常见的价 */
const DEFAULT_COST: Partial<Record<Cmd['kind'], number>> = { notifyStore: 25, rescue: 238, restock: 200, divert: 40 };
export function costOf(loop: Loop, c: Cmd): number {
  const same = (x: Cmd) => x.kind === c.kind && ('vid' in x ? 'vid' in c && x.vid === c.vid : true) && ('fam' in x ? 'fam' in c && x.fam === c.fam : true) && ('store' in x ? 'store' in c && x.store === c.store : true);
  for (const r of loop.cards()) {
    if (r.doneAt !== c.t || r.status !== 'done') continue;
    const o = r.options.find((x) => x.key === r.chosen);
    if (o?.cmds.some(same)) return o.cmds.length > 1 ? o.cost / o.cmds.length : o.cost;
  }
  return DEFAULT_COST[c.kind] ?? 0;
}

export interface SourceOptions {
  spec: SourceSpec;
  loop: Loop;
  board: Board;
  refs: Refs;
  recording?: Recording;
  feed?: LoadedFeed;
  recordPath?: string;
  outboxPath?: string;
  /** live、watch：允许数据晚到多少秒（孪生最多走到收到的最新数据的时刻减去它），默认 60 */
  lateness?: number;
  geo?: GeoOrigin;
  meta: Omit<RecordMeta, 'type' | 'version' | 'created'>;
}

export class DataSource {
  readonly stats = new Map<AdapterName, AdapterStats>();
  readonly outbox: Outbox;
  private recorder: Recorder | undefined;
  private closeRec: (() => Promise<void>) | undefined;
  private outFile: ReturnType<typeof createWriteStream> | undefined;
  private observed: ObservedField | undefined;
  private seen = 0;
  private readonly tail: DirTail | undefined;
  /** watch：每个文件收了几条、拒了几条 */
  private readonly perFile = new Map<string, { accepted: number; rejected: number }>();

  constructor(private readonly o: SourceOptions) {
    const names: AdapterName[] = o.spec.mode === 'sim' ? ['sim', 'tms', 'wms'] : o.spec.mode === 'replay' ? ['replay', 'tms', 'wms'] : ['tms', 'wms', 'edi'];
    for (const n of names) this.stats.set(n, new AdapterStats(n));
    if (o.outboxPath) this.outFile = createWriteStream(o.outboxPath, { flags: 'a' });
    this.outbox = new Outbox(o.refs, this.stats, this.outFile ? (line) => this.outFile?.write(`${line}\n`) : undefined);
    if (o.spec.mode === 'watch') this.tail = new DirTail(o.spec.dir);
    // 读文件时拒掉的记录
    if (o.recording) {
      const st = this.stats.get('replay') as AdapterStats;
      st.accepted = o.recording.msgs;
      for (const r of o.recording.rejected) st.reject(r.reason);
    }
    for (const p of o.feed?.parsed ?? []) {
      const st = this.stats.get(p.adapter) as AdapterStats;
      st.accepted += p.result.items.length + p.result.vehicles.length;
      for (const r of p.result.rejected) st.reject(r.reason);
    }
  }

  /** 数据来源收不收实时推来的数据（live、watch 收） */
  get accepting(): boolean {
    return this.o.spec.mode === 'live' || this.o.spec.mode === 'watch';
  }

  /** 在快进之前调：数据不是服务里模拟的时换掉闭环里模拟的现场；要记录的开始记；盯着目录的先把已有的文件读进来 */
  start(): void {
    const { loop, spec } = this.o;
    if (spec.mode !== 'sim') {
      const feed = spec.mode === 'replay' ? { steps: this.o.recording?.steps ?? new Map(), vehicles: this.o.recording?.vehicles ?? [] } : { items: this.o.feed?.items ?? [], vehicles: this.o.feed?.vehicles ?? [] };
      this.observed = new ObservedField(loop.field, feed, this.o.board, (c) => costOf(loop, c), this.stats);
      swapField(loop, this.observed);
    }
    if (this.o.recordPath) {
      const r = recordToFile(this.o.recordPath);
      this.recorder = r.rec;
      this.closeRec = r.close;
      this.recorder.attach(loop, this.o.meta);
    }
    this.poll();
  }

  /**
   * 实时推来的一批：走对应的接口转成感知数据（坏记录跳过并记下原因，时刻不在孪生这一天的不收），
   * 交给「看到的现场」按数据的时刻排队。
   */
  ingest(adapter: IngestAdapter, text: string): IngestResult {
    const st = this.stats.get(adapter) as AdapterStats;
    const r = parseAs(adapter, text, this.o.refs, this.o.geo);
    const inDay = (t: number) => t >= DAY_WINDOW[0] && t <= DAY_WINDOW[1];
    const outside = '时刻不在孪生的这一天（当天 0 点到第二天 2 点，最早收前一天 18 点的）';
    const items: FeedItem[] = [];
    const vehicles: VehicleReg[] = [];
    for (const x of r.items)
      if (inDay(x.m.t)) items.push(x);
      else r.rejected.push({ at: `${x.m.kind} ${toTs(x.m.t)}`, reason: outside });
    for (const x of r.vehicles)
      if (inDay(x.eff)) vehicles.push(x);
      else r.rejected.push({ at: `新行程 ${x.ref ?? x.vid}`, reason: outside });
    st.accepted += items.length + vehicles.length;
    for (const x of r.rejected) st.reject(x.reason);
    this.observed?.ingest(items, vehicles);
    return { adapter, accepted: items.length + vehicles.length, rejected: r.rejected.length, reasons: r.rejected.slice(0, 20), queued: this.observed?.queued ?? 0, ...(this.observed && Number.isFinite(this.observed.newest) ? { newest: this.observed.newest } : {}) };
  }

  /** watch：读一遍目录（新文件、追加的部分） */
  poll(): void {
    if (!this.tail || !this.observed) return;
    for (const c of this.tail.poll()) {
      const r = this.ingest(c.adapter, c.text);
      const f = this.perFile.get(c.name) ?? { accepted: 0, rejected: 0 };
      f.accepted += r.accepted;
      f.rejected += r.rejected;
      this.perFile.set(c.name, f);
    }
  }

  /** 孪生能不能走完到 t1 的这一步：live、watch 不跑到数据前面（收到的最新数据的时刻减去允许的晚到），别的来源随便走 */
  ready(t1: number): boolean {
    if (!this.accepting) return true;
    return t1 <= (this.observed?.newest ?? -Infinity) - (this.o.lateness ?? 60);
  }

  /** 本店的箱在港口的状态（数据来自外部系统、接了港口 EDI 才有） */
  containers(): BoxRow[] {
    return this.observed?.boxes.rows() ?? [];
  }

  /** 每走一步以后 */
  afterStep(): void {
    const { loop } = this.o;
    this.observed?.sync(loop.t);
    if (this.o.spec.mode === 'sim') {
      const st = this.stats.get('sim') as AdapterStats;
      const msgs = loop.field.msgs;
      for (; this.seen < msgs.length; this.seen++) {
        st.accepted++;
        st.ingested(msgs[this.seen] as (typeof msgs)[number], loop.t);
      }
    }
    this.recorder?.check(loop);
    this.outbox.sync(loop.cmds);
  }

  /** 调度员批准 / 否决、外部直接发指令以后 */
  afterCommand(): void {
    this.recorder?.check(this.o.loop);
    this.outbox.sync(this.o.loop.cmds);
  }

  info(): Record<string, unknown> {
    const { spec } = this.o;
    const live = () => ({ queued: this.observed?.queued ?? 0, ...(Number.isFinite(this.observed?.newest) ? { newest: this.observed?.newest } : {}), lateness: this.o.lateness ?? 60 });
    const base =
      spec.mode === 'sim'
        ? { mode: 'sim', label: '服务里模拟的现场' }
        : spec.mode === 'replay'
          ? { mode: 'replay', label: '回放一份记录（现实就是记录，孪生的指令改变不了它）', file: basename(spec.file), messages: this.o.recording?.msgs ?? 0, vehicles: this.o.recording?.vehicles.length ?? 0 }
          : spec.mode === 'feed'
            ? { mode: 'feed', label: '外部系统的数据（运输管理、仓储和门店、港口）', dir: basename(spec.dir), files: this.o.feed?.files ?? [] }
            : spec.mode === 'live'
              ? { mode: 'live', label: '外部系统实时推数据（POST /api/ingest/tms|wms|edi、WebSocket 的 ingest）', ...(spec.meta ? { meta: basename(spec.meta) } : {}), ...live() }
              : { mode: 'watch', label: '盯着一个目录（新文件从头读、已有的文件读追加的部分）', dir: basename(spec.dir), files: (this.tail?.list() ?? []).map((f) => ({ ...f, ...(this.perFile.get(f.name) ?? { accepted: 0, rejected: 0 }) })), ...live() };
    return { ...base, ...(this.o.recordPath ? { recording: basename(this.o.recordPath), lines: this.recorder?.lines ?? 0 } : {}) };
  }

  adapters(clock: (t: number) => string): Record<string, unknown> {
    return { source: this.info(), adapters: [...this.stats.values()].map((s) => s.json(clock)), outbox: this.outbox.list.length };
  }

  async close(): Promise<void> {
    await this.closeRec?.();
    await new Promise<void>((resolve) => (this.outFile ? this.outFile.end(resolve) : resolve()));
  }
}

export { loadRecording };
