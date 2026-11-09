import type { Board } from '../../src/sim/board';
import type { Msg } from '../../src/twin/types';
import { toTs, type Parsed, type Refs } from './common';

/**
 * 港口电子数据交换（EDI）的接口：按 UN/EDIFACT 的语法（段、元素、成分、转义字符）读写本店集装箱在港口的事件。
 *
 * 这是一个简化的子集：报文类型、段的用法和代码是本项目的约定，不是任何码头、船公司的实施指南。
 * - CODECO（闸口报告）：BGM 34 = 进闸，36 = 出闸；
 * - COARRI（装卸报告）：BGM 44 = 卸船，45 = 装车（装上班列或拖车）；
 * - IFTSTA（状态报告）：STS 的代码 CR = 海关放行，HD = 海关查验；
 * - 每个报文：UNH、BGM、DTM+137（报文时间）、TDT（运输方式 1 海运 / 2 铁路 / 3 公路，最后一个元素是车船编号）、LOC+165（地点）、
 *   每个箱一组 EQD（箱号、尺寸类型、5 = 重箱 / 4 = 空箱）+ DTM+203（事件时间，格式 204：年月日时分秒）+ STS（只有 IFTSTA）、CNT、UNT（段数）。
 * 进来的事件转成孪生的车载终端事件（地点 PORT，备注写事件和箱号）：进闸 → arrive，出闸 → leave，卸船、装车 → done，
 * 海关放行、查验 → done（不对应车辆，vid = −1）。孪生的估计不按箱算；「看到的现场」按箱号记下每个箱现在的状态
 * （ContainerBook：卸船、海关查验 / 放行、装车、出闸），孪生服务的 /api/containers 和值班助手的港口回答用它。
 */
export type PortEventCode = 'GATE_IN' | 'GATE_OUT' | 'DISCHARGE' | 'LOAD' | 'RELEASED' | 'HOLD';
export interface PortEvent {
  t: number;
  code: PortEventCode;
  container: string;
  sizeType: string;
  full: boolean;
  /** 车船编号（作业编号：VS1、拖车、班列）；海关的事件没有 */
  vehicleRef?: string;
  location: string;
}

const NOTE: Record<PortEventCode, string> = { GATE_IN: '进闸', GATE_OUT: '出闸', DISCHARGE: '卸船', LOAD: '装车', RELEASED: '海关放行', HOLD: '海关查验' };
const EV: Record<PortEventCode, 'arrive' | 'leave' | 'done'> = { GATE_IN: 'arrive', GATE_OUT: 'leave', DISCHARGE: 'done', LOAD: 'done', RELEASED: 'done', HOLD: 'done' };
const MSG_OF: Record<PortEventCode, { type: 'CODECO' | 'COARRI' | 'IFTSTA'; bgm: string; sts?: string }> = {
  GATE_IN: { type: 'CODECO', bgm: '34' },
  GATE_OUT: { type: 'CODECO', bgm: '36' },
  DISCHARGE: { type: 'COARRI', bgm: '44' },
  LOAD: { type: 'COARRI', bgm: '45' },
  RELEASED: { type: 'IFTSTA', bgm: '23', sts: 'CR' },
  HOLD: { type: 'IFTSTA', bgm: '23', sts: 'HD' },
};

// —— 箱号：ISO 6346（箱主代码 3 个字母 + U + 6 位序号 + 校验位） ——
const LETTER: Record<string, number> = {};
{
  let v = 10;
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    LETTER[c] = v++;
  }
}
export function checkDigit(id10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = id10[i] as string;
    sum += (/\d/.test(c) ? Number(c) : (LETTER[c] ?? 0)) * 2 ** i;
  }
  return (sum % 11) % 10;
}
/** 合成的箱号：箱主代码 SXC（本项目自用，不对应真实箱主） */
export function containerId(serial: number, owner = 'SXC'): string {
  const id10 = `${owner}U${String(serial % 1_000_000).padStart(6, '0')}`;
  return `${id10}${checkDigit(id10)}`;
}
export const validContainer = (id: string): boolean => /^[A-Z]{3}[UJZ]\d{7}$/.test(id) && checkDigit(id.slice(0, 10)) === Number(id[10]);

// —— 事件 ⇄ 孪生的感知数据 ——
export function portEventToMsg(e: PortEvent, refs: Refs): Msg {
  const vid = e.vehicleRef ? (refs.vid(e.vehicleRef) ?? -1) : -1;
  return { kind: 'event', t: e.t, vid, ev: EV[e.code], place: e.location, note: `${NOTE[e.code]} ${e.container}` };
}
const NOTE_RE = /^(进闸|出闸|卸船|装车|海关放行|海关查验) ([A-Z]{4}\d{7})$/;
export function msgToPortEvent(m: Msg, refs: Refs): PortEvent | undefined {
  if (m.kind !== 'event' || !m.note) return undefined;
  const x = NOTE_RE.exec(m.note);
  if (!x) return undefined;
  const code = (Object.keys(NOTE) as PortEventCode[]).find((k) => NOTE[k] === x[1]) as PortEventCode;
  return { t: m.t, code, container: x[2] as string, sizeType: '45G1', full: true, ...(m.vid >= 0 ? { vehicleRef: refs.ref(m.vid) } : {}), location: m.place ?? 'PORT' };
}

// —— 写 EDIFACT ——
const esc = (s: string) => s.replace(/([?+:'])/g, '?$1');
/** 年月日时分秒（DTM 格式 204） */
const dt204 = (t: number) => toTs(Math.round(t)).replace(/[-:T]/g, '').slice(0, 14);
const mode = (ref: string | undefined) => (ref?.startsWith('VS') ? '1' : ref?.startsWith('RL') || ref?.startsWith('TR') ? '2' : '3');

export function ediFromEvents(events: readonly PortEvent[], sender = 'PORTTERM', recipient = 'STOREX'): string {
  const segs: string[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const ref = 'IC0001';
  segs.push(`UNB+UNOC:3+${esc(sender)}+${esc(recipient)}+${dt204(sorted[0]?.t ?? 0).slice(2, 8)}:${dt204(sorted[0]?.t ?? 0).slice(8, 12)}+${ref}`);
  sorted.forEach((e, k) => {
    const m = MSG_OF[e.code];
    const body = [
      `UNH+${k + 1}+${m.type}:D:95B:UN`,
      `BGM+${m.bgm}+${m.type.slice(0, 2)}${String(k + 1).padStart(5, '0')}+9`,
      `DTM+137:${dt204(e.t)}:204`,
      ...(e.vehicleRef ? [`TDT+20++${mode(e.vehicleRef)}+++++${esc(e.vehicleRef)}`] : []),
      `LOC+165+${esc(e.location)}`,
      `EQD+CN+${e.container}+${e.sizeType}:102:5+++${e.full ? '5' : '4'}`,
      `DTM+203:${dt204(e.t)}:204`,
      ...(m.sts ? [`STS+1+${m.sts}`] : []),
      'CNT+16:1',
    ];
    segs.push(...body, `UNT+${body.length + 1}+${k + 1}`);
  });
  segs.push(`UNZ+${sorted.length}+${ref}`);
  // UNA（服务字符串）自己带段结束符，后面直接跟 UNB
  return `UNA:+.? '\n${segs.join("'\n")}'\n`;
}

// —— 读 EDIFACT ——
/** 按分隔符切开（释放字符后面的分隔符算普通字符） */
function split(s: string, sep: string, rel: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === rel && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
/** 只切段和元素，成分在元素里再切（保留释放字符给下一层） */
function splitKeep(s: string, sep: string, rel: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === rel && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
const fromDt204 = (s: string | undefined): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?$/.exec(s ?? '');
  if (!m) return undefined;
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) - Date.UTC(2030, 2, 28)) / 1000;
};

/** 按 UNA 取分隔符（没有 UNA 用默认的），返回服务字符串和去掉它的正文 */
function separators(text: string): { comp: string; elem: string; rel: string; term: string; una: string; body: string } {
  const s = text.replace(/^﻿/, '');
  if (s.startsWith('UNA')) return { comp: s[3] as string, elem: s[4] as string, rel: s[6] as string, term: s[8] as string, una: s.slice(0, 9), body: s.slice(9) };
  return { comp: ':', elem: '+', rel: '?', term: "'", una: "UNA:+.? '", body: s };
}

/** 解析一份交换文件：返回孪生的感知数据和事件；坏报文跳过并记下原因 */
export function parseEdi(text: string, refs: Refs): Parsed & { events: PortEvent[] } {
  const out: Parsed & { events: PortEvent[] } = { items: [], vehicles: [], rejected: [], events: [] };
  const { comp, elem, rel, term, body } = separators(text);
  const segs = splitKeep(body, term, rel)
    .map((s) => s.replace(/^[\r\n\t ]+/, ''))
    .filter((s) => s.length);
  let msg: { n: number; type: string; bgm?: string; tdt?: string; loc?: string; start: number; eqd: { container: string; sizeType: string; full: boolean; t?: number; sts?: string }[]; t?: number } | undefined;
  let segIndex = 0;
  for (const raw of segs) {
    const el = splitKeep(raw, elem, rel);
    const tag = el[0] as string;
    const c = (i: number) => split(el[i] ?? '', comp, rel);
    segIndex++;
    if (tag === 'UNB' || tag === 'UNZ') continue;
    if (tag === 'UNH') {
      msg = { n: segIndex, type: c(2)[0] ?? '', start: segIndex, eqd: [] };
      continue;
    }
    if (!msg) {
      out.rejected.push({ at: `段 ${segIndex}`, reason: `报文外面的段 ${tag}` });
      continue;
    }
    switch (tag) {
      case 'BGM':
        msg.bgm = c(1)[0];
        break;
      case 'DTM': {
        const [q, v] = c(1);
        const t = fromDt204(v);
        if (q === '137') msg.t = t;
        else if (q === '203' && msg.eqd.length) (msg.eqd[msg.eqd.length - 1] as (typeof msg.eqd)[number]).t = t;
        break;
      }
      case 'TDT':
        msg.tdt = split(el[el.length - 1] ?? '', comp, rel)[0];
        break;
      case 'LOC':
        msg.loc = c(2)[0];
        break;
      case 'EQD':
        msg.eqd.push({ container: c(2)[0] ?? '', sizeType: c(3)[0] ?? '', full: (c(6)[0] ?? '5') !== '4' });
        break;
      case 'STS':
        if (msg.eqd.length) (msg.eqd[msg.eqd.length - 1] as (typeof msg.eqd)[number]).sts = c(2)[0];
        break;
      case 'UNT': {
        const m = msg;
        msg = undefined;
        const at = `报文 ${c(2)[0] ?? '?'}（${m.type}）`;
        const count = segIndex - m.start + 1;
        if (Number(c(1)[0]) !== count) {
          out.rejected.push({ at, reason: '段数和 UNT 写的不符' });
          break;
        }
        if (!['CODECO', 'COARRI', 'IFTSTA'].includes(m.type)) {
          out.rejected.push({ at, reason: `不支持的报文类型 ${m.type}` });
          break;
        }
        if (!m.eqd.length) {
          out.rejected.push({ at, reason: '没有箱（EQD）' });
          break;
        }
        for (const q of m.eqd) {
          const t = q.t ?? m.t;
          const code: PortEventCode | undefined =
            m.type === 'CODECO' ? (m.bgm === '34' ? 'GATE_IN' : m.bgm === '36' ? 'GATE_OUT' : undefined) : m.type === 'COARRI' ? (m.bgm === '44' ? 'DISCHARGE' : m.bgm === '45' ? 'LOAD' : undefined) : q.sts === 'CR' ? 'RELEASED' : q.sts === 'HD' ? 'HOLD' : undefined;
          if (!code) out.rejected.push({ at, reason: '不认识的事件代码（BGM / STS）' });
          else if (t === undefined) out.rejected.push({ at, reason: '没有事件时间（DTM）' });
          else if (!validContainer(q.container)) out.rejected.push({ at, reason: `箱号校验位不对：${q.container}` });
          else {
            const e: PortEvent = { t, code, container: q.container, sizeType: q.sizeType || '45G1', full: q.full, ...(m.tdt ? { vehicleRef: m.tdt } : {}), location: m.loc || 'PORT' };
            out.events.push(e);
            out.items.push({ m: portEventToMsg(e, refs), src: 'edi' });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  if (msg) out.rejected.push({ at: `报文（${msg.type}）`, reason: '缺少 UNT（文件不完整）' });
  return out;
}

// —— 实时接入：交换文件拆成报文、报文拼回交换文件、追加写的文件读到哪里算完整 ——

/** 一份交换文件拆成一个个报文（UNH…UNT）和报文的时刻（DTM+137，没有就用第一个 DTM+203）：发送脚本按时刻一条条发 */
export function ediSplit(text: string): { una: string; messages: { t: number | undefined; text: string }[] } {
  const { comp, elem, rel, term, una, body } = separators(text);
  const messages: { t: number | undefined; text: string }[] = [];
  let cur: string[] | undefined;
  let t137: number | undefined;
  let t203: number | undefined;
  for (const raw of splitKeep(body, term, rel)) {
    const s = raw.replace(/^[\r\n\t ]+/, '');
    if (!s) continue;
    const el = splitKeep(s, elem, rel);
    const tag = el[0];
    if (tag === 'UNH') {
      cur = [s];
      t137 = t203 = undefined;
      continue;
    }
    if (!cur) continue;
    cur.push(s);
    if (tag === 'DTM') {
      const [q, v] = split(el[1] ?? '', comp, rel);
      if (q === '137') t137 = fromDt204(v);
      else if (q === '203' && t203 === undefined) t203 = fromDt204(v);
    } else if (tag === 'UNT') {
      messages.push({ t: t137 ?? t203, text: cur.map((x) => `${x}${term}`).join('\n') });
      cur = undefined;
    }
  }
  return { una, messages };
}

/** 几个报文拼成一份交换文件（UNA、UNB、报文、UNZ）；una 是原来文件的服务字符串，分隔符照它 */
export function ediWrap(messages: readonly string[], una = "UNA:+.? '", ref = 'IC0001', sender = 'PORTTERM', recipient = 'STOREX'): string {
  const { comp, elem, term } = separators(una);
  const d = dt204(0);
  return `${una}\nUNB${elem}UNOC${comp}3${elem}${sender}${elem}${recipient}${elem}${d.slice(2, 8)}${comp}0000${elem}${ref}${term}\n${messages.join('\n')}\nUNZ${elem}${messages.length}${elem}${ref}${term}\n`;
}

/** 正在追加写的交换文件：从头到哪里是完整的（最后一个 UNT 或 UNZ 段的结束符之后），后面的等写完再读 */
export function ediComplete(text: string): number {
  const bom = text.startsWith('﻿') ? 1 : 0;
  const una = text.startsWith('UNA', bom);
  const rel = una ? (text[bom + 6] as string) : '?';
  const term = una ? (text[bom + 8] as string) : "'";
  let start = una ? bom + 9 : bom;
  let cut = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === rel) {
      i++;
      continue;
    }
    if (c !== term) continue;
    const seg = text.slice(start, i).replace(/^[\r\n\t ]+/, '');
    if (seg.startsWith('UNT') || seg.startsWith('UNZ')) cut = i + 1;
    start = i + 1;
  }
  return cut;
}

// —— 本店的箱：按港口事件跟踪每个箱现在的状态 ——
export type BoxState = 'gateIn' | 'discharged' | 'hold' | 'released' | 'loaded' | 'gateOut';
const BOX_STATE: Record<PortEventCode, BoxState> = { GATE_IN: 'gateIn', DISCHARGE: 'discharged', HOLD: 'hold', RELEASED: 'released', LOAD: 'loaded', GATE_OUT: 'gateOut' };
export const BOX_LABEL: Record<BoxState, string> = { gateIn: '已进闸', discharged: '已卸船，等海关放行', hold: '海关查验中', released: '海关已放行，等装车提走', loaded: '已装上班列或拖车', gateOut: '已出闸' };
export interface BoxRow {
  /** 箱号 */
  id: string;
  state: BoxState;
  label: string;
  /** 进入这个状态的时刻 */
  since: number;
  /** 海关：还没有结果 / 查验 / 放行（看最后一次查验或放行） */
  customs: 'pending' | 'hold' | 'released';
  /** 最近一次带车船的事件是哪辆车（卸它的船、装它的班列或拖车）：车辆下标 */
  vid?: number;
  /** 这个箱的事件，按发生的时刻 */
  events: { t: number; code: PortEventCode; note: string }[];
}

/**
 * 本店的箱在港口的状态：港口 EDI 转来的事件（卸船、海关查验 / 放行、装车、进出闸）按箱号记下来。
 * 事件按发生的时刻排（晚到的插回原来的位置，重发的同一条只记一次），状态看最后一个事件，海关看最后一次查验或放行。
 */
export class ContainerBook {
  private readonly boxes = new Map<string, { t: number; code: PortEventCode; vid: number }[]>();

  /** 一条感知数据：是本店箱的港口事件就记下来，返回 true */
  observe(m: Msg): boolean {
    if (m.kind !== 'event' || !m.note) return false;
    const x = NOTE_RE.exec(m.note);
    if (!x) return false;
    const code = (Object.keys(NOTE) as PortEventCode[]).find((k) => NOTE[k] === x[1]) as PortEventCode;
    const list = this.boxes.get(x[2] as string) ?? [];
    if (list.some((e) => e.t === m.t && e.code === code)) return true;
    let i = list.length;
    while (i > 0 && (list[i - 1] as (typeof list)[number]).t > m.t) i--;
    list.splice(i, 0, { t: m.t, code, vid: m.vid });
    this.boxes.set(x[2] as string, list);
    return true;
  }

  get size(): number {
    return this.boxes.size;
  }

  /** 每个箱现在的状态（最近有变化的在前） */
  rows(): BoxRow[] {
    const out: BoxRow[] = [];
    for (const [id, list] of this.boxes) {
      const last = list[list.length - 1] as (typeof list)[number];
      const back = [...list].reverse();
      const customs = back.find((e) => e.code === 'HOLD' || e.code === 'RELEASED');
      const by = back.find((e) => e.vid >= 0);
      const state = BOX_STATE[last.code];
      out.push({ id, state, label: BOX_LABEL[state], since: last.t, customs: customs ? (customs.code === 'HOLD' ? 'hold' : 'released') : 'pending', ...(by ? { vid: by.vid } : {}), events: list.map((e) => ({ t: e.t, code: e.code, note: NOTE[e.code] })) });
    }
    return out.sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
  }
}

/**
 * 样例：按当天的计划给本店的箱编港口事件。本店班轮靠泊期间逐箱卸船（只取当天的部分），卸下来 2–5 小时后海关放行
 * （全链路预清关，大多很快）；当天有从港口出发的班列或拖车时，放行后的箱在发车前装车，拖车出闸。
 */
export function portEventsFromPlan(board: Board): PortEvent[] {
  const out: PortEvent[] = [];
  const vessel = board.ops.find((o) => o.kind === 'vessel' && o.dock);
  if (!vessel?.dock) return out;
  const n = Number(/约 (\d+) 个/.exec(vessel.label)?.[1] ?? 5);
  const [b0, b1] = vessel.dock;
  const boxes: { id: string; free: number }[] = [];
  for (let k = 0; k < n; k++) {
    const t = Math.round(b0 + ((k + 1) / (n + 1)) * (b1 - b0));
    const id = containerId(86000 + k);
    if (t >= 0 && t < 24 * 3600) out.push({ t, code: 'DISCHARGE', container: id, sizeType: '45G1', full: true, vehicleRef: vessel.id, location: 'PORT' });
    const free = t + (2 + (k % 4)) * 3600;
    if (free >= 0 && free < 24 * 3600) {
      out.push({ t: free, code: 'RELEASED', container: id, sizeType: '45G1', full: true, location: 'PORT' });
      boxes.push({ id, free });
    }
  }
  // 当天从港口出发的班列、拖车：放行了的箱在发车前装车
  for (const o of board.ops.filter((x) => (x.kind === 'rail' || x.kind === 'drayage') && x.from === 'PORT').sort((a, b) => a.t0 - b.t0)) {
    const box = boxes.find((b) => b.free < o.t0);
    if (!box) continue;
    boxes.splice(boxes.indexOf(box), 1);
    out.push({ t: Math.max(box.free + 600, o.t0 - 1800), code: 'LOAD', container: box.id, sizeType: '45G1', full: true, vehicleRef: o.id, location: 'PORT' });
    if (o.kind === 'drayage') out.push({ t: o.t0, code: 'GATE_OUT', container: box.id, sizeType: '45G1', full: true, vehicleRef: o.id, location: 'PORT' });
  }
  return out.sort((a, b) => a.t - b.t);
}
