import { DIORAMA_SCALE } from '../../src/region/region';
import type { BoardOp } from '../../src/sim/board';
import type { WVehicle } from '../../src/sim/trace';
import type { Msg } from '../../src/twin/types';

/**
 * 对接真实系统的公共部分：接口的名字和统计、时间和坐标的换算、车辆编号的对照。
 *
 * - 时间：外部系统用「日期 + 当地时间」（ISO 8601，不带时区）；仿真那一天用一个合成的日期 FEED_DATE，
 *   孪生里的时间是这一天 0 点起的秒（第二天凌晨就是 24 点以后）。
 * - 坐标：外部系统用经纬度；孪生用沙盘坐标（米，x 向东、z 向南，距离压缩成 1/10）。换算按一个合成的原点
 *   （默认经纬度 0, 0，不对应任何真实地点）做等距圆柱投影；接真实系统时用 --geo-origin 换成区域的原点。
 * - 车辆编号：外部系统按作业编号（调度台上的 M02、DS-BEV-1……）认车，孪生里是车辆下标；
 *   孪生派出来的车（救援车、追加补货车）由运输管理系统的「新行程」记录登记编号。
 */
export type AdapterName = 'sim' | 'replay' | 'tms' | 'wms' | 'edi';
export const ADAPTER_LABEL: Record<AdapterName, string> = {
  sim: '现场仿真（内置）',
  replay: '回放的记录',
  tms: '运输管理（TMS）',
  wms: '仓储和门店系统（WMS）',
  edi: '港口电子数据交换（EDI）',
};

/** 进来的一条感知数据和它从哪个接口来 */
export interface FeedItem {
  m: Msg;
  src: AdapterName;
}

/** 新出现、或者改了计划的车（救援车、追加补货车、改去处 / 改顺序的车）：eff = 从哪一步（那一步开始的时刻）起生效 */
export interface VehicleReg {
  eff: number;
  vid: number;
  v: WVehicle;
  extra?: { kind: 'rescue' | 'restock'; of?: number; fam?: string; units?: number; loadAt?: number };
  replan?: boolean;
  /** 外部系统里的编号 */
  ref?: string;
}

/** 一个接口解析一批记录的结果：转好的感知数据、登记的车、没用上的记录和原因 */
export interface Parsed {
  items: FeedItem[];
  vehicles: VehicleReg[];
  rejected: { at: string; reason: string }[];
}

/**
 * 每个接口的统计：收了多少、拒了多少（按原因）、最后一条的时刻、延迟、发出去多少；
 * 实时接入时还有：晚到的（孪生已经走过了它的时刻，按它自己的时刻补记）、顺序乱的（比这个接口已经收到的最新一条还旧）、
 * 过时没用上的定位（比已经交给孪生的同一辆车的定位还旧）。
 */
export class AdapterStats {
  accepted = 0;
  rejected = 0;
  readonly reasons = new Map<string, number>();
  lastAt: number | undefined;
  private latSum = 0;
  private latN = 0;
  latMax = 0;
  sent = 0;
  late = 0;
  outOfOrder = 0;
  stale = 0;
  private newest = -Infinity;

  constructor(readonly name: AdapterName) {}

  reject(reason: string): void {
    this.rejected++;
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  /** 实时收到一条（按收到的先后）：比这个接口收到过的最新一条还旧的算顺序乱 */
  received(m: Msg): void {
    if (m.t < this.newest) this.outOfOrder++;
    else this.newest = m.t;
  }

  /** 孪生收到这条数据的时刻减去数据本身的时刻（秒，仿真时间） */
  ingested(m: Msg, at: number): void {
    const lag = Math.max(0, at - m.t);
    this.latSum += lag;
    this.latN++;
    this.latMax = Math.max(this.latMax, lag);
    this.lastAt = Math.max(this.lastAt ?? -Infinity, m.t);
  }

  json(clock: (t: number) => string): Record<string, unknown> {
    return {
      name: this.name,
      label: ADAPTER_LABEL[this.name],
      accepted: this.accepted,
      rejected: this.rejected,
      reasons: Object.fromEntries(this.reasons),
      ...(this.lastAt !== undefined ? { lastAt: Math.round(this.lastAt), lastClock: clock(this.lastAt) } : {}),
      latency: { avg: this.latN ? Math.round((this.latSum / this.latN) * 10) / 10 : 0, max: Math.round(this.latMax), unit: '秒（仿真时间：孪生收到的时刻 − 数据的时刻）' },
      late: this.late,
      outOfOrder: this.outOfOrder,
      stale: this.stale,
      sent: this.sent,
    };
  }
}

/** 按文件名认接口：tms*.jsonl / *.json → 运输管理，*.csv → 仓储和门店，*.edi / *.edifact → 港口（meta.json、outbox* 不是数据） */
export function adapterOf(name: string): 'tms' | 'wms' | 'edi' | undefined {
  const n = name.toLowerCase();
  if (n === 'meta.json') return undefined;
  if (/\.(edi|edifact)$/.test(n)) return 'edi';
  if (n.endsWith('.csv')) return 'wms';
  if (/\.(jsonl|json)$/.test(n) && !n.startsWith('outbox')) return 'tms';
  return undefined;
}

// —— 时间 ——

/** 合成的日期：仿真那一天在外部系统里的日期（不对应任何真实的日子） */
export const FEED_DATE = '2030-03-28';
const BASE = Date.UTC(2030, 2, 28);

/** 当天的秒 → 「2030-03-28T09:30:00」（有小数秒时带毫秒） */
export function toTs(t: number): string {
  const iso = new Date(BASE + Math.round(t * 1000)).toISOString().replace('Z', '');
  return iso.endsWith('.000') ? iso.slice(0, -4) : iso;
}

/** 「2030-03-28T09:30:00(.123)」或「2030-03-28 09:30:00」→ 当天的秒；格式不对返回 undefined */
export function fromTs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(ts.trim());
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), Math.round(Number(m[7] ?? 0) * 1000));
  if (!Number.isFinite(ms)) return undefined;
  return (ms - BASE) / 1000;
}

// —— 坐标 ——

export interface GeoOrigin {
  lat0: number;
  lon0: number;
}
/** 合成的原点（经纬度 0, 0）：样例数据用它，不对应任何真实地点 */
export const GEO: GeoOrigin = { lat0: 0, lon0: 0 };
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;
/** 沙盘的 1 米 = 现实的几米 */
const REAL_PER_DIORAMA = 1000 / DIORAMA_SCALE;

export function toLatLon(x: number, z: number, g: GeoOrigin = GEO): { lat: number; lon: number } {
  const east = x * REAL_PER_DIORAMA;
  const north = -z * REAL_PER_DIORAMA;
  return { lat: g.lat0 + north / M_PER_DEG_LAT, lon: g.lon0 + east / (M_PER_DEG_LON * Math.cos((g.lat0 * Math.PI) / 180)) };
}

export function fromLatLon(lat: number, lon: number, g: GeoOrigin = GEO): { x: number; z: number } {
  const east = (lon - g.lon0) * M_PER_DEG_LON * Math.cos((g.lat0 * Math.PI) / 180);
  const north = (lat - g.lat0) * M_PER_DEG_LAT;
  return { x: east / REAL_PER_DIORAMA, z: -north / REAL_PER_DIORAMA };
}

/** 「30.25,120.5」→ 原点；格式不对返回 undefined */
export function parseGeo(s: string | undefined): GeoOrigin | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s ?? '');
  if (!m) return undefined;
  const lat0 = Number(m[1]);
  const lon0 = Number(m[2]);
  return Math.abs(lat0) < 80 && Math.abs(lon0) <= 180 ? { lat0, lon0 } : undefined;
}

/** 经纬度保留 7 位小数（约 1 厘米） */
export const round7 = (x: number): number => Math.round(x * 1e7) / 1e7;

// —— 车辆编号 ——

/** 外部系统的车辆编号（作业编号）和孪生里的车辆下标的对照 */
export class Refs {
  private readonly byRef = new Map<string, number>();
  private readonly byVid = new Map<number, string>();

  constructor(ops: readonly BoardOp[], vehicles: readonly WVehicle[] = []) {
    for (const o of ops) if (o.vehicle >= 0 && !this.byVid.has(o.vehicle)) this.add(o.id, o.vehicle);
    // 没有作业的车（背景车）用 V + 下标
    vehicles.forEach((_, i) => {
      if (!this.byVid.has(i)) this.add(`V${i}`, i);
    });
  }

  add(ref: string, vid: number): void {
    this.byRef.set(ref.toUpperCase(), vid);
    this.byVid.set(vid, ref);
  }

  vid(ref: unknown): number | undefined {
    return typeof ref === 'string' ? this.byRef.get(ref.trim().toUpperCase()) : undefined;
  }

  ref(vid: number): string {
    return this.byVid.get(vid) ?? `V${vid}`;
  }

  has(vid: number): boolean {
    return this.byVid.has(vid);
  }

  /** 下一个空着的车辆下标（登记新车用） */
  nextVid(): number {
    return Math.max(-1, ...this.byVid.keys()) + 1;
  }
}

/** 孪生派出来的车（记录里登记的）在外部系统里的编号都登记上，换算时前后一致 */
export function registerExtras(refs: Refs, regs: readonly VehicleReg[]): void {
  for (const r of regs) if (!r.replan && !refs.has(r.vid)) refs.add(extraRef(r, refs), r.vid);
}

/** 孪生派出来的车在外部系统里的编号：救援车 RS-原车编号、追加补货车 RT-商品族 */
export function extraRef(reg: Pick<VehicleReg, 'vid' | 'extra'>, refs: Refs): string {
  if (reg.extra?.kind === 'rescue' && reg.extra.of !== undefined) return `RS-${refs.ref(reg.extra.of)}`;
  if (reg.extra?.kind === 'restock') return `RT-${reg.extra.fam ?? 'X'}-${reg.vid}`;
  return `V${reg.vid}`;
}
