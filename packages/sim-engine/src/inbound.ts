import { createRng } from '@storewright/domain';
import { aisleFor, backroomLayout, backroomRoute, floorSpotFor, storeAreas, upperStock, type BackroomLayout, type StoreModel } from '@storewright/store-config';
import { Simulation } from './kernel';
import { planDeliveries, type DeliveryPlan, type DeliverySource, type Season } from './deliveries';
import type { TrafficParams } from './traffic';

/**
 * 到货、收货、上架与补货（后仓库存仓库）。
 *
 * 一天中的到货（排班见 deliveries.ts，决策记录 0019）：
 * - 清晨配送中心的冷藏半挂车（冷藏、冷冻货），由早班收货员用叉车卸货；
 * - 上午一家接一家的供应商直送（面包、乳品、饮料、零食、啤酒……厢式货车和面包车），用手动液压搬运车卸货，直接送上货架；
 *   饮用水、整车直送用半挂车；下午快递面包车、（每周几次）配送中心的百货半挂车；
 * - 关门后配送中心的长途半挂车（常温货为主，约 18 托一车，几车间隔一段时间陆续到达），由夜班叉车司机卸货。
 * 每托货卸到收货区点数贴标后，约 45% 直接上货架（当晚补货），其余用叉车放进托盘货架（库存）。
 * 夜班补货员从收货区或货架上的托盘取货（约 40 箱一车），推到对应货架通道逐箱上架；
 * 需要的托盘在高层时，先由叉车放到地面。开门时没上架的箱数即开店缺货风险。
 *
 * 卸货场（决策记录 0018）：车辆到达后在场内的待命车道按先后排队；场地同一时间只让一辆车行驶
 * （驶向卸货门并倒车靠台，或从卸货门拉出驶离），驶离优先（让出卸货门）；有空门且场地空出时，排在最前的车进场。
 * 后仓的叉车与搬运车（决策记录 0018）：派离作业点最近的空闲设备；两台以上叉车时分工（一台主卸货、一台主上架和取高层），
 * 对方空着时互相顶上；一个车厢里同时只进一台设备；一条货架通道同时只进一台叉车（别的叉车在通道口等）；
 * 作业完从货架通道驶出到主通道，司机去做别的事之前把设备停回充电位。
 *
 * 连通通道（决策记录 0019）：后仓货架放满、或者收货区地面快堆满时，搬运车把等着上架的托盘经连通通道送到暂存区的溢流位，
 * 夜班也从那里取货补货。两层的门店：二楼货架的托盘用搬运车经一楼收货区旁的货梯送到二楼卸货区（再摆进补货区），
 * 夜班从二楼补货区给二楼的货架补货。
 *
 * 后仓内的移动按叉车通道走直角路线；进入售货区后沿店内行走网络。全部为假设参数，按种子可复现。
 */

export interface InboundParams {
  open: number;
  close: number;
  nextOpen: number;
  nightCrew: number;
  receivers: number;
  totalCases: number;
  /** 夜间常温半挂车、早上冷藏半挂车的托盘数 */
  dcPallets: number;
  reeferPallets: number;
  /** 门店规模（中型店 = 1）：供应商直送的频次与托盘数（决策记录 0019） */
  scale?: number;
  /** 星期几（0 = 周一，默认周四）与季节：决定当天来哪些供应商 */
  weekday?: number;
  season?: Season;
  /** 直接给定当天的到货（不给时按上面的参数排班） */
  deliveries?: DeliveryPlan[];
  /** 路况：到货车辆在路上的延误（拥堵、学校、铁路道口） */
  traffic?: TrafficParams;
  /** 货位分配（决策记录 0020）：默认按低层、靠主通道；velocity 时走得快的通道的托盘放低层、靠主通道，走得慢的放高层和里面 */
  slotting?: 'default' | 'velocity';
  /** 二楼托盘上货梯的顺序：默认先到先送；urgency 时先送二楼走得快的货架的托盘 */
  liftOrder?: 'fifo' | 'urgency';
  /** 开门时货架库存的初始占用率 */
  initialFill: number;
  directShare: number;
  casesPerLoad: number;
  secPerCase: [number, number];
}

export const DEFAULT_INBOUND = {
  receivers: 2,
  initialFill: 0.55,
  directShare: 0.45,
  casesPerLoad: 40,
  secPerCase: [28, 45] as [number, number],
};

export interface Pt3 {
  x: number;
  z: number;
  y: number;
}

/** 带折线的作业片段（坐标为配置平面坐标：x、z 为平面位置，y 为楼层高度） */
export interface PolySegment {
  t0: number;
  t1: number;
  pts: Pt3[];
  activity: string;
  /** 正在搬运的托盘 id（叉车、搬运车）或「cases」（补货车装着纸箱） */
  carry?: string;
  /** 叉车在货位前举升：目标层高度（米）、托盘、放上去（up）还是取下来（down） */
  lift?: { y: number; pallet: string; mode: 'up' | 'down' };
  /** 前几段折线是倒车（叉车叉着托盘从车厢里倒出来，车头仍朝车厢） */
  reverseLegs?: number;
}

export type WorkerKind = 'forklift' | 'jack' | 'receiver' | 'stocker';

export interface WorkerTrace {
  id: string;
  role: 'receiver' | 'night';
  shifts: Array<[number, number]>;
  segments: PolySegment[];
}

export interface EquipmentTrace {
  id: string;
  kind: 'forklift' | 'jack';
  segments: PolySegment[];
}

export interface PalletRecord {
  id: string;
  runId: string;
  /** 仿真结束时剩余箱数 */
  cases: number;
  /** 进入后仓时的箱数 */
  initialCases: number;
  /** 夜班取货记录：时刻与取走箱数（用于按时刻显示剩余高度） */
  draws: Array<[number, number]>;
  /** 到达收货区的时刻与位置（初始库存为空） */
  receivedAt?: number;
  spot?: { x: number; z: number };
  /** 放进货架的时刻与货位 */
  storedAt?: number;
  location?: string;
  /** 高层放到地面（取货前） */
  letdownAt?: number;
  /** 取完的时刻 */
  emptiedAt?: number;
  direct: boolean;
  truck?: string;
  /** 经连通通道送到暂存区溢流位的时刻与位置（决策记录 0019） */
  overflowAt?: number;
  overflowSpot?: { x: number; z: number };
  /** 经货梯送到二楼补货区的时刻、位置与楼层高度（米） */
  upAt?: number;
  upSpot?: { x: number; z: number; y: number };
}

export interface Truck {
  id: string;
  /** 半挂车、冷藏半挂车、厢式货车、面包车（决策记录 0019） */
  kind: 'SEMI' | 'REEFER' | 'BOX' | 'VAN';
  label: string;
  /** 配送中心、配送中心百货、供应商直送、快递 */
  source?: DeliverySource;
  /** 预约时刻（准点应该到的时刻） */
  appt?: number;
  /** 到达卸货场入口的时刻；之后在场内的待命车道排队（决策记录 0018） */
  arrive: number;
  /** 获准进场、开始驶向卸货门（绕到卸货门前、倒车靠台）的时刻 */
  dockAt: number;
  /** 倒车靠稳的时刻 */
  dockedAt: number;
  /** 开始卸货（轮挡、车辆锁、调平板、开门之后） */
  unloadStart: number;
  /** 卸完、交接后从卸货门拉出、开始驶离的时刻 */
  leave: number;
  /** 驶出卸货场的时刻（场地空出来） */
  goneAt: number;
  door: number;
  pallets: number;
  /** 供应商整车直送：托盘白天直接送上货架 */
  vendor?: boolean;
}

/** 卸货场的作业时间（秒）：进场并倒车靠台、靠台后的准备、拉出并驶出卸货场 */
export const YARD_TIMING: Record<Truck['kind'], { dock: number; setup: number; exit: number }> = {
  SEMI: { dock: 240, setup: 180, exit: 150 },
  REEFER: { dock: 240, setup: 180, exit: 150 },
  BOX: { dock: 150, setup: 120, exit: 90 },
  VAN: { dock: 100, setup: 60, exit: 75 },
};

export interface InboundMetrics {
  trucks: number;
  palletsReceived: number;
  avgTurnaroundMin: number;
  /** 从卸货到放进货架或送上货架的平均时间 */
  dockToStockMin: number;
  totalCases: number;
  stockedCases: number;
  backlogCases: number;
  finishAt?: number;
  readyAtOpen: number;
  rackCapacity: number;
  rackUsedStart: number;
  rackUsedEnd: number;
  receivingHours: number;
  nightHours: number;
}

export interface InboundResult {
  trucks: Truck[];
  pallets: PalletRecord[];
  workers: WorkerTrace[];
  equipment: EquipmentTrace[];
  metrics: InboundMetrics;
  /** 上架完成记录 [时刻, 箱数] */
  progress: Array<[number, number]>;
}

const SPEED = 1.5;
const LIFT_SEC = 10;
const SCAN_SEC = 40;
/** 楼层高度（米），与模拟器一致 */
const FLOOR_H = 7;
/** 等货梯开门、进出货梯（秒） */
const LIFT_WAIT = 20;

/**
 * 折线长度里竖直方向的权重：乘电梯、货梯上下一层（7 米）折算成约 42 米的行走，按行走速度约半分钟（决策记录 0019）。
 * 模拟器按同样的长度插值，楼层之间的移动和平面移动速度一致。
 */
export const VERTICAL_WEIGHT = 6;

/** 当天的到货排班（与 simulateInbound 不给 deliveries 时用的一样）：AI 建议改预约时先取出来再改 */
export function inboundDeliveries(model: StoreModel, p: InboundParams, seed: number): DeliveryPlan[] {
  const cfg = model.config;
  return planDeliveries({
    industry: cfg.industry,
    scale: p.scale ?? 1,
    weekday: p.weekday ?? 3,
    season: p.season ?? 'autumn',
    open: p.open,
    close: p.close,
    dcPallets: p.dcPallets,
    reeferPallets: p.reeferPallets,
    gm: cfg.catalog.categories.some((c) => c.fulfillmentType === 'GM'),
    pharmacy: cfg.facilities.some((f) => f.kind === 'PHARMACY'),
    seed,
    ...(p.traffic ? { traffic: p.traffic } : {}),
  });
}

export function simulateInbound(model: StoreModel, runWeights: Record<string, number>, p: InboundParams, seed: number): InboundResult {
  const rng = createRng(seed * 9157 + 31);
  const b: BackroomLayout = backroomLayout(model.config);
  const cfg = model.config;
  const forklifts = cfg.backroom.forklifts;
  const jacks = cfg.backroom.palletJacks;
  const floorY = (id: string) => (cfg.layout.floors.find((f) => f.id === id)?.level ?? 0) * FLOOR_H;
  const node = (id: number): Pt3 => {
    const n = model.nodes[id];
    return n ? { x: n.x, z: n.y, y: floorY(n.floorId) } : { x: 0, z: 0, y: 0 };
  };
  const flat = (pts: Array<{ x: number; z: number }>): Pt3[] => pts.map((q) => ({ x: q.x, z: q.z, y: 0 }));
  const len3 = (pts: Pt3[]) => {
    let n = 0;
    for (let i = 1; i < pts.length; i++) n += Math.hypot((pts[i] as Pt3).x - (pts[i - 1] as Pt3).x, (pts[i] as Pt3).z - (pts[i - 1] as Pt3).z) + Math.abs((pts[i] as Pt3).y - (pts[i - 1] as Pt3).y) * VERTICAL_WEIGHT;
    return n;
  };

  // ---------- 货架通道的销售权重（决定托盘品类与补货去向） ----------
  const runs = cfg.layout.runs.filter((r) => (model.locationsByRun.get(r.id)?.length ?? 0) > 0);
  const weights = runs.map((r) => Math.max(0.05, runWeights[r.id] ?? 1));
  const wsum = weights.reduce((a, c) => a + c, 0) || 1;
  const pickRun = () => {
    let u = rng.next() * wsum;
    for (let i = 0; i < runs.length; i++) {
      u -= weights[i] as number;
      if (u <= 0) return (runs[i] as (typeof runs)[number]).id;
    }
    return (runs[runs.length - 1] as (typeof runs)[number]).id;
  };

  // ---------- 货位状态 ----------
  const locFree = new Map<string, boolean>(b.locations.map((l) => [l.id, true]));
  const locById = new Map(b.locations.map((l) => [l.id, l]));
  const pallets: PalletRecord[] = [];
  let palletSeq = 0;
  const newPallet = (runId: string, cases: number, direct: boolean, truck?: string): PalletRecord => {
    const pr: PalletRecord = { id: `P${String(++palletSeq).padStart(4, '0')}`, runId, cases, initialCases: cases, draws: [], direct, truck };
    pallets.push(pr);
    return pr;
  };
  // 开门前已在货架上的库存（离主通道近、低层优先）
  const order = [...b.locations].sort((a, c) => a.level - c.level || a.row - c.row || c.x - a.x);
  const initial = Math.round(order.length * p.initialFill);
  // 每个通道至少有一托库存（容量允许时），其余按销售比例随机
  const byWeight = runs.map((r, i) => ({ id: r.id, w: weights[i] as number })).sort((a, c) => c.w - a.w || a.id.localeCompare(c.id));
  // 走得快的通道：销量不低于中位数（按走得快慢分货位、按紧缺程度送货梯时用）
  const weightOf = new Map(byWeight.map((r) => [r.id, r.w]));
  const medianWeight = (byWeight[Math.floor(byWeight.length / 2)] as { w: number } | undefined)?.w ?? 0;
  for (let i = 0; i < initial; i++) {
    const l = order[i] as (typeof order)[number];
    const runId = i < byWeight.length ? (byWeight[i] as { id: string }).id : pickRun();
    const pr = newPallet(runId, rng.int(30, 60), false);
    pr.location = l.id;
    pr.storedAt = p.open - 3 * 3600;
    locFree.set(l.id, false);
  }
  const rackUsedStart = initial;

  // ---------- 到货车辆（排班见 deliveries.ts，决策记录 0019） ----------
  const plans = p.deliveries ?? inboundDeliveries(model, p, seed);
  const trucks: Truck[] = plans.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    source: d.source,
    appt: d.appt,
    arrive: d.arrive,
    dockAt: d.arrive,
    dockedAt: d.arrive,
    unloadStart: d.arrive,
    leave: 0,
    goneAt: 0,
    door: 0,
    pallets: d.pallets,
    ...(d.vendor ? { vendor: true } : {}),
  }));
  trucks.sort((a, c) => a.arrive - c.arrive);
  // 百货半挂车的托盘只去百货通道
  const gmCats = new Set(cfg.catalog.categories.filter((c) => c.fulfillmentType === 'GM').map((c) => c.id));
  const gmRuns = runs.filter((r) => r.categoryIds.length > 0 && r.categoryIds.every((c) => gmCats.has(c)));
  const pickGmRun = () => (gmRuns.length ? (gmRuns[rng.int(0, gmRuns.length - 1)] as (typeof gmRuns)[number]).id : pickRun());
  const pickFoodRun = () => {
    for (let k = 0; k < 20; k++) {
      const id = pickRun();
      if (!gmRuns.some((r) => r.id === id)) return id;
    }
    return pickRun();
  };

  // ---------- 人员与设备 ----------
  const workers: WorkerTrace[] = [];
  // 收货员：开门前 2 小时上班；下午还有车（快递、百货半挂车）时值班到最后一辆白天的车到达后 2.5 小时（关门前收工）
  const lastDay = Math.max(0, ...trucks.filter((tr) => tr.arrive < p.close - 3600).map((tr) => tr.arrive));
  const recvShift: [number, number] = [p.open - 2 * 3600, Math.min(p.close - 1800, Math.max(p.open + 6.5 * 3600, lastDay + 2.5 * 3600))];
  for (let i = 0; i < p.receivers; i++) workers.push({ id: `recv-${i + 1}`, role: 'receiver', shifts: [recvShift], segments: [] });
  for (let i = 0; i < p.nightCrew; i++) workers.push({ id: `night-${i + 1}`, role: 'night', shifts: [[p.close, p.nextOpen]], segments: [] });
  const equipment: EquipmentTrace[] = [
    ...Array.from({ length: forklifts }, (_, i) => ({ id: `FL-${i + 1}`, kind: 'forklift' as const, segments: [] as PolySegment[] })),
    ...Array.from({ length: jacks }, (_, i) => ({ id: `PJ-${i + 1}`, kind: 'jack' as const, segments: [] as PolySegment[] })),
  ];
  const eqFree = new Map(equipment.map((e) => [e.id, true]));
  const pos = new Map<string, Pt3>();
  const home: Pt3 = { x: b.receiving.x1 - 1.5, z: b.receiving.z0 + 1, y: 0 };
  for (const w of workers) pos.set(w.id, { ...home });
  // 设备的停放 / 充电位：收货区靠里的一排
  const parkAt = new Map<string, Pt3>(equipment.map((e, i) => [e.id, { x: b.receiving.x0 + 1 + i * 1.6, z: b.receiving.z0 + 0.8, y: 0 }]));
  for (const e of equipment) pos.set(e.id, { ...(parkAt.get(e.id) as Pt3) });
  /** 两台以上叉车时的分工：FL-1 主卸货，FL-2 主上架和取高层，其余不分 */
  const roleOf = (e: EquipmentTrace): 'unload' | 'rack' | 'any' => (forklifts >= 2 && e.kind === 'forklift' ? (e.id === 'FL-1' ? 'unload' : e.id === 'FL-2' ? 'rack' : 'any') : 'any');
  /** 最后一个用这台设备的人（去做别的事之前把它停回充电位） */
  const lastOp = new Map<string, string>();
  /** 正在进出车厢的设备（一个卸货门同时只进一台） */
  const doorLock = new Map<number, string>();
  /** 货架通道的占用：哪台叉车、占到什么时刻 */
  const aisleRes = new Map<number, { eq: string; until: number }>();
  const aisleFreeAt = (ai: number, t: number, eq: string) => {
    const r = aisleRes.get(ai);
    return r && r.eq !== eq && r.until > t ? r.until : t;
  };

  // 收货区的落地位置（网格）
  const spots: Array<{ x: number; z: number; taken: boolean }> = [];
  for (let x = b.receiving.x0 + 1.2; x < b.receiving.x1 - 1; x += 1.6) for (let z = b.receiving.z0 + 2.4; z < b.receiving.z1 - 1.5; z += 1.6) spots.push({ x, z, taken: false });
  // 连通通道与暂存区的溢流位（决策记录 0019）
  const sa = storeAreas(cfg);
  const passage = sa.areas.find((a) => a.kind === 'PASSAGE' && a.floorId === cfg.layout.points.staging.floorId);
  const overflowArea = sa.areas.find((a) => a.kind === 'OVERFLOW');
  const ovSpots: Array<{ x: number; z: number; taken: boolean }> = [];
  if (passage && overflowArea) for (let z = overflowArea.z0 + 0.9; z < overflowArea.z1 - 0.5; z += 1.6) for (let x = overflowArea.x1 - 0.9; x > overflowArea.x0 + 0.5; x -= 1.6) ovSpots.push({ x, z, taken: false });
  const sp = cfg.layout.points.staging;
  const stagingAt: Pt3 = { x: sp.x, z: sp.y, y: 0 };
  /** 去掉连续重复的点 */
  const dedupe = (pts: Pt3[]): Pt3[] => pts.filter((q, i, a) => i === 0 || Math.hypot(q.x - (a[i - 1] as Pt3).x, q.z - (a[i - 1] as Pt3).z) + Math.abs(q.y - (a[i - 1] as Pt3).y) > 0.01);
  /** 连通通道里经过的点：收货区前沿 → 通道后端 → 通道前端 */
  const pcx = passage ? (passage.x0 + passage.x1) / 2 : 0;
  const viaPassage = (from: { x: number; z: number }, to: { x: number; z: number }): Pt3[] =>
    passage ? dedupe(flat([from, { x: from.x, z: b.receiving.z0 + 0.6 }, { x: pcx, z: b.receiving.z0 + 0.6 }, { x: pcx, z: passage.z0 + 0.6 }, { x: pcx, z: to.z }, to])) : flat([from, to]);
  // 二楼的卸货区与补货区（两层的门店）
  const us = upperStock(cfg);
  const upRuns = new Set(us ? cfg.layout.runs.filter((r) => r.floorId === us.floorId).map((r) => r.id) : []);
  const upSpots = (us?.spots ?? []).map((q) => ({ ...q, taken: false }));
  const upH = (us?.level ?? 1) * FLOOR_H;
  const up = (q: { x: number; z: number }): Pt3 => ({ x: q.x, z: q.z, y: upH });
  /** 二楼补货区门口（后走廊）最近的行走网络节点 */
  const upDoorNode = (() => {
    if (!us) return -1;
    let best = -1;
    let bd = Infinity;
    model.nodes.forEach((n, i) => {
      if (n.floorId !== us.floorId) return;
      const d = Math.hypot(n.x - us.door.x, n.y - us.door.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  })();
  /** 一楼收货区 → 货梯 → 二楼货梯门口（含乘货梯） */
  const liftUp = (from: { x: number; z: number }): Pt3[] => (us ? dedupe([...flat([from, { x: us.liftDoor.x, z: from.z }, us.liftDoor, us.lift]), up(us.lift), up(us.liftDoor)]) : []);
  const liftDown = (to: { x: number; z: number }): Pt3[] => (us ? dedupe([up(us.liftDoor), up(us.lift), ...flat([us.lift, us.liftDoor, { x: us.liftDoor.x, z: to.z }, to])]) : []);

  const sim = new Simulation(Math.min(recvShift[0], ...trucks.map((tr) => tr.arrive)));
  const docked: Array<{ truck: Truck; remaining: number; inFlight: number }> = [];
  const waitingPutaway: PalletRecord[] = [];
  /** 等着送上二楼的托盘 */
  const waitingLift: PalletRecord[] = [];
  const letdownQueue: PalletRecord[] = [];
  /** 已排队或叉车正在去取的高层托盘（避免重复取下） */
  const letdownPending = new Set<string>();
  /** 正在从这个托盘装车的人数 */
  const loading = new Map<string, number>();
  const progress: Array<[number, number]> = [];
  let stocked = 0;

  // 补货任务：按通道权重分配需补箱数，每车约 40 箱
  interface RestockTask {
    runId: string;
    cases: number;
    node: number;
  }
  const restock: RestockTask[] = [];
  runs.forEach((r, i) => {
    let cases = Math.round((p.totalCases * (weights[i] as number)) / wsum);
    const locs = model.locationsByRun.get(r.id) ?? [];
    const loads = Math.max(1, Math.ceil(cases / p.casesPerLoad));
    for (let k = 0; cases > 0; k++) {
      const n = Math.min(p.casesPerLoad, cases);
      cases -= n;
      const loc = locs[Math.min(locs.length - 1, Math.floor(((k + 0.5) / loads) * locs.length))];
      restock.push({ runId: r.id, cases: n, node: loc?.nodeId ?? model.backroomNode });
    }
  });
  const totalCases = restock.reduce((n, t) => n + t.cases, 0);
  // 夜间半挂车的配货：托盘数按各通道需补箱数的比例分配（最大余数法），每托箱数 = 该通道需补箱数 ÷ 托盘数
  const demandByRun = new Map<string, number>();
  for (const t of restock) demandByRun.set(t.runId, (demandByRun.get(t.runId) ?? 0) + t.cases);
  const shares = [...demandByRun.entries()].map(([runId, c]) => ({ runId, c, exact: (c / Math.max(1, totalCases)) * p.dcPallets }));
  const counts = new Map(shares.map((x) => [x.runId, Math.floor(x.exact)]));
  let left = p.dcPallets - [...counts.values()].reduce((a, c) => a + c, 0);
  for (const x of [...shares].sort((a, c) => c.exact - Math.floor(c.exact) - (a.exact - Math.floor(a.exact)) || a.runId.localeCompare(c.runId))) {
    if (left <= 0) break;
    counts.set(x.runId, (counts.get(x.runId) ?? 0) + 1);
    left--;
  }
  const nightMix: string[] = [];
  const nightCases = new Map<string, number>();
  for (const [runId, n] of counts) {
    for (let k = 0; k < n; k++) nightMix.push(runId);
    if (n > 0) nightCases.set(runId, Math.min(120, Math.max(20, Math.ceil((demandByRun.get(runId) ?? 0) / n))));
  }
  rng.shuffle(nightMix);
  // 每个通道的货源：先用当晚到的直送托盘，再用二楼补货区、溢流位上的托盘（决策记录 0019），最后用货架上的库存
  const sourceFor = (runId: string, t: number): PalletRecord | undefined => {
    const direct = pallets.find((q) => q.runId === runId && q.direct && q.receivedAt !== undefined && q.receivedAt <= t && q.emptiedAt === undefined && q.cases > 0 && q.receivedAt >= p.close - 3600);
    if (direct) return direct;
    // 收货区地面上等着上架的托盘：夜里直接拉去补货（腾出地面，后仓放满时卸货不会卡住）
    const floor = waitingPutaway.find((q) => q.runId === runId && q.receivedAt !== undefined && q.receivedAt <= t && q.cases > 0 && t >= p.close - 3600);
    if (floor) return floor;
    const staged = pallets.find((q) => q.runId === runId && q.emptiedAt === undefined && q.cases > 0 && ((q.upAt !== undefined && q.upAt <= t) || (q.overflowAt !== undefined && q.overflowAt <= t)));
    if (staged) return staged;
    return pallets.find((q) => q.runId === runId && q.location !== undefined && q.emptiedAt === undefined && q.cases > 0 && (locById.get(q.location)?.level === 0 || q.letdownAt !== undefined));
  };
  /**
   * 补货员取货、上架、回来的路线：后仓货架或收货区地面上的托盘走后仓出口进店；
   * 二楼补货区的托盘乘货梯上去、从二楼的后走廊进卖场；溢流位的托盘经连通通道过去、从暂存区进店。
   */
  const restockRoute = (src: PalletRecord, task: { node: number }, from: Pt3): { toPallet: Pt3[]; at: Pt3; toStore: Pt3[]; inStore: Pt3[]; back: Pt3[] } => {
    const nodes = (a: number, c: number) => {
      const ids = model.path(a, c);
      return (ids.length ? ids : [c]).map(node);
    };
    if (src.upSpot && us && upDoorNode >= 0) {
      const at = up(src.upSpot);
      const inStore = nodes(upDoorNode, task.node);
      return {
        toPallet: [...flat(backroomRoute(b, from, us.liftDoor)), ...liftUp(us.liftDoor).slice(1), up({ x: at.x, z: us.liftDoor.z }), at],
        at,
        toStore: [at, up(us.door), node(upDoorNode)],
        inStore,
        back: [...[...inStore].reverse(), up(us.door), up({ x: us.liftDoor.x, z: us.door.z }), ...liftDown(us.liftDoor), ...flat(backroomRoute(b, us.liftDoor, home)).slice(1)],
      };
    }
    if (src.overflowSpot && passage) {
      const at: Pt3 = { x: src.overflowSpot.x + 0.9, z: src.overflowSpot.z, y: 0 };
      const inStore = nodes(model.stagingNode, task.node);
      return {
        toPallet: [...flat(backroomRoute(b, from, { x: pcx, z: b.receiving.z0 + 0.6 })), ...viaPassage({ x: pcx, z: b.receiving.z0 + 0.6 }, at).slice(1)],
        at,
        toStore: [at, { x: at.x, z: stagingAt.z + 1.5, y: 0 }, stagingAt],
        inStore,
        back: [...[...inStore].reverse(), stagingAt, ...viaPassage({ x: pcx, z: stagingAt.z + 1.5 }, { x: pcx, z: b.receiving.z0 + 0.6 }).reverse(), ...flat(backroomRoute(b, { x: pcx, z: b.receiving.z0 + 0.6 }, home)).slice(1)],
      };
    }
    const loc = src.location ? locById.get(src.location) : undefined;
    // 站在托盘前：货架底层托盘在通道边取，取下的高层托盘在地面上（再往外一点）
    const a2: { x: number; z: number } = loc ? floorSpotFor(loc, src.letdownAt !== undefined ? 2.9 : 1.4) : { x: (src.spot ?? home).x, z: (src.spot ?? home).z - 1 };
    const inStore = nodes(model.backroomNode, task.node);
    return {
      toPallet: flat(backroomRoute(b, from, a2, loc ? aisleFor(loc) : undefined)),
      at: { x: a2.x, z: a2.z, y: 0 },
      toStore: flat(backroomRoute(b, a2, b.entry)),
      inStore,
      back: [...[...inStore].reverse(), ...flat(backroomRoute(b, b.entry, home))],
    };
  };
  const needsLetdown = (runId: string): PalletRecord | undefined =>
    pallets.find((q) => q.runId === runId && q.location !== undefined && q.emptiedAt === undefined && q.cases > 0 && q.letdownAt === undefined && (locById.get(q.location)?.level ?? 0) > 0);

  const seg = (list: PolySegment[], s: PolySegment) => {
    if (s.t1 > s.t0) list.push(s);
  };
  const onShift = (w: WorkerTrace, t: number) => w.shifts.some(([a, c]) => t >= a && t < c);

  /** 取一台空闲设备：按种类优先级，同种里离作业人员最近的；分工不对口的设备算远 25 米（对口的忙时才轮到它） */
  const takeEquip = (kinds: Array<'forklift' | 'jack'>, near: Pt3, want: 'unload' | 'rack') => {
    for (const k of kinds) {
      let best: EquipmentTrace | undefined;
      let bd = Infinity;
      for (const e of equipment) {
        if (e.kind !== k || !eqFree.get(e.id)) continue;
        const q = pos.get(e.id) ?? near;
        const r = roleOf(e);
        const d = Math.hypot(q.x - near.x, q.z - near.z) + (r !== 'any' && r !== want ? 25 : 0);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      if (best) return best;
    }
    return undefined;
  };
  /** 按给定的起始时刻记一段行驶（人和设备各一份），返回结束时刻 */
  const driveAt = (t0: number, w: WorkerTrace, e: EquipmentTrace | undefined, pts: Pt3[], activity: string, carry?: string, speed = SPEED, reverseLegs = 0): number => {
    const t1 = t0 + len3(pts) / speed;
    seg(w.segments, { t0, t1, pts, activity, carry });
    if (e) seg(e.segments, reverseLegs ? { t0, t1, pts, activity, carry, reverseLegs } : { t0, t1, pts, activity, carry });
    return t1;
  };
  /** 在一点停一段（等通道、举升） */
  const holdAt = (t0: number, t1: number, w: WorkerTrace, e: EquipmentTrace | undefined, at: Pt3, activity: string, carry?: string, lift?: PolySegment['lift']) => {
    const sgm: PolySegment = lift ? { t0, t1, pts: [at], activity, carry, lift } : { t0, t1, pts: [at], activity, carry };
    seg(w.segments, sgm);
    if (e) seg(e.segments, sgm);
  };
  /** 货架通道的出入口（主通道上） */
  const mouthOf = (ai: number): Pt3 => ({ x: b.mainAisleX, z: b.aisles[ai] ?? b.zone.z0, y: 0 });
  /** 路线在通道口分成两段：开到通道口、从通道口进通道（已经停在通道口时第一段为空，先看通道空不空再进） */
  const splitAtMouth = (route: Pt3[], mouth: Pt3): [Pt3[], Pt3[]] => {
    const k = route.findIndex((q) => Math.abs(q.x - mouth.x) < 0.01 && Math.abs(q.z - mouth.z) < 0.01);
    if (k < 0) return [route, []];
    return [k > 0 ? route.slice(0, k + 1) : [], route.slice(k)];
  };

  function drive(w: WorkerTrace, e: EquipmentTrace | undefined, pts: Pt3[], activity: string, carry?: string, speed = SPEED, reverseLegs = 0): number {
    const t0 = sim.now;
    const dur = len3(pts) / speed;
    seg(w.segments, { t0, t1: t0 + dur, pts, activity, carry });
    if (e) seg(e.segments, reverseLegs ? { t0, t1: t0 + dur, pts, activity, carry, reverseLegs } : { t0, t1: t0 + dur, pts, activity, carry });
    const last = pts[pts.length - 1] as Pt3;
    pos.set(w.id, { ...last });
    if (e) pos.set(e.id, { ...last });
    return dur;
  }

  function next(w: WorkerTrace): void {
    const t = sim.now;
    if (!onShift(w, t)) {
      const nextOn = w.shifts.find(([a]) => a > t)?.[0];
      if (nextOn !== undefined) sim.at(nextOn, () => next(w));
      return;
    }
    const shiftEnd = w.shifts.find(([a, c]) => t >= a && t < c)?.[1] ?? t;
    const here = pos.get(w.id) ?? home;
    /** 走到设备旁（离得远时），返回走完的时刻 */
    const walkTo = (e: EquipmentTrace): number => {
      const ePos = pos.get(e.id) ?? here;
      return Math.hypot(here.x - ePos.x, here.z - ePos.z) > 0.5 ? driveAt(t, w, undefined, [here, ePos], e.kind === 'forklift' ? '去取叉车' : '去取搬运车', undefined, 1.2) : t;
    };
    const take = (e: EquipmentTrace) => {
      eqFree.set(e.id, false);
      lastOp.set(e.id, w.id);
    };
    // 1. 卸货：找一辆还有货、车厢里没有别的设备的车
    const dockTask = docked.find((d) => d.remaining > 0 && !doorLock.has(d.truck.door));
    const small = (k: Truck['kind']) => k === 'BOX' || k === 'VAN';
    const eqUnload = dockTask ? takeEquip(small(dockTask.truck.kind) ? ['jack', 'forklift'] : ['forklift', 'jack'], here, 'unload') : undefined;
    if (dockTask && eqUnload) {
      const spot = spots.find((s) => !s.taken);
      if (spot) {
        const tr = dockTask.truck;
        dockTask.remaining--;
        dockTask.inFlight++;
        spot.taken = true;
        take(eqUnload);
        doorLock.set(tr.door, eqUnload.id);
        const door = b.docks[tr.door] ?? b.docks[0] ?? { x: b.receiving.x1, z: b.receiving.z1 };
        const ePos = pos.get(eqUnload.id) ?? here;
        const isFork = eqUnload.kind === 'forklift';
        // 夜间配送中心的半挂车按各通道的补货需要配货（配送中心按门店销售补货）；百货半挂车只装百货；
        // 供应商直送是食品杂货（不进百货通道）；其他车按销售比例随机
        const dc = (tr.source ?? 'DC') === 'DC' && tr.kind === 'SEMI' && !tr.vendor;
        const runId = tr.source === 'DC_GM' ? pickGmRun() : dc ? (nightMix.shift() ?? pickRun()) : tr.vendor && gmRuns.length < runs.length ? pickFoodRun() : pickRun();
        const direct = small(tr.kind) || tr.vendor ? true : rng.chance(p.directShare);
        const pr = newPallet(runId, dc ? (nightCases.get(runId) ?? 45) : rng.int(30, 60), direct, tr.id);
        // 走到设备旁 → 开到卸货门 → 进车厢叉起托盘 → 叉着托盘先倒出车厢（车头仍朝车厢）→ 开回收货区放下 → 扫码
        const t1 = walkTo(eqUnload);
        const t2 = driveAt(t1, w, eqUnload, flat([ePos, { x: door.x, z: door.z - 2 }, { x: door.x, z: door.z + 4 }]), isFork ? '叉车进车厢' : '搬运车进车厢');
        const t3 = t2 + LIFT_SEC;
        const t4 = driveAt(t3, w, eqUnload, flat([{ x: door.x, z: door.z + 4 }, { x: door.x, z: door.z - 2 }, { x: spot.x, z: spot.z }]), isFork ? '叉车卸货' : '搬运车卸货', pr.id, isFork ? SPEED : 1.1, 1);
        const t5 = t4 + LIFT_SEC;
        const t6 = t5 + SCAN_SEC;
        seg(w.segments, { t0: t5, t1: t6, pts: [{ x: spot.x + 0.8, z: spot.z, y: 0 }], activity: '点数贴标' });
        seg(eqUnload.segments, { t0: t5, t1: t6, pts: [{ x: spot.x, z: spot.z - 1.2, y: 0 }], activity: '停放' });
        pos.set(eqUnload.id, { x: spot.x, z: spot.z - 1.2, y: 0 });
        pos.set(w.id, { x: spot.x + 0.8, z: spot.z, y: 0 });
        // 设备退出车厢、开到收货区后，下一台设备才能进这个车厢
        sim.at(t4, () => {
          if (doorLock.get(tr.door) === eqUnload.id) doorLock.delete(tr.door);
        });
        sim.at(t5, () => {
          pr.receivedAt = sim.now;
          pr.spot = { x: spot.x, z: spot.z };
        });
        sim.at(t6, () => {
          eqFree.set(eqUnload.id, true);
          dockTask.inFlight--;
          if (pr.direct && sim.now < p.close - 3600) {
            // 白天到的直送货：由白班理货员或供应商人员送上货架（不计入夜班补货）
            pr.emptiedAt = sim.now + rng.uniform(small(tr.kind) ? 15 : 30, small(tr.kind) ? 40 : 120) * 60;
            sim.at(pr.emptiedAt, () => {
              spot.taken = false;
            });
          } else if (!pr.direct) (us && upRuns.has(pr.runId) && upSpots.length ? waitingLift : waitingPutaway).push(pr);
          // 这辆车最后一托卸完：交接 8 分钟后申请驶离（场地空出来时拉出卸货门）
          if (dockTask.remaining === 0 && dockTask.inFlight === 0 && !exitAsked.has(tr.id)) {
            exitAsked.add(tr.id);
            sim.at(sim.now + 8 * 60, () => {
              exits.push(tr);
              yardNext();
            });
          }
          next(w);
        });
        return;
      }
    }
    // 1b. 二楼货架的托盘（决策记录 0019）：搬运车叉起 → 推到货梯 → 等门、上楼 → 推到二楼卸货区的托盘位放下 → 空车乘货梯下来
    // 先到先送；按紧缺程度送时（决策记录 0020）先送二楼走得快的货架的托盘
    const upIdx = p.liftOrder === 'urgency' ? waitingLift.reduce((m, q, i) => ((weightOf.get(q.runId) ?? 0) > (weightOf.get((waitingLift[m] as PalletRecord).runId) ?? 0) ? i : m), 0) : 0;
    const upPr = waitingLift[upIdx];
    const upEq = us && upPr ? takeEquip(['jack', 'forklift'], here, 'rack') : undefined;
    const upSpot = upEq ? upSpots.find((q) => !q.taken) : undefined;
    if (us && upPr && upEq && upSpot) {
      waitingLift.splice(upIdx, 1);
      upSpot.taken = true;
      take(upEq);
      const ePos = pos.get(upEq.id) ?? here;
      const from = upPr.spot ?? { x: ePos.x, z: ePos.z };
      const fk = upEq.kind === 'forklift';
      const t1 = walkTo(upEq);
      const t2 = driveAt(t1, w, upEq, flat([ePos, from]), fk ? '叉车去叉托盘' : '搬运车去取托盘');
      const t3 = t2 + LIFT_SEC;
      const ride = liftUp(from);
      const ground = ride.findIndex((q) => q.y > 0) - 1;
      // 叉车代替搬运车时作业名带「叉车」（画面上司机坐在叉车上）
      const FORK: Record<string, string> = { 送上二楼: '叉车送上二楼', 等货梯: '叉车等货梯', 回货梯: '叉车回货梯' };
      const nm = (a: string) => (fk ? (FORK[a] ?? a) : a);
      const t4 = driveAt(t3, w, upEq, ride.slice(0, ground + 1), nm('送上二楼'), upPr.id, 1.1);
      holdAt(t4, t4 + LIFT_WAIT, w, upEq, ride[ground] as Pt3, nm('等货梯'), upPr.id);
      const t5 = driveAt(t4 + LIFT_WAIT, w, upEq, [...ride.slice(ground), up({ x: upSpot.x, z: (us.liftDoor as { z: number }).z }), up(upSpot)], nm('送上二楼'), upPr.id, 1.1);
      const t6 = t5 + LIFT_SEC;
      const down = liftDown(us.liftDoor);
      const t7 = driveAt(t6, w, upEq, [up(upSpot), up({ x: upSpot.x, z: us.liftDoor.z }), ...down.slice(0, 2)], nm('回货梯'), undefined, 1.3);
      holdAt(t7, t7 + LIFT_WAIT, w, upEq, down[1] as Pt3, nm('等货梯'));
      const t8 = driveAt(t7 + LIFT_WAIT, w, upEq, down.slice(1, 4), nm('回货梯'), undefined, 1.3);
      const end = down[3] as Pt3;
      pos.set(upEq.id, { ...end });
      pos.set(w.id, { ...end });
      sim.at(t3, () => {
        const q = spots.find((s) => Math.abs(s.x - from.x) < 0.01 && Math.abs(s.z - from.z) < 0.01);
        if (q) q.taken = false;
      });
      sim.at(t6, () => {
        upPr.upAt = sim.now;
        upPr.upSpot = { x: upSpot.x, z: upSpot.z, y: upH };
      });
      sim.at(t8, () => {
        eqFree.set(upEq.id, true);
        next(w);
      });
      return;
    }
    // 2. 放进货架（只有叉车能放高层）：优先此刻没有别的叉车在里面的通道，其次低层、靠主通道
    const pr = waitingPutaway[0];
    const fork = pr ? takeEquip(['forklift'], here, 'rack') : undefined;
    if (pr && fork) {
      const busy = (l: (typeof b.locations)[number]) => Number(aisleFreeAt(aisleFor(l), t, fork.id) > t);
      // 按走得快慢分货位（决策记录 0020）：快的放低层、靠主通道；慢的放高层、里面，把好位置留给快的
      const fast = p.slotting === 'velocity' && (weightOf.get(pr.runId) ?? 0) >= medianWeight;
      const near = (l: (typeof b.locations)[number]) => Math.abs(l.x - b.mainAisleX);
      const loc = b.locations
        .filter((l) => locFree.get(l.id))
        .sort((a, c) => busy(a) - busy(c) || (p.slotting === 'velocity' && !fast ? c.level - a.level || near(c) - near(a) : a.level - c.level || near(a) - near(c)))[0];
      if (loc) {
        waitingPutaway.shift();
        locFree.set(loc.id, false);
        take(fork);
        const ePos = pos.get(fork.id) ?? here;
        const spot = pr.spot ?? { x: ePos.x, z: ePos.z };
        const ai = aisleFor(loc);
        const mouth = mouthOf(ai);
        // 走到叉车旁 → 开到托盘前叉起 → 开到通道口（有别的叉车在里面就等）→ 进通道举升放货 → 倒出货位、驶出通道
        const t1 = walkTo(fork);
        const t2 = driveAt(t1, w, fork, flat([ePos, spot]), '叉车去叉托盘');
        const t3 = t2 + LIFT_SEC;
        const [toMouth, inAisle] = splitAtMouth(flat(backroomRoute(b, spot, loc, ai)), mouth);
        const t4 = toMouth.length > 1 ? driveAt(t3, w, fork, toMouth, '叉车放进货架', pr.id) : t3;
        const t5 = aisleFreeAt(ai, t4, fork.id);
        if (t5 > t4) holdAt(t4, t5, w, fork, mouth, '等待通道空出', pr.id);
        const t6 = driveAt(t5, w, fork, inAisle, '叉车放进货架', pr.id);
        const lift = LIFT_SEC + loc.level * 8;
        const at: Pt3 = { x: loc.x, z: loc.z, y: 0 };
        holdAt(t6, t6 + lift, w, fork, at, '叉车举升放货', pr.id, { y: loc.y, pallet: pr.id, mode: 'up' });
        const t7 = t6 + lift;
        const t8 = driveAt(t7, w, fork, [at, { x: loc.x, z: mouth.z, y: 0 }, mouth], '叉车驶出通道', undefined, SPEED, 1);
        aisleRes.set(ai, { eq: fork.id, until: t8 });
        pos.set(fork.id, { ...mouth });
        pos.set(w.id, { ...mouth });
        sim.at(t3, () => {
          const sp = spots.find((s) => Math.abs(s.x - spot.x) < 0.01 && Math.abs(s.z - spot.z) < 0.01);
          if (sp) sp.taken = false;
        });
        sim.at(t7, () => {
          pr.storedAt = sim.now;
          pr.location = loc.id;
        });
        sim.at(t8, () => {
          eqFree.set(fork.id, true);
          next(w);
        });
        return;
      }
    }
    // 2b. 溢流（决策记录 0019）：后仓货架放满了、或者收货区地面快堆满（空位不到 3 个）而叉车都忙时，
    //     搬运车把等着上架的托盘经连通通道送到暂存区的溢流位（夜班也从那里取货）
    const ovPr = waitingPutaway[0];
    if (ovPr && passage && ovSpots.length) {
      const freeRecv = spots.reduce((n, q) => n + (q.taken ? 0 : 1), 0);
      const racksFull = !b.locations.some((l) => locFree.get(l.id));
      const ovEq = racksFull || (freeRecv <= 3 && !fork) ? takeEquip(['jack', 'forklift'], here, 'rack') : undefined;
      const os = ovEq ? ovSpots.find((q) => !q.taken) : undefined;
      if (ovEq && os) {
        waitingPutaway.shift();
        os.taken = true;
        take(ovEq);
        const ePos = pos.get(ovEq.id) ?? here;
        const from = ovPr.spot ?? { x: ePos.x, z: ePos.z };
        const fk = ovEq.kind === 'forklift';
        const t1 = walkTo(ovEq);
        const t2 = driveAt(t1, w, ovEq, flat([ePos, from]), fk ? '叉车去叉托盘' : '搬运车去取托盘');
        const t3 = t2 + LIFT_SEC;
        const route = viaPassage(from, os);
        const t4 = driveAt(t3, w, ovEq, route, fk ? '叉车经连通通道送往溢流位' : '经连通通道送往溢流位', ovPr.id, 1.1);
        const t5 = t4 + LIFT_SEC;
        // 空车经通道回到收货区前沿
        const backPts = dedupe(flat([os, { x: pcx, z: os.z }, { x: pcx, z: passage.z0 + 0.6 }, { x: pcx, z: b.receiving.z0 + 0.6 }]));
        const t6 = driveAt(t5, w, ovEq, backPts, fk ? '叉车经连通通道返回' : '经连通通道返回', undefined, 1.3);
        const end = backPts[backPts.length - 1] as Pt3;
        pos.set(ovEq.id, { ...end });
        pos.set(w.id, { ...end });
        sim.at(t3, () => {
          const q = spots.find((s) => Math.abs(s.x - from.x) < 0.01 && Math.abs(s.z - from.z) < 0.01);
          if (q) q.taken = false;
        });
        sim.at(t5, () => {
          ovPr.overflowAt = sim.now;
          ovPr.overflowSpot = { x: os.x, z: os.z };
        });
        sim.at(t6, () => {
          eqFree.set(ovEq.id, true);
          next(w);
        });
        return;
      }
      if (ovEq) eqFree.set(ovEq.id, true);
    }
    // 3. 高层放到地面：开到通道口（有别的叉车在里面就等）→ 进通道取下托盘放在货位前的地面 → 驶出通道
    const ld = letdownQueue[0];
    const fork2 = ld ? takeEquip(['forklift'], here, 'rack') : undefined;
    if (ld && fork2 && ld.location) {
      letdownQueue.shift();
      const loc = locById.get(ld.location);
      if (loc) {
        take(fork2);
        const ePos = pos.get(fork2.id) ?? here;
        const ai = aisleFor(loc);
        const mouth = mouthOf(ai);
        const t1 = walkTo(fork2);
        const [toMouth, inAisle] = splitAtMouth(flat(backroomRoute(b, ePos, loc, ai)), mouth);
        const t2 = toMouth.length > 1 ? driveAt(t1, w, fork2, toMouth, '叉车去高层货位') : t1;
        const t3 = aisleFreeAt(ai, t2, fork2.id);
        if (t3 > t2) holdAt(t2, t3, w, fork2, mouth, '等待通道空出');
        const t4 = driveAt(t3, w, fork2, inAisle, '叉车去高层货位');
        const lift = LIFT_SEC + loc.level * 8;
        holdAt(t4, t4 + lift, w, fork2, { x: loc.x, z: loc.z, y: 0 }, '叉车把高层托盘放到地面', undefined, { y: loc.y, pallet: ld.id, mode: 'down' });
        const t5 = t4 + lift;
        const t6 = driveAt(t5, w, fork2, [{ x: loc.x, z: loc.z, y: 0 }, { x: loc.x, z: mouth.z, y: 0 }, mouth], '叉车驶出通道', undefined, SPEED, 1);
        aisleRes.set(ai, { eq: fork2.id, until: t6 });
        pos.set(fork2.id, { ...mouth });
        pos.set(w.id, { ...mouth });
        sim.at(t5, () => {
          ld.letdownAt = sim.now;
        });
        sim.at(t6, () => {
          eqFree.set(fork2.id, true);
          next(w);
        });
        return;
      }
    }
    // 去做别的事（补货、待命）之前，把自己最后用过的设备停回充电位
    const parkE = equipment.find((e) => {
      const q = pos.get(e.id);
      const dest = parkAt.get(e.id);
      return eqFree.get(e.id) && lastOp.get(e.id) === w.id && !!q && !!dest && Math.hypot(q.x - dest.x, q.z - dest.z) > 1.5;
    });
    if (parkE) {
      take(parkE);
      lastOp.delete(parkE.id);
      const ePos = pos.get(parkE.id) as Pt3;
      const dest = parkAt.get(parkE.id) as Pt3;
      const t1 = walkTo(parkE);
      const t2 = driveAt(t1, w, parkE, flat(backroomRoute(b, ePos, dest)), parkE.kind === 'forklift' ? '叉车停回充电位' : '搬运车停回原位');
      pos.set(parkE.id, { ...dest });
      pos.set(w.id, { ...dest });
      sim.at(t2, () => {
        eqFree.set(parkE.id, true);
        next(w);
      });
      return;
    }
    // 4. 补货（夜班）
    if (w.role === 'night' && restock.length) {
      for (let k = 0; k < restock.length; k++) {
        const task = restock[k] as RestockTask;
        const src = sourceFor(task.runId, t);
        if (!src) {
          const up = needsLetdown(task.runId);
          if (up && !letdownPending.has(up.id)) {
            letdownPending.add(up.id);
            letdownQueue.push(up);
          }
          continue;
        }
        restock.splice(k, 1);
        const take = Math.min(task.cases, src.cases);
        src.cases -= take;
        loading.set(src.id, (loading.get(src.id) ?? 0) + 1);
        // 从等着上架的托盘里取货：取完前不再上架（取剩的再排回去）
        const wi = waitingPutaway.indexOf(src);
        if (wi >= 0) waitingPutaway.splice(wi, 1);
        if (task.cases > take) restock.push({ ...task, cases: task.cases - take });
        // 走到托盘 → 装车 → 走到出口（后仓出口、二楼后走廊或暂存区）→ 沿店内网络到货架 → 逐箱上架 → 推空车回来
        const rt = restockRoute(src, task, here);
        const { toPallet, at, inStore } = rt;
        const toEntry = rt.toStore;
        const work = take * rng.uniform(p.secPerCase[0], p.secPerCase[1]);
        const t1 = drive(w, undefined, toPallet, '去托盘取货', undefined, 1.2);
        const load = take * 4;
        if (sim.now + t1 + load + (len3(toEntry) + len3(inStore)) / 0.8 + work > shiftEnd) {
          // 收工前做不完：放回去
          src.cases += take;
          restock.unshift(task);
          w.segments.pop();
          pos.set(w.id, { ...here });
          break;
        }
        seg(w.segments, { t0: sim.now + t1, t1: sim.now + t1 + load, pts: [at], activity: `装车 ${take} 箱` });
        sim.after(t1 + load, () => {
          src.draws.push([sim.now, take]);
          // 几个人同时从一个托盘取货时，最后一个装完车才算取空（腾出货位）
          const still = (loading.get(src.id) ?? 1) - 1;
          loading.set(src.id, still);
          if (wi >= 0 && src.cases > 0 && still === 0 && !waitingPutaway.includes(src)) waitingPutaway.push(src);
          if (src.cases <= 0 && still === 0) {
            src.emptiedAt = sim.now;
            if (src.location) locFree.set(src.location, true);
            const freeSpot = (list: Array<{ x: number; z: number; taken: boolean }>, q?: { x: number; z: number }) => {
              const hit = q ? list.find((s) => Math.abs(s.x - q.x) < 0.01 && Math.abs(s.z - q.z) < 0.01) : undefined;
              if (hit) hit.taken = false;
            };
            if (src.upSpot) freeSpot(upSpots, src.upSpot);
            else if (src.overflowSpot) freeSpot(ovSpots, src.overflowSpot);
            else freeSpot(spots, src.spot);
          }
          const go = [...toEntry, ...inStore];
          const u = drive(w, undefined, go, '推货去货架', 'cases', 0.8);
          const end = inStore[inStore.length - 1] as Pt3;
          sim.after(u, () => {
            seg(w.segments, { t0: sim.now, t1: sim.now + work, pts: [end], activity: `上架 ${take} 箱`, carry: 'cases' });
            sim.after(work, () => {
              stocked += take;
              progress.push([sim.now, take]);
              const v = drive(w, undefined, rt.back, '推空车回后仓', undefined, 0.9);
              sim.after(v, () => next(w));
            });
          });
        });
        return;
      }
    }
    // 没事做：稍后再看（等车厢里的设备出来时很快再看一次）
    const doorWait = docked.some((d) => d.remaining > 0);
    const idleUntil = Math.min(shiftEnd, t + (doorWait ? 30 : 120));
    if (idleUntil > t) {
      seg(w.segments, { t0: t, t1: idleUntil, pts: [here], activity: '待命' });
      sim.at(idleUntil, () => next(w));
    }
  }

  // 卸货场调度（决策记录 0018）：车到了先在场内排队（先到先进）；场地同一时间只让一辆车行驶，
  // 驶离优先（让出卸货门）；有空门、场地空着时，排在最前的车进场（冷藏车优先用冷藏门，其他车优先用普通门）
  const doorBusy: Array<Truck | undefined> = b.docks.map(() => undefined);
  const yard: Truck[] = [];
  const exits: Truck[] = [];
  const exitAsked = new Set<string>();
  let yardFree = true;
  const pickDoor = (tr: Truck): number => {
    const order = b.docks
      .map((d, i) => ({ i, reefer: !!d.reefer }))
      .sort((a, c) => (tr.kind === 'REEFER' ? Number(c.reefer) - Number(a.reefer) : Number(a.reefer) - Number(c.reefer)) || a.i - c.i);
    return order.find((d) => !doorBusy[d.i])?.i ?? -1;
  };
  function yardNext(): void {
    if (!yardFree) return;
    const out = exits.shift();
    if (out) {
      // 从卸货门拉出、驶出卸货场；门在拉出后就空了，但下一辆车要等场地空出来
      yardFree = false;
      out.leave = sim.now;
      out.goneAt = sim.now + YARD_TIMING[out.kind].exit;
      const i = doorBusy.indexOf(out);
      if (i >= 0) doorBusy[i] = undefined;
      sim.at(out.goneAt, () => {
        yardFree = true;
        yardNext();
      });
      return;
    }
    const head = yard[0];
    if (!head) return;
    const door = pickDoor(head);
    if (door < 0) return;
    yard.shift();
    yardFree = false;
    const tm = YARD_TIMING[head.kind];
    doorBusy[door] = head;
    head.door = door;
    head.dockAt = sim.now;
    head.dockedAt = sim.now + tm.dock;
    head.unloadStart = head.dockedAt + tm.setup;
    sim.at(head.dockedAt, () => {
      yardFree = true;
      yardNext();
    });
    sim.at(head.unloadStart, () => {
      docked.push({ truck: head, remaining: head.pallets, inFlight: 0 });
    });
  }
  for (const tr of trucks) {
    sim.at(tr.arrive, () => {
      yard.push(tr);
      yardNext();
    });
  }
  for (const w of workers) sim.at(w.shifts[0]?.[0] ?? sim.now, () => next(w));
  sim.run(p.nextOpen);
  for (const tr of trucks) {
    if (yard.includes(tr)) {
      // 一直没轮到进场（夜里没人卸货、卸货门都占着）：在待命车道上等到第二天开门
      tr.dockAt = tr.dockedAt = tr.unloadStart = p.nextOpen;
      tr.leave = tr.goneAt = p.nextOpen;
      continue;
    }
    if (!tr.leave) tr.leave = Math.min(p.nextOpen, Math.max(tr.unloadStart, tr.unloadStart + tr.pallets * 4 * 60 + 10 * 60));
    if (!tr.goneAt) tr.goneAt = tr.leave + YARD_TIMING[tr.kind].exit;
  }

  progress.sort((a, c) => a[0] - c[0]);
  const received = pallets.filter((q) => q.receivedAt !== undefined);
  const dts = received.map((q) => (((q.storedAt ?? q.emptiedAt ?? q.receivedAt) as number) - (q.receivedAt as number)) / 60).filter((x) => x >= 0);
  const finishAt = restock.length === 0 && progress.length ? (progress[progress.length - 1] as [number, number])[0] : undefined;
  return {
    trucks,
    pallets,
    workers,
    equipment,
    progress,
    metrics: {
      trucks: trucks.length,
      palletsReceived: received.length,
      avgTurnaroundMin: trucks.reduce((n, tr) => n + (tr.leave - tr.arrive), 0) / Math.max(1, trucks.length) / 60,
      dockToStockMin: dts.length ? dts.reduce((a, c) => a + c, 0) / dts.length : 0,
      totalCases,
      stockedCases: stocked,
      backlogCases: totalCases - stocked,
      finishAt,
      readyAtOpen: totalCases > 0 ? stocked / totalCases : 1,
      rackCapacity: b.capacity,
      rackUsedStart,
      rackUsedEnd: [...locFree.values()].filter((f) => !f).length,
      receivingHours: (p.receivers * (recvShift[1] - recvShift[0])) / 3600,
      nightHours: (p.nightCrew * (p.nextOpen - p.close)) / 3600,
    },
  };
}

/** 托盘数的默认值：按门店规模（中型店夜间半挂车约 22 托、早上冷藏车约 8 托）；scale 决定供应商直送的频次（决策记录 0019） */
export function defaultInboundVolume(staffScale: number): { dcPallets: number; reeferPallets: number; scale: number } {
  const k = Math.max(0.3, staffScale);
  return { dcPallets: Math.max(6, Math.round(22 * k)), reeferPallets: Math.max(2, Math.round(8 * k)), scale: k };
}

/**
 * 按当天售出估算今晚需要补的箱数：线上订单件数 ÷ 线上占比 → 全店售出件数，
 * 每箱约 12 件，其中约 65% 需要当晚补上（其余货架上还有余量）。
 */
export function estimateRestockCases(onlineUnits: number, onlineShare = 0.15, unitsPerCase = 12, restockShare = 0.65): number {
  return Math.round((onlineUnits / Math.max(0.01, onlineShare) / unitsPerCase) * restockShare);
}

/** 夜班人数的默认值：中型店 6 人，按规模缩放 */
export function defaultNightCrew(staffScale: number): number {
  return Math.max(2, Math.round(6 * staffScale));
}
