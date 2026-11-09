import type { WSeg } from '../../src/sim/trace';
import type { Cmd, Msg } from '../../src/twin/types';
import { extraRef, fromLatLon, fromTs, GEO, round7, toLatLon, toTs, type GeoOrigin, type Parsed, type Refs, type VehicleReg } from './common';

/**
 * 运输管理系统（TMS）的接口：车辆定位、行程状态、预计到达、冷机、电量、路况，按 JSON Lines（一行一条）进出。
 *
 * 进来（→ 孪生的感知数据）：
 * - position（经纬度）→ gps；status（DEPARTED / ARRIVED / LEFT / BREAKDOWN / REEFER_FAULT / REPAIRED / INSTRUCTION_ACK / TASK_DONE）→ event；
 * - eta → event（eta）；reefer → temp；battery → soc；incident（导航数据的事故、施工）→ traffic；
 * - trip：新行程（孪生派出的救援车、追加补货车）或改了计划的行程，带计划的路线和时刻，登记给孪生。
 * 出去（孪生的指令 → TMS 的调度指令）：改顺序、晚点进场、改去处、派救援车、通知门店、提醒司机检查、调冷机设定温度。
 */
export type TmsStatus = 'DEPARTED' | 'ARRIVED' | 'LEFT' | 'BREAKDOWN' | 'REEFER_FAULT' | 'REPAIRED' | 'INSTRUCTION_ACK' | 'TASK_DONE';
export interface TmsSegment {
  start: string;
  end: string;
  /** 路线（经纬度）；停留的段只有一个点 */
  path: [number, number][];
  act?: string;
  place?: string;
  nodes?: string[];
  loop?: boolean;
  yaw?: number;
}
export type TmsRecord =
  | { type: 'position'; ts: string; vehicleRef: string; lat: number; lon: number }
  | { type: 'status'; ts: string; vehicleRef: string | null; status: TmsStatus; location?: string; code?: string; note?: string; family?: string; units?: number }
  | { type: 'eta'; ts: string; vehicleRef: string; eta: string; note?: string }
  | { type: 'reefer'; ts: string; vehicleRef: string; airTemp: number; productTemp: number; setPoint: number; doorOpen: boolean; compressorOn: boolean }
  | { type: 'battery'; ts: string; vehicleRef: string; soc: number }
  | { type: 'incident'; ts: string; incidentRef: string; lat: number; lon: number; radiusM: number; travelFactor: number; until: string; text: string; cleared?: boolean }
  | { type: 'trip'; ts: string; vehicleRef: string; kind: string; label: string; purpose: 'rescue' | 'restock' | 'replan'; forRef?: string; family?: string; units?: number; loadAt?: string; segments: TmsSegment[] };

export type TmsInstruction = { type: 'instruction'; id: string; ts: string; action: string; vehicleRef?: string; storeRef?: string; [k: string]: unknown };

const EV_STATUS: Record<string, TmsStatus> = { depart: 'DEPARTED', arrive: 'ARRIVED', leave: 'LEFT', fixed: 'REPAIRED', ack: 'INSTRUCTION_ACK', done: 'TASK_DONE' };
type EventKind = Extract<Msg, { kind: 'event' }>['ev'];
const STATUS_EV: Record<TmsStatus, EventKind> = {
  DEPARTED: 'depart',
  ARRIVED: 'arrive',
  LEFT: 'leave',
  BREAKDOWN: 'fault',
  REEFER_FAULT: 'fault',
  REPAIRED: 'fixed',
  INSTRUCTION_ACK: 'ack',
  TASK_DONE: 'done',
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** 孪生的感知数据 → TMS 的记录（gps、车载终端的事件、冷机、电量、路况；门磁、装车、收银盘点归仓储和门店系统） */
export function tmsFromMsgs(msgs: readonly Msg[], refs: Refs, geo: GeoOrigin = GEO): TmsRecord[] {
  const out: TmsRecord[] = [];
  for (const m of msgs) {
    const ts = toTs(m.t);
    if (m.kind === 'gps') {
      const p = toLatLon(m.x, m.z, geo);
      out.push({ type: 'position', ts, vehicleRef: refs.ref(m.vid), lat: round7(p.lat), lon: round7(p.lon) });
    } else if (m.kind === 'event') {
      if (m.ev === 'eta') {
        out.push({ type: 'eta', ts, vehicleRef: refs.ref(m.vid), eta: toTs(m.eta ?? m.t), ...(m.note ? { note: m.note } : {}) });
        continue;
      }
      const status: TmsStatus = m.ev === 'fault' ? (m.code === 'COMP' ? 'REEFER_FAULT' : 'BREAKDOWN') : (EV_STATUS[m.ev] as TmsStatus);
      out.push({ type: 'status', ts, vehicleRef: m.vid < 0 ? null : refs.ref(m.vid), status, ...(m.place ? { location: m.place } : {}), ...(m.code ? { code: m.code } : {}), ...(m.note ? { note: m.note } : {}), ...(m.fam ? { family: m.fam } : {}), ...(m.units !== undefined ? { units: m.units } : {}) });
    } else if (m.kind === 'temp') {
      out.push({ type: 'reefer', ts, vehicleRef: refs.ref(m.vid), airTemp: r3(m.air), productTemp: r3(m.product), setPoint: m.set, doorOpen: m.door, compressorOn: m.cool });
    } else if (m.kind === 'soc') {
      out.push({ type: 'battery', ts, vehicleRef: refs.ref(m.vid), soc: r3(m.soc) });
    } else if (m.kind === 'traffic') {
      const p = toLatLon(m.x, m.z, geo);
      out.push({ type: 'incident', ts, incidentRef: m.id, lat: round7(p.lat), lon: round7(p.lon), radiusM: r2(m.r * 10), travelFactor: r3(m.factor), until: toTs(m.until), text: m.text, ...(m.end ? { cleared: true } : {}) });
    }
  }
  return out;
}

/** 新行程（孪生派出的车、改了计划的车）→ TMS 的 trip 记录 */
export function tmsTrip(reg: VehicleReg, refs: Refs, geo: GeoOrigin = GEO): TmsRecord {
  // 新车第一次出现：登记编号（后面的定位、状态按这个编号报）
  if (!refs.has(reg.vid)) refs.add(extraRef(reg, refs), reg.vid);
  const ref = refs.ref(reg.vid);
  const segments: TmsSegment[] = reg.v.segs.map((s) => {
    const path: [number, number][] = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) {
      const p = toLatLon(s.pts[i] as number, s.pts[i + 1] as number, geo);
      path.push([round7(p.lat), round7(p.lon)]);
    }
    return { start: toTs(s.t0), end: toTs(s.t1), path, ...(s.act ? { act: s.act } : {}), ...(s.place ? { place: s.place } : {}), ...(s.route ? { nodes: s.route } : {}), ...(s.loop ? { loop: true } : {}), ...(s.yaw !== undefined ? { yaw: s.yaw } : {}) };
  });
  return {
    type: 'trip',
    ts: toTs(reg.eff),
    vehicleRef: ref,
    kind: reg.v.kind,
    label: reg.v.label,
    purpose: reg.replan ? 'replan' : (reg.extra?.kind ?? 'replan'),
    ...(reg.extra?.of !== undefined ? { forRef: refs.ref(reg.extra.of) } : {}),
    ...(reg.extra?.fam ? { family: reg.extra.fam } : {}),
    ...(reg.extra?.units !== undefined ? { units: reg.extra.units } : {}),
    ...(reg.extra?.loadAt !== undefined ? { loadAt: toTs(reg.extra.loadAt) } : {}),
    segments,
  };
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const TYPES = new Set(['position', 'status', 'eta', 'reefer', 'battery', 'incident', 'trip']);
const LAT_OK = (lat: unknown, lon: unknown) => num(lat) && num(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/**
 * 解析 TMS 的记录（JSON Lines，或者一个 JSON 数组）：转成孪生的感知数据、登记新行程。
 * 坏记录跳过并记下原因：不是 JSON、不认识的类型、时间格式不对、不认识的车辆编号、坐标不对、不认识的状态、数值不对。
 */
export function parseTms(text: string, refs: Refs, geo: GeoOrigin = GEO): Parsed {
  const out: Parsed = { items: [], vehicles: [], rejected: [] };
  const trimmed = text.trim();
  let rows: { at: string; raw: unknown; bad?: string }[];
  if (trimmed.startsWith('[')) {
    try {
      rows = (JSON.parse(trimmed) as unknown[]).map((raw, i) => ({ at: `#${i + 1}`, raw }));
    } catch {
      out.rejected.push({ at: '全文', reason: '不是合法的 JSON' });
      return out;
    }
  } else
    rows = trimmed
      .split('\n')
      .map((line, i) => ({ line: line.trim(), i }))
      .filter((x) => x.line && !x.line.startsWith('//'))
      .map(({ line, i }) => {
        try {
          return { at: `第 ${i + 1} 行`, raw: JSON.parse(line) as unknown };
        } catch {
          return { at: `第 ${i + 1} 行`, raw: undefined, bad: '不是合法的 JSON' };
        }
      });
  // 新行程先登记（同一批里后面的记录可能用到它的编号）
  const ordered = [...rows.filter((r) => (r.raw as { type?: unknown } | undefined)?.type === 'trip'), ...rows.filter((r) => (r.raw as { type?: unknown } | undefined)?.type !== 'trip')];
  for (const row of ordered) {
    const reject = (reason: string) => out.rejected.push({ at: row.at, reason });
    if (row.bad) {
      reject(row.bad);
      continue;
    }
    const r = row.raw as Record<string, unknown>;
    if (!r || typeof r !== 'object') {
      reject('不是一条记录');
      continue;
    }
    if (!TYPES.has(r.type as string)) {
      reject('不认识的记录类型');
      continue;
    }
    const t = fromTs(r.ts);
    if (t === undefined) {
      reject('时间格式不对');
      continue;
    }
    const vid = refs.vid(r.vehicleRef);
    const needVehicle = r.type !== 'incident' && !(r.type === 'status' && r.vehicleRef === null);
    if (r.type !== 'trip' && needVehicle && vid === undefined) {
      reject('不认识的车辆编号');
      continue;
    }
    const v = vid as number;
    switch (r.type) {
      case 'position': {
        if (!LAT_OK(r.lat, r.lon)) {
          reject('坐标不对');
          break;
        }
        const p = fromLatLon(r.lat as number, r.lon as number, geo);
        out.items.push({ m: { kind: 'gps', t, vid: v, x: p.x, z: p.z }, src: 'tms' });
        break;
      }
      case 'status': {
        const ev = STATUS_EV[r.status as TmsStatus];
        if (!ev) {
          reject('不认识的状态');
          break;
        }
        const code = typeof r.code === 'string' ? r.code : ev === 'fault' ? (r.status === 'REEFER_FAULT' ? 'COMP' : 'ENG') : undefined;
        const m: Msg = { kind: 'event', t, vid: r.vehicleRef === null ? -1 : v, ev, ...(typeof r.location === 'string' ? { place: r.location } : {}), ...(code ? { code } : {}), ...(typeof r.note === 'string' ? { note: r.note } : {}), ...(typeof r.family === 'string' ? { fam: r.family } : {}), ...(num(r.units) ? { units: r.units } : {}) };
        out.items.push({ m, src: 'tms' });
        break;
      }
      case 'eta': {
        const eta = fromTs(r.eta);
        if (eta === undefined) {
          reject('预计到达的时间格式不对');
          break;
        }
        out.items.push({ m: { kind: 'event', t, vid: v, ev: 'eta', eta, ...(typeof r.note === 'string' ? { note: r.note } : {}) }, src: 'tms' });
        break;
      }
      case 'reefer': {
        if (!num(r.airTemp) || !num(r.productTemp) || !num(r.setPoint) || Math.abs(r.productTemp) > 60) {
          reject('冷机读数不对');
          break;
        }
        out.items.push({ m: { kind: 'temp', t, vid: v, air: r.airTemp, product: r.productTemp, set: r.setPoint, door: r.doorOpen === true, cool: r.compressorOn === true }, src: 'tms' });
        break;
      }
      case 'battery': {
        if (!num(r.soc) || r.soc < 0 || r.soc > 1) {
          reject('电量不对（0–1）');
          break;
        }
        out.items.push({ m: { kind: 'soc', t, vid: v, soc: r.soc }, src: 'tms' });
        break;
      }
      case 'incident': {
        const until = fromTs(r.until);
        if (!LAT_OK(r.lat, r.lon) || !num(r.radiusM) || !num(r.travelFactor) || until === undefined || typeof r.incidentRef !== 'string') {
          reject('路况记录不完整');
          break;
        }
        const p = fromLatLon(r.lat as number, r.lon as number, geo);
        out.items.push({ m: { kind: 'traffic', t, id: r.incidentRef, x: p.x, z: p.z, r: r.radiusM / 10, factor: r.travelFactor, until, text: typeof r.text === 'string' ? r.text : '路况', ...(r.cleared === true ? { end: true } : {}) }, src: 'tms' });
        break;
      }
      case 'trip': {
        const segs: WSeg[] = [];
        let bad = typeof r.vehicleRef !== 'string' || !Array.isArray(r.segments) || !(r.segments as unknown[]).length;
        for (const s of (Array.isArray(r.segments) ? r.segments : []) as Record<string, unknown>[]) {
          const t0 = fromTs(s.start);
          const t1 = fromTs(s.end);
          const path = Array.isArray(s.path) ? (s.path as unknown[]) : [];
          if (t0 === undefined || t1 === undefined || t1 < t0 || !path.length || !path.every((p) => Array.isArray(p) && LAT_OK(p[0], p[1]))) {
            bad = true;
            break;
          }
          const pts = (path as [number, number][]).flatMap(([lat, lon]) => {
            const p = fromLatLon(lat, lon, geo);
            return [p.x, p.z];
          });
          segs.push({ t0, t1, pts, ...(typeof s.act === 'string' ? { act: s.act } : {}), ...(typeof s.place === 'string' ? { place: s.place } : {}), ...(Array.isArray(s.nodes) ? { route: s.nodes as string[] } : {}), ...(s.loop === true ? { loop: true } : {}), ...(num(s.yaw) ? { yaw: s.yaw } : {}) });
        }
        const purpose = r.purpose === 'rescue' || r.purpose === 'restock' || r.purpose === 'replan' ? r.purpose : undefined;
        const of = refs.vid(r.forRef);
        if (bad || !purpose || (purpose === 'rescue' && of === undefined) || (purpose === 'replan' && vid === undefined)) {
          reject('新行程记录不完整（编号、用途、路线或时刻）');
          break;
        }
        const id = purpose === 'replan' ? v : (vid ?? refs.nextVid());
        if (vid === undefined) refs.add(r.vehicleRef as string, id);
        const loadAt = fromTs(r.loadAt);
        out.vehicles.push({
          eff: t,
          vid: id,
          v: { id, kind: typeof r.kind === 'string' ? r.kind : 'truck', label: typeof r.label === 'string' ? r.label : (r.vehicleRef as string), segs },
          ...(purpose === 'replan' ? { replan: true } : { extra: { kind: purpose, ...(of !== undefined ? { of } : {}), ...(typeof r.family === 'string' ? { fam: r.family } : {}), ...(num(r.units) ? { units: r.units } : {}), ...(loadAt !== undefined ? { loadAt } : {}) } }),
          ref: r.vehicleRef as string,
        });
        break;
      }
      default:
        reject('不认识的记录类型');
    }
  }
  return out;
}

let seq = 0;
/** 孪生的指令 → TMS 的调度指令（改门、追加补货归仓储系统，返回 undefined） */
export function tmsInstruction(c: Cmd, refs: Refs): TmsInstruction | undefined {
  const base = { type: 'instruction' as const, id: `TI-${String(++seq).padStart(5, '0')}`, ts: toTs(c.t) };
  switch (c.kind) {
    case 'resequence':
      return { ...base, action: 'RESEQUENCE', vehicleRef: refs.ref(c.vid), stops: c.order };
    case 'hold':
      return { ...base, action: 'HOLD_UNTIL', vehicleRef: refs.ref(c.vid), until: toTs(c.until) };
    case 'divert':
      return { ...base, action: 'DIVERT', vehicleRef: refs.ref(c.vid), to: c.to === 'store' ? 'STORE' : 'DC' };
    case 'rescue':
      return { ...base, action: 'DISPATCH_RESCUE', vehicleRef: refs.ref(c.vid) };
    case 'notifyStore':
      return { ...base, action: 'NOTIFY_STORE', storeRef: c.store, receiveUntil: toTs(c.until) };
    case 'driverCheck':
      return { ...base, action: 'DRIVER_CHECK', vehicleRef: refs.ref(c.vid), check: 'DOOR_SEAL' };
    case 'setpoint':
      return { ...base, action: 'REEFER_SETPOINT', vehicleRef: refs.ref(c.vid), deltaC: c.delta };
    default:
      return undefined;
  }
}
