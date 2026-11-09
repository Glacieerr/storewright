import { Rng } from '../../../StoreX/src/core/rng';
import { BASE_UNITS, FAMILIES, casesPerPallet, PALLETS_PER_FEU, PALLETS_PER_MULTI_TEMP, PALLETS_PER_TRAILER, type Family, type Source, type Temp } from '../region/products';
import { buildGraph, currentRegion, dcMainRoad, Routes, STORE, STORES, travelHours, type PathInfo, type StoreSite } from '../region/network';
import { NODES, RAIL, RAIL_DC_INDEX, RAIL_PORT_INDEX, type Km } from '../region/region';
import { flightHours, nextWeekDay, trainDays, vesselDays, type ChainScenario, type Disruption, type DisruptionKey } from './config';
import { directLoads } from './flows';
import { planRoutes, routeKm, type Job, type Route } from './routing';
import { WorldTrace, type Op, type OpKind } from './trace';

/**
 * 全链路仿真：按小时推进若干天。
 *
 * - 门店：每个商品族分 4 个「商品位」（代表畅销到长尾的单品），每小时按需求卖货，卖空了算缺货；
 *   每晚 22 点按「补到目标量」给下一次配送下单；生鲜按批次记年龄，过期报废、临期打折；
 * - 配送中心：按门店订单分配库存（不够时按比例），排线路、派车；按预测给供应商下单；
 * - 上游：长途公路供应商（含跨境，整车；按规划直送门店或进配送中心）、区域生鲜（内陆产区的集货车）、中央面包房（每天按单生产）、
 *   海运（每周一班船 → 堆场 → 拖车或铁路）、洲际铁路班列（每周一列 → 物流园货运站）、空运（每天一班 → 货站 → 冷藏车）；
 *   海运、班列、空运的货都先进配送中心，再用卡车送店；
 * - 生鲜的「年龄」从产地算起，每一段运输和停留都在消耗保质期，所以链条越快，门店的生鲜越新鲜、报废越少。
 *
 * 需求、促销、船期等只用独立的随机数子流，三代方案在同一个种子下面对完全相同的需求（公共随机数）。
 */
export { BASE_UNITS };
const SLOT_W = [0.4, 0.3, 0.2, 0.1];
const WEEKDAY_RAW = [0.93, 0.9, 0.95, 1.0, 1.1, 1.17, 0.95];
const WEEKDAY = WEEKDAY_RAW.map((x) => (x * 7) / WEEKDAY_RAW.reduce((a, b) => a + b, 0));
/** 门店 7–22 点营业，每小时的需求比例（与 StoreX 的到店曲线一致） */
const CURVE = [3, 5, 6, 7, 9, 9, 7, 6, 7, 9, 10, 9, 7, 4, 2];
export const HOUR_W = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 22 ? (CURVE[h - 7] as number) / CURVE.reduce((a, b) => a + b, 0) : 0));
/** 生鲜陈列量系数、每天的搬运和品相损耗（校准到门店常见的损耗水平） */
const PRESENTATION: Partial<Record<string, number>> = { dairy: 1.0, produce: 1.3, meat: 0.6, bakery: 0.5 };
const SPOIL: Partial<Record<string, number>> = { dairy: 0.009, produce: 0.04, meat: 0.02, bakery: 0.03 };
/** 配送中心不再往门店发剩余保质期不到三成的货 */
const dcMinRemain = (life: number) => Math.max(2, Math.round(life * 0.3));
/** 配送车次的编号前缀：冷藏 L、冷冻 F、常温 A、多温区 M、面包车 B（编号 = 前缀 + 当天这个温区的第几趟） */
export const ZONE_CODE: Record<string, string> = { chilled: 'L', frozen: 'F', ambient: 'A', multi: 'M', bakery: 'B' };

interface Cohort {
  q: number;
  age: number;
}
interface Slot {
  onHand: number;
  cohorts: Cohort[];
  onOrder: number;
}
interface DcFam {
  onHand: number;
  cohorts: Cohort[];
  onOrder: number;
  fcst: number;
  sse: number;
  /** 共享销售数据给出的当天订单预测（全链路） */
  posFcst: number;
  /** 当天门店订单（件）、当天门店实际需求（件） */
  ordersToday: number;
  demandToday: number;
}
type Ev =
  | { type: 'dc'; t: number; fam: number; units: number; age: number; pallets: number; src: Source | 'backhaul'; ordered: number; box?: { rail: boolean; dwell: number; wait: number }; train?: boolean }
  | { type: 'store'; t: number; store: number; items: { fam: number; units: number[]; ordered: number[]; ages: Cohort[] }[]; onTime: boolean; direct?: { fam: number; loads: number; pallets: number; km: number } };

export interface ChainResult {
  name: string;
  gen: ChainScenario['gen'];
  seed: number;
  days: number;
  /** 每天的平均值（只算预热期之后） */
  store: {
    demandUnits: number;
    soldUnits: number;
    lostUnits: number;
    service: number;
    lostMargin: number;
    wastePct: number;
    wasteUnits: number;
    markdownCost: number;
    invDays: number;
    invValue: number;
    freshAgeDays: number;
    freshRemainPct: number;
    deliveries: number;
    arrivals: number;
    onTimePct: number;
    stockoutSlotPct: number;
    /** 每个温区每天最多的时候放了多少托（货架 + 后仓）：平均、95% 的日子不超过（门店要准备的仓储） */
    peakPallets: Record<Temp, number>;
    peakPallets95: Record<Temp, number>;
  };
  dc: { invDays: number; invValue: number; fillPct: number; wasteUnits: number; laborHours: number; casesPicked: number; casesPerHour: number; inboundPallets: number; outboundPallets: number };
  outbound: { trips: number; km: number; driverHours: number; fillPct: number; evKm: number; dieselKm: number; reeferHours: number; fleet: number; vanTrips: number; vanKm: number; stopsPerTrip: number };
  /** 进货：到配送中心的长途整车、回程顺带、区域生鲜集货、海运集装箱（其中走铁路接驳的）、班列箱；长途直送门店的整车 */
  inbound: { truckloads: number; km: number; backhaulLoads: number; milkRuns: number; milkKm: number; containers: number; railContainers: number; drayageKm: number; portDwellDays: number; demurrage: number; airKg: number; seaTonnes: number; trainBoxes: number; railTonnes: number; directLoads: number; directKm: number; directPallets: number };
  leadTime: { domesticDays: number; seaDays: number; railDays: number; airDays: number; localDays: number };
  cost: { outbound: number; vans: number; inbound: number; drayageRail: number; freight: number; dcLabor: number; carrying: number; waste: number; lostMargin: number; total: number; perCase: number };
  co2: { outbound: number; vans: number; inbound: number; portRail: number; longHaul: number; total: number; perCase: number };
  /** 门店送达的箱数（每天） */
  casesDelivered: number;
  /** 每个商品族：配送中心满足率、门店服务水平、生鲜报废率、配送中心库存天数 */
  byFamily: { key: string; label: string; dcFill: number; service: number; wastePct: number; dcDays: number; dcWasteUnits: number }[];
  daily: { service: number[]; dcInvDays: number[]; storeInvDays: number[]; lost: number[]; onTime: number[]; airService: number[] };
  /** 应对扰动多花的钱（过桥采购的差价、备降机场的卡车运费），整个运行期合计 */
  responseCost: number;
  /** 预测模型训练用的记录（场景设了 history 才有） */
  history?: ChainHistory;
  trace?: ReturnType<WorldTrace['toJSON']>;
}

/**
 * 预测模型训练用的记录：每天（含预热期）每个商品族的需求（各店合计，件）、期望需求（不含随机波动）、促销倍数（促销日历，事先知道）；
 * 运行期里每班本店班轮、每列洲际班列按时刻表的日子和实际晚到的天数（含港口拥堵多晚的）
 */
export interface ChainHistory {
  demand: number[][];
  expected: number[][];
  promo: number[][];
  calls: { day: number; delay: number }[];
  trains: { day: number; delay: number }[];
}

export function runChain(s: ChainScenario): ChainResult {
  const rng = new Rng(s.seed);
  const demandRng = rng.fork('demand');
  const promoRng = rng.fork('promo');
  const vesselRng = rng.fork('vessel');
  const trainRng = rng.fork('train');
  const opsRng = rng.fork('ops');
  const fcRng = rng.fork('forecast');
  const days = s.days;
  const NF = FAMILIES.length;
  const NS = STORES.length;
  const NK = SLOT_W.length;
  // 扰动：disruption 加上同时发生的 disruptions（同一种扰动只取第一条）
  const disList: Disruption[] = [...(s.disruption ? [s.disruption] : []), ...(s.disruptions ?? [])];
  const disOf = (key: DisruptionKey): Disruption | undefined => disList.find((x) => x.key === key);
  const inDis = (key: DisruptionKey, d: number) => {
    const x = disOf(key);
    return !!x && d >= x.start && d < x.start + x.days;
  };
  const closed = new Set<string>();
  const routesOpen = new Routes(buildGraph());
  // 道路封闭：物流园进城的主路（配送中心到门店最短路上的第一段高速）
  const routesClosed = new Routes(buildGraph(new Set([dcMainRoad()])));
  void closed;
  const trace = s.traceDay >= 0 ? new WorldTrace(s.traceDay) : undefined;
  // 船期延误：开始时按固定顺序抽好（动画打开与否不会改变随机数的顺序）
  // 每周的航次、班列（负荷档位加密时一周几班）、每天的货运航班
  const callDays = vesselDays(s);
  const tDays = trainDays(s);
  const fHours = flightHours(s);
  const vesselDelays = new Map<number, number>();
  for (let w = 0; w * 7 < days + 70; w++) for (const cd of callDays) vesselDelays.set(w * 7 + cd, s.port.vesselDelayDays * vesselRng.logNormal(1, 0.8));
  // 班列晚点：同样开始时抽好（按时刻表上的到站日）
  const trainDelays = new Map<number, number>();
  for (let w = 0; w * 7 < days + 70; w++) for (const td of tDays) trainDelays.set(w * 7 + td, s.rail.delayDays * trainRng.logNormal(1, 0.6));

  // —— 促销日历（每周四到周日，2 个商品族）——
  const promo: number[][] = FAMILIES.map(() => new Array<number>(days + 14).fill(1));
  for (let w = 0; w * 7 < days + 14; w++) {
    const picks = new Set<number>();
    while (picks.size < s.demand.promoPerWeek) picks.add(Math.floor(promoRng.next() * NF));
    for (const f of picks) for (let k = 3; k <= 6; k++) if (w * 7 + k < days + 14) (promo[f] as number[])[w * 7 + k] = 1 + s.demand.promoUplift;
  }
  const surge = (d: number) => (inDis('demandSurge', d) ? (disOf('demandSurge')?.factor ?? 1.35) : 1);
  /** 某一天某个商品族的期望需求（件，不含随机波动） */
  const expected = (st: StoreSite, f: number, d: number, promoKnown: number, surgeKnown: boolean) => {
    const fam = FAMILIES[f] as Family;
    const p = (promo[f] as number[])[Math.min(d, days + 13)] as number;
    return BASE_UNITS * s.demand.scale * st.size * fam.share * (WEEKDAY[d % 7] as number) * (1 + (p - 1) * promoKnown) * (surgeKnown ? surge(d) : 1);
  };
  const surgeKnown = (d: number, responseDays: number) => {
    const x = disOf('demandSurge');
    return !!x && d >= x.start + responseDays && d < x.start + x.days;
  };
  // 预测模型训练用的记录（只读，不抽随机数）
  const hist: ChainHistory | undefined = s.history ? { demand: FAMILIES.map(() => new Array<number>(days).fill(0)), expected: FAMILIES.map(() => new Array<number>(days).fill(0)), promo: FAMILIES.map((_, f) => (promo[f] as number[]).slice(0, days)), calls: [], trains: [] } : undefined;

  // —— 门店状态 ——
  const zoneOf = (f: Family): Temp | 'bakery' => (f.source === 'bakery' ? 'bakery' : f.temp);
  const deliversOn = (st: StoreSite, z: Temp | 'bakery', d: number) => {
    if (z === 'bakery') return true;
    const sched = s.store.deliveryDays[z];
    return (st.id % 2 === 0 ? sched.A : sched.B).includes(d % 7);
  };
  const daysToNext = (st: StoreSite, z: Temp | 'bakery', d: number) => {
    for (let k = 1; k <= 7; k++) if (deliversOn(st, z, d + k)) return k;
    return 7;
  };
  /** 长途整车直送门店的商品族：门店直接向供应商订整车（降到订货点就订），不经过配送中心 */
  const isDirect = (fam: Family) => fam.source === 'domestic' && s.flow.direct.includes(fam.key);
  const unitsPerPalletOf = (fam: Family) => casesPerPallet(fam) * fam.unitsPerCase;
  /** 直送一次的量（件）和平均几天来一车 */
  const directQ = (fam: Family) => directLoads(s, fam) * PALLETS_PER_TRAILER * unitsPerPalletOf(fam);
  const directInterval = (st: StoreSite, f: number) => directQ(FAMILIES[f] as Family) / Math.max(1, expected(st, f, 3, 0, false));
  const slots: Slot[][][] = STORES.map((st) =>
    FAMILIES.map((fam, f) =>
      SLOT_W.map((w) => {
        const mean = expected(st, f, 0, 0, false) * w;
        const cycle = isDirect(fam) ? directInterval(st, f) : daysToNext(st, zoneOf(fam), 0);
        const cover = mean * (cycle * 0.6 + 1 + (fam.life ? s.store.presentationDays * (PRESENTATION[fam.cat] ?? 0) : 0.3));
        return fam.life ? { onHand: 0, cohorts: [{ q: cover * 0.6, age: 2 }, { q: cover * 0.4, age: 1 }], onOrder: 0 } : { onHand: cover, cohorts: [], onOrder: 0 };
      }),
    ),
  );
  const stockOf = (sl: Slot) => (sl.cohorts.length ? sl.cohorts.reduce((a, c) => a + c.q, 0) : sl.onHand);
  /** 到货前一天里已经卖掉的比例（按出车时段的中点 + 1 小时路程估算到货时刻） */
  const beforeArrival = (z: Temp | 'bakery') => {
    const w = s.fleet.consolidated ? s.fleet.windows.multi : z === 'bakery' ? ([4.5, 6] as [number, number]) : s.fleet.windows[z];
    const arrive = (w[0] + w[1]) / 2 + 1;
    let share = 0;
    for (let h = 0; h < 24; h++) if (h + 0.5 < arrive) share += HOUR_W[h] as number;
    return share;
  };

  // —— 配送中心状态 ——
  const chainMean = (f: number) => STORES.reduce((a, st) => a + expected(st, f, 3, 0, false), 0);
  /** 下单周期：生鲜每天（海运冷箱每周），不易腐的按货源 */
  const reviewOf = (fam: Family) => (fam.life ? (fam.source === 'sea' ? 7 : 1) : s.dc.reviewDays[fam.source]);
  /** 提前期：国内生鲜（肉类）第二天到；跨境的过境清关多 2 天 */
  const leadOf = (fam: Family) => (fam.life && fam.source === 'domestic' ? 1 : s.dc.leadDays[fam.source]) + (fam.supplier?.border ? 2 : 0);
  /** 海运：下单到进配送中心的天数（等下一班船 + 航程 + 延误 + 卸船 + 堆场 + 铁路班次或拖车）；不给日期时按平均等船 3.5 天 */
  const seaLead = (d?: number) => {
    let wait = 3.5 / callDays.length + s.dc.leadDays.sea;
    if (d !== undefined) wait = nextWeekDay(d + s.dc.leadDays.sea, callDays) - d;
    return wait + s.port.vesselHour / 24 + s.port.vesselDelayDays + 0.55 + s.port.dwellDays + s.port.railShare * 1.3 + (1 - s.port.railShare) * 0.1;
  };
  /** 班列：备好货的那天之后，第一班「到站前 transitDays 天发车」的班列哪天到站 */
  const railArrival = (ready: number) => nextWeekDay(ready + s.rail.transitDays, tDays);
  /** 班列：下单到进配送中心的天数；不给日期时按平均等车 3.5 天 */
  const railLead = (d?: number) => (d === undefined ? 3.5 / tDays.length + s.dc.leadDays.rail + s.rail.transitDays : railArrival(d + s.dc.leadDays.rail) - d) + s.rail.arriveHour / 24 + s.rail.delayDays + s.rail.terminalHours / 24;
  const dcLead = (fam: Family, d?: number) => (fam.source === 'sea' ? seaLead(d) : fam.source === 'rail' ? railLead(d) : leadOf(fam) + 0.5);
  /** 易腐品到配送中心时的年龄（天）和在配送中心能放的天数（到「不再往门店发」为止） */
  const arrivalAge = (fam: Family) => (fam.source === 'sea' ? 14.5 + s.port.dwellDays : fam.source === 'air' ? 1.9 : fam.source === 'local' ? 0.6 : 2);
  const dcWindow = (fam: Family) => (fam.life ? Math.max(1, fam.life - dcMinRemain(fam.life) - arrivalAge(fam)) : Infinity);
  /** 提前期的标准差（天） */
  const leadSigma = (fam: Family) =>
    fam.source === 'sea' ? Math.sqrt((s.port.vesselDelayDays * 0.8) ** 2 + (s.port.dwellDays * s.port.dwellCv) ** 2 + (s.port.railShare > 0 ? 0.8 : 0.2) ** 2) : fam.source === 'rail' ? s.rail.delayDays * 0.7 : fam.source === 'domestic' ? leadOf(fam) * s.dc.leadCv : fam.source === 'air' ? 0.1 : 0.05;
  const dc: DcFam[] = FAMILIES.map((fam, f) => {
    const m = chainMean(f);
    const cover = m * (reviewOf(fam) / 2 + 1 + s.dc.safetyZ * 0.3 * Math.sqrt(reviewOf(fam) + dcLead(fam)));
    return fam.source === 'bakery' || isDirect(fam) ? { onHand: 0, cohorts: [], onOrder: 0, fcst: m, sse: 0, posFcst: m, ordersToday: 0, demandToday: 0 } : fam.life ? { onHand: 0, cohorts: [{ q: cover, age: 1.5 }], onOrder: 0, fcst: m, sse: (m * 0.3) ** 2, posFcst: m, ordersToday: 0, demandToday: 0 } : { onHand: cover, cohorts: [], onOrder: 0, fcst: m, sse: (m * 0.3) ** 2, posFcst: m, ordersToday: 0, demandToday: 0 };
  });
  const dcStock = (x: DcFam) => (x.cohorts.length ? x.cohorts.reduce((a, c) => a + c.q, 0) : x.onHand);
  /** 易腐品的「可用」库存：按先进先出、每天发 F 往后推，到出库期限还发不完的部分不算 */
  const usableStock = (x: DcFam, fam: Family, F: number) => {
    if (!fam.life) return dcStock(x);
    const cutoff = fam.life - dcMinRemain(fam.life);
    let used = 0;
    for (const c of x.cohorts) used += Math.min(c.q, Math.max(0, F * (cutoff - c.age) - used));
    return used;
  };

  // —— 事件队列（按小时） ——
  const queue: Ev[] = [];
  const push = (e: Ev) => {
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((queue[mid] as Ev).t <= e.t) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, e);
  };

  // —— 统计 ——
  const measured = (d: number) => d >= s.warmup;
  const M = { demand: 0, sold: 0, lost: 0, lostMargin: 0, waste: 0, received: 0, markdown: 0, invUnits: 0, invValue: 0, dcInvUnits: 0, dcInvValue: 0, transitValue: 0, freshAgeSum: 0, freshRemainSum: 0, freshUnits: 0, deliveries: 0, onTime: 0, stockoutSlots: 0, slotDays: 0, dcOrdered: 0, dcShipped: 0, dcWaste: 0, picked: 0, inPallets: 0, outPallets: 0, laborHours: 0, trips: 0, km: 0, driverHours: 0, palletsOut: 0, capOut: 0, evKm: 0, dieselKm: 0, reeferHours: 0, fleetMax: 0, vanTrips: 0, vanKm: 0, vanHours: 0, vanFleet: 0, stops: 0, vanStops: 0, inLoads: 0, inKm: 0, backhaul: 0, backhaulKm: 0, milk: 0, milkKm: 0, milkHours: 0, containers: 0, rail: 0, drayKm: 0, drayWait: 0, dwellSum: 0, demurrageDays: 0, airKg: 0, seaKg: 0, leadDom: [0, 0], leadSea: [0, 0], leadRail: [0, 0], leadAir: [0, 0], leadLocal: [0, 0], trainBoxes: 0, railKg: 0, directLoads: 0, directKm: 0, directPallets: 0, cases: 0, trucksDays: 0, trailers: { dry: 0, reefer: 0, multi: 0 }, evTrucksDays: 0 };
  const daily = { service: [] as number[], dcInvDays: [] as number[], storeInvDays: [] as number[], lost: [] as number[], onTime: [] as number[], airService: [] as number[] };
  let responseCost = 0;
  const dayStats = { deliveries: 0, onTime: 0, airDemand: 0, airLost: 0 };
  const FM = FAMILIES.map(() => ({ ordered: 0, shipped: 0, demand: 0, lost: 0, waste: 0, received: 0, dcUnits: 0, dcWaste: 0 }));
  // 门店每个温区的货（托，货架 + 后仓）：每小时到货以后看一次，记当天最多的时候（直送的整车一次到，门店要多准备仓储）
  const TEMPS: readonly Temp[] = ['ambient', 'chilled', 'frozen'];
  const zeroZones = (): Record<Temp, number> => ({ ambient: 0, chilled: 0, frozen: 0 });
  const zonePeak = STORES.map(zeroZones);
  const zoneDaily: Record<Temp, number[]> = { ambient: [], chilled: [], frozen: [] };
  function watchZones(): void {
    for (let i = 0; i < NS; i++) {
      const z = zeroZones();
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        let q = 0;
        for (const sl of (slots[i] as Slot[][])[f] as Slot[]) q += stockOf(sl);
        z[fam.temp] += q / unitsPerPalletOf(fam);
      }
      const peak = zonePeak[i] as Record<Temp, number>;
      for (const k of TEMPS) peak[k] = Math.max(peak[k], z[k]);
    }
  }
  function closeZones(d: number): void {
    for (const peak of zonePeak)
      for (const k of TEMPS) {
        if (measured(d)) zoneDaily[k].push(peak[k]);
        peak[k] = 0;
      }
  }
  const valueOf = (f: number, units: number) => (units * (FAMILIES[f] as Family).caseCost) / (FAMILIES[f] as Family).unitsPerCase;

  // 记录链条各段的时间（下单 → 到店），按货源
  const orderTime = new Map<string, number>();

  // —— 每天的需求（公共随机数） ——
  const demandOf: number[][][] = STORES.map(() => FAMILIES.map(() => new Array<number>(NK).fill(0)));
  function drawDemand(d: number): void {
    for (let i = 0; i < NS; i++) {
      const st = STORES[i] as StoreSite;
      const day = demandRng.logNormal(1, s.demand.storeNoise);
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        const base = expected(st, f, d, 1, true) * day;
        for (let k = 0; k < NK; k++) (demandOf[i] as number[][])[f]![k] = base * (SLOT_W[k] as number) * demandRng.logNormal(1, fam.cv);
        if (hist && d < days) {
          (hist.expected[f] as number[])[d] = ((hist.expected[f] as number[])[d] as number) + expected(st, f, d, 1, true);
          (hist.demand[f] as number[])[d] = ((hist.demand[f] as number[])[d] as number) + ((demandOf[i] as number[][])[f] as number[]).reduce((a, b) => a + b, 0);
        }
      }
    }
  }

  // —— 门店：每小时卖货 ——
  function sell(d: number, h: number): void {
    const w = HOUR_W[h] as number;
    if (!w) return;
    for (let i = 0; i < NS; i++)
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        for (let k = 0; k < NK; k++) {
          const want = ((demandOf[i] as number[][])[f] as number[])[k]! * w;
          const sl = ((slots[i] as Slot[][])[f] as Slot[])[k] as Slot;
          let got = 0;
          if (fam.life) {
            // 一半顾客挑最新鲜的，其余先拿最老的
            const half = want / 2;
            got += take(sl.cohorts, half, true) + take(sl.cohorts, want - half, false);
          } else {
            got = Math.min(sl.onHand, want);
            sl.onHand -= got;
          }
          if (measured(d)) {
            M.demand += want;
            M.sold += got;
            M.lost += want - got;
            (FM[f] as { demand: number }).demand += want;
            (FM[f] as { lost: number }).lost += want - got;
            M.lostMargin += (want - got) * fam.price * fam.margin * 0.6;
          }
          (dc[f] as DcFam).demandToday += want;
          if (fam.source === 'air') {
            dayStats.airDemand += want;
            dayStats.airLost += want - got;
          }
        }
      }
  }
  function take(cs: Cohort[], q: number, freshest: boolean): number {
    let got = 0;
    while (q - got > 1e-9 && cs.length) {
      // 批次按年龄从老到新排
      const c = (freshest ? cs[cs.length - 1] : cs[0]) as Cohort;
      const n = Math.min(c.q, q - got);
      c.q -= n;
      got += n;
      if (c.q <= 1e-9) {
        if (freshest) cs.pop();
        else cs.shift();
      }
    }
    return got;
  }
  function addCohort(cs: Cohort[], q: number, age: number): void {
    if (q <= 0) return;
    let i = cs.length;
    while (i > 0 && (cs[i - 1] as Cohort).age < age) i--;
    cs.splice(i, 0, { q, age });
  }

  // —— 门店：每晚下单 ——
  type Order = { store: number; fam: number; units: number[]; cases: number };
  const pending = new Map<number, Order[]>();
  function storeOrders(d: number): void {
    const list: Order[] = [];
    const resp = s.gen === 'g1' ? s.twin.surgeResponseDays : s.gen === 'g2' ? Math.min(1, s.twin.surgeResponseDays) : s.twin.surgeResponseDays;
    for (let i = 0; i < NS; i++) {
      const st = STORES[i] as StoreSite;
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        const z = zoneOf(fam);
        if (isDirect(fam) || !deliversOn(st, z, d + 1)) continue;
        // 这一单要撑到「下一次之后那一次」到货：R 天，加上那天到货前卖掉的量
        const R = daysToNext(st, z, d + 1);
        const H = R + beforeArrival(z);
        let mean = 0;
        for (let k = 1; k <= R + 1; k++) mean += expected(st, f, d + k, s.store.promoKnown, surgeKnown(d + k, resp));
        mean /= R + 1;
        const err = 1 + fcRng.normal(0, s.store.forecastError);
        const units: number[] = [];
        let total = 0;
        for (let k = 0; k < NK; k++) {
          const sl = ((slots[i] as Slot[][])[f] as Slot[])[k] as Slot;
          const F = mean * (SLOT_W[k] as number) * Math.max(0.3, err);
          const cvc = Math.sqrt(fam.cv * fam.cv + s.store.forecastError * s.store.forecastError);
          // 生鲜陈列量；不易腐商品货架上至少摆 1.2 天的量（陈列面）
          const pres = fam.life ? s.store.presentationDays * F * (PRESENTATION[fam.cat] ?? 0) : 1.2 * F;
          const z = fam.life ? (s.store.safetyZFresh ?? s.store.safetyZ) : s.store.safetyZ;
          const target = F * H + z * F * cvc * Math.sqrt(H) + pres;
          let q = target - stockOf(sl) - sl.onOrder;
          if (q < fam.unitsPerCase * 0.25) q = 0;
          const cases = Math.ceil(q / fam.unitsPerCase);
          const u = cases * fam.unitsPerCase;
          units.push(u);
          sl.onOrder += u;
          total += cases;
        }
        if (total > 0) list.push({ store: i, fam: f, units, cases: total });
        (dc[f] as DcFam).ordersToday += units.reduce((a, b) => a + b, 0);
      }
    }
    pending.set(d, list);
  }

  /**
   * 门店向长途供应商直接订整车：库存（含在途）降到订货点（提前期 + 1 天的量 + 安全量 + 陈列量）就订一车，
   * 车按供应商的提前期（跨境多 2 天）在门店的直送收货时段里到。
   */
  function directOrders(d: number): void {
    for (let i = 0; i < NS; i++) {
      const st = STORES[i] as StoreSite;
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        if (!isDirect(fam)) continue;
        const sls = (slots[i] as Slot[][])[f] as Slot[];
        const L = leadOf(fam);
        let mean = 0;
        for (let k = 1; k <= L + 1; k++) mean += expected(st, f, d + k, s.store.promoKnown, surgeKnown(d + k, s.twin.surgeResponseDays));
        mean /= L + 1;
        const F = mean * Math.max(0.3, 1 + fcRng.normal(0, s.store.forecastError));
        const cvc = Math.sqrt(fam.cv * fam.cv + s.store.forecastError * s.store.forecastError);
        const rop = F * (L + 1 + beforeArrival('ambient')) + s.store.safetyZ * F * cvc * Math.sqrt(L + 1) + 1.2 * F;
        const pos = sls.map((sl) => stockOf(sl) + sl.onOrder);
        const position = pos.reduce((a, b) => a + b, 0);
        if (position > rop) continue;
        // 订整车：至少按规划的车数，不够回到订货点以上就再加一车（需求涨了、一天的量超过一车时一次订几车）
        const truck = PALLETS_PER_TRAILER * unitsPerPalletOf(fam);
        let loads = directLoads(s, fam);
        while (position + loads * truck <= rop) loads++;
        const q = loads * truck;
        // 一整车按每个单品组的缺口分（缺得多的多装），不按固定比例：否则有的单品组卖空、有的压货
        const need = SLOT_W.map((w, k) => Math.max(0, w * (rop + q) - (pos[k] as number)));
        const sumNeed = need.reduce((a, b) => a + b, 0);
        const units = need.map((n, k) => Math.round((q * (sumNeed > 0 ? n / sumNeed : (SLOT_W[k] as number))) / fam.unitsPerCase) * fam.unitsPerCase);
        units.forEach((u, k) => ((sls[k] as Slot).onOrder += u));
        let lead = L * opsRng.logNormal(1, s.dc.leadCv);
        if (inDis('supplierOutage', d) && fam.key === 'AMB_A') {
          const o = disOf('supplierOutage') as Disruption;
          lead = d - o.start < s.twin.detectOutageDays ? (s.twin.dualSource ? o.start + s.twin.detectOutageDays - d + lead + 1 : o.start + o.days - d + lead) : lead + (s.twin.dualSource ? 1 : 3);
        }
        const day = d + Math.max(1, Math.round(lead));
        const [w0, w1] = s.flow.window;
        let t = day * 24 + w0 + opsRng.next() * (w1 - w0);
        const moved = day === s.traceDay ? s.plan?.arrive?.[`DS-${fam.key}`] : undefined;
        if (moved !== undefined) t = day * 24 + Math.max(0, Math.min(23.9, moved));
        const via = fam.supplier?.via ?? 'NORTH';
        const km = loads * ((fam.supplier?.km ?? 150) + routesOpen.get(via, st.key).km) * 2;
        const pallets = q / unitsPerPalletOf(fam);
        push({ type: 'store', t, store: i, items: [{ fam: f, units, ordered: units, ages: [] }], onTime: t <= day * 24 + w1 + 1e-9, direct: { fam: f, loads, pallets, km } });
        orderTime.set(`d${f}:${t}`, d * 24 + 22);
        if (trace && day === s.traceDay)
          for (let k = 0; k < loads; k++) traceDirect(st, via, t + k * 0.3, fam, Math.min(PALLETS_PER_TRAILER, Math.round(pallets - k * PALLETS_PER_TRAILER)), k + 1, loads, [w0, w1], q / loads);
      }
    }
  }

  // —— 配送中心：分配、装车、派车 ——
  const allocAbs = (d: number) => d * 24 + (s.gen === 'g3' ? 26 : 23);
  function allocate(d: number): void {
    const orders = pending.get(d) ?? [];
    pending.delete(d);
    const byFam = new Map<number, Order[]>();
    for (const o of orders) byFam.set(o.fam, [...(byFam.get(o.fam) ?? []), o]);
    // 每家店要送的：商品族 → 件数、批次年龄
    const ship = new Map<number, { fam: number; units: number[]; ordered: number[]; ages: Cohort[] }[]>();
    for (const [f, os] of byFam) {
      const fam = FAMILIES[f] as Family;
      const x = dc[f] as DcFam;
      const want = os.reduce((a, o) => a + o.units.reduce((p, q) => p + q, 0), 0);
      const have = fam.source === 'bakery' ? want : dcStock(x);
      const ratio = want > 0 ? Math.min(1, have / want) : 1;
      if (measured(d)) {
        M.dcOrdered += want;
        M.dcShipped += want * ratio;
        (FM[f] as { ordered: number }).ordered += want;
        (FM[f] as { shipped: number }).shipped += want * ratio;
      }
      for (const o of os) {
        const units = o.units.map((u) => Math.floor((u * ratio) / fam.unitsPerCase) * fam.unitsPerCase);
        const n = units.reduce((a, b) => a + b, 0);
        // 没分到的从门店的「在途」里扣掉
        o.units.forEach((u, k) => {
          ((slots[o.store] as Slot[][])[f] as Slot[])[k]!.onOrder -= u - (units[k] as number);
        });
        if (n <= 0) continue;
        let ages: Cohort[] = [];
        if (fam.source === 'bakery') ages = [{ q: n, age: 0.15 }];
        else if (fam.life) {
          // 先进先出：最老的先发
          let need = n;
          while (need > 1e-9 && x.cohorts.length) {
            const c = x.cohorts[0] as Cohort;
            const m = Math.min(c.q, need);
            ages.push({ q: m, age: c.age });
            c.q -= m;
            need -= m;
            if (c.q <= 1e-9) x.cohorts.shift();
          }
        } else x.onHand -= n;
        const list = ship.get(o.store) ?? [];
        list.push({ fam: f, units, ordered: o.units, ages });
        ship.set(o.store, list);
        if (measured(d)) M.picked += n / fam.unitsPerCase;
      }
    }
    dispatch(d, ship);
  }

  /** 装车、排线路、派车，生成门店到货事件 */
  function dispatch(d: number, ship: Map<number, { fam: number; units: number[]; ordered: number[]; ages: Cohort[] }[]>): void {
    const routes = inDis('highwayClosed', d + 1) && s.twin.reroute ? routesClosed : routesOpen;
    const dist = (a: string, b: string) => routes.get(a, b).km;
    // 每家店每个温区的托盘数
    const pal = new Map<number, Record<string, number>>();
    for (const [i, items] of ship) {
      const z: Record<string, number> = { ambient: 0, chilled: 0, frozen: 0, bakery: 0 };
      for (const it of items) {
        const fam = FAMILIES[it.fam] as Family;
        const cases = it.units.reduce((a, b) => a + b, 0) / fam.unitsPerCase;
        z[zoneOf(fam)] = (z[zoneOf(fam)] as number) + cases * fam.cube;
      }
      for (const k of Object.keys(z)) z[k] = (z[k] as number) > 0 ? Math.ceil((z[k] as number) / 1.5) : 0;
      pal.set(i, z);
    }
    type Leg = { route: Route; zone: string; cap: number; depot: string; van: boolean };
    const legs: Leg[] = [];
    if (s.fleet.consolidated) {
      const jobs: Job[] = [];
      for (const [i, z] of pal) {
        const p = (z.ambient as number) + (z.chilled as number) + (z.frozen as number) + (z.bakery as number);
        if (p > 0) jobs.push({ store: (STORES[i] as StoreSite).key, pallets: p });
      }
      for (const r of planRoutes(jobs, PALLETS_PER_MULTI_TEMP, s.fleet.maxStops, dist, 'DC')) legs.push({ route: r, zone: 'multi', cap: PALLETS_PER_MULTI_TEMP, depot: 'DC', van: false });
    } else {
      for (const zone of ['chilled', 'frozen', 'ambient'] as const) {
        const jobs: Job[] = [];
        for (const [i, z] of pal) if ((z[zone] as number) > 0) jobs.push({ store: (STORES[i] as StoreSite).key, pallets: z[zone] as number });
        for (const r of fixedRoutes(zone, jobs, dist, (d + 1) % 7)) legs.push({ route: r, zone, cap: PALLETS_PER_TRAILER, depot: 'DC', van: false });
      }
    }
    // 面包房：上一代自己用小货车直送；全链路方案装进多温区车（上面已算进托盘）
    if (s.fleet.bakeryDsd) {
      const jobs: Job[] = [];
      for (const [i, z] of pal) if ((z.bakery as number) > 0) jobs.push({ store: (STORES[i] as StoreSite).key, pallets: z.bakery as number });
      for (const r of planRoutes(jobs, 8, 5, dist, 'BAKERY')) legs.push({ route: r, zone: 'bakery', cap: 8, depot: 'BAKERY', van: true });
    } else if (!s.fleet.consolidated) {
      const jobs: Job[] = [];
      for (const [i, z] of pal) if ((z.bakery as number) > 0) jobs.push({ store: (STORES[i] as StoreSite).key, pallets: z.bakery as number });
      for (const r of planRoutes(jobs, PALLETS_PER_TRAILER, s.fleet.maxStops, dist, 'DC')) legs.push({ route: r, zone: 'ambient', cap: PALLETS_PER_TRAILER, depot: 'DC', van: false });
    }
    // 远的先走；电动车跑短线路；每个温区在自己的出车时段里均匀出发
    legs.sort((a, b) => Number(a.van) - Number(b.van) || routeKm(b.route, dist, b.depot) - routeKm(a.route, dist, a.depot));
    const zoneCount = new Map<string, number>();
    for (const l of legs) zoneCount.set(l.zone, (zoneCount.get(l.zone) ?? 0) + 1);
    const zoneIdx = new Map<string, number>();
    const trucks = legs.filter((l) => !l.van);
    const byKm = [...trucks].sort((a, b) => routeKm(a.route, dist, a.depot) - routeKm(b.route, dist, b.depot));
    const evSet = new Set<Leg>();
    const evMax = Math.round(trucks.length * s.fleet.evShare);
    for (const l of byKm) if (evSet.size < evMax && routeKm(l.route, dist, l.depot) <= 230) evSet.add(l);
    const free: { t: number; kind: string }[] = [];
    let vk = 0;
    // 一家店的同一类货分几车送时，每车按托盘数分一份（最后一车把剩下的全带上）
    const palLeft = new Map<string, number>();
    const legKey = (store: string, zone: string) => `${store}:${zone}`;
    for (const l of legs) for (const st of l.route.stops) palLeft.set(legKey(st.store, l.zone), (palLeft.get(legKey(st.store, l.zone)) ?? 0) + st.pallets);
    // 当天调度只改动画那一天：车次可以改出发时刻（不早于分配完 + 半小时装车；面包车不早于 4 点出炉）
    const traceToday = !!trace && d + 1 === s.traceDay;
    const dayStart = (d + 1) * 24;
    const earliest = allocAbs(d) + 0.5;
    for (const leg of legs) {
      const zw = leg.zone === 'bakery' ? ([4.5, 6] as [number, number]) : s.fleet.windows[leg.zone as 'chilled' | 'frozen' | 'ambient' | 'multi'];
      const zi = zoneIdx.get(leg.zone) ?? 0;
      zoneIdx.set(leg.zone, zi + 1);
      const span = (zw[1] - zw[0]) / Math.max(1, zoneCount.get(leg.zone) ?? 1);
      const planned = leg.van ? dayStart + 4.5 + vk++ * 0.1 : dayStart + zw[0] + zi * span;
      const id = `${ZONE_CODE[leg.zone] ?? 'X'}${String(zi + 1).padStart(2, '0')}`;
      const minDepart = leg.van ? dayStart + 4 : earliest;
      const moved = traceToday ? s.plan?.depart?.[id] : undefined;
      const depart = moved === undefined ? planned : Math.max(minDepart, dayStart + moved);
      let t = depart;
      let at = leg.depot;
      let km = 0;
      const stopsTrace: { at: string; path: PathInfo; t0: number; arrive: number; t1: number; unload: number; open: number; close: number; onTime: boolean; slow: number; pallets: number; load: Record<string, number> }[] = [];
      for (const stop of leg.route.stops) {
        // 道路封闭但没有提前改道：第一趟车走到封闭处才折返（多绕 40%）
        const blocked = inDis('highwayClosed', d + 1) && !s.twin.reroute && at === 'DC';
        const path = blocked ? routesClosed.get(at, stop.store) : routes.get(at, stop.store);
        const extra = blocked ? routesOpen.get(at, stop.store).hours * 0.4 : 0;
        const t0 = t;
        const drive = travelHours(path, t % 24);
        t += drive + extra;
        km += path.km + (blocked ? routesOpen.get(at, stop.store).km * 0.4 : 0);
        // 门店的收货时段：单独排过的门店按它，其余从 receiveFrom 开始收；到早了在门外等
        const win = s.store.windows?.[stop.store];
        const open = win ? win[0] : s.store.receiveFrom;
        const arrive = t;
        if (t < dayStart + open) t = dayStart + open;
        const i = STORES.findIndex((x) => x.key === stop.store);
        const unload = (s.store.unloadMin + s.store.unloadMinPerPallet * stop.pallets) / 60;
        const due = leg.zone === 'bakery' ? 8 : s.fleet.dueBy[leg.zone as 'chilled' | 'frozen' | 'ambient' | 'multi'];
        const close = win ? win[1] : due;
        const onTime = t <= dayStart + close;
        // 这一站送的货：多温区车送全部温区；单温区车只送自己的温区；面包车只送面包
        const mine = (ship.get(i) ?? []).filter((it) => {
          const z = zoneOf(FAMILIES[it.fam] as Family);
          return leg.zone === 'multi' || z === leg.zone || (leg.zone === 'ambient' && z === 'bakery' && !s.fleet.bakeryDsd);
        });
        // 这家店这类货还有几托没送：这车分它的那一份
        const lk = legKey(stop.store, leg.zone);
        const left = palLeft.get(lk) ?? stop.pallets;
        const share = left > stop.pallets + 1e-9 ? stop.pallets / left : 1;
        palLeft.set(lk, Math.max(0, left - stop.pallets));
        const items: typeof mine = [];
        for (const it of mine) {
          const fam = FAMILIES[it.fam] as Family;
          const units = share >= 1 ? it.units : it.units.map((u) => Math.round((u * share) / fam.unitsPerCase) * fam.unitsPerCase);
          const n = units.reduce((a, b) => a + b, 0);
          const total = it.units.reduce((a, b) => a + b, 0);
          if (n <= 0) continue;
          const f2 = total > 0 ? n / total : 1;
          items.push({ fam: it.fam, units, ordered: it.ordered.map((u) => u * f2), ages: it.ages.map((c) => ({ q: c.q * f2, age: c.age })) });
          it.units = it.units.map((u, k) => u - (units[k] as number));
          it.ordered = it.ordered.map((u) => u * (1 - f2));
          it.ages = it.ages.map((c) => ({ q: c.q * (1 - f2), age: c.age }));
        }
        ship.set(
          i,
          (ship.get(i) ?? []).filter((it) => it.units.reduce((a, b) => a + b, 0) > 0),
        );
        const load: Record<string, number> = {};
        for (const it of items) load[(FAMILIES[it.fam] as Family).key] = (load[(FAMILIES[it.fam] as Family).key] ?? 0) + it.units.reduce((a, b) => a + b, 0);
        stopsTrace.push({ at: stop.store, path, t0, arrive, t1: t, unload, open, close, onTime, slow: (drive - path.hours) * 60, pallets: stop.pallets, load });
        if (items.length) {
          const transit = (t - depart) / 24;
          push({ type: 'store', t, store: i, items: items.map((it) => ({ ...it, ages: it.ages.map((c) => ({ q: c.q, age: c.age + transit + (s.gen === 'g3' ? 0.05 : 0.15) })) })), onTime });
        }
        t += unload;
        at = stop.store;
      }
      const back = routes.get(at, leg.depot);
      const tb0 = t;
      t += travelHours(back, t % 24);
      km += back.km;
      const hours = t - depart + 0.5;
      if (measured(d + 1) && d + 1 < days) {
        if (leg.van) {
          M.vanTrips++;
          M.vanKm += km;
          M.vanHours += hours;
          M.vanStops += leg.route.stops.length;
        } else {
          M.trips++;
          M.km += km;
          M.driverHours += hours;
          M.palletsOut += leg.route.pallets;
          M.capOut += leg.cap;
          M.stops += leg.route.stops.length;
          if (evSet.has(leg)) M.evKm += km;
          else M.dieselKm += km;
          if (leg.zone === 'chilled' || leg.zone === 'frozen') M.reeferHours += hours;
          else if (leg.zone === 'multi') M.reeferHours += hours * 0.6;
        }
      }
      // 车队：同一辆车做完一趟可以再跑一趟
      const kind = leg.van ? 'van' : leg.zone === 'multi' ? 'multi' : leg.zone === 'ambient' ? 'dry' : 'reefer';
      const truck = free.find((x) => x.kind === kind && x.t <= depart - 0.5);
      if (truck) truck.t = t;
      else free.push({ t, kind });
      if (trace && traceToday) {
        const segs: { t0: number; t1: number; pts?: Km[]; at?: Km; act: string; route?: string[]; place?: string }[] = [];
        // 出发前在月台装车（配送中心）或在面包房装车
        // 分配完才能装车：最早的几趟车装得快一些（多派人手）
        const loadStart = leg.depot === 'DC' ? Math.max(allocAbs(d), depart - (15 + (leg.route.pallets * 60) / s.dc.loadRate) / 60) : depart - 0.3;
        segs.push({ t0: loadStart, t1: depart, at: NODES[leg.depot] as Km, place: leg.depot, act: leg.depot === 'DC' ? '在配送中心月台装车' : '在面包房装车' });
        let prev: StoreSite | undefined;
        for (const st of stopsTrace) {
          const node = STORES.find((x) => x.key === st.at) as StoreSite;
          segs.push({ t0: st.t0, t1: st.arrive, pts: dockPts(st.path.pts, prev, node), route: st.path.nodes, act: `开往${node.name}` });
          if (st.t1 - st.arrive > 1 / 120) segs.push({ t0: st.arrive, t1: st.t1, at: node.dock, place: node.key, act: `在${node.name}等收货时间` });
          segs.push({ t0: st.t1, t1: st.t1 + st.unload, at: node.dock, place: node.key, act: `在${node.name}卸货` });
          prev = node;
        }
        segs.push({ t0: tb0, t1: t, pts: dockPts(back.pts, prev, undefined), route: back.nodes, act: leg.depot === 'BAKERY' ? '回面包房' : '回配送中心' });
        const label = `${leg.van ? '面包配送车' : evSet.has(leg) ? '电动配送车' : leg.zone === 'multi' ? '多温区配送车' : leg.zone === 'ambient' ? '常温配送车' : leg.zone === 'chilled' ? '冷藏配送车' : '冷冻配送车'}${leg.route.stops.length > 1 ? ` · ${leg.route.stops.length} 家店` : ''} · ${leg.route.pallets} 托`;
        const vid = trace.vehicle(leg.van ? 'van' : evSet.has(leg) ? 'ev' : leg.zone === 'ambient' ? 'truck' : 'reefer', label, segs, dayStart);
        trace.op({
          id,
          kind: leg.van ? 'bakery' : 'delivery',
          label,
          vehicle: vid,
          t0: loadStart,
          t1: t,
          from: leg.depot,
          to: leg.depot,
          zone: leg.zone,
          unit: kind,
          ev: evSet.has(leg),
          pallets: leg.route.pallets,
          cap: leg.cap,
          km,
          depart,
          planned,
          ...(leg.depot === 'DC' ? { dock: [loadStart, depart] as [number, number] } : {}),
          stops: stopsTrace.map((st) => ({ key: st.at, name: (STORES.find((x) => x.key === st.at) as StoreSite).name, arrive: st.arrive, start: st.t1, end: st.t1 + st.unload, pallets: st.pallets, open: st.open, close: st.close, onTime: st.onTime, slow: st.slow, load: st.load })),
          edit: { mode: 'depart', key: id, min: minDepart - dayStart, max: 23.5 },
        });
      }
    }
    if (measured(d + 1) && d + 1 < days) {
      const fleet = free.filter((x) => x.kind !== 'van').length;
      M.fleetMax = Math.max(M.fleetMax, fleet);
      M.trucksDays += fleet;
      // 电动车跑的趟数占比 × 车队 = 电动车的台数（一辆车一天跑一到两趟）
      M.evTrucksDays += Math.round(fleet * (trucks.length ? evSet.size / trucks.length : 0));
      M.vanFleet = Math.max(M.vanFleet, free.filter((x) => x.kind === 'van').length);
      for (const x of free) if (x.kind !== 'van') M.trailers[x.kind as 'dry' | 'reefer' | 'multi']++;
      M.outPallets += legs.reduce((a, l) => a + (l.van ? 0 : l.route.pallets), 0);
    }
  }

  // 上一代的固定线路：每个温区、每个星期几按排班的门店和平均量排好一次，每天照着跑（量大时多派一辆）
  const fixed = new Map<string, string[][]>();
  function fixedRoutes(zone: string, jobs: Job[], dist: (a: string, b: string) => number, dow: number): Route[] {
    const key = `${zone}:${dow}`;
    let groups = fixed.get(key);
    if (!groups) {
      const avg = STORES.filter((st) => deliversOn(st, zone as Temp, dow)).map((st) => {
        let cube = 0;
        FAMILIES.forEach((fam, f) => {
          if (zoneOf(fam) === zone) cube += (expected(st, f, dow, 0, false) * (daysToNext(st, zone as Temp, dow) || 1)) / fam.unitsPerCase * fam.cube;
        });
        return { store: st.key, pallets: Math.max(1, Math.ceil(cube / 1.5)) };
      });
      groups = planRoutes(avg, PALLETS_PER_TRAILER, s.fleet.maxStops, dist, 'DC').map((r) => r.stops.map((x) => x.store));
      fixed.set(key, groups);
    }
    const byStore = new Map(jobs.map((j) => [j.store, j.pallets]));
    const out: Route[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      const stops = g.filter((x) => byStore.has(x) && !seen.has(x)).map((x) => ({ store: x, pallets: byStore.get(x) as number }));
      stops.forEach((x) => seen.add(x.store));
      // 超过一车：多出来的单独派车
      let load = 0;
      const cur: Job[] = [];
      for (const st of stops) {
        if (load + st.pallets > PALLETS_PER_TRAILER && cur.length) {
          out.push({ stops: [...cur], pallets: load });
          cur.length = 0;
          load = 0;
        }
        let p = st.pallets;
        while (p > PALLETS_PER_TRAILER) {
          out.push({ stops: [{ store: st.store, pallets: PALLETS_PER_TRAILER }], pallets: PALLETS_PER_TRAILER });
          p -= PALLETS_PER_TRAILER;
        }
        cur.push({ store: st.store, pallets: p });
        load += p;
      }
      if (cur.length) out.push({ stops: cur, pallets: load });
    }
    for (const j of jobs) if (!seen.has(j.store)) out.push({ stops: [j], pallets: j.pallets });
    return out;
  }

  /**
   * 港口拥堵开始时：全链路孪生拿到船公司和码头的最新到港时间，逐个商品族推算接下来 12 天的库存：
   * 需求 + 2 天安全量 − 现有可用库存 − 这期间确定能到的货 = 缺口，只按缺口向国内分销商过桥采购（贵 15%，3 天到）
   */
  function bridgeBuy(d: number): void {
    const pc = disOf('portCongestion');
    if (!pc || d !== pc.start || !s.twin.bridgeBuy) return;
    const H = 12;
    let bought = 0;
    FAMILIES.forEach((fam, f) => {
      if (fam.source !== 'sea') return;
      const x = dc[f] as DcFam;
      let need = 0;
      for (let k = 1; k <= H + 2; k++) need += STORES.reduce((a, st) => a + expected(st, f, d + k, 1, false), 0);
      const F = need / (H + 2);
      const inflow = queue.reduce((a, e) => a + (e.type === 'dc' && e.fam === f && e.t <= (d + H) * 24 ? e.units : 0), 0);
      const gap = need - usableStock(x, fam, F) - inflow;
      if (gap <= F * 0.5) return;
      const units = Math.ceil(gap / fam.unitsPerCase) * fam.unitsPerCase;
      const t = (d + 3) * 24 + 8 + opsRng.next() * 6;
      x.onOrder += units;
      push({ type: 'dc', t, fam: f, units, age: fam.life ? 6 : 0, pallets: units / (casesPerPallet(fam) * fam.unitsPerCase), src: 'domestic', ordered: units });
      responseCost += valueOf(f, units) * 0.15;
      bought += units / F;
    });
    trace?.event(d * 24 + 10, bought > 0 ? `孪生发现班轮延误：按推算的缺口向国内分销商过桥采购（合计约 ${Math.round(bought)} 天的量，分摊在几个进口商品族）` : '孪生发现班轮延误：推算库存够用，不需要过桥采购');
  }

  // —— 配送中心：给供应商下单 ——
  function replenish(d: number): void {
    bridgeBuy(d);
    for (let f = 0; f < NF; f++) {
      const fam = FAMILIES[f] as Family;
      const x = dc[f] as DcFam;
      // 预测：上一代 / StoreX 用门店订单做指数平滑（看不到真实销售，会放大波动）；全链路用共享的销售预测 + 促销日历
      // 配送中心要满足的是门店订单：误差按订单算（全链路的预测来自共享销售数据，订单围绕它波动得小）
      const demandSignal = s.dc.forecastFrom === 'orders' ? x.ordersToday : x.demandToday;
      const ordersNow = x.ordersToday;
      const err = x.ordersToday - (s.dc.forecastFrom === 'orders' ? x.fcst : x.posFcst);
      // 平滑按下单周期折算：每天下单的商品族每天 0.2，每周下单的约等于每周 0.2（采购员看的是周量）
      const alpha = 0.2 / Math.sqrt(reviewOf(fam));
      x.sse = (1 - alpha / 2) * x.sse + (alpha / 2) * err * err;
      x.fcst = (1 - alpha) * x.fcst + alpha * demandSignal;
      x.ordersToday = 0;
      x.demandToday = 0;
      // 明晚门店下的单是给后天的：用后天的需求预测去比（比错一天会把星期几的起伏当成误差）
      x.posFcst = STORES.reduce((a, st) => a + expected(st, f, d + 2, s.dc.promoKnown, surgeKnown(d + 2, s.twin.surgeResponseDays)), 0);
      if (fam.source === 'bakery' || isDirect(fam)) continue;
      // 越库：区域生鲜按今晚的门店订单订（内陆产区的集货车 1 点送到、2 点分配），配送中心不留库存。
      // 空运量太小、门店按箱订得很不均匀，仍按预测补货留一点库存（夜间航班照样赶上早上那一波）
      if (s.dc.crossDock && fam.source === 'local') {
        const need = ordersNow * 1.02;
        let q = need - dcStock(x) - x.onOrder;
        if (q <= 0) continue;
        q = Math.ceil(q / fam.unitsPerCase) * fam.unitsPerCase;
        x.onOrder += q;
        ship(d, f, q);
        continue;
      }
      const R = reviewOf(fam);
      if ((d + f) % R !== 0) continue;
      const L = dcLead(fam, d);
      let F = x.fcst;
      if (s.dc.forecastFrom === 'pos') {
        // 未来 R + L 天的平均：门店的预测（含已知促销、需求突增）
        let m = 0;
        const span = Math.max(1, Math.round(R + L));
        for (let k = 1; k <= span; k++) m += STORES.reduce((a, st) => a + expected(st, f, d + k, s.dc.promoKnown, surgeKnown(d + k, s.twin.surgeResponseDays)), 0);
        F = (m / span) * (1 + fcRng.normal(0, 0.03));
      }
      // 安全库存：提前期内需求的波动 + 提前期本身的波动（船期、堆场、铁路班次、供应商）
      const sigmaL = leadSigma(fam);
      const sigma = Math.sqrt((R + L) * x.sse + F * F * sigmaL * sigmaL);
      const target = F * (R + L) + s.dc.safetyZ * sigma;
      // 易腐品：到期前发不完的库存不算数；一次最多订到期前卖得掉的量（采购员的常识，三代都有）。
      // 海运生鲜的提前期是保质期的好几倍：每周按预测订一周的量，缺口分三周补齐（比例补货，压住长链条的牛鞭效应）
      const gap = target - usableStock(x, fam, F) - x.onOrder;
      // 比例补货的缺口按「下单前」的位置算：稳态时下单前 = 目标 − 一周的量
      let q = fam.life && fam.source === 'sea' ? F * R + (gap - F * R) / 3 : gap;
      if (q <= 0) continue;
      if (fam.life) q = Math.min(q, F * Math.max(R + 1, dcWindow(fam)));
      const unitsPerPallet = casesPerPallet(fam) * fam.unitsPerCase;
      if (fam.source === 'domestic') q = Math.ceil(q / unitsPerPallet) * unitsPerPallet;
      else if (fam.source === 'sea' || fam.source === 'rail') q = Math.ceil(q / (unitsPerPallet * PALLETS_PER_FEU)) * unitsPerPallet * PALLETS_PER_FEU;
      else q = Math.ceil(q / fam.unitsPerCase) * fam.unitsPerCase;
      x.onOrder += q;
      ship(d, f, q);
    }
  }

  /** 供应商发货：按货源排到货事件 */
  function ship(d: number, f: number, units: number): void {
    const fam = FAMILIES[f] as Family;
    const unitsPerPallet = casesPerPallet(fam) * fam.unitsPerCase;
    const pallets = units / unitsPerPallet;
    const now = d * 24 + 23;
    if (fam.source === 'domestic') {
      let lead = leadOf(fam) * opsRng.logNormal(1, s.dc.leadCv);
      // 供应商断货：没发现之前单子卡住；发现后改由备用供应商。
      // 全链路有预先认证的备用供应商：发现时立即把卡住的单转过去（多 1 天）；否则卡到断货结束，之后的单多 3 天
      if (inDis('supplierOutage', d) && fam.key === 'AMB_A') {
        const o = disOf('supplierOutage') as Disruption;
        const dd = d - o.start;
        if (dd < s.twin.detectOutageDays) lead = s.twin.dualSource ? o.start + s.twin.detectOutageDays - d + lead + 1 : o.start + o.days - d + lead;
        else lead += s.twin.dualSource ? 1 : 3;
      }
      const day = d + Math.max(1, Math.round(lead));
      const [w0, w1] = s.dc.inboundWindow;
      let t = day * 24 + w0 + opsRng.next() * (w1 - w0);
      // 当天调度：调度台改过这家供应商的到达时刻
      const moved = day === s.traceDay ? s.plan?.arrive?.[`IN-${fam.key}`] : undefined;
      if (moved !== undefined) t = day * 24 + Math.max(0, Math.min(23.9, moved));
      push({ type: 'dc', t, fam: f, units, age: fam.life ? 2 : 0, pallets, src: 'domestic', ordered: units });
      orderTime.set(`${f}:${t}`, now);
    } else if (fam.source === 'local') {
      let t = (d + 1) * 24 + s.dc.localArriveHour + opsRng.normal(0, 0.2);
      const moved = d + 1 === s.traceDay ? s.plan?.arrive?.FR : undefined;
      if (moved !== undefined) t = (d + 1) * 24 + Math.max(0, Math.min(23.9, moved));
      push({ type: 'dc', t, fam: f, units, age: 0.6, pallets, src: 'local', ordered: units });
      orderTime.set(`${f}:${t}`, now);
    } else if (fam.source === 'air') {
      // 当天的空运货分到各班航班（平常档每天一班）
      for (const fh of fHours) {
        const u = units / fHours.length;
        const pl = pallets / fHours.length;
        let flight = (d + s.dc.leadDays.air) * 24 + fh + opsRng.normal(0, 0.3);
        // 机场关闭：没有备降方案时航班顺延到重新开放；全链路改降备降机场（约 300 公里），卡车运回多 5 小时
        const ac = disOf('airportClosed');
        if (ac) {
          const fd = Math.floor(flight / 24);
          if (fd >= ac.start && fd < ac.start + ac.days) {
            if (s.twin.altAirport) {
              flight += 5;
              responseCost += Math.ceil(pl / 12) * 600 * s.costs.inboundPerKm;
            } else flight = (ac.start + ac.days) * 24 + fh;
          }
        }
        const toDc = travelHours(routesOpen.get('AIR', 'DC'), (flight + s.air.handlingHours) % 24);
        const t = flight + s.air.handlingHours + toDc;
        push({ type: 'dc', t, fam: f, units: u, age: 1.5 + (t - flight) / 24, pallets: pl, src: 'air', ordered: u });
        orderTime.set(`${f}:${t}`, now);
        if (measured(d)) M.airKg += (u / fam.unitsPerCase) * fam.kg;
      }
    } else if (fam.source === 'sea') {
      // 下单后约 38 天到港：赶上那之后的第一班船
      seaShipment(nextWeekDay(d + s.dc.leadDays.sea, callDays), f, units, now);
    } else if (fam.source === 'rail') railShipment(railArrival(d + s.dc.leadDays.rail), f, units, now);
  }

  /** 一列班列上的货：按时刻表到物流园货运站（可能晚点），查验、卸箱、调车后进配送中心 */
  function railShipment(arrDay: number, f: number, units: number, placed: number | undefined): void {
    const fam = FAMILIES[f] as Family;
    const pallets = units / unitsPerPalletOf(fam);
    const arrive = arrDay * 24 + s.rail.arriveHour + (trainDelays.get(arrDay) ?? s.rail.delayDays) * 24;
    const boxes = Math.max(1, Math.round(pallets / PALLETS_PER_FEU));
    for (let b = 0; b < boxes; b++) {
      const t = arrive + s.rail.terminalHours + b * 0.2;
      push({ type: 'dc', t, fam: f, units: units / boxes, age: 0, pallets: pallets / boxes, src: 'rail', ordered: units / boxes, train: true });
      if (placed !== undefined) orderTime.set(`${f}:${t}`, placed);
    }
    if (trace && Math.floor(arrive / 24) <= s.traceDay && Math.floor((arrive + s.rail.terminalHours) / 24) >= s.traceDay) trace.train(arrive, s.rail.terminalHours, boxes, fam.label);
  }

  /** 一班船上的货：卸船 → 堆场（清关、等提箱）→ 拖车或铁路 → 配送中心 */
  function seaShipment(call: number, f: number, units: number, placed: number | undefined): void {
    const fam = FAMILIES[f] as Family;
    const unitsPerPallet = casesPerPallet(fam) * fam.unitsPerCase;
    const pallets = units / unitsPerPallet;
    const delay = vesselDelay(call) + congestionDelay(call);
    const berth = call * 24 + s.port.vesselHour + delay * 24;
    const boxes = Math.max(1, Math.round(pallets / PALLETS_PER_FEU));
    for (let b = 0; b < boxes; b++) {
      const avail = berth + 6 + opsRng.next() * 14;
      const congested = inDis('portCongestion', Math.floor(avail / 24));
      // 拥堵时堆场停留翻倍；全链路靠预清关和预约优先放行自己的箱（只多 30%）
      const dwell = s.port.dwellDays * opsRng.logNormal(1, s.port.dwellCv) * (congested ? (s.twin.bridgeBuy ? 1.3 : 2) : 1);
      const out = avail + dwell * 24;
      // 没排铁路班次时全部走拖车（随机数照抽，保持公共随机数的顺序）
      const rail = opsRng.next() < s.port.railShare && s.port.railDays.length > 0;
      let t: number;
      let wait = 0;
      if (rail) {
        // 下一班铁路（默认每周一、三、五 14 点），2.5 小时到物流园货运站，再 1 小时调车
        let dd = Math.floor(out / 24);
        while (!s.port.railDays.includes(dd % 7) || dd * 24 + s.port.railHour < out) dd++;
        t = dd * 24 + s.port.railHour + 3.5;
      } else {
        wait = s.port.gateWaitHours * opsRng.logNormal(1, 0.5);
        t = out + wait + travelHours(routesOpen.get('PORT', 'DC'), (out + wait) % 24);
      }
      const u = units / boxes;
      // 海运冷箱（气调保鲜）到港时已经过了约 14 天
      push({ type: 'dc', t, fam: f, units: u, age: fam.life ? 14 + dwell : 0, pallets: pallets / boxes, src: 'sea', ordered: u, box: { rail, dwell, wait } });
      if (placed !== undefined) orderTime.set(`${f}:${t}`, placed);
      if (trace && Math.floor(t / 24) === s.traceDay) traceContainer(rail, t, out, fam);
    }
  }
  function vesselDelay(call: number): number {
    return vesselDelays.get(call) ?? s.port.vesselDelayDays;
  }
  /** 港口拥堵时这一班船多晚到的天数 */
  function congestionDelay(call: number): number {
    return inDis('portCongestion', call) ? (disOf('portCongestion')?.delayDays ?? 6) : 0;
  }

  // 初始的在途货：海运按每周一班船、国内按提前期，每天均匀到货（像系统一直在运行）
  for (let f = 0; f < NF; f++) {
    const fam = FAMILIES[f] as Family;
    if (fam.source === 'bakery' || isDirect(fam)) continue;
    const m = chainMean(f);
    const x = dc[f] as DcFam;
    if (fam.source === 'rail') {
      // 已经在路上的班列（每周一列，每列一周的量），接到运行中下的第一批单到站
      for (let w = 0; w < 5; w++)
        for (const td of tDays) {
          const u = (m * 7) / tDays.length;
          x.onOrder += u;
          railShipment(w * 7 + td, f, u, undefined);
        }
    } else if (fam.source === 'sea') {
      // 已经在路上的货（每周一班船，每班一周的量），一直接到运行中下的第一批单到港
      for (let w = 0; w < 8; w++)
        for (const cd of callDays) {
          const u = (m * 7) / callDays.length;
          x.onOrder += u;
          seaShipment(w * 7 + cd, f, u, undefined);
        }
    } else {
      const L = Math.max(1, Math.round(leadOf(fam)));
      for (let k = 1; k <= L; k++) {
        const u = m;
        x.onOrder += u;
        const t = k * 24 + (fam.source === 'local' ? s.dc.localArriveHour : fam.source === 'air' ? s.air.flightHour + s.air.handlingHours + 1 : 10);
        push({ type: 'dc', t, fam: f, units: u, age: fam.source === 'local' ? 0.6 : fam.source === 'air' ? 2 : 3, pallets: u / (casesPerPallet(fam) * fam.unitsPerCase), src: fam.source, ordered: u });
      }
    }
  }

  // —— 处理到货事件 ——
  const lastTraceIn = new Map<string, number>();
  function process(until: number): void {
    while (queue.length && (queue[0] as Ev).t < until) {
      const e = queue.shift() as Ev;
      const d = Math.floor(e.t / 24);
      if (e.type === 'dc') {
        const x = dc[e.fam] as DcFam;
        const fam = FAMILIES[e.fam] as Family;
        x.onOrder = Math.max(0, x.onOrder - e.ordered);
        if (fam.life) addCohort(x.cohorts, e.units, e.age);
        else x.onHand += e.units;
        if (measured(d) && d < days && e.box) {
          M.containers++;
          if (e.box.rail) M.rail++;
          else {
            M.drayKm += routesOpen.get('PORT', 'DC').km * 2;
            M.drayWait += e.box.wait;
          }
          M.dwellSum += e.box.dwell;
          M.demurrageDays += Math.max(0, e.box.dwell - s.port.freeDays);
          M.seaKg += (e.units / fam.unitsPerCase) * fam.kg;
        }
        if (measured(d) && d < days && e.train) {
          M.trainBoxes++;
          M.railKg += (e.units / fam.unitsPerCase) * fam.kg;
        }
        if (measured(d) && d < days) {
          M.inPallets += e.pallets;
          const placed = orderTime.get(`${e.fam}:${e.t}`);
          if (placed !== undefined) {
            const lt = (e.t - placed) / 24;
            const bucket = e.src === 'domestic' ? M.leadDom : e.src === 'sea' ? M.leadSea : e.src === 'rail' ? M.leadRail : e.src === 'air' ? M.leadAir : M.leadLocal;
            bucket[0] = (bucket[0] as number) + lt * e.units;
            bucket[1] = (bucket[1] as number) + e.units;
          }
        }
        // 入库车辆：国内整车（按 26 托拼车，部分由回程车顺带）、本地集货车、机场冷藏车
        if (e.src === 'domestic' || e.src === 'local' || e.src === 'air') inboundTruck(e, d);
      } else {
        for (const it of e.items) {
          const fam = FAMILIES[it.fam] as Family;
          const total = it.units.reduce((a, b) => a + b, 0);
          it.units.forEach((u, k) => {
            const sl = ((slots[e.store] as Slot[][])[it.fam] as Slot[])[k] as Slot;
            sl.onOrder = Math.max(0, sl.onOrder - u);
            if (fam.life) {
              const share = total > 0 ? u / total : 0;
              for (const c of it.ages) addCohort(sl.cohorts, c.q * share, c.age);
            } else sl.onHand += u;
          });
          if (measured(d) && d < days) {
            M.cases += total / fam.unitsPerCase;
            if (fam.life) {
              M.received += total;
              (FM[it.fam] as { received: number }).received += total;
              for (const c of it.ages) {
                M.freshAgeSum += c.q * c.age;
                M.freshRemainSum += c.q * Math.max(0, 1 - c.age / (fam.life as number));
                M.freshUnits += c.q;
              }
            }
          }
        }
        if (measured(d) && d < days) {
          M.deliveries++;
          if (e.onTime) M.onTime++;
          if (e.direct) {
            M.directLoads += e.direct.loads;
            M.directKm += e.direct.km;
            M.directPallets += e.direct.pallets;
            const placed = orderTime.get(`d${e.direct.fam}:${e.t}`);
            if (placed !== undefined) {
              const total = e.items.reduce((a, it) => a + it.units.reduce((p, q) => p + q, 0), 0);
              M.leadDom[0] = (M.leadDom[0] as number) + ((e.t - placed) / 24) * total;
              M.leadDom[1] = (M.leadDom[1] as number) + total;
            }
          }
        }
        dayStats.deliveries++;
        if (e.onTime) dayStats.onTime++;
      }
    }
    void lastTraceIn;
  }

  // 入库车辆的计数（每天、每条进货路线拼车）
  const inbound = new Map<string, { pallets: number; t: number; via: string; src: string; kmPallets: number; fam: Family }>();
  function inboundTruck(e: Extract<Ev, { type: 'dc' }>, d: number): void {
    const fam = FAMILIES[e.fam] as Family;
    const via = e.src === 'domestic' || e.src === 'local' ? (fam.supplier?.via ?? 'NORTH') : 'AIR';
    // 国内供应商各自发车（一个商品族 = 一家供应商，不足一车也要单独走）；区域生鲜集货和机场货站按路线拼车
    // 一天几班航班时，每班的货各用一趟冷藏车从机场拉回来
    const key = e.src === 'domestic' ? `${d}:${fam.key}:${e.src}` : `${d}:${via}:${e.src}${e.src === 'air' && fHours.length > 1 ? `:${Math.floor(e.t)}` : ''}`;
    const cur = inbound.get(key) ?? { pallets: 0, t: e.t, via, src: e.src, kmPallets: 0, fam };
    cur.pallets += e.pallets;
    cur.kmPallets += e.pallets * (e.src === 'domestic' ? (fam.supplier?.km ?? 150) : e.src === 'local' ? (fam.supplier?.km ?? 0) : 0);
    inbound.set(key, cur);
  }
  function closeInbound(d: number): void {
    for (const [key, x] of inbound) {
      if (!key.startsWith(`${d}:`)) continue;
      inbound.delete(key);
      const cap = x.src === 'air' ? 12 : PALLETS_PER_TRAILER;
      const loads = Math.ceil(x.pallets / cap - 1e-9);
      const inMap = routesOpen.get(x.via, 'DC').km;
      const km = x.pallets > 0 ? x.kmPallets / x.pallets : 0;
      if (x.src === 'domestic') {
        const back = loads * s.fleet.backhaulShare;
        if (measured(d) && d < days) {
          M.inLoads += loads - back;
          M.inKm += (loads - back) * (km + inMap) * 2;
          M.backhaul += back;
          // 回程车顺带：从门店绕到供应商出口再回来，额外里程约为进货里程的一半
          M.backhaulKm += back * (km + inMap) * 0.5;
        }
        if (trace && d === s.traceDay)
          for (let k = 0; k < Math.min(loads, 8); k++) {
            const p = Math.max(1, Math.min(cap, Math.round(x.pallets - k * cap)));
            traceInbound(x.via, x.t + k * 0.4, `长途整车（进配送中心） · ${x.fam.label} · ${p} 托${loads > 1 ? `（第 ${k + 1}/${loads} 车）` : ''}`, x.fam.temp === 'ambient' ? 'truck' : 'reefer', p, { id: `IN-${x.fam.key}-${k + 1}`, kind: 'supplier', zone: x.fam.temp, edit: { mode: 'arrive', key: `IN-${x.fam.key}`, min: 0, max: 23.5 }, load: { [x.fam.key]: p * casesPerPallet(x.fam) * x.fam.unitsPerCase } });
          }
      } else if (x.src === 'local') {
        if (measured(d) && d < days) {
          M.milk += loads;
          M.milkKm += loads * (inMap + km) * 2;
          M.milkHours += loads * ((inMap + km) / 45 + 1.5);
        }
        if (trace && d === s.traceDay)
          for (let k = 0; k < loads; k++) {
            const p = Math.max(1, Math.min(cap, Math.round(x.pallets - k * cap)));
            traceInbound(x.via, x.t + k * 0.15, `区域生鲜集货车（内陆产区） · ${p} 托`, 'reefer', p, { id: `FR-${k + 1}`, kind: 'farm', zone: 'chilled', edit: { mode: 'arrive', key: 'FR', min: 0, max: 23.5 } });
          }
      } else if (x.src === 'air') {
        if (measured(d) && d < days) M.milkKm += loads * inMap * 2;
        if (trace && d === s.traceDay)
          for (let k = 0; k < loads; k++) {
            const p = Math.max(1, Math.min(cap, Math.round(x.pallets - k * cap)));
            traceInbound('AIR', x.t + k * 0.1, `空运冷藏车（机场 → 配送中心）· ${p} 托`, 'reefer', p, { id: `AT-${k + 1}`, kind: 'airTruck', zone: 'chilled', edit: { mode: 'standing', key: 'flight' } });
          }
      }
    }
  }

  // —— 三维动画：入库车辆、集装箱、铁路、船、飞机 ——
  /** 进货车：开到配送中心，在月台卸货（卸货时长按收货效率） */
  function traceInbound(from: string, arrive: number, label: string, kind: string, pallets: number, o: { id: string; kind: OpKind; zone: string; edit?: Op['edit']; load?: Record<string, number> }): void {
    if (!trace) return;
    const path = routesOpen.get(from, 'DC');
    const h = travelHours(path, arrive % 24);
    const unload = 0.25 + pallets / s.dc.receiveRate;
    // 空运冷藏车出发前在机场货站的收货口装车（叉车把拆好的航空板货装进车厢），三维和跟踪里看得到
    const pre = from === 'AIR' ? [{ t0: arrive - h - 0.35, t1: arrive - h, at: path.pts[0] as Km, place: 'AIR', act: '在机场货站装车' }] : [];
    const vid = trace.vehicle(kind, label, [...pre, { t0: arrive - h, t1: arrive, path, act: '进货' }, { t0: arrive, t1: arrive + unload, at: path.pts[path.pts.length - 1] as Km, place: 'DC', act: '在配送中心卸货' }], s.traceDay * 24);
    trace.op({ id: o.id, kind: o.kind, label, vehicle: vid, t0: arrive - h, t1: arrive + unload, from, to: 'DC', zone: o.zone, unit: kind === 'truck' ? 'dry' : 'reefer', pallets, km: path.km, arrive, dock: [arrive, arrive + unload], ...(o.edit ? { edit: o.edit } : {}), ...(o.load ? { load: o.load } : {}) });
  }
  /** 长途直送车：从高速口开进城，在门店收货口卸完，原路回高速口 */
  function traceDirect(st: StoreSite, via: string, arrive: number, fam: Family, pallets: number, k: number, loads: number, win: [number, number], units: number): void {
    if (!trace) return;
    const path = routesOpen.get(via, st.key);
    const h = travelHours(path, arrive % 24);
    const dayStart = s.traceDay * 24;
    const start = Math.max(arrive, dayStart + win[0]);
    const unload = (s.store.unloadMin + s.store.unloadMinPerPallet * pallets) / 60;
    const back = routesOpen.get(st.key, via);
    const t1 = start + unload + travelHours(back, (start + unload) % 24);
    const label = `长途直送车 · ${fam.label} · ${pallets} 托${loads > 1 ? `（第 ${k}/${loads} 车）` : ''}`;
    const kind = fam.temp === 'ambient' ? 'truck' : 'reefer';
    const segs: { t0: number; t1: number; pts?: Km[]; at?: Km; act: string; route?: string[]; place?: string }[] = [{ t0: arrive - h, t1: arrive, pts: dockPts(path.pts, undefined, st), route: path.nodes, act: `开往${st.name}` }];
    if (start - arrive > 1 / 120) segs.push({ t0: arrive, t1: start, at: st.dock, place: st.key, act: `在${st.name}等收货时间` });
    segs.push({ t0: start, t1: start + unload, at: st.dock, place: st.key, act: `在${st.name}卸货` });
    segs.push({ t0: start + unload, t1, pts: dockPts(back.pts, st, undefined), route: back.nodes, act: fam.supplier?.border ? '回跨境口岸方向' : '回高速口' });
    const vid = trace.vehicle(kind, label, segs, dayStart);
    trace.op({
      id: `DS-${fam.key}-${k}`,
      kind: 'direct',
      label,
      vehicle: vid,
      t0: arrive - h,
      t1,
      from: via,
      to: st.key,
      zone: fam.temp,
      unit: kind === 'truck' ? 'dry' : 'reefer',
      pallets,
      cap: PALLETS_PER_TRAILER,
      km: path.km + back.km,
      arrive,
      stops: [{ key: st.key, name: st.name, arrive, start, end: start + unload, pallets, open: win[0], close: win[1], onTime: start <= dayStart + win[1] + 1e-9, slow: (h - path.hours) * 60, load: { [fam.key]: units } }],
      edit: { mode: 'arrive', key: `DS-${fam.key}`, min: 0, max: 23.5 },
    });
  }
  let drayN = 0;
  function traceContainer(rail: boolean, t: number, leftPort: number, fam: Family): void {
    if (!trace) return;
    if (rail) trace.rail(t - 3.5, t - 1, fam.label);
    else {
      const path = routesOpen.get('PORT', 'DC');
      const t0 = t - travelHours(path, leftPort % 24);
      const label = `集装箱拖车 · ${fam.label}`;
      // 出发前在港口堆场：龙门吊把箱放到拖车上
      const vid = trace.vehicle('drayage', label, [{ t0: t0 - 0.2, t1: t0, at: path.pts[0] as Km, place: 'PORT', act: '在港口堆场装箱' }, { t0, t1: t, path, act: '从港口提箱' }, { t0: t, t1: t + 0.6, at: path.pts[path.pts.length - 1] as Km, place: 'DC', act: '在配送中心拆箱' }], s.traceDay * 24);
      trace.op({ id: `DR-${String(++drayN).padStart(2, '0')}`, kind: 'drayage', label, vehicle: vid, t0, t1: t + 0.6, from: 'PORT', to: 'DC', zone: fam.temp, unit: 'tractor', pallets: PALLETS_PER_FEU, km: path.km, arrive: t, dock: [t, t + 0.6] });
    }
  }

  // —— 每天结束：生鲜打折、过期、损耗，记库存 ——
  function endOfDay(d: number): void {
    let inv = 0;
    let invV = 0;
    let dayDemand = 0;
    let dayLost = 0;
    for (let i = 0; i < NS; i++)
      for (let f = 0; f < NF; f++) {
        const fam = FAMILIES[f] as Family;
        for (let k = 0; k < NK; k++) {
          const sl = ((slots[i] as Slot[][])[f] as Slot[])[k] as Slot;
          const want = ((demandOf[i] as number[][])[f] as number[])[k] as number;
          dayDemand += want;
          if (fam.life) {
            const life = fam.life;
            for (const c of sl.cohorts) {
              // 打折：上一代最后一天卖掉约 35%（6 折）；动态降价从倒数第二天开始，卖得更多、折扣更浅
              const md = s.store.markdown === 'lastDay' ? (c.age >= life - 1 ? 0.35 : 0) : c.age >= life - 2 ? 0.45 : 0;
              if (md > 0) {
                const n = c.q * md;
                c.q -= n;
                if (measured(d)) M.markdown += n * fam.price * (s.store.markdown === 'lastDay' ? 0.4 : 0.25);
              }
              const spoil = c.q * (SPOIL[fam.cat] ?? 0) * s.store.spoilFactor;
              c.q -= spoil;
              if (measured(d)) {
                M.waste += spoil;
                (FM[f] as { waste: number }).waste += spoil;
              }
              c.age += 1;
            }
            const keep: Cohort[] = [];
            for (const c of sl.cohorts) {
              if (c.age >= life) {
                if (measured(d)) {
                  M.waste += c.q;
                  (FM[f] as { waste: number }).waste += c.q;
                }
              } else if (c.q > 1e-6) keep.push(c);
            }
            sl.cohorts = keep;
          }
          const q = stockOf(sl);
          inv += q;
          invV += valueOf(f, q);
          if (measured(d)) {
            M.slotDays++;
            if (q < 0.5) M.stockoutSlots++;
          }
        }
      }
    // 配送中心：剩余保质期太短的报废
    let dcInv = 0;
    let dcV = 0;
    for (let f = 0; f < NF; f++) {
      const fam = FAMILIES[f] as Family;
      const x = dc[f] as DcFam;
      if (fam.life) {
        const keep: Cohort[] = [];
        for (const c of x.cohorts) {
          c.age += 1;
          if (c.age >= fam.life - dcMinRemain(fam.life)) {
            if (measured(d)) {
              M.dcWaste += c.q;
              (FM[f] as { dcWaste: number }).dcWaste += c.q;
            }
          } else keep.push(c);
        }
        x.cohorts = keep;
      }
      const q = dcStock(x);
      dcInv += q;
      dcV += valueOf(f, q);
      if (measured(d)) (FM[f] as { dcUnits: number }).dcUnits += q;
    }
    if (measured(d)) {
      M.invUnits += inv;
      M.invValue += invV;
      M.dcInvUnits += dcInv;
      M.dcInvValue += dcV;
      // 在途库存（下单了还没到配送中心的）
      M.transitValue += FAMILIES.reduce((a, _f, f) => a + valueOf(f, (dc[f] as DcFam).onOrder), 0);
      const lostToday = M.lost - (daily.lost.reduce((a, b) => a + b, 0) || 0);
      void lostToday;
    }
    const meanDemand = BASE_UNITS * s.demand.scale * STORES.reduce((a, st) => a + st.size, 0);
    daily.storeInvDays.push(inv / meanDemand);
    daily.dcInvDays.push(dcInv / meanDemand);
    void dayDemand;
    void dayLost;
  }

  /** 三维动画：这一天靠港的船、货运航班、门店的线上配送车 */
  function traceExtras(d: number): void {
    if (!trace) return;
    // 一周几个航次时每班船小一些、在港时间短一些（不和下一班重叠）
    const stay = callDays.length > 1 ? Math.max(14, 26 - 3 * (callDays.length - 1)) : 26;
    for (const w of [Math.floor(d / 7) - 1, Math.floor(d / 7)])
    for (const cd of callDays) {
      const call = w * 7 + cd;
      const berth = call * 24 + s.port.vesselHour + (vesselDelay(call) + congestionDelay(call)) * 24;
      const weekly = FAMILIES.reduce((a, fam, f) => a + (fam.source === 'sea' ? (chainMean(f) * 7) / (casesPerPallet(fam) * fam.unitsPerCase * PALLETS_PER_FEU) : 0), 0);
      const label = callDays.length > 1 ? `集装箱船（本店班轮 · 每周 ${callDays.length} 个航次，约 ${Math.round(weekly / callDays.length)} 个自己的 40 尺箱）` : `集装箱船（本周班轮，约 ${Math.round(weekly)} 个自己的 40 尺箱）`;
      const arrive = call * 24 + s.port.vesselHour;
      if (berth + stay + 3 > d * 24 && berth - 3 < (d + 1) * 24) {
        trace.ship(berth, stay, label);
        trace.event(berth, '集装箱船靠泊，开始卸箱');
      } else if (inDis('portCongestion', call) && arrive < (d + 1) * 24 && berth - 3 > d * 24) {
        trace.anchored(Math.max(d * 24, arrive), Math.min((d + 1) * 24, berth - 3), label);
        trace.event(Math.max(d * 24, arrive) + 0.01, '港口拥堵：本周班轮在锚地等泊位');
      }
    }
    for (const dd of [d - 1, d])
      for (const fh of fHours) {
        const land = dd * 24 + fh;
        if (inDis('airportClosed', dd)) continue;
        if (land + 3 > d * 24 && land - 0.2 < (d + 1) * 24) {
          trace.flight(land, 3, fHours.length > 1 ? `货运航班（进口果蔬、海鲜 · 每天 ${fHours.length} 班）` : '货运航班（进口果蔬、海鲜）');
          trace.event(land, '货运航班落地，生鲜进货站');
        }
      }
    // 门店的线上配送车：每天 10、13、16、19 点几波出发，沿道路往附近的小区送一圈再回来（只是动画，按门店规模定车次）
    for (const st of STORES) {
      const trips = Math.max(1, Math.round(4 * st.size * s.demand.scale));
      const near = [...currentRegion().city.nodes].sort((a, b) => Math.hypot((NODES[a] as Km).x - st.km.x, (NODES[a] as Km).y - st.km.y) - Math.hypot((NODES[b] as Km).x - st.km.x, (NODES[b] as Km).y - st.km.y)).slice(0, 5);
      for (let k = 0; k < trips; k++) {
        const t0 = d * 24 + [10, 13, 16, 19][k % 4]! + Math.floor(k / 4) * 0.25;
        const out = routesOpen.get(st.key, near[k % near.length] as string);
        const outPts = dockPts(out.pts, st, undefined).slice(0, -1);
        // 送到半路的小区就折返（不进别的门店）
        const half = outPts.slice(0, Math.max(2, Math.ceil(outPts.length * 0.75)));
        const h = travelHours(out, t0 % 24) * 0.75;
        // 三维场景按街道生成这一圈的路线和几个送货点（loop）；pts 是没有车道模型时的退路
        const vid = trace.vehicle('van', `${st.name}线上配送车`, [{ t0, t1: t0 + 2 * h + 0.35, pts: [...half, ...[...half].reverse()], place: st.key, loop: true, act: '送线上订单' }], d * 24);
        trace.op({ id: `VN-${st.key}-${k + 1}`, kind: 'van', label: `${st.name}线上配送车（第 ${k + 1} 波）`, vehicle: vid, t0, t1: t0 + 2 * h + 0.35, from: st.key, to: st.key, unit: 'van', km: out.km * 1.5, depart: t0 });
      }
    }
    if (inDis('highwayClosed', d)) trace.event(d * 24 + 3, s.twin.reroute ? '高速（物流园进城）封闭：孪生已为所有车辆改道' : '高速（物流园进城）封闭：第一批车开到封闭处才折返');
    if (inDis('portCongestion', d)) trace.event(d * 24 + 8, '港口拥堵：班轮延误、堆场停留翻倍');
    if (inDis('airportClosed', d)) trace.event(d * 24 + 5, '机场因风暴关闭，货运航班顺延');
    if (inDis('supplierOutage', d)) trace.event(d * 24 + 9, '常温畅销品的主供应商停产');
    if (inDis('demandSurge', d)) trace.event(d * 24 + 9, '需求突增（约 +35%）');
  }

  // —— 主循环 ——
  let lostBefore = 0;
  let demandBefore = 0;
  const totalSize = STORES.reduce((a, st) => a + st.size, 0);
  for (let d = 0; d < days; d++) {
    drawDemand(d);
    if (trace && d === s.traceDay) {
      FAMILIES.forEach((fam, f) => {
        trace.storeStock[fam.key] = ((slots[0] as Slot[][])[f] as Slot[]).reduce((a, sl) => a + stockOf(sl), 0);
        trace.storeDemand[fam.key] = (((demandOf[0] as number[][])[f] as number[]) ?? []).reduce((a, b) => a + b, 0);
      });
      traceExtras(d);
      trace.series.dcDays = [];
      trace.series.storeDays = [];
      trace.series.lost = [];
    }
    for (let h = 0; h < 24; h++) {
      process(d * 24 + h + 1);
      watchZones();
      if (trace && d === s.traceDay) {
        const mean = BASE_UNITS * s.demand.scale * totalSize;
        (trace.series.dcDays as number[]).push(dc.reduce((a, x) => a + dcStock(x), 0) / mean);
        let st = 0;
        for (const ss of slots) for (const ff of ss) for (const sl of ff) st += stockOf(sl);
        (trace.series.storeDays as number[]).push(st / mean);
        (trace.series.lost as number[]).push(M.lost - lostBefore);
      }
      sell(d, h);
      if (h === 22) {
        storeOrders(d);
        directOrders(d);
      }
      // 分配：上一代 / StoreX 当晚 23 点；全链路第二天 2 点（等夜里到的生鲜一起越库）
      if (d * 24 + h === allocAbs(d)) allocate(d);
      if (s.gen === 'g3' && d > 0 && d * 24 + h === allocAbs(d - 1)) allocate(d - 1);
      if (h === 23) replenish(d);
    }
    closeInbound(d);
    closeZones(d);
    // 配送中心工时：拣货、收货、装车
    if (measured(d)) {
      M.laborHours += s.dc.fixedHours;
    }
    endOfDay(d);
    daily.service.push(M.demand - demandBefore > 0 ? 1 - (M.lost - lostBefore) / (M.demand - demandBefore) : 1);
    daily.lost.push(M.lost - lostBefore);
    daily.onTime.push(dayStats.deliveries > 0 ? dayStats.onTime / dayStats.deliveries : 1);
    daily.airService.push(dayStats.airDemand > 0 ? 1 - dayStats.airLost / dayStats.airDemand : 1);
    dayStats.deliveries = 0;
    dayStats.onTime = 0;
    dayStats.airDemand = 0;
    dayStats.airLost = 0;
    lostBefore = M.lost;
    demandBefore = M.demand;
  }

  // —— 汇总 ——
  const n = days - s.warmup;
  const per = (x: number) => x / n;
  const meanDemand = BASE_UNITS * s.demand.scale * STORES.reduce((a, st) => a + st.size, 0);
  const C = s.costs;
  const laborHours = per(M.laborHours) + per(M.picked) / s.dc.pickRate + per(M.inPallets) / s.dc.receiveRate + per(M.outPallets) / s.dc.loadRate;
  const outboundCost = per(M.driverHours) * C.driverHour + per(M.dieselKm) * C.diesel.perKm + per(M.evKm) * C.ev.perKm + (per(M.trucksDays) - per(M.evTrucksDays)) * C.diesel.perDay + per(M.evTrucksDays) * C.ev.perDay + per(M.trailers.dry) * C.trailerPerDay.dry + per(M.trailers.reefer) * C.trailerPerDay.reefer + per(M.trailers.multi) * C.trailerPerDay.multi + per(M.reeferHours) * C.reeferPerHour * (1 - s.fleet.evShare * 0.6);
  const vanCost = per(M.vanKm) * C.van.perKm + per(M.vanHours) * C.van.driverHour + (M.vanFleet || 0) * C.van.perDay * (M.vanTrips > 0 ? 1 : 0);
  // 长途整车（到配送中心、直送门店）按供应商到货价里的运费算（每车公里，往返里程的一半）
  const inboundCost = (per(M.inKm) + per(M.directKm)) * C.inboundPerKm / 2 + per(M.backhaulKm) * C.diesel.perKm + per(M.backhaul) * 1.0 * C.driverHour + per(M.milkKm) * C.diesel.perKm + per(M.milkHours) * C.driverHour;
  const truckBoxes = per(M.containers) - per(M.rail);
  const drayageCost = truckBoxes * (C.drayage.base + C.drayage.perKm * routesOpen.get('PORT', 'DC').km) + per(M.drayWait) * C.drayage.waitPerHour + per(M.rail) * C.railPerContainer + per(M.demurrageDays) * C.demurragePerDay;
  const freight = per(M.containers) * C.oceanPerFeu + per(M.trainBoxes) * C.railFreightPerFeu + per(M.airKg) * C.airPerKg;
  const dcLabor = laborHours * C.dcLaborHour;
  const carrying = (per(M.invValue) + per(M.dcInvValue) + per(M.transitValue)) * (C.carrying / 365);
  // 报废按各商品族自己的进价算（门店报废 + 配送中心报废），再加打折少收的钱
  const wasteCost = FAMILIES.reduce((a, fam, f) => a + (per((FM[f] as { waste: number }).waste) + per((FM[f] as { dcWaste: number }).dcWaste)) * (fam.caseCost / fam.unitsPerCase), 0) + per(M.markdown);
  const lostMargin = per(M.lostMargin);
  const total = outboundCost + vanCost + inboundCost + drayageCost + freight + dcLabor + carrying + wasteCost + lostMargin;
  const cases = per(M.cases);
  const co2Out = per(M.dieselKm) * C.co2.dieselKm + per(M.evKm) * C.co2.evKm + per(M.reeferHours) * C.co2.reeferHour * (1 - s.fleet.evShare * 0.6);
  const co2Vans = per(M.vanKm) * C.co2.vanKm;
  const co2In = (per(M.inKm) + per(M.directKm) + per(M.backhaulKm) + per(M.milkKm)) * C.co2.dieselKm;
  const co2Port = per(M.drayKm) * C.co2.drayageKm + per(M.rail) * RAIL_KM * C.co2.railContainerKm;
  const co2Long = (per(M.seaKg) / 1000) * C.co2.oceanTonne + (per(M.railKg) / 1000) * C.co2.railTonne + (per(M.airKg) / 1000) * C.co2.airTonne;
  const co2 = co2Out + co2Vans + co2In + co2Port + co2Long;
  const lead = (b: number[]) => ((b[1] as number) > 0 ? (b[0] as number) / (b[1] as number) : 0);
  const storeDemand = per(M.demand);
  if (hist) {
    for (const [day, delay] of vesselDelays) if (day < days) hist.calls.push({ day, delay: delay + congestionDelay(day) });
    for (const [day, delay] of trainDelays) if (day < days) hist.trains.push({ day, delay });
  }

  return {
    name: s.name,
    gen: s.gen,
    seed: s.seed,
    days: n,
    store: {
      demandUnits: storeDemand,
      soldUnits: per(M.sold),
      lostUnits: per(M.lost),
      service: M.demand > 0 ? (M.sold / M.demand) * 100 : 100,
      lostMargin,
      wastePct: M.received > 0 ? (M.waste / M.received) * 100 : 0,
      wasteUnits: per(M.waste),
      markdownCost: per(M.markdown),
      invDays: per(M.invUnits) / meanDemand,
      invValue: per(M.invValue),
      freshAgeDays: M.freshUnits > 0 ? M.freshAgeSum / M.freshUnits : 0,
      freshRemainPct: M.freshUnits > 0 ? (M.freshRemainSum / M.freshUnits) * 100 : 0,
      deliveries: per(M.deliveries),
      arrivals: per(M.stops + M.vanStops + M.directLoads),
      onTimePct: M.deliveries > 0 ? (M.onTime / M.deliveries) * 100 : 100,
      stockoutSlotPct: M.slotDays > 0 ? (M.stockoutSlots / M.slotDays) * 100 : 0,
      peakPallets: Object.fromEntries(TEMPS.map((k) => [k, zoneDaily[k].length ? zoneDaily[k].reduce((a, b) => a + b, 0) / zoneDaily[k].length : 0])) as Record<Temp, number>,
      peakPallets95: Object.fromEntries(TEMPS.map((k) => [k, quantile(zoneDaily[k], 0.95)])) as Record<Temp, number>,
    },
    dc: {
      invDays: per(M.dcInvUnits) / meanDemand,
      invValue: per(M.dcInvValue),
      fillPct: M.dcOrdered > 0 ? (M.dcShipped / M.dcOrdered) * 100 : 100,
      wasteUnits: per(M.dcWaste),
      laborHours,
      casesPicked: per(M.picked),
      casesPerHour: laborHours > 0 ? per(M.picked) / laborHours : 0,
      inboundPallets: per(M.inPallets),
      outboundPallets: per(M.outPallets),
    },
    outbound: {
      trips: per(M.trips),
      km: per(M.km),
      driverHours: per(M.driverHours),
      fillPct: M.capOut > 0 ? (M.palletsOut / M.capOut) * 100 : 0,
      evKm: per(M.evKm),
      dieselKm: per(M.dieselKm),
      reeferHours: per(M.reeferHours),
      fleet: M.fleetMax,
      vanTrips: per(M.vanTrips),
      vanKm: per(M.vanKm),
      stopsPerTrip: M.trips > 0 ? M.stops / M.trips : 0,
    },
    inbound: {
      truckloads: per(M.inLoads),
      km: per(M.inKm),
      backhaulLoads: per(M.backhaul),
      milkRuns: per(M.milk),
      milkKm: per(M.milkKm),
      containers: per(M.containers),
      railContainers: per(M.rail),
      drayageKm: per(M.drayKm),
      portDwellDays: M.containers > 0 ? M.dwellSum / M.containers : 0,
      demurrage: per(M.demurrageDays) * C.demurragePerDay,
      airKg: per(M.airKg),
      seaTonnes: per(M.seaKg) / 1000,
      trainBoxes: per(M.trainBoxes),
      railTonnes: per(M.railKg) / 1000,
      directLoads: per(M.directLoads),
      directKm: per(M.directKm),
      directPallets: per(M.directPallets),
    },
    leadTime: { domesticDays: lead(M.leadDom), seaDays: lead(M.leadSea), railDays: lead(M.leadRail), airDays: lead(M.leadAir), localDays: lead(M.leadLocal) },
    cost: { outbound: outboundCost, vans: vanCost, inbound: inboundCost, drayageRail: drayageCost, freight, dcLabor, carrying, waste: wasteCost, lostMargin, total, perCase: cases > 0 ? total / cases : 0 },
    co2: { outbound: co2Out, vans: co2Vans, inbound: co2In, portRail: co2Port, longHaul: co2Long, total: co2, perCase: cases > 0 ? co2 / cases : 0 },
    casesDelivered: cases,
    responseCost,
    byFamily: FAMILIES.map((fam, f) => {
      const x = FM[f] as { ordered: number; shipped: number; demand: number; lost: number; waste: number; received: number; dcUnits: number; dcWaste: number };
      return { key: fam.key, label: fam.label, dcFill: x.ordered > 0 ? (x.shipped / x.ordered) * 100 : 100, service: x.demand > 0 ? (1 - x.lost / x.demand) * 100 : 100, wastePct: x.received > 0 ? (x.waste / x.received) * 100 : 0, dcDays: x.demand > 0 ? x.dcUnits / x.demand : 0, dcWasteUnits: per(x.dcWaste) };
    }),
    daily,
    ...(trace ? { trace: trace.toJSON() } : {}),
    ...(hist ? { history: hist } : {}),
  };
}

/** 港口到物流园的铁路里程 */
const RAIL_KM = (() => {
  let km = 0;
  for (let i = RAIL_PORT_INDEX + 1; i <= RAIL_DC_INDEX; i++) km += Math.hypot((RAIL[i] as Km).x - (RAIL[i - 1] as Km).x, (RAIL[i] as Km).y - (RAIL[i - 1] as Km).y);
  return km * 1.1;
})();

/**
 * 三维动画用：路线的两头换成门店的卸货口（店房北面），从南边来的车先绕到店房侧面，不穿过店房
 */
function dockPts(path: readonly Km[], from: StoreSite | undefined, to: StoreSite | undefined): Km[] {
  const pts = path.slice(from ? 1 : 0, to ? -1 : undefined);
  const out: Km[] = [];
  const side = (st: StoreSite, other: Km | undefined): Km | undefined => (other && other.y < st.km.y + 0.15 ? { x: st.km.x + (other.x <= st.km.x ? -0.5 : 0.5), y: st.km.y + 0.1 } : undefined);
  if (from) {
    out.push(from.dock);
    const s1 = side(from, pts[0]);
    if (s1) out.push(s1);
  }
  out.push(...pts);
  if (to) {
    const s2 = side(to, pts[pts.length - 1]);
    if (s2) out.push(s2);
    out.push(to.dock);
  }
  return out;
}

function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))] as number;
}
