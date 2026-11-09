import { FAMILIES, PALLETS_PER_FEU, type Family } from '../region/products';
import { buildGraph, shortestPath } from '../region/network';
import type { HubDay, HubFlow } from '../hub/types';
import type { BoardOp } from '../sim/board';
import type { OpStop, WVehicle } from '../sim/trace';

/**
 * 演示导览「一个集装箱从船到货架」的数据：从当天的仿真轨迹、调度台的作业、四处仓储中心的作业计划（HubDay）、
 * 港口三维计划里本店每个箱的记录、门店模型里员工的作业，串出一个本店的箱（或一托货）一路经过的每一段。
 *
 * 每一段如实标出数据从哪来：
 * - record：仿真 / 作业计划的记录（这一段在动画里看得到，时刻、门、车都是记录里的）；
 * - estimate：按规则推出来的（例如堆场停留按方案的平均天数、门店配哪一车按先进先出）；
 * - proxy：同一个环节、今天的另一件货（这个箱的这一段不在动画这一天，用今天同一环节的真实作业来演示）。
 * 跨天的段（堆场停留一两天）不假装：标出跨了几天、动画里跳过。纯函数、结果确定，不依赖 three.js。
 *
 * Data for the "one container, ship to shelf" tour. Each leg says where its data comes from:
 * record (simulation / plan record), estimate (derived by a rule), proxy (same step, another load today).
 */
export type TourSource = 'record' | 'estimate' | 'proxy';
export interface TourText {
  zh: string;
  en: string;
}
export type TourPreset = 'overview' | 'port' | 'airport' | 'dc' | 'flagship';
/** 镜头看哪里：预设、跟随一辆车、港口里的点（本店泊位、某个箱、闸口）、门店里的点（门店模型的坐标） */
export type TourWhere =
  | { kind: 'preset'; preset: TourPreset }
  | { kind: 'vehicle'; vehicle: number }
  | { kind: 'port-berth' }
  | { kind: 'port-box'; box: string }
  | { kind: 'port-gate' }
  | { kind: 'store-point'; x: number; y: number };
export type TourLegKey = 'ship' | 'discharge' | 'yard' | 'dwell' | 'dray' | 'dc' | 'dispatch' | 'store' | 'shelf' | 'train' | 'flight' | 'airtruck';
export interface TourLeg {
  key: TourLegKey;
  title: string;
  titleEn: string;
  /** 动画里看的时刻（当天 0 点起的秒，0–86340）：导览跳到这里 */
  at: number;
  /** 这一段实际发生的时段（可能不在当天：前一天卸船、跨天停留） */
  t0: number;
  t1: number;
  where: TourWhere;
  /** 选中（画整趟路线）、跟随的车（区域车辆层的下标） */
  vehicle?: number;
  facts: TourText[];
  source: TourSource;
  /** 说明（跨天、用今天的另一件货演示……） */
  note?: TourText;
  /** 跨了几天（动画里跳过） */
  skipDays?: number;
}
export interface Journey {
  /** 箱号（或作业编号、托盘批次） */
  box: string;
  mode: 'sea' | 'rail' | 'air';
  family?: { key: string; label: string; temp: string };
  legs: TourLeg[];
  /** 一句话的总结（导览开头、结尾显示） */
  summary: TourText;
}

/** 港口三维计划里的一个箱（web/src/three/ops/port.ts 的 PortBox，只取用到的字段） */
export interface PortBoxLike {
  id: string;
  store: boolean;
  stacked?: number;
  pickup?: number;
  dray?: number;
  slot?: { block: string; bay: number; row: number; tier: number };
  steps: { t: number; text: string }[];
}
/** 门店模型（第二部分 StoreX）的一个员工 / 机器人的轨迹 */
export interface StoreAgentLike {
  kind: string;
  label: string;
  segs: { t0: number; t1: number; pts: number[]; act?: string }[];
}
export interface TourInput {
  /** 当天仿真里的车（trace.vehicles，不含装饰用的背景车也可以） */
  vehicles: readonly WVehicle[];
  /** 调度台的作业（带月台门、在门上的时段） */
  ops: readonly BoardOp[];
  hubs?: readonly HubDay[];
  portBoxes?: readonly PortBoxLike[];
  storeAgents?: readonly StoreAgentLike[];
  /** 方案的平均堆场停留（天） */
  dwellDays?: number;
  /** 配送中心越库 */
  crossDock?: boolean;
  /** 到店的平均剩余保质期（%） */
  freshRemainPct?: number;
  /** 港口到物流园的路（不给就按当前区域的路网算） */
  portToDc?: { km: number; hours: number };
  storeKey: string;
}

const DAY = 86340;
const DAWN = 6 * 3600;
const clampDay = (t: number) => Math.max(0, Math.min(DAY, t));
const pad = (n: number) => String(n).padStart(2, '0');
function hm(t: number): string {
  const m = Math.round(t / 60);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
}
const dayOf = (t: number) => Math.floor(Math.round(t / 60) / 1440);
const whenZh = (t: number) => `${dayOf(t) < 0 ? '前一天 ' : dayOf(t) > 0 ? '次日 ' : ''}${hm(t)}`;
const whenEn = (t: number) => `${hm(t)}${dayOf(t) < 0 ? ' the day before' : dayOf(t) > 0 ? ' the next day' : ''}`;
const mins = (s: number) => Math.max(1, Math.round(s / 60));
const T = (zh: string, en: string): TourText => ({ zh, en });

const famByLabel = (label: string): Family | undefined => {
  const tail = label.split(' · ')[1]?.trim();
  return tail ? FAMILIES.find((f) => f.label === tail) : undefined;
};
const famText = (f: Family | undefined): TourText => (f ? T(f.label, FAMILY_EN[f.key] ?? f.key) : T('本店的货', 'store goods'));
/** 商品族的英文名（导览里显示） */
const FAMILY_EN: Record<string, string> = {
  AMB_IMP: 'imported ambient goods (sea)',
  FRZ_IMP: 'imported frozen goods (reefer container)',
  PROD_SEA: 'imported produce (reefer container)',
  AMB_RAIL: 'imported ambient goods (rail)',
  HH_RAIL: 'imported household goods (rail)',
  PROD_AIR: 'imported produce (air)',
  SEAFOOD_AIR: 'imported seafood (air)',
};

/** 3D 港口计划的步骤说明（中文）→ 中英文 */
function craneFact(text: string): TourText | undefined {
  const m = /岸桥 (\S+) 从班轮上吊起（(.+)）/.exec(text);
  if (!m) return undefined;
  const d = /甲板 (\d+) 贝 (\d+) 列 (\d+) 层/.exec(m[2] as string);
  const en = d ? `deck bay ${d[1]}, row ${d[2]}, tier ${d[3]}` : 'from the hold';
  return T(`岸桥 ${m[1]} 从班轮上吊起（${m[2]}）`, `Quay crane ${m[1]} lifts it off the liner (${en})`);
}
function truckFact(text: string): TourText | undefined {
  const m = /放到场内集卡 (\S+)/.exec(text);
  return m ? T(`放到场内集卡 ${m[1]}，开往堆场`, `Set on yard truck ${m[1]}, which drives it to the stack`) : undefined;
}

/** 门店配送车在门店的那一站 */
const stopAt = (o: BoardOp, key: string): OpStop | undefined => o.stops?.find((s) => s.key === key);
const loadAt = (o: BoardOp): number => o.dockAt?.[0] ?? o.dock?.[0] ?? o.depart ?? o.t0;

/**
 * 挑一个箱、串出一路。找不到本店的海运箱时退而求其次：铁路班列的箱、空运板；都没有返回 undefined。
 */
export function buildContainerJourney(input: TourInput): Journey | undefined {
  const { vehicles, ops, storeKey } = input;
  const hubs = input.hubs ?? [];
  const port = hubs.find((h) => h.key === 'port');
  const park = hubs.find((h) => h.key === 'park');
  const store = hubs.find((h) => h.key === 'store');
  const opById = new Map(ops.map((o) => [o.id, o]));
  const drays = ops.filter((o) => o.kind === 'drayage' && o.vehicle >= 0).sort((a, b) => a.t0 - b.t0);
  const deliveries = ops.filter((o) => o.kind === 'delivery' && o.vehicle >= 0 && stopAt(o, storeKey)).sort((a, b) => loadAt(a) - loadAt(b));
  const vessel = ops.find((o) => o.kind === 'vessel');
  const ship = vessel && vessel.vehicle >= 0 ? vehicles[vessel.vehicle] : vehicles.find((v) => v.kind === 'ship' && !/背景/.test(v.label) && v.segs.some((s) => /靠泊/.test(s.act ?? '')));
  const ownFlows = (port?.flows ?? []).filter((f) => f.own && f.kind === 'cargo');
  // 本店的箱：港口三维计划的记录优先（有岸桥、箱位、提箱的每一步），没有三维时用港口作业计划的流程
  const boxes: PortBoxLike[] = (input.portBoxes ?? []).filter((b) => b.store && b.stacked !== undefined);
  if (!boxes.length)
    for (const f of ownFlows) {
      const cy = f.steps.find((s) => s.zone === 'cy');
      if (!cy) continue;
      const out = f.steps.find((s) => s.zone === 'gate');
      const dop = f.carrierOut ? opById.get(f.carrierOut) : undefined;
      boxes.push({ id: f.id, store: true, stacked: cy.t0, ...(out ? { pickup: out.t0 } : {}), ...(dop ? { dray: dop.vehicle } : {}), steps: [] });
    }
  const flowOf = (id: string): HubFlow | undefined => ownFlows.find((f) => f.id === id);
  const drayOpOf = (b: PortBoxLike): BoardOp | undefined => {
    const f = flowOf(b.id);
    const byFlow = f?.carrierOut ? opById.get(f.carrierOut) : undefined;
    if (byFlow?.kind === 'drayage') return byFlow;
    return b.dray !== undefined ? drays.find((o) => o.vehicle === b.dray) : undefined;
  };

  // —— 挑箱：今天就被提走的（一路都在动画里）> 白天卸下的 > 离今天最近卸下的 ——
  const picked = boxes.filter((b) => drayOpOf(b));
  const daylight = (t: number | undefined) => t !== undefined && t >= DAWN && t <= 18 * 3600;
  const box = picked.sort((a, b) => (a.pickup ?? 0) - (b.pickup ?? 0))[0] ?? boxes.filter((b) => daylight(b.steps[0]?.t ?? b.stacked)).sort((a, b) => (a.stacked ?? 0) - (b.stacked ?? 0))[0] ?? boxes.sort((a, b) => (b.stacked ?? 0) - (a.stacked ?? 0))[0];

  if (box) return seaJourney(input, box, ship?.id, vessel, flowOf(box.id), drayOpOf(box), drays, deliveries, park, store);
  if (drays.length) return seaJourney(input, undefined, ship?.id, vessel, undefined, drays[0], drays, deliveries, park, store);
  const train = ops.find((o) => (o.kind === 'train' || o.kind === 'rail') && o.vehicle >= 0);
  if (train) return railJourney(input, train, deliveries, park, store);
  const truck = ops.find((o) => o.kind === 'airTruck' && o.vehicle >= 0);
  if (truck) return airJourney(input, truck, ops, deliveries, park, store);
  return undefined;
}

// ———————————————————————— 海运 ————————————————————————

function seaJourney(input: TourInput, box: PortBoxLike | undefined, shipVid: number | undefined, vessel: BoardOp | undefined, flow: HubFlow | undefined, ownDray: BoardOp | undefined, drays: readonly BoardOp[], deliveries: readonly BoardOp[], park: HubDay | undefined, store: HubDay | undefined): Journey {
  const legs: TourLeg[] = [];
  const steps = box?.steps ?? [];
  // 这个箱今天就被拖车提走（港口三维计划把今天卸下的箱交给今天来的拖车）；没有港口记录时跟的就是今天这辆拖车拉的箱
  const mine = !!ownDray;
  const fam = ownDray ? famByLabel(ownDray.label) : seaFamilyOf(deliveries, input.storeKey);
  const famT = famText(fam);
  const berth = vessel?.dock;
  const own = vessel ? Number(/约 (\d+) 个/.exec(vessel.label)?.[1] ?? NaN) : NaN;
  const lift = steps[0]?.t ?? box?.stacked;
  // 港口这几段在动画里看的时刻：箱今天卸船就看卸船；前一天卸的，挑船还在泊位的白天
  const portAt = clampDay(lift !== undefined && lift >= 0 ? lift - 90 : berth ? Math.min(Math.max(berth[0] + 600, DAWN), berth[1] - 900) : DAWN);

  if (box) {
    // 1. 班轮靠泊
    if (berth) {
      const facts = [T(`靠泊 ${whenZh(berth[0])}，离泊 ${whenZh(berth[1])}`, `Berthed ${whenEn(berth[0])}, leaves ${whenEn(berth[1])}`)];
      if (Number.isFinite(own)) facts.push(T(`这一班上有本店约 ${own} 个 40 尺箱`, `About ${own} of the store's 40-ft containers on this call`));
      legs.push({
        key: 'ship',
        title: '班轮靠泊',
        titleEn: 'The liner is alongside',
        at: portAt,
        t0: berth[0],
        t1: berth[1],
        where: shipVid !== undefined ? { kind: 'vehicle', vehicle: shipVid } : { kind: 'port-berth' },
        ...(shipVid !== undefined ? { vehicle: shipVid } : {}),
        facts,
        source: 'record',
        ...(berth[0] < 0 ? { note: T('前一天就靠泊了：动画从今天 0 点开始，船还在泊位上', 'It berthed the day before; the animation starts at midnight with the ship still alongside') } : {}),
      });
    }
    // 2. 岸桥卸船
    const cf = steps[0] ? craneFact(steps[0].text) : undefined;
    const tf = steps[1] ? truckFact(steps[1].text) : undefined;
    const t0 = lift ?? portAt;
    legs.push({
      key: 'discharge',
      title: '岸桥卸船',
      titleEn: 'Quay crane discharge',
      at: portAt,
      t0,
      t1: steps[2]?.t ?? box.stacked ?? t0,
      where: { kind: 'port-berth' },
      facts: [T(`本店的箱 ${box.id}`, `Store container ${box.id}`), ...(cf ? [T(`${whenZh(t0)} ${cf.zh}`, `${whenEn(t0)}: ${cf.en}`)] : [T(`${whenZh(t0)} 卸到码头`, `Discharged at ${whenEn(t0)}`)]), ...(tf ? [tf] : [])],
      source: 'record',
      ...(t0 < 0 ? { note: T(`这一步发生在前一天 ${hm(t0)}，动画里看不到；镜头对着同一台岸桥`, `This happened at ${hm(t0)} the day before, outside the animated day; the camera shows the same berth`) } : {}),
    });
    // 3. 堆场：龙门吊堆箱
    const s = box.slot;
    legs.push({
      key: 'yard',
      title: '进堆场',
      titleEn: 'Into the container yard',
      at: clampDay(box.stacked !== undefined && box.stacked >= 0 ? box.stacked - 40 : portAt + 20),
      t0: box.stacked ?? t0,
      t1: box.pickup ?? box.stacked ?? t0,
      where: { kind: 'port-box', box: box.id },
      facts: [
        s ? T(`龙门吊堆到 ${s.block} 箱区 ${s.bay} 贝 ${s.row} 列 ${s.tier} 层（${whenZh(box.stacked ?? t0)}）`, `The yard gantry stacks it at block ${s.block}, bay ${s.bay}, row ${s.row}, tier ${s.tier} (${whenEn(box.stacked ?? t0)})`) : T(`卸到堆场 ${whenZh(box.stacked ?? t0)}`, `Into the yard at ${whenEn(box.stacked ?? t0)}`),
        T('本店的箱是蓝色的，等清关、等拖车来提', "The store's boxes are blue; it waits for customs release and a pickup"),
      ],
      source: 'record',
    });
    // 4. 清关、等提箱
    const ins = flow?.steps.filter((x) => x.zone === 'scan' || x.zone === 'inspect') ?? [];
    const insFacts = ins.map((x) => (x.zone === 'scan' ? T(`布控：${whenZh(x.t0)} 过机检通道`, `Selected for inspection: X-ray scan at ${whenEn(x.t0)}`) : T(`开箱查验 ${whenZh(x.t0)}–${hm(x.t1)}`, `Opened for inspection ${whenEn(x.t0)}–${hm(x.t1)}`)));
    if (mine && box.pickup !== undefined && box.stacked !== undefined) {
      const h = (box.pickup - box.stacked) / 3600;
      legs.push({ key: 'dwell', title: '清关、提箱', titleEn: 'Customs release and pickup', at: clampDay(box.pickup - 150), t0: box.stacked, t1: box.pickup, where: { kind: 'port-box', box: box.id }, facts: [T(`在堆场停了 ${h.toFixed(1)} 小时`, `${h.toFixed(1)} hours in the yard`), ...insFacts, T(`${whenZh(box.pickup)} 龙门吊把它装上集装箱拖车 ${ownDray?.id ?? ''}`, `At ${whenEn(box.pickup)} the gantry loads it onto drayage truck ${ownDray?.id ?? ''}`)], source: 'record' });
    } else {
      const d = input.dwellDays ?? 1.6;
      legs.push({
        key: 'dwell',
        title: '清关、等提箱（跨天）',
        titleEn: 'Customs and waiting for pickup (days)',
        at: clampDay(portAt + 40),
        t0: box.stacked ?? t0,
        t1: (box.stacked ?? t0) + d * 86400,
        where: { kind: 'port-box', box: box.id },
        facts: [T(`这个方案的平均堆场停留约 ${d.toFixed(1)} 天（清关、预约提箱）`, `This scheme's average yard dwell is about ${d.toFixed(1)} days (customs, booked pickup)`), ...insFacts],
        source: 'estimate',
        skipDays: d,
        note: T(`这一段跨了约 ${d.toFixed(1)} 天，动画只有一天，这里跳过`, `This step spans about ${d.toFixed(1)} days; the animation covers one day, so it is skipped here`),
      });
    }
  } else if (ownDray) {
    // 港口里没有今天卸下的本店箱：从今天来提箱的拖车开始，港口那几段只说一句
    const d = input.dwellDays ?? 1.6;
    legs.push({ key: 'dwell', title: '到港、清关（之前几天）', titleEn: 'Arrival and customs (days before)', at: clampDay(ownDray.t0 - 600), t0: ownDray.t0 - d * 86400, t1: ownDray.t0, where: { kind: 'port-gate' }, facts: [T(`这个箱几天前随班轮到港，在堆场停了约 ${d.toFixed(1)} 天（方案的平均值）`, `This box came in on a liner a few days ago and waited about ${d.toFixed(1)} days in the yard (scheme average)`)], source: 'estimate', skipDays: d, note: T('卸船那几段不在今天，动画里看不到', 'The discharge steps were days ago, outside the animated day') });
  }

  // 5. 集装箱拖车送物流园
  const route = input.portToDc ?? portToDc();
  const dray = mine ? ownDray : ownDray ?? drays[0];
  if (dray) {
    const arrive = dray.arrive ?? dray.t1;
    const facts = [T(`${whenZh(dray.t0)} 出闸，${whenZh(arrive)} 到物流园（${mins(arrive - dray.t0)} 分钟、${Math.round(dray.km ?? route?.km ?? 0)} 公里）`, `Out of the gate ${whenEn(dray.t0)}, at the logistics park ${whenEn(arrive)} (${mins(arrive - dray.t0)} min, ${Math.round(dray.km ?? route?.km ?? 0)} km)`)];
    const proxy = !mine && !!box;
    legs.push({ key: 'dray', title: '集装箱拖车送物流园', titleEn: 'Drayage to the logistics park', at: clampDay(dray.t0 + 60), t0: dray.t0, t1: arrive, where: { kind: 'vehicle', vehicle: dray.vehicle }, vehicle: dray.vehicle, facts, source: proxy ? 'proxy' : 'record', ...(proxy ? { note: T(`今天的另一辆本店集装箱拖车（${dray.id}，拉的是更早到港的箱）；我们这个箱约 ${(input.dwellDays ?? 1.6).toFixed(1)} 天后也这样走`, `Another store drayage truck today (${dray.id}, carrying a box that arrived earlier); our box takes the same trip about ${(input.dwellDays ?? 1.6).toFixed(1)} days later`) } : {}) });
  } else {
    legs.push({
      key: 'dray',
      title: '集装箱拖车送物流园',
      titleEn: 'Drayage to the logistics park',
      at: clampDay((legs[legs.length - 1]?.at ?? portAt) + 60),
      t0: NaN,
      t1: NaN,
      where: { kind: 'preset', preset: 'dc' },
      facts: [route ? T(`港口到物流园约 ${Math.round(route.km)} 公里，不堵车约 ${mins(route.hours * 3600)} 分钟`, `Port to logistics park: about ${Math.round(route.km)} km, about ${mins(route.hours * 3600)} min without traffic`) : T('出闸以后走高速到物流园', 'Out of the gate and up the highway to the logistics park'), T('今天没有本店的集装箱拖车（这一天提箱的车次为 0）', 'No store drayage runs on the animated day')],
      source: 'estimate',
      note: T('这一段在动画以外的那一天，按路网估算', 'This happens on a later day; estimated from the road network'),
    });
  }

  // 6. 配送中心收货门拆箱
  const dcLeg = dcLegFor(input, mine && ownDray ? ownDray : undefined, park, fam, legs[legs.length - 1]?.at ?? portAt);
  legs.push(dcLeg);
  const ready = mine && ownDray ? (ownDray.dockAt?.[1] ?? ownDray.dock?.[1] ?? ownDray.t1) + (input.crossDock ? 1800 : 5400) : undefined;
  legs.push(...storeLegs(input, deliveries, store, fam, ready, dcLeg.at));
  const first = legs.find((l) => l.source !== 'record');
  return {
    box: box?.id ?? ownDray?.id ?? '',
    mode: 'sea',
    ...(fam ? { family: { key: fam.key, label: fam.label, temp: fam.temp } } : {}),
    legs,
    summary: summaryOf(box ? T(`箱 ${box.id}`, `container ${box.id}`) : T(`${ownDray?.id ?? ''} 拉的箱`, `the box on ${ownDray?.id ?? ''}`), famT, legs, !!first),
  };
}

/** 没有拖车记录时这个箱装的是什么：今天门店配送车上装得最多的海运商品族（估算） */
function seaFamilyOf(deliveries: readonly BoardOp[], storeKey: string): Family | undefined {
  const sea = FAMILIES.filter((f) => f.source === 'sea');
  let best: Family | undefined;
  let max = -1;
  for (const f of sea) {
    const n = deliveries.reduce((a, o) => a + (stopAt(o, storeKey)?.load?.[f.key] ?? 0), 0);
    if (n > max) {
      max = n;
      best = f;
    }
  }
  return best;
}

function portToDc(): { km: number; hours: number } | undefined {
  try {
    const p = shortestPath(buildGraph(), 'PORT', 'DC');
    return Number.isFinite(p.km) && p.km > 0 ? { km: p.km, hours: p.hours } : undefined;
  } catch {
    return undefined;
  }
}

// ———————————————————————— 配送中心 ————————————————————————

/** 配送中心收货门：本店这个箱今天就到（记录）；否则用今天在收货门拆箱 / 卸货的另一件本店的货演示（同类作业） */
function dcLegFor(input: TourInput, own: BoardOp | undefined, park: HubDay | undefined, fam: Family | undefined, after: number, train?: string): TourLeg {
  const xd = input.crossDock ? T('全链路方案：一部分直接越库装上门店配送车，其余进立体库按先进先出出库', 'In this scheme part of it cross-docks straight onto store trucks; the rest goes into the automated store, first in, first out') : T('拆出来的托盘进库位，按先进先出出库', 'The pallets go into storage and leave first in, first out');
  if (own) {
    const f = park?.flows.find((x) => x.carrierIn === own.id);
    const gate = f?.steps.find((s) => s.zone === 'gate');
    const dock = own.dockAt ?? own.dock ?? [own.arrive ?? own.t1, own.t1];
    const facts = [...(gate ? [T(`${whenZh(gate.t0)} 进园登记`, `Checked in at the park gate at ${whenEn(gate.t0)}`)] : []), T(`${own.door ? `${own.door} 号门` : '收货门'}拆箱 ${whenZh(dock[0])}–${hm(dock[1])}（${own.pallets ?? PALLETS_PER_FEU} 托）`, `Devanned at ${own.door ? `door ${own.door}` : 'a receiving door'} ${whenEn(dock[0])}–${hm(dock[1])} (${own.pallets ?? PALLETS_PER_FEU} pallets)`), xd];
    return { key: 'dc', title: '配送中心收货门拆箱', titleEn: 'Devanning at the DC door', at: clampDay(dock[0] + 120), t0: dock[0], t1: dock[1], where: { kind: 'vehicle', vehicle: own.vehicle }, vehicle: own.vehicle, facts, source: 'record' };
  }
  // 同类作业：今天进配送中心、在收货门拆箱的本店箱（班列来的）优先，其次今天在收货门卸货的进货车；同温区、白天、在前一段之后的优先
  const cold = fam ? fam.temp !== 'ambient' : false;
  const boxFlows = (park?.flows ?? []).filter((x) => x.own && x.kind === 'cargo' && x.steps.some((s) => /配送中心收货门拆箱/.test(s.act)));
  const pickBy = <X>(list: X[], t: (x: X) => number) => list.filter((x) => t(x) >= Math.max(after, DAWN)).sort((a, b) => t(a) - t(b))[0] ?? list.filter((x) => t(x) >= DAWN).sort((a, b) => t(a) - t(b))[0] ?? list.sort((a, b) => t(a) - t(b))[0];
  const devan = (x: HubFlow) => x.steps.find((s) => /配送中心收货门拆箱/.test(s.act)) as HubFlow['steps'][number];
  // 跟的就是班列的箱：同一列车卸下来、在收货门拆箱的那一个算记录
  const fromTrain = train ? boxFlows.filter((x) => x.carrierIn === train) : [];
  if (fromTrain.length) {
    const x = pickBy(fromTrain, (y) => devan(y).t0) as HubFlow;
    const s = devan(x);
    return { key: 'dc', title: '配送中心收货门拆箱', titleEn: 'Devanning at the DC door', at: clampDay(s.t0 + 120), t0: s.t0, t1: s.t1, where: { kind: 'preset', preset: 'dc' }, facts: [T(`${x.id}：${whenZh(s.t0)}–${hm(s.t1)} 短驳到收货门拆箱`, `${x.id}: shuttled to a receiving door and devanned ${whenEn(s.t0)}–${hm(s.t1)}`), xd], source: 'record' };
  }
  const bf = cold ? undefined : pickBy(boxFlows, (x) => devan(x).t0);
  const inbound = input.ops.filter((o) => o.to === 'DC' && o.door && o.vehicle >= 0 && (o.dockAt ?? o.dock) && ['supplier', 'farm', 'airTruck', 'drayage'].includes(o.kind));
  const sameTemp = inbound.filter((o) => (o.zone && o.zone !== 'ambient') === cold);
  const op = pickBy(sameTemp.length ? sameTemp : inbound, (o) => (o.dockAt ?? o.dock ?? [o.t0])[0] as number);
  const ourFacts = [T(`我们这个箱到了以后：在收货门拆箱约 36 分钟（${PALLETS_PER_FEU} 托）`, `When our box arrives: about 36 minutes of devanning at a receiving door (${PALLETS_PER_FEU} pallets)`), xd];
  if (bf) {
    const s = devan(bf);
    return { key: 'dc', title: '配送中心收货门拆箱', titleEn: 'Devanning at the DC door', at: clampDay(s.t0 + 120), t0: s.t0, t1: s.t1, where: { kind: 'preset', preset: 'dc' }, facts: [T(`今天 ${whenZh(s.t0)}–${hm(s.t1)}：${bf.label}（${bf.carrierIn ?? '班列'}）在收货门拆箱`, `Today ${whenEn(s.t0)}–${hm(s.t1)}: ${bf.id} (off ${bf.carrierIn ?? 'the train'}) is devanned at a receiving door`), ...ourFacts], source: 'proxy', note: T('我们这个箱到配送中心是几天以后的事；这里用今天进配送中心拆箱的另一个本店箱演示同一个环节', 'Our box reaches the DC days later; another store box being devanned today shows the same step') };
  }
  if (op) {
    const dock = (op.dockAt ?? op.dock) as [number, number];
    return { key: 'dc', title: '配送中心收货门', titleEn: 'At the DC receiving door', at: clampDay(dock[0] + 120), t0: dock[0], t1: dock[1], where: { kind: 'vehicle', vehicle: op.vehicle }, vehicle: op.vehicle, facts: [T(`今天 ${whenZh(dock[0])}–${hm(dock[1])}：${op.label.split(' · ')[0]}（${op.id}）在 ${op.door} 号门卸货`, `Today ${whenEn(dock[0])}–${hm(dock[1])}: inbound ${op.id} unloads at door ${op.door}`), ...ourFacts], source: 'proxy', note: T('我们这个箱到配送中心是几天以后的事；这里用今天在收货门卸货的另一车货演示同一个环节', 'Our box reaches the DC days later; another inbound load today shows the same step') };
  }
  return { key: 'dc', title: '配送中心收货门拆箱', titleEn: 'Devanning at the DC door', at: clampDay(after + 60), t0: NaN, t1: NaN, where: { kind: 'preset', preset: 'dc' }, facts: ourFacts, source: 'estimate' };
}

// ———————————————————————— 门店 ————————————————————————

/** 门店配送车（先进先出）→ 门店收货口 → 后仓、上架 */
function storeLegs(input: TourInput, deliveries: readonly BoardOp[], store: HubDay | undefined, fam: Family | undefined, ready: number | undefined, after: number): TourLeg[] {
  const out: TourLeg[] = [];
  const key = input.storeKey;
  const carries = (o: BoardOp) => !fam || (stopAt(o, key)?.load?.[fam.key] ?? 0) > 0 || (!stopAt(o, key)?.load && (o.zone === 'multi' || o.zone === fam.temp));
  const withFam = deliveries.filter(carries);
  // 先进先出：这个箱今天到配送中心，就配它能赶上的第一车；不然用今天装着同一类货的车（白天、在前一段之后的优先）
  let truck: BoardOp | undefined;
  let source: TourSource = 'estimate';
  if (ready !== undefined) truck = withFam.find((o) => loadAt(o) >= ready);
  // 今天到配送中心、但赶不上今天最后一车：按先进先出是明天的第一车
  const missed = ready !== undefined && !truck;
  if (!truck) {
    source = 'proxy';
    truck = withFam.find((o) => loadAt(o) >= Math.max(after, DAWN)) ?? withFam.find((o) => loadAt(o) >= DAWN) ?? withFam[0];
  }
  if (!truck) return out;
  const lastLoad = withFam.length ? loadAt(withFam[withFam.length - 1] as BoardOp) : undefined;
  const st = stopAt(truck, key) as OpStop;
  const units = fam ? st.load?.[fam.key] : undefined;
  const famT = famText(fam);
  const t0 = loadAt(truck);
  const dep = truck.depart ?? truck.dockAt?.[1] ?? t0;
  out.push({
    key: 'dispatch',
    title: '装上门店配送车',
    titleEn: 'Onto the store delivery truck',
    at: clampDay(t0 + 90),
    t0,
    t1: st.arrive,
    where: { kind: 'vehicle', vehicle: truck.vehicle },
    vehicle: truck.vehicle,
    facts: [T(`${truck.id}：${truck.door ? `${truck.door} 号门` : '发货门'}装车 ${whenZh(t0)}，${whenZh(dep)} 发车（${truck.pallets ?? st.pallets} 托）`, `${truck.id}: loads at ${truck.door ? `door ${truck.door}` : 'a shipping door'} ${whenEn(t0)}, departs ${whenEn(dep)} (${truck.pallets ?? st.pallets} pallets)`), ...(units ? [T(`车上有${famT.zh} ${Math.round(units).toLocaleString('en-US')} 件`, `${Math.round(units).toLocaleString('en-US')} units of ${famT.en} on board`)] : [])],
    source,
    note:
      source === 'estimate'
        ? T('按先进先出配车：这个箱的货能赶上的第一车（同温区）', 'Assigned first in, first out: the first truck its goods can make (same temperature zone)')
        : missed
          ? T(`这个箱的货赶不上今天的车（装着这类货的最后一车 ${hm(lastLoad ?? 0)} 装车），按先进先出明天第一车走；这里用今天的同一类车演示`, `Its goods miss today's trucks (the last one with this kind of goods loads at ${hm(lastLoad ?? 0)}); first in, first out puts them on tomorrow's first truck. Today's truck shows the step`)
          : T('我们这个箱的货要几天后才发；这里用今天装着同一类货的车演示', 'Our box ships days later; a truck carrying the same kind of goods today shows the step'),
  });
  // 门店收货口
  const f = store?.flows.find((x) => x.carrierIn === truck.id);
  const dock = f?.steps.find((s) => s.zone === 'docks');
  const queue = f?.steps.find((s) => s.zone === 'queue');
  const dockNo = dock ? /(\d+) 号收货口/.exec(dock.act)?.[1] : undefined;
  const u0 = dock?.t0 ?? st.start;
  const u1 = dock?.t1 ?? st.end;
  out.push({
    key: 'store',
    title: '门店收货口卸货',
    titleEn: 'Unloading at the store dock',
    at: clampDay(Math.max(st.arrive - 60, u0 - 150)),
    t0: st.arrive,
    t1: u1,
    where: { kind: 'vehicle', vehicle: truck.vehicle },
    vehicle: truck.vehicle,
    facts: [
      T(`${whenZh(st.arrive)} 到店${st.onTime ? '（准时）' : '（晚了）'}`, `At the store ${whenEn(st.arrive)}${st.onTime ? ' (on time)' : ' (late)'}`),
      ...(queue ? [T(`在待命车位等了 ${mins(queue.t1 - queue.t0)} 分钟`, `Waited ${mins(queue.t1 - queue.t0)} min in the holding lane`)] : []),
      T(`${dockNo ? `${dockNo} 号收货口` : '收货口'}卸货 ${whenZh(u0)}–${hm(u1)}（${st.pallets} 托）`, `Unloads at ${dockNo ? `dock ${dockNo}` : 'the dock'} ${whenEn(u0)}–${hm(u1)} (${st.pallets} pallets)`),
    ],
    source: 'record',
  });
  // 后仓、上架（门店模型里的员工作业：卸完以后第一次送到后仓、第一次上架）
  const agents = input.storeAgents ?? [];
  const find = (re: RegExp, t: number) => {
    let best: { a: StoreAgentLike; s: StoreAgentLike['segs'][number] } | undefined;
    for (const a of agents) for (const s of a.segs) if (re.test(s.act ?? '') && s.t0 >= t && (!best || s.t0 < best.s.t0)) best = { a, s };
    return best;
  };
  const back = find(/后仓/, u1);
  const shelf = find(/^上架$/, back ? back.s.t1 : u1);
  const fresh = fam && fam.temp !== 'ambient' && input.freshRemainPct !== undefined ? [T(`这个方案到店的生鲜平均还剩 ${input.freshRemainPct.toFixed(1)}% 的保质期`, `In this scheme fresh goods reach the store with ${input.freshRemainPct.toFixed(1)}% of their shelf life left on average`)] : [];
  const pt = (shelf ?? back)?.s.pts;
  out.push({
    key: 'shelf',
    title: '进后仓、上架',
    titleEn: 'Backroom and shelf',
    at: clampDay(shelf ? shelf.s.t0 + 5 : back ? back.s.t0 + 5 : u1 + 600),
    t0: back?.s.t0 ?? u1,
    t1: shelf?.s.t1 ?? (back?.s.t1 ?? u1 + 1800),
    where: pt && pt.length >= 2 ? { kind: 'store-point', x: pt[pt.length - 2] as number, y: pt[pt.length - 1] as number } : { kind: 'preset', preset: 'flagship' },
    facts: [...(back ? [T(`${whenZh(back.s.t0)} ${back.a.label} 把货送到后仓`, `${whenEn(back.s.t0)}: a ${AGENT_EN[back.a.kind] ?? back.a.kind} takes it to the backroom`)] : []), ...(shelf ? [T(`${whenZh(shelf.s.t0)} ${shelf.a.label} 上架`, `${whenEn(shelf.s.t0)}: a ${AGENT_EN[shelf.a.kind] ?? shelf.a.kind} puts it on the shelf`)] : [T('按补货点上架：货架低于补货点时从后仓补上', 'Shelved when the shelf drops below its reorder point')]), ...fresh],
    source: 'estimate',
    note: T('店里的作业来自门店模型（第二部分 StoreX）：按卸完以后第一次进后仓、第一次上架配上，时刻和全链路的到车不完全对齐', "In-store work comes from the store model (part 2, StoreX), matched to the first backroom and shelving moves after unloading; its clock is not tied exactly to the chain's trucks"),
  });
  return out;
}
const AGENT_EN: Record<string, string> = { receiver: 'receiver', stocker: 'stocker', pallet: 'pallet robot', amr: 'restocking robot', porter: 'porter', picker: 'picker', decanter: 'decanter' };

// ———————————————————————— 铁路、空运（找不到海运箱时） ————————————————————————

function railJourney(input: TourInput, train: BoardOp, deliveries: readonly BoardOp[], park: HubDay | undefined, store: HubDay | undefined): Journey {
  const legs: TourLeg[] = [];
  const v = input.vehicles[train.vehicle];
  const unload = v?.segs.find((s) => /卸箱/.test(s.act ?? ''));
  const boxes = /(\d+) 箱/.exec(train.label)?.[1];
  const fam = FAMILIES.find((f) => f.source === 'rail') as Family | undefined;
  legs.push({
    key: 'train',
    title: train.kind === 'train' ? '洲际铁路班列进站' : '港口铁路接驳',
    titleEn: train.kind === 'train' ? 'Intercontinental train arrives' : 'Port rail shuttle',
    at: clampDay((train.arrive ?? train.t0) - 300),
    t0: train.t0,
    t1: train.t1,
    where: { kind: 'vehicle', vehicle: train.vehicle },
    vehicle: train.vehicle,
    facts: [T(`${whenZh(train.arrive ?? train.t0)} 到物流园货运站${boxes ? `（本店 ${boxes} 箱）` : ''}`, `At the park rail terminal ${whenEn(train.arrive ?? train.t0)}${boxes ? ` (${boxes} store boxes)` : ''}`), ...(unload ? [T(`查验、卸箱 ${whenZh(unload.t0)}–${hm(unload.t1)}`, `Inspection and unloading ${whenEn(unload.t0)}–${hm(unload.t1)}`)] : [])],
    source: 'record',
    note: T('今天没有本店的海运箱可跟：改跟一个铁路班列来的箱', 'No store sea container to follow today; following a box off the train instead'),
  });
  const dcLeg = dcLegFor(input, undefined, park, fam, legs[0]?.at ?? DAWN, v?.label ?? train.label);
  legs.push(dcLeg);
  legs.push(...storeLegs(input, deliveries, store, fam, dcLeg.source === 'record' && Number.isFinite(dcLeg.t1) ? dcLeg.t1 + (input.crossDock ? 1800 : 5400) : undefined, dcLeg.at));
  return { box: train.id, mode: 'rail', ...(fam ? { family: { key: fam.key, label: fam.label, temp: fam.temp } } : {}), legs, summary: summaryOf(T(`${train.id} 班列上的箱`, `a box off train ${train.id}`), famText(fam), legs, legs.some((l) => l.source !== 'record')) };
}

function airJourney(input: TourInput, truck: BoardOp, ops: readonly BoardOp[], deliveries: readonly BoardOp[], park: HubDay | undefined, store: HubDay | undefined): Journey {
  const legs: TourLeg[] = [];
  const flight = ops.filter((o) => o.kind === 'flight' && o.vehicle >= 0 && o.t0 <= truck.t0).sort((a, b) => b.t0 - a.t0)[0];
  const fam = FAMILIES.find((f) => f.key === 'PROD_AIR') as Family | undefined;
  if (flight)
    legs.push({ key: 'flight', title: '货运航班落地', titleEn: 'The cargo flight lands', at: clampDay((flight.arrive ?? flight.t0) - 120), t0: flight.t0, t1: flight.t1, where: { kind: 'vehicle', vehicle: flight.vehicle }, vehicle: flight.vehicle, facts: [T(`${whenZh(flight.arrive ?? flight.t0)} 落地（${flight.id}）`, `Lands ${whenEn(flight.arrive ?? flight.t0)} (${flight.id})`)], source: 'record', note: T('今天没有本店的海运箱可跟：改跟一块空运集装板', 'No store sea container to follow today; following an air cargo pallet instead') });
  legs.push({ key: 'airtruck', title: '货站装冷藏车', titleEn: 'Loaded at the cargo terminal', at: clampDay(truck.t0 + 60), t0: truck.t0, t1: truck.t1, where: { kind: 'vehicle', vehicle: truck.vehicle }, vehicle: truck.vehicle, facts: [T(`${truck.id}：${whenZh(truck.t0)} 出发去物流园（${truck.pallets ?? '?'} 托）`, `${truck.id}: leaves for the logistics park ${whenEn(truck.t0)} (${truck.pallets ?? '?'} pallets)`)], source: 'record' });
  const dock = truck.dockAt ?? truck.dock;
  if (dock && truck.door) legs.push({ key: 'dc', title: '配送中心冷链门卸货', titleEn: 'Unloading at the DC cold door', at: clampDay(dock[0] + 60), t0: dock[0], t1: dock[1], where: { kind: 'vehicle', vehicle: truck.vehicle }, vehicle: truck.vehicle, facts: [T(`${truck.door} 号门卸货 ${whenZh(dock[0])}–${hm(dock[1])}`, `Unloads at door ${truck.door} ${whenEn(dock[0])}–${hm(dock[1])}`)], source: 'record' });
  else legs.push(dcLegFor(input, undefined, park, fam, legs[legs.length - 1]?.at ?? DAWN));
  legs.push(...storeLegs(input, deliveries, store, fam, dock ? dock[1] + 1800 : undefined, legs[legs.length - 1]?.at ?? DAWN));
  return { box: truck.id, mode: 'air', ...(fam ? { family: { key: fam.key, label: fam.label, temp: fam.temp } } : {}), legs, summary: summaryOf(T(`${truck.id} 运的空运货`, `the air cargo on ${truck.id}`), famText(fam), legs, legs.some((l) => l.source !== 'record')) };
}

function summaryOf(who: TourText, fam: TourText, legs: readonly TourLeg[], mixed: boolean): TourText {
  const n = legs.length;
  const rec = legs.filter((l) => l.source === 'record').length;
  const skip = legs.reduce((a, l) => a + (l.skipDays ?? 0), 0);
  return T(
    `跟着本店的${who.zh}（${fam.zh}）走 ${n} 段：${rec} 段来自仿真记录${mixed ? '，其余按规则估算或用今天同一环节的作业演示（卡片上都标着）' : ''}${skip ? `；中间跳过约 ${skip.toFixed(1)} 天` : ''}。`,
    `Follow the store's ${who.en} (${fam.en}) through ${n} steps: ${rec} from the simulation record${mixed ? '; the rest are estimated by rule or shown with the same step from today (each card says which)' : ''}${skip ? `; about ${skip.toFixed(1)} days are skipped in between` : ''}.`,
  );
}
