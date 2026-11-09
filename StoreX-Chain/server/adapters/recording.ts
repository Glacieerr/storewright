import { createWriteStream, readFileSync } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
import type { WVehicle } from '../../src/sim/trace';
import type { Loop } from '../../src/twin/loop';
import type { Cmd, Msg } from '../../src/twin/types';
import type { FeedItem, VehicleReg } from './common';

/**
 * 记录和回放：把孪生收到的每一条现场数据（按它在哪一步收到）、新出现或改了计划的车、发出的指令写成 JSON Lines，
 * 以后用 --source replay:<文件> 让孪生在这份记录上再跑一遍（现实就是这份记录，孪生的指令改变不了它）。
 *
 * 一行一条：
 * - {"type":"meta", ...}：方案、种子、现场状况、自动执行范围、区域、负荷、哪一天（回放时用它建同一份计划）；
 * - {"type":"msg","step":秒,"msg":{…}}：孪生在哪一步（那一步开始的时刻）收到的哪条数据，按收到的先后；
 * - {"type":"vehicle","eff":秒,"vid":…,"v":{…},"extra"?:{…},"replan"?:true}：救援车、追加补货车、改了计划的车，从哪一步起生效；
 * - {"type":"cmd","cmd":{…}}：孪生发出的指令（只做参考，回放时不当作现实）。
 * 文件名以 .gz 结尾就压缩。
 */
export interface RecordMeta {
  type: 'meta';
  version: 1;
  gen: string;
  seed: number;
  level: string;
  policy: string;
  region: string;
  load: string;
  day: number;
  created: string;
}
export type RecordLine = RecordMeta | { type: 'msg'; step: number; msg: Msg } | { type: 'vehicle'; eff: number; vid: number; v: WVehicle; extra?: VehicleReg['extra']; replan?: true } | { type: 'cmd'; cmd: Cmd };

export class Recorder {
  private seen = new Map<number, WVehicle>();
  private cmdN = 0;
  lines = 0;

  constructor(private readonly sink: (line: string) => void) {}

  private write(x: RecordLine): void {
    this.sink(JSON.stringify(x));
    this.lines++;
  }

  /** 开始记：写表头，接管孪生收数据的入口（原样转给孪生，只多记一笔），记下现在有哪些车（created 默认是现在） */
  attach(loop: Loop, meta: Omit<RecordMeta, 'type' | 'version' | 'created'>, created = new Date().toISOString()): void {
    this.write({ type: 'meta', version: 1, ...meta, created });
    const twin = loop.twin;
    const ingest = twin.ingest.bind(twin);
    twin.ingest = (m: Msg) => {
      this.write({ type: 'msg', step: loop.t, msg: m });
      ingest(m);
    };
    this.seen = new Map(loop.field.fv.map((f) => [f.vid, f.v]));
    this.cmdN = loop.cmds.length;
  }

  /** 每走一步、每执行一条指令以后：记下新出现或改了计划的车（从下一步起生效）、新发出的指令 */
  check(loop: Loop): void {
    for (const f of loop.field.fv) {
      const prev = this.seen.get(f.vid);
      if (prev === f.v) continue;
      this.seen.set(f.vid, f.v);
      this.write({ type: 'vehicle', eff: loop.t, vid: f.vid, v: f.v, ...(f.extra ? { extra: { ...f.extra } } : {}), ...(prev ? { replan: true as const } : {}) });
    }
    for (; this.cmdN < loop.cmds.length; this.cmdN++) this.write({ type: 'cmd', cmd: loop.cmds[this.cmdN] as Cmd });
  }
}

/** 写到文件（.gz 结尾的压缩）：返回记录器和关闭（把缓冲写完）的方法 */
export function recordToFile(path: string): { rec: Recorder; close: () => Promise<void> } {
  const file = createWriteStream(path);
  const gz = path.endsWith('.gz') ? createGzip() : undefined;
  if (gz) gz.pipe(file);
  const out = gz ?? file;
  const rec = new Recorder((line) => out.write(`${line}\n`));
  return {
    rec,
    close: () =>
      new Promise((resolve) => {
        file.on('close', () => resolve());
        out.end();
      }),
  };
}

export interface Recording {
  meta?: RecordMeta;
  /** 步 → 这一步孪生收到的数据（按收到的先后） */
  steps: Map<number, FeedItem[]>;
  vehicles: VehicleReg[];
  cmds: Cmd[];
  msgs: number;
  rejected: { at: string; reason: string }[];
}

/** 读一份记录（坏行跳过并记下原因） */
export function readRecording(text: string): Recording {
  const rec: Recording = { steps: new Map(), vehicles: [], cmds: [], msgs: 0, rejected: [] };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = `第 ${i + 1} 行`;
    let x: RecordLine;
    try {
      x = JSON.parse(line) as RecordLine;
    } catch {
      rec.rejected.push({ at, reason: '不是合法的 JSON' });
      return;
    }
    if (x.type === 'meta') rec.meta = x;
    else if (x.type === 'msg' && Number.isFinite(x.step) && x.msg && typeof x.msg === 'object' && Number.isFinite(x.msg.t)) {
      const list = rec.steps.get(x.step) ?? [];
      list.push({ m: x.msg, src: 'replay' });
      rec.steps.set(x.step, list);
      rec.msgs++;
    } else if (x.type === 'vehicle' && Number.isFinite(x.eff) && Number.isInteger(x.vid) && Array.isArray(x.v?.segs)) rec.vehicles.push({ eff: x.eff, vid: x.vid, v: x.v, ...(x.extra ? { extra: x.extra } : {}), ...(x.replan ? { replan: true } : {}) });
    else if (x.type === 'cmd' && x.cmd) rec.cmds.push(x.cmd);
    else rec.rejected.push({ at, reason: '不认识或不完整的记录' });
  });
  return rec;
}

/** 读记录文件（.gz 的先解压） */
export function loadRecording(path: string): Recording {
  const buf = readFileSync(path);
  return readRecording((path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}
