import { Rng } from '../../../StoreX/src/core/rng';
import { buildGraph, Routes, STORE, STORES, travelHours } from '../region/network';
import { BASE_UNITS, casesPerPallet, FAMILIES } from '../region/products';
import { NODES, type Km } from '../region/region';
import type { BoardOp } from '../sim/board';
import { HOUR_W } from '../sim/engine';
import { toXZ, type WSeg, type WVehicle } from '../sim/trace';
import { ambient, LIMIT, reeferParams, reeferStep, RESTOCK_PALLETS, SETPOINT, type ReeferState, type ReeferZone } from './models';
import { isDcUnload, isLoad, isMoving as moving, isStoreUnload, isWait, posAt, segAt } from './track';
import type { Cmd, Msg } from './types';

/**
 * 现场（物理层的仿真）：按当天的计划执行，但现场会出计划不知道的状况——
 * 装车晚了、路上出事故、车抛锚、冷机密封不严或压缩机坏了、门店某个商品族突然卖得快、门店卸货慢、收货口排不开。
 * 现场只通过「感知数据」（定位、车载终端事件、温度、装车进度、门磁、收银、盘点、路况、电量）让孪生知道发生了什么，
 * 并执行孪生发回来的指令（通知门店顺延、调整顺序、派救援车、提醒司机检查、调设定温度、改月台门、
 * 配送中心追加补货、长途车改直送门店 / 改送配送中心、让车晚点到）。
 *
 * 门店的库存按商品族记，从仿真里这一天 0 点的库存开始，需求用仿真里这一天的需求（按小时曲线卖），
 * 每趟车卸下的货就是仿真里这一站的货（trace 里每一站的 load）。
 *
 * 每辆车有一个「计划时钟」τ：正常时和现实时间一起走；遇到事故走得慢、抛锚和等门时停住、卸货慢时变慢，
 * 延误 = 现实时间 − τ。车的位置就是计划在 τ 时刻的位置，所以延误自然地往后传，三维里也只要把计划的运动平移。
 */
export interface FieldInput {
  vehicles: WVehicle[];
  ops: BoardOp[];
  seed: number;
  /** 仿真里这一天 0 点门店每个商品族的库存、这一天的需求（件）；不给就按规模估 */
  store?: { stock: Record<string, number>; demand: Record<string, number> };
  /** 长途整车直送门店的商品族 */
  direct?: readonly string[];
  /** 现场状况：平常的一天，还是多事的一天（需求暴涨、送生鲜的车长时间抛锚、供应商发车晚很多） */
  level?: FieldLevel;
}
export type FieldLevel = 'normal' | 'rough';
export const LEVEL_LABEL: Record<FieldLevel, string> = { normal: '平常的一天', rough: '多事的一天' };
export interface Incident {
  id: string;
  x: number;
  z: number;
  r: number;
  f: number;
  t0: number;
  t1: number;
  text: string;
}
export interface Disturbances {
  loadDelay: Map<number, number>;
  incidents: Incident[];
  breakdowns: Map<number, { at: number; repair: number }>;
  seal: Map<number, number>;
  comp: Map<number, number>;
  /** 门店某个商品族突然卖得快（促销、天气） */
  spikes: { fam: string; t0: number; t1: number; f: number }[];
  /** 发车晚了（秒）：供应商那边装车晚 */
  startDelay: Map<number, number>;
  slow: Set<string>;
}
interface Reefer {
  zone: ReeferZone;
  st: ReeferState;
  set: number;
  seal: boolean;
  comp: boolean;
  sealFrom?: number;
  compFrom?: number;
}
export interface FVehicle {
  vid: number;
  v: WVehicle;
  op: BoardOp | undefined;
  tau: number;
  started: boolean;
  finished: boolean;
  door: string | undefined;
  atDoor: boolean;
  waitingDoor: boolean;
  loadLeft: number;
  broken?: { from: number; until: number };
  /** 抛锚过了（修好后不再抛锚）；货转给救援车以后，修好就收车 */
  bdDone?: boolean;
  retire?: boolean;
  /** 停在路边等这辆救援车来转货（冷机坏了的车也是就近停车等） */
  heldBy?: number;
  /** 现实里什么时候收车（三维里车从这时起消失） */
  endAt?: number;
  checkUntil?: number;
  checkFix?: boolean;
  reefer: Reefer | undefined;
  soc: number | undefined;
  /** 已经到过（卸完）的门店 */
  done: Set<string>;
  /** 这辆车是孪生派出来的（救援、追加补货）；救援车在计划时钟 loadAt 转完货，之后车上才有货 */
  extra?: { kind: 'rescue' | 'restock'; of?: number; fam?: string; units?: number; loadAt?: number };
  /** 孪生把它改了去处：长途进配送中心的车改直送门店（store），直送车改送配送中心（DC） */
  diverted?: 'store' | 'DC';
  /** 孪生让它晚点到：开到这个时刻之前在路边等 */
  holdUntil?: number;
  /** 在门店占着的收货口、在等收货口 */
  dock?: string;
  waitingDock?: boolean;
  /** 长途车进区域之前，上一次报预计进区域时刻的时间 */
  etaAt?: number;
}
export interface StopResult {
  vid: number;
  store: string;
  t: number;
  close: number;
  late: number;
}

const MIN = 60;
/** 分项按 5 分钟一格记到第二天 2 点 */
const SLOTS = (26 * 3600) / 300;
function tally<K>(m: Map<K, Float32Array>, key: K, t: number, minutes: number): void {
  let a = m.get(key);
  if (!a) m.set(key, (a = new Float32Array(SLOTS)));
  const k = Math.min(SLOTS - 1, Math.max(0, Math.floor(t / 300)));
  a[k] = (a[k] as number) + minutes;
}
const hhmm = (t: number): string => {
  const m = ((Math.round(t / MIN) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** 现场今天会出的状况（同一个种子每次一样） */
export function makeDisturbances(input: FieldInput): Disturbances {
  const r = new Rng(input.seed * 7919 + 86).fork('field');
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)] as T;
  const rough = input.level === 'rough';
  const own = input.ops.filter((o) => o.kind === 'delivery' && o.vehicle >= 0 && o.from === 'DC');
  const reefers = own.filter((o) => o.zone !== 'ambient');
  // 抛锚：开往门店路上的车（配送中心的车、长途直送车）
  const toStore = input.ops.filter((o) => (o.kind === 'delivery' || o.kind === 'direct') && o.vehicle >= 0);
  const d: Disturbances = { loadDelay: new Map(), incidents: [], breakdowns: new Map(), seal: new Map(), comp: new Map(), spikes: [], slow: new Set(), startDelay: new Map() };
  const shuffled = [...own].sort(() => r.next() - 0.5);
  for (const o of shuffled.slice(0, Math.max(2, Math.round(own.length * (rough ? 0.3 : 0.12))))) d.loadDelay.set(o.vehicle, (12 + r.next() * 23) * MIN);
  // 事故：放在某趟车会经过的路段上，时间也对上（让它真的影响到车）
  for (let k = 0; k < (rough ? 5 : 3); k++) {
    const o = pick(own);
    const v = input.vehicles[o.vehicle];
    const segs = (v?.segs ?? []).filter((s) => s.route && s.pts.length >= 6);
    if (!segs.length) continue;
    const s = pick(segs);
    const f = 0.25 + r.next() * 0.5;
    const i = Math.floor((s.pts.length / 2) * f) * 2;
    const t0 = s.t0 + (s.t1 - s.t0) * f - (10 + r.next() * 20) * MIN;
    d.incidents.push({ id: `I${k + 1}`, x: s.pts[i] as number, z: s.pts[i + 1] as number, r: 110, f: 1.8 + r.next(), t0, t1: t0 + (50 + r.next() * 60) * MIN, text: pick(['交通事故，占用一条车道', '道路施工，车速降低', '车流拥堵']) });
  }
  if (toStore.length) {
    // 多事的一天：抛锚的是装生鲜最多的那车，修得也久
    const freshUnits = (o: BoardOp) => Object.entries(o.stops?.[0]?.load ?? {}).reduce((a, [k, u]) => a + (FAMILIES.find((f) => f.key === k)?.life !== undefined ? u : 0), 0);
    const o = rough ? [...toStore].sort((a, b) => freshUnits(b) - freshUnits(a))[0] as BoardOp : pick(toStore);
    const v = input.vehicles[o.vehicle];
    const s = (v?.segs ?? []).find((x) => x.route);
    if (s) d.breakdowns.set(o.vehicle, { at: s.t0 + (s.t1 - s.t0) * (0.35 + r.next() * 0.3), repair: (rough ? 150 + r.next() * 60 : 85 + r.next() * 40) * MIN });
  }
  for (const o of [...reefers].sort(() => r.next() - 0.5).slice(0, 2)) if (!d.breakdowns.has(o.vehicle)) d.seal.set(o.vehicle, (o.depart ?? o.t0) + (5 + r.next() * 20) * MIN);
  if (rough || r.next() < 0.7) {
    const o = reefers.find((x) => !d.seal.has(x.vehicle) && !d.breakdowns.has(x.vehicle));
    if (o) d.comp.set(o.vehicle, (o.depart ?? o.t0) + (5 + r.next() * 15) * MIN);
  }
  // 门店两个商品族突然卖得快（促销、天气）：一个生鲜、一个走配送中心的常温货，挑开门时库存天数少的（10–13 点开始，持续 5 小时）
  const cover = (key: string) => (input.store?.stock[key] ?? 1) / Math.max(1, input.store?.demand[key] ?? 1);
  const fresh = FAMILIES.filter((f) => f.life !== undefined && f.share > 0.03);
  const dry = FAMILIES.filter((f) => f.life === undefined && f.share > 0.02 && !(input.direct ?? []).includes(f.key));
  for (const list of [fresh, dry]) {
    const low = [...list].sort((a, b) => cover(a.key) - cover(b.key)).slice(0, 2);
    const t0 = (10 + r.next() * 3) * 3600;
    d.spikes.push({ fam: pick(low).key, t0, t1: t0 + (rough ? 6 : 5) * 3600, f: rough ? 3 : 2.3 });
  }
  // 一辆长途直送车的供应商发车晚了（平常 1.5–3 小时，多事的一天 3–5 小时）
  const direct = input.ops.filter((o) => o.kind === 'direct' && o.vehicle >= 0);
  if (direct.length) d.startDelay.set(pick(direct).vehicle, (rough ? 180 + r.next() * 120 : 90 + r.next() * 90) * MIN);
  const stops = own.flatMap((o) => (o.stops ?? []).map((s) => `${o.vehicle}:${s.key}`));
  for (const k of [...stops].sort(() => r.next() - 0.5).slice(0, 3)) d.slow.add(k);
  return d;
}

export class Field {
  readonly fv: FVehicle[] = [];
  readonly msgs: Msg[] = [];
  readonly stopResults: StopResult[] = [];
  readonly d: Disturbances;
  /** 门店：每个商品族的库存（货架 + 后仓）、这一天每个商品族的需求、顺延到几点收货 */
  readonly stock = new Map<string, number>();
  readonly demand = new Map<string, number>();
  readonly extendTo = new Map<string, number>();
  /** 月台门 / 门店收货口现在被哪辆车占着 */
  readonly doors = new Map<string, number>();
  readonly storeDocks = new Map<string, number>();
  /** 累计的现场结果（给闭环效果用）：缺货分钟按商品族累计 */
  readonly kpi = { lateStops: 0, lateMin: 0, hotMin: 0, shortMin: 0, lostUnits: 0, doorWaitMin: 0, dockWaitMin: 0, extraKm: 0, cost: 0, notified: 0 };
  /** 分项（建议复盘用：每张建议卡预测的和实际发生的比）：每辆车等门、等收货口的分钟，每辆车超温、每个商品族缺货的分钟（每 5 分钟一格） */
  readonly by = { door: new Map<number, number>(), dock: new Map<number, number>(), hot: new Map<number, Float32Array>(), short: new Map<string, Float32Array>() };
  readonly sold = new Map<string, number>();
  private readonly r: Rng;
  /** 长途车报预计进区域时刻的误差（单独的随机数，不影响现场其余的状况） */
  private readonly etaRng: Rng;
  private readonly routes = new Routes(buildGraph());
  private incidentOn = new Set<string>();
  private pending: { at: number; run: () => void }[] = [];

  constructor(readonly input: FieldInput) {
    this.d = makeDisturbances(input);
    this.r = new Rng(input.seed * 104729 + 17).fork('field-msgs');
    this.etaRng = new Rng(input.seed * 104729 + 17).fork('field-eta');
    const byVehicle = new Map(input.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
    input.vehicles.forEach((v, i) => {
      if (!['truck', 'reefer', 'ev', 'van', 'drayage'].includes(v.kind)) return;
      const op = byVehicle.get(i);
      const zone: ReeferZone | undefined = op?.kind === 'delivery' || op?.kind === 'farm' || op?.kind === 'airTruck' || op?.kind === 'supplier' ? (op.zone === 'frozen' ? 'frozen' : op.zone === 'ambient' || op.zone === undefined || (op.kind === 'supplier' && op.zone !== 'chilled') ? undefined : 'chilled') : undefined;
      this.fv.push({
        vid: i,
        v: { ...v, segs: v.segs.map((s) => ({ ...s })) },
        op,
        tau: v.segs[0]?.t0 ?? 0,
        started: false,
        finished: false,
        door: op?.door,
        atDoor: false,
        waitingDoor: false,
        loadLeft: this.d.loadDelay.get(i) ?? 0,
        reefer: zone ? { zone, st: { air: SETPOINT[zone], product: SETPOINT[zone] + 0.4, cool: false }, set: SETPOINT[zone], seal: false, comp: true } : undefined,
        soc: v.kind === 'ev' ? 0.94 : undefined,
        done: new Set(),
      });
    });
    for (const fam of FAMILIES) {
      const base = BASE_UNITS * STORE.size * fam.share;
      this.stock.set(fam.key, input.store?.stock[fam.key] ?? base);
      this.demand.set(fam.key, input.store?.demand[fam.key] ?? base);
      this.sold.set(fam.key, 0);
    }
  }

  /** 计划时钟 τ 时刻所在的段 */
  segAt(f: FVehicle, tau: number): { i: number; s: WSeg } | undefined {
    return segAt(f.v, tau);
  }

  posAt(s: WSeg, tau: number): { x: number; z: number } {
    return posAt(s, tau);
  }

  /** 收货截止（小时）：门店的收货时段，被通知顺延的按顺延 */
  closeOf(store: string, op: BoardOp | undefined): number {
    const base = (op?.stops ?? []).find((s) => s.key === store)?.close ?? 12;
    return Math.max(base * 3600, this.extendTo.get(store) ?? 0);
  }

  private emit(m: Msg): void {
    this.msgs.push(m);
  }

  /** 往前走 dt 秒（现实时间从 t 到 t + dt） */
  step(t: number, dt: number): void {
    const t1 = t + dt;
    // 延迟执行的指令（确认、准备）
    this.pending = this.pending.filter((p) => {
      if (p.at > t1) return true;
      p.run();
      return false;
    });
    // 路况消息
    for (const inc of this.d.incidents) {
      if (t1 >= inc.t0 && !this.incidentOn.has(inc.id) && t1 < inc.t1) {
        this.incidentOn.add(inc.id);
        this.emit({ kind: 'traffic', t: inc.t0, id: inc.id, x: inc.x, z: inc.z, r: inc.r, factor: inc.f, until: inc.t1, text: inc.text });
      }
      if (t1 >= inc.t1 && this.incidentOn.has(inc.id)) {
        this.incidentOn.delete(inc.id);
        this.emit({ kind: 'traffic', t: inc.t1, id: inc.id, x: inc.x, z: inc.z, r: inc.r, factor: 1, until: inc.t1, text: `${inc.text}，已恢复`, end: true });
      }
    }
    // 先算月台门的占用（先到先占）
    for (const f of this.fv) this.vehicleStep(f, t, dt);
    this.storeStep(t, dt);
  }

  private vehicleStep(f: FVehicle, t: number, dt: number): void {
    if (f.finished) return;
    const first = f.v.segs[0];
    const last = f.v.segs[f.v.segs.length - 1];
    if (!first || !last) return;
    const t1 = t + dt;
    if (!f.started) {
      const appear = first.t0 + (this.d.startDelay.get(f.vid) ?? 0);
      // 长途车（直送门店、进配送中心）还在区域外：车载终端提前 4 小时开始、每小时报一次预计进区域的时刻（几分钟误差）
      if ((f.op?.kind === 'direct' || f.op?.kind === 'supplier') && t1 >= first.t0 - 4 * 3600 && t1 < appear && t1 - (f.etaAt ?? -Infinity) >= 3600) {
        f.etaAt = t1;
        const eta = appear + this.etaRng.normal(0, 3 * MIN);
        this.emit({ kind: 'event', t: t1, vid: f.vid, ev: 'eta', eta, note: `车载终端：预计 ${hhmm(eta)} 进入区域` });
      }
      // 还没到出现的时刻（发车晚了的再等一会儿）；已经在路上的（前一天开始装车的）从此刻接着走，不算延误
      if (t1 < appear) return;
      f.started = true;
      f.tau = Math.max(first.t0, t - (this.d.startDelay.get(f.vid) ?? 0));
    }
    const cur = this.segAt(f, f.tau);
    if (!cur) {
      if (f.tau >= last.t1) this.finish(f, t1);
      return;
    }
    const s = cur.s;
    let rate = 1;
    if (f.heldBy !== undefined) {
      rate = 0;
      const rv = this.fv.find((x) => x.vid === f.heldBy);
      if (rv && rv.tau >= (rv.extra?.loadAt ?? Infinity)) {
        // 救援车转完货：剩下的门店归救援车，货的温度跟着货走
        for (const k of f.op?.stops ?? []) f.done.add(k.key);
        if (rv.reefer && f.reefer) rv.reefer.st.product = f.reefer.st.product;
        f.heldBy = undefined;
        this.emit({ kind: 'event', t, vid: f.vid, ev: 'done', note: f.broken ? '货已转到救援车，修好后空车回配送中心' : '货已转到救援车，空车回配送中心' });
        if (!f.broken) {
          this.finish(f, t);
          return;
        }
      }
    }
    // 装车 / 进货卸车：要占月台门（调度台排成提前装好、挂车在场地等的不再占门）
    if ((isLoad(s) || isDcUnload(s)) && f.door && !f.op?.preload) {
      const occ = this.doors.get(f.door);
      if (occ !== undefined && occ !== f.vid) {
        rate = 0;
        if (!f.waitingDoor) f.waitingDoor = true;
        this.kpi.doorWaitMin += dt / MIN;
        this.by.door.set(f.vid, (this.by.door.get(f.vid) ?? 0) + dt / MIN);
      } else {
        if (!f.atDoor) {
          f.atDoor = true;
          f.waitingDoor = false;
          this.doors.set(f.door, f.vid);
          this.emit({ kind: 'door', t, door: f.door, open: true, vid: f.vid });
        }
        if (isLoad(s) && f.loadLeft > 0) {
          rate = 0;
          f.loadLeft -= dt;
        }
      }
    }
    if (moving(s) && s.route) {
      // 现实比计划的路况略差：早高峰慢约 12%、晚高峰慢约 8%（计划不知道，孪生要从定位数据里学出来）
      const hr = t / 3600;
      if (hr >= 7 && hr < 9.5) rate = Math.min(rate, 1 / 1.12);
      else if (hr >= 16 && hr < 19) rate = Math.min(rate, 1 / 1.08);
      const p = this.posAt(s, f.tau);
      for (const inc of this.d.incidents) if (t >= inc.t0 && t < inc.t1 && Math.hypot(p.x - inc.x, p.z - inc.z) < inc.r) rate = Math.min(rate, 1 / inc.f);
      const bd = this.d.breakdowns.get(f.vid);
      if (bd && !f.broken && !f.bdDone && f.tau >= bd.at) {
        f.broken = { from: t, until: t + bd.repair };
        f.bdDone = true;
        this.emit({ kind: 'event', t, vid: f.vid, ev: 'fault', code: 'ENG', note: '发动机故障，车辆停在路边' });
      }
      if (f.broken) {
        if (t >= f.broken.until) {
          f.broken = undefined;
          if (f.retire) {
            this.emit({ kind: 'event', t, vid: f.vid, ev: 'fixed', note: '修好了，空车回配送中心' });
            this.finish(f, t);
            return;
          }
          this.emit({ kind: 'event', t, vid: f.vid, ev: 'fixed', note: '修好了，继续行驶' });
        } else rate = 0;
      }
    }
    // 孪生让它晚点到：在路边等到那个时刻
    if (f.holdUntil !== undefined) {
      if (t < f.holdUntil && moving(s)) rate = 0;
      else if (t >= f.holdUntil) f.holdUntil = undefined;
    }
    // 门店收货口：开始卸货要先占一个口，都占着就在收货场排队（开始卸货的时刻才判迟到）
    if (isStoreUnload(s) && s.place && !f.dock) {
      const free = Array.from({ length: STORE.docks }, (_, k) => `${s.place}-${k + 1}`).find((d) => !this.storeDocks.has(d));
      if (!free) {
        rate = 0;
        f.waitingDock = true;
        this.kpi.dockWaitMin += dt / MIN;
        this.by.dock.set(f.vid, (this.by.dock.get(f.vid) ?? 0) + dt / MIN);
      } else {
        f.dock = free;
        f.waitingDock = false;
        this.storeDocks.set(free, f.vid);
        this.emit({ kind: 'door', t, door: free, open: true, vid: f.vid });
        this.unloadStart(f, s.place, t);
      }
    }
    // 停车检查车门：路上要靠边停 16 分钟；在门店（等收货、卸货）时顺手就查了，不耽误
    if (f.checkUntil !== undefined) {
      if (t < f.checkUntil) {
        if (moving(s)) rate = 0;
      } else {
        if (f.reefer && f.checkFix) {
          f.reefer.seal = false;
          this.emit({ kind: 'event', t, vid: f.vid, ev: 'done', note: '司机检查车门：密封条卡住，已处理' });
        } else this.emit({ kind: 'event', t, vid: f.vid, ev: 'done', note: '司机检查车门：没发现问题' });
        f.checkUntil = undefined;
      }
    }
    if (isStoreUnload(s) && this.d.slow.has(`${f.vid}:${s.place}`)) rate = Math.min(rate, 1 / 1.8);
    // 等门店开门：门店已经开始收货了就不用等
    const before = f.tau;
    const open = isWait(s) && s.place ? ((f.op?.stops ?? []).find((x) => x.key === s.place)?.open ?? 0) * 3600 : Infinity;
    if (t >= open) f.tau = s.t1;
    else f.tau += rate * dt;
    // 冷机
    if (f.reefer) {
      const rf = f.reefer;
      const sf = this.d.seal.get(f.vid);
      if (sf !== undefined && !rf.seal && rf.sealFrom === undefined && f.tau >= sf) {
        rf.seal = true;
        rf.sealFrom = t;
      }
      const cf = this.d.comp.get(f.vid);
      if (cf !== undefined && rf.comp && rf.compFrom === undefined && f.tau >= cf) {
        rf.comp = false;
        rf.compFrom = t;
        this.emit({ kind: 'event', t, vid: f.vid, ev: 'fault', code: 'COMP', note: '冷机压缩机故障' });
      }
      const door = isLoad(s) || isStoreUnload(s) || isDcUnload(s);
      rf.st = reeferStep(rf.st, reeferParams(rf.zone), { amb: ambient(t), set: rf.set, door, seal: rf.seal, comp: rf.comp }, dt / MIN);
      const hasLoad = !isLoad(s) && (f.op?.stops ?? []).some((x) => !f.done.has(x.key)) && (f.extra?.kind !== 'rescue' || f.tau >= (f.extra.loadAt ?? 0));
      if (hasLoad && rf.st.product > LIMIT[rf.zone]) {
        this.kpi.hotMin += dt / MIN;
        tally(this.by.hot, f.vid, t, dt / MIN);
      }
    }
    // 电量
    if (f.soc !== undefined && moving(s)) {
      const p0 = this.posAt(s, before);
      const p1 = this.posAt(s, f.tau);
      f.soc = Math.max(0.03, f.soc - Math.hypot(p1.x - p0.x, p1.z - p0.z) * 0.0000312);
    }
    // 段的边界：出发、到达、离开
    const now = this.segAt(f, f.tau);
    if (!now || now.i !== cur.i) {
      if (isLoad(s) || isDcUnload(s)) {
        if (f.door && this.doors.get(f.door) === f.vid) {
          this.doors.delete(f.door);
          this.emit({ kind: 'door', t: t1, door: f.door, open: false, vid: f.vid });
        }
        f.atDoor = false;
      }
      // 从停着的地方开走（配送中心装完车、门店的线上配送车位、救援车备车、转运货物）；门店卸完货是 leave
      if (now && moving(now.s) && !moving(s) && !isStoreUnload(s)) this.emit({ kind: 'event', t: t1, vid: f.vid, ev: 'depart', place: s.place ?? '' });
      if (isStoreUnload(s) && s.place) {
        f.done.add(s.place);
        this.delivered(f, s.place, t1);
        this.releaseDock(f, t1);
        this.emit({ kind: 'event', t: t1, vid: f.vid, ev: 'leave', place: s.place });
      }
      if (now && !moving(now.s) && moving(s)) this.emit({ kind: 'event', t: t1, vid: f.vid, ev: 'arrive', place: now.s.place ?? '' });
      if (!now && f.tau >= last.t1) this.finish(f, t1);
    }
    // 感知数据：每分钟定位，每 5 分钟温度和装车进度，每 10 分钟电量
    const minute = Math.floor(t1 / MIN);
    if (Math.floor(t / MIN) !== minute && now) {
      const p = this.posAt(now.s, f.tau);
      this.emit({ kind: 'gps', t: t1, vid: f.vid, x: p.x + this.r.normal(0, 4), z: p.z + this.r.normal(0, 4) });
      if (minute % 5 === 0) {
        if (f.reefer) {
          const rf = f.reefer;
          this.emit({ kind: 'temp', t: t1, vid: f.vid, air: rf.st.air + this.r.normal(0, 0.15), product: rf.st.product + this.r.normal(0, 0.1), set: rf.set, door: isLoad(now.s) || isStoreUnload(now.s) || isDcUnload(now.s), cool: rf.st.cool });
        }
        if (isLoad(now.s) && f.door && f.atDoor) {
          const total = Math.round(f.op?.pallets ?? 20);
          const span = Math.max(1, now.s.t1 - now.s.t0);
          const done = Math.round(total * Math.min(1, (f.tau - now.s.t0) / span));
          this.emit({ kind: 'load', t: t1, vid: f.vid, door: f.door, done, total });
        }
      }
      if (minute % 10 === 0 && f.soc !== undefined) this.emit({ kind: 'soc', t: t1, vid: f.vid, soc: f.soc });
    }
  }

  private unloadStart(f: FVehicle, store: string, t: number): void {
    if (f.extra?.kind === 'restock' || f.diverted === 'store') return;
    const close = this.closeOf(store, f.op ?? (f.extra?.of !== undefined ? this.fv.find((x) => x.vid === f.extra?.of)?.op : undefined));
    const late = Math.max(0, (t - close) / MIN);
    this.stopResults.push({ vid: f.vid, store, t, close, late });
    if (late > 0.5) {
      this.kpi.lateStops++;
      this.kpi.lateMin += late;
    }
  }

  /** 卸完货：按仿真里这一站的货加到门店库存（追加补货车按它装的、改直送的长途车按它整车装的） */
  private delivered(f: FVehicle, store: string, t: number): void {
    void t;
    const add = (fam: string, units: number) => this.stock.set(fam, (this.stock.get(fam) ?? 0) + units);
    if (f.extra?.kind === 'restock' && f.extra.fam) {
      add(f.extra.fam, f.extra.units ?? 0);
      return;
    }
    if (f.diverted === 'store') {
      for (const [fam, u] of Object.entries(f.op?.load ?? {})) add(fam, u);
      return;
    }
    const op = f.op ?? (f.extra?.of !== undefined ? this.fv.find((x) => x.vid === f.extra?.of)?.op : undefined);
    const stop = (op?.stops ?? []).find((x) => x.key === store);
    for (const [fam, u] of Object.entries(stop?.load ?? {})) add(fam, u);
  }

  private releaseDock(f: FVehicle, t: number): void {
    if (!f.dock) return;
    if (this.storeDocks.get(f.dock) === f.vid) this.storeDocks.delete(f.dock);
    this.emit({ kind: 'door', t, door: f.dock, open: false, vid: f.vid });
    f.dock = undefined;
  }

  private finish(f: FVehicle, t: number): void {
    if (f.finished) return;
    f.finished = true;
    f.endAt = t;
    if (f.door && this.doors.get(f.door) === f.vid) this.doors.delete(f.door);
    if (f.dock) this.releaseDock(f, t);
  }

  /** 门店每个商品族按这一天的需求和小时曲线卖货；收银每 15 分钟、盘点每小时报一次 */
  private storeStep(t: number, dt: number): void {
    const t1 = t + dt;
    const q = Math.floor(t1 / 900) !== Math.floor(t / 900);
    const hour = Math.floor(t1 / 3600) !== Math.floor(t / 3600);
    const h = Math.floor((t / 3600) % 24);
    for (const fam of FAMILIES) {
      let rate = ((this.demand.get(fam.key) ?? 0) * (HOUR_W[h] as number)) / 3600;
      for (const sp of this.d.spikes) if (sp.fam === fam.key && t >= sp.t0 && t < sp.t1) rate *= sp.f;
      const want = rate * dt;
      const have = this.stock.get(fam.key) ?? 0;
      const got = Math.min(have, want);
      this.stock.set(fam.key, have - got);
      this.sold.set(fam.key, (this.sold.get(fam.key) ?? 0) + got);
      if (rate > 0 && have - got <= 0.5) {
        this.kpi.shortMin += dt / MIN;
        tally(this.by.short, fam.key, t, dt / MIN);
      }
      this.kpi.lostUnits += want - got;
      if (q) {
        this.emit({ kind: 'pos', t: t1, store: STORE.key, fam: fam.key, units: Math.round((this.sold.get(fam.key) ?? 0) * (1 + this.r.normal(0, 0.03))) });
        this.sold.set(fam.key, 0);
      }
      if (hour) this.emit({ kind: 'stock', t: t1, store: STORE.key, fam: fam.key, units: Math.max(0, Math.round((this.stock.get(fam.key) ?? 0) * (1 + this.r.normal(0, 0.02)))) });
    }
  }

  // ———————————————————————— 执行指令 ————————————————————————

  apply(c: Cmd, t: number): void {
    switch (c.kind) {
      case 'notifyStore': {
        const ok = this.r.next() < 0.9;
        this.pending.push({
          at: t + 6 * MIN,
          run: () => {
            if (ok) {
              this.extendTo.set(c.store, Math.max(this.extendTo.get(c.store) ?? 0, c.until));
              this.kpi.notified++;
              this.kpi.cost += 25;
            }
            this.msgs.push({ kind: 'event', t: t + 6 * MIN, vid: -1, ev: 'ack', place: c.store, note: ok ? '门店确认：收货顺延' : '门店回复：人手不够，没法顺延' });
          },
        });
        break;
      }
      case 'setpoint': {
        const f = this.fv.find((x) => x.vid === c.vid);
        if (f?.reefer) {
          const rf = f.reefer;
          this.pending.push({ at: t + MIN, run: () => (rf.set = SETPOINT[rf.zone] + c.delta) });
        }
        break;
      }
      case 'driverCheck': {
        const f = this.fv.find((x) => x.vid === c.vid);
        if (f) {
          const fix = this.r.next() < 0.88;
          this.pending.push({
            at: t + 4 * MIN,
            run: () => {
              f.checkUntil = t + 16 * MIN;
              f.checkFix = fix;
              this.msgs.push({ kind: 'event', t: t + 4 * MIN, vid: f.vid, ev: 'ack', note: '司机收到，就近停车检查' });
            },
          });
        }
        break;
      }
      case 'reassignDoor': {
        const f = this.fv.find((x) => x.vid === c.vid);
        if (f && !f.atDoor) f.door = c.door;
        break;
      }
      case 'resequence':
        this.resequence(c.vid, c.order, t);
        break;
      case 'rescue':
        this.rescue(c.vid, t);
        break;
      case 'restock':
        this.restock(c.fam, c.units, t);
        break;
      case 'divert':
        this.divert(c.vid, c.to, t);
        break;
      case 'hold': {
        const f = this.fv.find((x) => x.vid === c.vid);
        if (f && !f.finished) {
          f.holdUntil = c.until;
          this.emit({ kind: 'event', t, vid: f.vid, ev: 'ack', note: `司机收到：${Math.round((c.until - t) / MIN)} 分钟后再进门店收货场` });
        }
        break;
      }
    }
  }

  /** 从某个地点开到一串门店，返回新的段（计划时钟从 tau 开始）和里程 */
  private legs(from: string, stores: string[], tau: number, tReal: number, op: BoardOp | undefined, back: string): { segs: WSeg[]; km: number } {
    const segs: WSeg[] = [];
    let at = from;
    let tt = tau;
    let km = 0;
    for (const key of [...stores, back]) {
      const p = this.routes.get(at, key);
      const h = travelHours(p, ((tReal + (tt - tau)) / 3600) % 24);
      const st = STORES.find((x) => x.key === key);
      segs.push({ t0: tt, t1: tt + h * 3600, pts: p.pts.flatMap((k) => toXZ(k)), route: p.nodes, act: st ? `开往${st.name}` : '回配送中心' });
      km += p.km;
      tt += h * 3600;
      if (st) {
        const stop = (op?.stops ?? []).find((s) => s.key === key);
        const unload = stop ? stop.end - stop.start : 20 * MIN;
        segs.push({ t0: tt, t1: tt + unload, pts: toXZ(st.dock), place: key, act: `在${st.name}卸货` });
        tt += unload;
      }
      at = key;
    }
    return { segs, km };
  }

  private resequence(vid: number, order: string[], t: number): void {
    const f = this.fv.find((x) => x.vid === vid);
    if (!f || f.finished) return;
    const cur = this.segAt(f, f.tau);
    if (!cur) return;
    // 正在路上：从下一站之前的那个地点重新出发（这里简化成从当前段的终点重排剩下的站）
    const keep = f.v.segs.slice(0, cur.i + 1);
    const from = cur.s.place && /^S\d\d$/.test(cur.s.place) ? cur.s.place : (cur.s.route?.[cur.s.route.length - 1] ?? 'DC');
    const remaining = order.filter((k) => !f.done.has(k) && k !== cur.s.place);
    const target = cur.s.route?.[cur.s.route.length - 1];
    // 当前段是开往某家店：这一段照常开完，到店后按新顺序继续
    const firstStop = target && /^S\d\d$/.test(target) ? target : undefined;
    const rest = remaining.filter((k) => k !== firstStop);
    const tail = f.v.segs.slice(cur.i + 1);
    const unloadNext = firstStop ? tail.find((s) => s.place === firstStop && /卸货/.test(s.act ?? '')) : undefined;
    const base = unloadNext ? [...keep, ...tail.slice(0, tail.indexOf(unloadNext) + 1)] : keep;
    const lastSeg = base[base.length - 1] as WSeg;
    const { segs, km } = this.legs(firstStop ?? from, rest, lastSeg.t1, t + (lastSeg.t1 - f.tau), f.op, f.op?.from === 'BAKERY' ? 'BAKERY' : 'DC');
    f.v = { ...f.v, segs: [...base, ...segs] };
    this.kpi.extraKm += Math.max(0, km - (f.op?.km ?? km)) * 0.2;
    this.emit({ kind: 'event', t, vid, ev: 'ack', note: `司机收到新顺序：${rest.map((k) => STORES.find((s) => s.key === k)?.name ?? k).join(' → ')}` });
  }

  private rescue(vid: number, t: number): void {
    const f = this.fv.find((x) => x.vid === vid);
    if (!f || f.finished || f.heldBy !== undefined) return;
    const cur = this.segAt(f, f.tau);
    if (!cur) return;
    const p = this.posAt(cur.s, f.tau);
    // 最近的道路节点：救援车开到那里接货
    let near = 'DC';
    let bd = Infinity;
    for (const [id, k] of Object.entries(NODES)) {
      const [x, z] = toXZ(k as Km);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bd) {
        bd = d;
        near = id;
      }
    }
    const remaining = (f.op?.stops ?? []).map((s) => s.key).filter((k) => !f.done.has(k));
    if (!remaining.length) return;
    // 原来的车停在原地等救援车（抛锚的修好以后、冷机坏的转完货以后收车，空车回配送中心）
    f.retire = true;
    // 救援车：15 分钟备车，开到抛锚处，转运 30 分钟，再送剩下的门店（出发时是空车，冷机预冷到设定温度）
    const id = this.input.vehicles.length + this.fv.filter((x) => x.extra).length;
    const out = this.routes.get('DC', near);
    const h0 = travelHours(out, (t / 3600) % 24);
    const s0: WSeg = { t0: t, t1: t + 15 * MIN, pts: toXZ(NODES.DC as Km), place: 'DC', act: '救援车备车' };
    const s1: WSeg = { t0: s0.t1, t1: s0.t1 + h0 * 3600, pts: out.pts.flatMap((k) => toXZ(k)), route: out.nodes, act: '开往抛锚的车' };
    const s2: WSeg = { t0: s1.t1, t1: s1.t1 + 30 * MIN, pts: [p.x, p.z], act: '转运货物' };
    const rest = this.legs(near, remaining, s2.t1, s2.t1, f.op, 'DC');
    const v: WVehicle = { id, kind: f.v.kind, label: `救援车（接 ${f.op?.id ?? '抛锚车'} 的货）`, segs: [s0, s1, s2, ...rest.segs] };
    const zone = f.reefer?.zone;
    const nf: FVehicle = {
      vid: id,
      v,
      op: f.op,
      tau: t,
      started: false,
      finished: false,
      door: undefined,
      atDoor: false,
      waitingDoor: false,
      loadLeft: 0,
      reefer: zone ? { zone, st: { air: SETPOINT[zone], product: SETPOINT[zone], cool: false }, set: SETPOINT[zone], seal: false, comp: true } : undefined,
      soc: f.soc !== undefined ? 0.95 : undefined,
      done: new Set((f.op?.stops ?? []).map((s) => s.key).filter((k) => !remaining.includes(k))),
      extra: { kind: 'rescue', of: vid, loadAt: s2.t1 },
    };
    f.heldBy = id;
    this.fv.push(nf);
    this.kpi.extraKm += out.km + rest.km;
    this.kpi.cost += 180 + (out.km + rest.km) * 1.2;
    this.emit({ kind: 'event', t, vid: id, ev: 'ack', note: `救援车出发，接 ${f.op?.id ?? ''} 的 ${remaining.length} 家店` });
  }

  /** 配送中心追加一趟小车：装车 20 分钟、开到门店、卸货 20 分钟、回配送中心（一车最多 RESTOCK_PALLETS 托） */
  private restock(famKey: string, units: number, t: number): void {
    const fam = FAMILIES.find((x) => x.key === famKey);
    if (!fam) return;
    const u = Math.min(units, RESTOCK_PALLETS * casesPerPallet(fam) * fam.unitsPerCase);
    const id = this.input.vehicles.length + this.fv.filter((x) => x.extra).length;
    const out = this.routes.get('DC', STORE.key);
    const back = this.routes.get(STORE.key, 'DC');
    const h = travelHours(out, (t / 3600) % 24);
    const t1 = t + 20 * MIN + h * 3600;
    const segs: WSeg[] = [
      { t0: t, t1: t + 20 * MIN, pts: toXZ(NODES.DC as Km), place: 'DC', act: '在配送中心装追加补货' },
      { t0: t + 20 * MIN, t1, pts: out.pts.flatMap((k) => toXZ(k)), route: out.nodes, act: `开往${STORE.name}` },
      { t0: t1, t1: t1 + 20 * MIN, pts: toXZ(STORE.dock), place: STORE.key, act: `在${STORE.name}卸货` },
      { t0: t1 + 20 * MIN, t1: t1 + 20 * MIN + travelHours(back, ((t1 + 20 * MIN) / 3600) % 24) * 3600, pts: back.pts.flatMap((k) => toXZ(k)), route: back.nodes, act: '回配送中心' },
    ];
    const kind = fam.temp === 'ambient' ? 'truck' : 'reefer';
    const zone: ReeferZone | undefined = fam.temp === 'frozen' ? 'frozen' : fam.temp === 'chilled' ? 'chilled' : undefined;
    this.fv.push({ vid: id, v: { id, kind, label: `追加补货车（${fam.label}，${Math.round(u)} 件）`, segs }, op: undefined, tau: t, started: false, finished: false, door: undefined, atDoor: false, waitingDoor: false, loadLeft: 0, reefer: zone ? { zone, st: { air: SETPOINT[zone], product: SETPOINT[zone] + 0.3, cool: false }, set: SETPOINT[zone], seal: false, comp: true } : undefined, soc: undefined, done: new Set(), extra: { kind: 'restock', fam: famKey, units: u } });
    this.kpi.extraKm += out.km + back.km;
    this.kpi.cost += 150 + (out.km + back.km) * 1.2;
    this.emit({ kind: 'event', t, vid: id, ev: 'ack', place: 'DC', fam: famKey, units: Math.round(u), note: `配送中心追加补货：${fam.label} ${Math.round(u)} 件` });
  }

  /**
   * 改去处：长途进配送中心的车改直送门店（还没到配送中心的才行），直送车改送配送中心（还没到门店的才行）。
   * 从当前这段路的终点重新排路线，到了卸货，再回高速口。
   */
  private divert(vid: number, to: 'store' | 'DC', t: number): void {
    const f = this.fv.find((x) => x.vid === vid);
    if (!f || f.finished || f.diverted) return;
    const cur = this.segAt(f, f.tau);
    if (!cur || !moving(cur.s)) return;
    const target = to === 'store' ? STORE.key : 'DC';
    const from = cur.s.route?.[cur.s.route.length - 1] ?? 'DC';
    if (from === target) return;
    const back = f.op?.from ?? 'NORTH';
    const keep = f.v.segs.slice(0, cur.i + 1);
    const p = this.routes.get(from, target);
    const tt0 = cur.s.t1;
    const h = travelHours(p, ((t + (tt0 - f.tau)) / 3600) % 24);
    const unload = (15 + (f.op?.pallets ?? 20) * 1.5) * MIN;
    const ret = this.routes.get(target, back);
    const segs: WSeg[] = [
      { t0: tt0, t1: tt0 + h * 3600, pts: p.pts.flatMap((k) => toXZ(k)), route: p.nodes, act: to === 'store' ? `改直送${STORE.name}` : '改送配送中心' },
      { t0: tt0 + h * 3600, t1: tt0 + h * 3600 + unload, pts: to === 'store' ? toXZ(STORE.dock) : toXZ(NODES.DC as Km), place: target, act: to === 'store' ? `在${STORE.name}卸货` : '在配送中心卸货' },
      { t0: tt0 + h * 3600 + unload, t1: tt0 + h * 3600 + unload + travelHours(ret, 12) * 3600, pts: ret.pts.flatMap((k) => toXZ(k)), route: ret.nodes, act: '回高速口' },
    ];
    f.v = { ...f.v, segs: [...keep, ...segs] };
    f.diverted = to;
    if (to === 'DC') f.door = undefined;
    this.kpi.extraKm += Math.max(0, p.km - (cur.s.route ? 0 : 0)) * 0.3;
    this.kpi.cost += 40;
    this.emit({ kind: 'event', t, vid, ev: 'ack', note: to === 'store' ? `司机收到：改直送${STORE.name}` : '司机收到：改送配送中心' });
  }
}
