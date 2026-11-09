import type { PathInfo } from '../region/network';
import { airKm, DIORAMA_SCALE, LOCAL_AIR_APPROACH, LOCAL_ANCHORAGE, LOCAL_LINER_IN, LOCAL_LINER_OUT, LOCAL_RUNWAY, LOCAL_SEA_BERTH, portKm, RAIL, RAIL_DC_INDEX, RAIL_PORT_INDEX, type Km } from '../region/region';

/**
 * 区域三维孪生的动画轨迹（某一天）：每辆车、每列火车、每条船、每架飞机一条轨迹，
 * 由一段段「移动」（沙盘坐标的折线）和「停留」组成，时间是当天 0 点起的秒数，和 StoreX 门店的轨迹格式一样，
 * 网页上用同一个回放逻辑。沙盘坐标：x = 公里 × 100（向东），z = −公里 × 100（向南为正）。
 */
export interface WSeg {
  t0: number;
  t1: number;
  /** 沙盘坐标的折线（三维场景没有车道模型时的退路） */
  pts: number[];
  act?: string;
  /** 行驶：经过的道路图节点（三维场景按它沿车道走、过路口和立交） */
  route?: string[];
  /** 停留：在哪个地点（门店编号、DC 等），三维场景把车停到那里的卸货位 */
  place?: string;
  /** 线上配送车：从 place 出发在附近小区送一圈再回来（路线由三维场景按街道生成） */
  loop?: boolean;
  /** 停留时船头的朝向（沙盘坐标的 atan2(dz, dx)）：靠泊的船用 */
  yaw?: number;
}
export interface WVehicle {
  id: number;
  kind: string;
  label: string;
  segs: WSeg[];
}
export interface WEvent {
  t: number;
  text: string;
}

/**
 * 作业：调度台上的一行。一趟配送、一辆进货车、一个集装箱的提箱、一列班列、一次靠泊、一个航班、一趟线上配送。
 * 时间是当天 0 点起的秒数；月台门、车辆编号、冲突由调度台（board）在仿真之后排。
 */
export type OpKind = 'delivery' | 'bakery' | 'supplier' | 'direct' | 'farm' | 'airTruck' | 'drayage' | 'rail' | 'train' | 'vessel' | 'flight' | 'van';
export interface OpStop {
  key: string;
  name: string;
  /** 到门店、开始卸货、卸完（秒）；开始卸货晚于到达 = 门店还没到收货时间，车在等 */
  arrive: number;
  start: number;
  end: number;
  pallets: number;
  /** 门店的收货时段（小时） */
  open: number;
  close: number;
  onTime: boolean;
  /** 高峰拥堵多花的分钟（夜里是负的：比平时快） */
  slow: number;
  /** 这一站卸下的货：商品族 → 件数（闭环孪生的门店库存用） */
  load?: Record<string, number>;
}
export interface Op {
  id: string;
  kind: OpKind;
  label: string;
  /** 对应的车辆（WorldTrace.vehicles 的下标），−1 = 没有画出来 */
  vehicle: number;
  t0: number;
  t1: number;
  from: string;
  to: string;
  /** 温区（配送车按装的温区；进货车按货的温区） */
  zone?: string;
  /** 车型：dry / reefer / multi / van / tractor */
  unit?: string;
  ev?: boolean;
  pallets?: number;
  cap?: number;
  km?: number;
  /** 出发时刻、原计划的出发时刻（秒）；到配送中心的时刻（进货） */
  depart?: number;
  planned?: number;
  arrive?: number;
  /** 在配送中心月台上的时段（装车或卸货，秒） */
  dock?: [number, number];
  stops?: OpStop[];
  /** 车上装的货（长途进配送中心的车）：商品族 → 件数；孪生把它改直送门店时用 */
  load?: Record<string, number>;
  /** 调度台里怎么改：配送车次改出发时刻、进货车改到达时刻、班次改常规计划；min / max 是当天的小时 */
  edit?: { mode: 'depart' | 'arrive' | 'standing'; key: string; min?: number; max?: number };
}

export const toXZ = (p: Km): [number, number] => [p.x * DIORAMA_SCALE, -p.y * DIORAMA_SCALE];
const flat = (pts: readonly Km[]): number[] => pts.flatMap((p) => toXZ(p));

export class WorldTrace {
  vehicles: WVehicle[] = [];
  events: WEvent[] = [];
  ops: Op[] = [];
  /** 已经用过的作业编号（重复的加后缀） */
  private readonly idSeen = new Map<string, number>();
  /** 节点每小时的状态（配送中心库存天数、港口堆场里自己的箱数等） */
  series: Record<string, number[]> = {};
  /** 每列班列上本店的箱数 */
  private trainBoxes = new Map<string, number>();
  /** 这一天 0 点门店每个商品族的库存、这一天每个商品族的需求（件）：闭环孪生的现场从这里开始 */
  storeStock: Record<string, number> = {};
  storeDemand: Record<string, number> = {};

  constructor(readonly day: number) {}

  private sec(absHours: number): number {
    return (absHours - this.day * 24) * 3600;
  }

  /** 一辆车：段的时间是绝对小时（从仿真第 0 天 0 点算），只保留和这一天有交集的段；返回车辆下标（没有交集返回 −1） */
  vehicle(kind: string, label: string, segs: { t0: number; t1: number; path?: PathInfo; at?: Km; pts?: Km[]; act: string; route?: string[]; place?: string; loop?: boolean; yaw?: number }[], _dayStartHours: number): number {
    const out: WSeg[] = [];
    for (const s of segs) {
      const t0 = this.sec(s.t0);
      const t1 = this.sec(s.t1);
      if (t1 <= t0 || t1 < -600 || t0 > 86400 + 600) continue;
      const pts = s.path ? flat(s.path.pts) : s.pts ? flat(s.pts) : s.at ? toXZ(s.at) : [];
      if (!pts.length) continue;
      const route = s.route ?? s.path?.nodes;
      out.push({ t0, t1, pts, act: s.act, ...(route && route.length > 1 ? { route } : {}), ...(s.place ? { place: s.place } : {}), ...(s.loop ? { loop: true } : {}), ...(s.yaw !== undefined ? { yaw: s.yaw } : {}) });
    }
    if (!out.length) return -1;
    this.vehicles.push({ id: this.vehicles.length, kind, label, segs: out });
    return this.vehicles.length - 1;
  }

  /** 一个作业：时间给绝对小时，存成当天的秒；和这一天没有交集的不记 */
  op(o: Omit<Op, 't0' | 't1' | 'depart' | 'planned' | 'arrive' | 'dock' | 'stops'> & { t0: number; t1: number; depart?: number; planned?: number; arrive?: number; dock?: [number, number]; stops?: (Omit<OpStop, 'arrive' | 'start' | 'end'> & { arrive: number; start: number; end: number })[] }): void {
    const t0 = this.sec(o.t0);
    const t1 = this.sec(o.t1);
    if (t1 < 0 || t0 > 86400) return;
    const sec = (h: number | undefined) => (h === undefined ? undefined : this.sec(h));
    const { depart, planned, arrive, dock, stops, ...rest } = o;
    // 同一个编号再出现（高负荷时一天几班航班、几批集货，每批都从 1 编起）：第二个起加 -2、-3，调度台才能一个个指定门和车
    const n = (this.idSeen.get(rest.id) ?? 0) + 1;
    this.idSeen.set(rest.id, n);
    if (n > 1) rest.id = `${rest.id}-${n}`;
    this.ops.push({
      ...rest,
      t0,
      t1,
      ...(depart !== undefined ? { depart: sec(depart) as number } : {}),
      ...(planned !== undefined ? { planned: sec(planned) as number } : {}),
      ...(arrive !== undefined ? { arrive: sec(arrive) as number } : {}),
      ...(dock ? { dock: [this.sec(dock[0]), this.sec(dock[1])] as [number, number] } : {}),
      ...(stops ? { stops: stops.map((x) => ({ ...x, arrive: this.sec(x.arrive), start: this.sec(x.start), end: this.sec(x.end) })) } : {}),
    });
  }

  /** 港口 → 物流园货运站的铁路班列 */
  rail(t0: number, t1: number, label: string): void {
    // 同一班列只画一列车（装多个集装箱）
    const exists = this.vehicles.find((v) => v.kind === 'train' && v.segs.some((sg) => sg.act === '港口 → 物流园货运站' && Math.round(sg.t0 / 360) === Math.round(this.sec(t0) / 360)));
    if (exists) {
      exists.label = exists.label.replace(/(\d+) 箱/, (_, n) => `${Number(n) + 1} 箱`);
      const op = this.ops.find((o) => o.vehicle === exists.id);
      if (op) op.label = exists.label;
      return;
    }
    const pts = RAIL.slice(RAIL_PORT_INDEX, RAIL_DC_INDEX + 1);
    const label2 = `铁路班列 · 1 箱 · ${label}`;
    // 发车前在港口铁路站装箱（轨道式龙门吊把箱吊上平车），到物流园货运站后卸箱
    const vid = this.vehicle('train', label2, [{ t0: t0 - 1.2, t1: t0, at: pts[0] as Km, act: '在港口铁路站装箱' }, { t0, t1, pts, act: '港口 → 物流园货运站' }, { t0: t1, t1: t1 + 1, at: pts[pts.length - 1] as Km, act: '在货运站卸箱' }], this.day * 24);
    const hh = Math.round((((t0 % 24) + 24) % 24) * 60);
    this.op({ id: `RL${String(Math.floor(hh / 60)).padStart(2, '0')}${String(hh % 60).padStart(2, '0')}`, kind: 'rail', label: label2, vehicle: vid, t0, t1: t1 + 1, from: 'PORT', to: 'RAIL_DC', depart: t0, arrive: t1, edit: { mode: 'standing', key: 'rail' } });
  }

  /**
   * 洲际铁路班列：从东面出图的地方开进物流园货运站，查验、卸箱 dwellHours 小时（箱进配送中心），再往东开走。
   * 班列是整列的公共班列，本店只占几个箱位；同一列车上几个商品族的箱合在一起记。
   */
  train(arriveAbs: number, dwellHours: number, boxes: number, famLabel: string): void {
    const hh = Math.round((((arriveAbs % 24) + 24) % 24) * 60);
    const id = `TR${String(Math.floor(hh / 60)).padStart(2, '0')}${String(hh % 60).padStart(2, '0')}`;
    const op = this.ops.find((o) => o.id === id);
    const n = (this.trainBoxes.get(id) ?? 0) + boxes;
    this.trainBoxes.set(id, n);
    const label = `洲际铁路班列 · 本店 ${n} 箱`;
    if (op) {
      op.label = label;
      const v = this.vehicles[op.vehicle];
      if (v) v.label = label;
      return;
    }
    void famLabel;
    const inbound = RAIL.slice(RAIL_DC_INDEX).reverse();
    const run = 0.6;
    const vid = this.vehicle('train', label, [
      { t0: arriveAbs - run, t1: arriveAbs, pts: inbound, act: '班列进站' },
      { t0: arriveAbs, t1: arriveAbs + dwellHours, at: inbound[inbound.length - 1] as Km, act: '在物流园货运站查验、卸箱' },
      { t0: arriveAbs + dwellHours, t1: arriveAbs + dwellHours + run, pts: [...inbound].reverse(), act: '空车出站' },
    ], this.day * 24);
    this.op({ id, kind: 'train', label, vehicle: vid, t0: arriveAbs - run, t1: arriveAbs + dwellHours + run, from: 'RAIL_EAST', to: 'RAIL_DC', arrive: arriveAbs, dock: [arriveAbs, arriveAbs + dwellHours], edit: { mode: 'standing', key: 'train' } });
  }

  /** 集装箱船：从外海沿进港航道开进来，在泊位正前方掉头、拖轮顶推靠泊，卸完由拖轮拖离、掉头出港 */
  ship(berthAbs: number, hoursAtBerth: number, label: string): void {
    const approach = 3;
    // 港口局部坐标里的航线（和港口里别家的船走同一套航道），换到区域里；泊位上船首朝码头的局部 +x
    const berth = portKm(LOCAL_SEA_BERTH);
    const ahead = portKm({ x: LOCAL_SEA_BERTH.x + 1, y: LOCAL_SEA_BERTH.y });
    const yaw = Math.atan2(-(ahead.y - berth.y), ahead.x - berth.x);
    const vid = this.vehicle('ship', label, [
      { t0: berthAbs - approach, t1: berthAbs, pts: LOCAL_LINER_IN.map(portKm), act: '进港' },
      { t0: berthAbs, t1: berthAbs + hoursAtBerth, at: berth, act: '靠泊装卸', yaw },
      { t0: berthAbs + hoursAtBerth, t1: berthAbs + hoursAtBerth + approach, pts: LOCAL_LINER_OUT.map(portKm), act: '离港' },
    ], this.day * 24);
    this.op({ id: 'VS1', kind: 'vessel', label, vehicle: vid, t0: berthAbs - approach, t1: berthAbs + hoursAtBerth + approach, from: 'SEA', to: 'PORT', arrive: berthAbs, dock: [berthAbs, berthAbs + hoursAtBerth], edit: { mode: 'standing', key: 'vessel' } });
  }

  /** 港口拥堵：船到了港外锚地，等泊位 */
  anchored(t0Abs: number, t1Abs: number, label: string): void {
    const vid = this.vehicle('ship', label, [{ t0: t0Abs, t1: t1Abs, at: portKm(LOCAL_ANCHORAGE), act: '在锚地等泊位（港口拥堵）' }], this.day * 24);
    this.op({ id: 'VS0', kind: 'vessel', label: `${label} · 在锚地等泊位`, vehicle: vid, t0: t0Abs, t1: t1Abs, from: 'SEA', to: 'ANCHORAGE', edit: { mode: 'standing', key: 'vessel' } });
  }

  /**
   * 货运航班：从跑道 +x 一侧进近、往 −x 降落，从快速出口脱离，沿平行滑行道（单向往 +x）滑进机位，停几个小时；
   * 起飞时滑到跑道 +x 头对正，往 −x 起飞。三维里的飞机由机场作业按同样的落地和推出时刻画（ops/airport.ts）
   */
  flight(landAbs: number, groundHours: number, label: string): void {
    // 机场局部坐标里的航线（跑道沿局部 x），换到区域里
    const RW = LOCAL_RUNWAY;
    const AP = LOCAL_AIR_APPROACH;
    const twy = RW.a.y + 1; // 平行滑行道
    const exit = RW.a.x + 4; // 快速出口
    const hold = RW.b.x - 0.5; // 跑道 +x 头的联络道
    const stand = { x: 20.3, y: -11.0 }; // 1 号机位
    const hh = Math.round((((landAbs % 24) + 24) % 24) * 60);
    const L = (pts: Km[]) => pts.map(airKm);
    const vid = this.vehicle('plane', label, [
      { t0: landAbs - 0.12, t1: landAbs, pts: L([AP, RW.b]), act: '进近降落' },
      { t0: landAbs, t1: landAbs + 0.04, pts: L([RW.b, { x: exit, y: RW.a.y }]), act: '减速' },
      { t0: landAbs + 0.04, t1: landAbs + 0.15, pts: L([{ x: exit, y: RW.a.y }, { x: exit + 0.4, y: twy }, { x: stand.x, y: twy }, stand]), act: '滑行到货运机坪' },
      { t0: landAbs + 0.15, t1: landAbs + groundHours, at: airKm(stand), act: '卸货' },
      { t0: landAbs + groundHours, t1: landAbs + groundHours + 0.12, pts: L([stand, { x: stand.x, y: twy }, { x: hold, y: twy }, { x: hold, y: RW.a.y }]), act: '滑行到跑道头' },
      { t0: landAbs + groundHours + 0.12, t1: landAbs + groundHours + 0.2, pts: L([{ x: hold, y: RW.a.y }, RW.a, { x: RW.a.x - 8, y: RW.a.y }]), act: '起飞' },
    ], this.day * 24);
    // 前一天晚上落地、还停在机坪上的航班编号后面加 -1
    const dayOff = Math.floor(landAbs / 24) - this.day;
    this.op({ id: `FL${String(Math.floor(hh / 60)).padStart(2, '0')}${String(hh % 60).padStart(2, '0')}${dayOff < 0 ? '-1' : ''}`, kind: 'flight', label, vehicle: vid, t0: landAbs - 0.12, t1: landAbs + groundHours + 0.2, from: 'AIR_IN', to: 'AIR', arrive: landAbs, dock: [landAbs + 0.15, landAbs + groundHours], edit: { mode: 'standing', key: 'flight' } });
  }

  event(absHours: number, text: string): void {
    const t = this.sec(absHours);
    if (t >= 0 && t < 86400) this.events.push({ t, text });
  }

  toJSON(): { day: number; vehicles: WVehicle[]; events: WEvent[]; series: Record<string, number[]>; ops: Op[]; storeStock: Record<string, number>; storeDemand: Record<string, number> } {
    this.events.sort((a, b) => a.t - b.t);
    this.ops.sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id));
    return { day: this.day, vehicles: this.vehicles, events: this.events, series: this.series, ops: this.ops, storeStock: this.storeStock, storeDemand: this.storeDemand };
  }
}
