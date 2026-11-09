import { Rng } from '../core/rng';
import { H, Sim } from '../core/sim';
import { mean, quantile } from '../core/stats';
import { buildCatalog, CATEGORY, sizeShelves, type Catalog } from '../world/catalog';
import { ROLES, type Role, type Scenario } from '../world/config';
import { BASKET_MEAN, generateOrders, generateShoppers, ORDER_ITEMS_MEAN, type Order, type Shopper } from '../world/demand';
import { buildLayout, CATEGORIES, type Category, type Layout, type Pt } from '../world/layout';
import { Router } from '../world/path';
import { Pool } from './agents';
import { energyModel, ROBOT_KW, type EnergyResult } from './energy';
import { freshWaste, type FreshResult } from './fresh';
import { Inbound } from './inbound';
import { Instore } from './instore';
import { Mfc } from './mfc';
import { Online } from './online';
import { demandRate, Shelf } from './shelf';
import { paidHours, planStaff } from './staffing';
import { Trace, type AgentKind, type AgentTrace, type TraceEvent } from './trace';

export const WAGE = 22;
export const TECH_WAGE = 32;

export interface DayResult {
  name: string;
  generation: Scenario['generation'];
  seed: number;
  demand: { orders: number; items: number; lines: number; shoppers: number };
  online: {
    done: number;
    onTimePct: number;
    waitAvg: number;
    waitP80: number;
    waitP95: number;
    waitOver5Pct: number;
    dwellAvg: number;
    fillPct: number;
    substitutionPct: number;
    shortItems: number;
    totesPerOrder: number;
    floorItemsPerHour: number;
    walkKm: number;
    /** 线上作业的有效工时（分钟 / 单）：拣货、站台、拆箱、暂存交付 */
    laborMinPerOrder: number;
    laborCostPerOrder: number;
    mfcLines: number;
    mfcBotUtil: number;
    mfcPortUtil: number;
    mfcFailures: number;
    lockerPeak: Record<'ambient' | 'chilled' | 'frozen', number>;
    lockerQueuedMax: number;
    exceptions: number;
    /** 降级模式下在卖场拣的包装商品件数（货格仓停机演练） */
    fallbackItems: number;
    byMode: Record<string, { n: number; waitAvg: number }>;
  };
  instore: { shoppers: number; sales: number; lostSales: number; waitAvg: number; waitP95: number; byKind: Record<string, { n: number; waitAvg: number; waitP95: number }>; interventions: number };
  shelf: { outOfShelfPct: number; outages: number; restocks: number; failedTrips: number; recoverAvgMin: number; lostItems: number; lostSales: number };
  inbound: { trucks: number; pallets: number; cases: number; dockAvgMin: number; decantCases: number };
  labor: {
    scheduled: Record<Role, number>;
    productive: Record<Role, number>;
    night: number;
    fixed: number;
    paidTotal: number;
    /** 在岗时段里的平均利用率（有效工时 / 排班工时，只算事件仿真里的岗位） */
    utilization: number;
    costPerDay: number;
    /** 当天在岗的员工人数（按 8 小时折算的全职人数） */
    fte: number;
  };
  robots: { counts: Record<string, number>; busyHours: Record<string, number>; failures: number; downtimeMin: number; total: number };
  fresh: FreshResult;
  energy: EnergyResult;
  money: { labor: number; energy: number; freshLoss: number; lostMargin: number; total: number };
  hourly: { ordersDone: number[]; pickupWait: number[]; checkoutWait: number[]; staffOnDuty: number[]; robotsBusy: number[]; shelfOut: number[] };
  events: number;
  /** 逐单结果（调试和实验报告用） */
  orders?: import('./online').OrderOutcome[];
  trace?: { agents: AgentTrace[]; events: TraceEvent[] };
}

export interface World {
  layout: Layout;
  catalog: Catalog;
  orders: Order[];
  shoppers: Shopper[];
}

/** 同一个种子下两代流程的需求完全一样（只用 demand 子流） */
export function buildWorld(s: Scenario): World {
  const rng = new Rng(s.seed);
  const layout = buildLayout(s.generation);
  const catalog = buildCatalog(layout, rng.fork('catalog'), s.catalog);
  // 货架容量按这家店预期的地面销量定（本方案里货格仓商品的线上需求不走货架）
  const inStore = s.demand.shoppersPerDay * BASKET_MEAN;
  const online = s.demand.ordersPerDay * ORDER_ITEMS_MEAN;
  sizeShelves(catalog, (k) => demandRate(catalog, k) * (inStore + (s.generation === 'storex' && k.inMfc ? 0 : online)), s.catalog.daysOfSupply);
  const demandRng = rng.fork('demand');
  const orders = generateOrders(catalog, demandRng, s.demand);
  const shoppers = generateShoppers(catalog, rng.fork('shoppers'), s.demand);
  return { layout, catalog, orders, shoppers };
}

const ROLE_KIND: Record<Role, AgentKind> = {
  picker: 'picker',
  dispenser: 'dispenser',
  porter: 'porter',
  decanter: 'decanter',
  freshPicker: 'freshPicker',
  handoff: 'handoff',
  stocker: 'stocker',
  receiver: 'receiver',
  cashier: 'cashier',
  host: 'host',
  robotTech: 'robotTech',
};

const ROLE_NAME: Record<Role, string> = {
  picker: '拣货员',
  dispenser: '交付员',
  porter: '站台拣货员',
  decanter: '拆箱员',
  freshPicker: '生鲜拣选员',
  handoff: '自提服务员',
  stocker: '补货员',
  receiver: '收货员',
  cashier: '收银员',
  host: '出口服务员',
  robotTech: '机器人值班员',
};

export function runDay(s: Scenario): DayResult {
  const world = buildWorld(s);
  const { layout, catalog, orders, shoppers } = world;
  const rng = new Rng(s.seed);
  const ops = rng.fork('ops');
  const plan = planStaff(s, orders, shoppers, rng.fork('forecast'));
  // 收银员不超过收银台数
  plan.schedule.cashier = plan.schedule.cashier.map((n) => Math.min(n, s.checkout.staffedLanes));
  const sim = new Sim();
  const trace = new Trace(s.trace);
  const router = new Router(layout);
  const poi = layout.poi;
  const gen1 = s.generation === 'gen1';
  const home = (r: Role): Pt => {
    switch (r) {
      case 'picker':
      case 'dispenser':
        return poi.staging ?? poi.service;
      case 'porter':
        return poi.mfcPorts[0] ?? poi.service;
      case 'decanter':
        return poi.decant ?? poi.service;
      case 'freshPicker':
        return poi.freshDrop ?? poi.service;
      case 'handoff':
        return poi.consolidation ?? poi.service;
      case 'stocker':
        return poi.backroomStock[0] ?? poi.service;
      case 'receiver':
        return (poi.docks[0] as { inside: Pt }).inside;
      case 'cashier':
        return poi.staffedLanes[0] ?? poi.service;
      case 'host':
        return poi.selfCheckouts[0] ?? poi.service;
      case 'robotTech':
        return poi.chargers[0] ?? poi.service;
    }
  };
  // 站台拣货员各守一个站台，收银员各守一条人工通道
  const homes: Partial<Record<Role, Pt[]>> = {
    porter: poi.mfcPorts,
    cashier: poi.staffedLanes.slice(0, s.checkout.staffedLanes).map((p) => ({ x: p.x - 2, y: p.y })),
  };
  const crew = Object.fromEntries(
    ROLES.map((r) => [r, new Pool(sim, router, trace, { kind: ROLE_KIND[r], name: !gen1 && r === 'stocker' ? '门店作业员' : ROLE_NAME[r], home: home(r), ...(homes[r]?.length ? { homes: homes[r] } : {}), speed: 1.0, schedule: plan.schedule[r] as number[], rng: ops.fork(r) })]),
  ) as Record<Role, Pool>;
  // 本方案：多技能员工，孪生按任务派活——自提异常、出口协助交给门店作业员，拆箱交给站台拣货员
  const taskPool: Record<Role, Pool> = gen1 ? crew : { ...crew, handoff: crew.stocker, host: crew.stocker, decanter: crew.porter };
  const robot = (kind: AgentKind, name: string, count: number, at: Pt, speed: number) => (count > 0 ? new Pool(sim, router, trace, { kind, name, home: at, speed, count, reliability: s.reliability, rng: ops.fork(kind) }) : undefined);
  const charger = (i: number) => poi.chargers[i % Math.max(1, poi.chargers.length)] ?? poi.service;
  const amr = robot('amr', '补货机器人', s.robots.amr, charger(0), 1.1);
  const scanner = robot('scanner', '盘点机器人', s.robots.scanners, charger(1), 0.6);
  const scrubbers = robot('scrubber', '洗地机器人', s.robots.scrubbers, charger(2), 0.7);
  const carts = robot('cart', '送框小车', s.pickup.carts, poi.consolidation ?? poi.service, s.pickup.cartSpeed);
  const loaders = robot('loader', '装柜机器人', s.robots.lockerLoaders, poi.consolidation ?? poi.service, 1.2);
  const pallet = robot('pallet', '自动托盘车', s.robots.palletMovers, charger(3), 1.0);
  const kiosks = new Pool(sim, router, trace, { kind: 'host', name: '自助结账机', home: poi.service, speed: 1, count: s.checkout.selfCheckouts, rng: ops.fork('kiosk'), silent: true });
  const gates = s.checkout.gates > 0 ? new Pool(sim, router, trace, { kind: 'host', name: '免排队通道', home: poi.service, speed: 1, count: s.checkout.gates, rng: ops.fork('gate'), silent: true }) : undefined;

  const shelf = new Shelf(sim, catalog, s, layout, trace, ops.fork('shelf'), { stocker: taskPool.stocker, ...(amr ? { amr } : {}), ...(scanner ? { scanner } : {}) });
  const mfc = !gen1 && s.mfc.bots > 0 ? new Mfc(sim, s, layout, trace, ops.fork('mfc'), taskPool.porter, taskPool.decanter) : undefined;
  const online = new Online(sim, s, layout, router, trace, ops.fork('online'), shelf, { stocker: taskPool.stocker, picker: taskPool.picker, dispenser: taskPool.dispenser, freshPicker: taskPool.freshPicker, handoff: taskPool.handoff, ...(carts ? { carts } : {}), ...(loaders ? { loaders } : {}) }, mfc, orders);
  const instore = new Instore(sim, s, layout, router, trace, ops.fork('instore'), shelf, { cashier: taskPool.cashier, host: taskPool.host, kiosks, ...(gates ? { gates } : {}) }, shoppers);
  const inbound = new Inbound(sim, s, layout, trace, { receiver: crew.receiver, ...(pallet ? { pallet } : {}) }, mfc, plan);

  // 洗地机器人：夜里整场清洁，白天每两小时局部清洁一次
  if (scrubbers) {
    const route = cleaningRoute(layout);
    const clean = (sec: number, label: string, part: number) =>
      scrubbers.submit({
        priority: 50,
        label,
        steps: () => [...route.filter((_, i) => i % scrubbers.size === part % scrubbers.size).map((p) => ({ kind: 'walk' as const, to: p, act: label })), { kind: 'work' as const, sec, act: label }, { kind: 'walk' as const, to: charger(2), act: '回去充电' }],
      });
    for (const t of [22.3 * H, 1 * H, 3.5 * H]) for (let k = 0; k < scrubbers.size; k++) sim.at(t, () => clean(1800, '夜间洗地', k));
    for (let t = 9 * H; t < 21 * H; t += 2 * H) sim.at(t, () => clean(300, '局部清洁', 0));
  }
  // 机器人值班员：每小时巡一次站台和充电区
  if (!gen1) {
    for (let t = 6 * H; t < 22 * H; t += H) {
      sim.at(t, () =>
        crew.robotTech.submit({
          priority: 100,
          label: '巡检',
          steps: () => [
            { kind: 'walk', to: poi.mfcPorts[1] ?? poi.service, act: '巡检站台' },
            { kind: 'work', sec: 240, act: '巡检' },
            { kind: 'walk', to: charger(0), act: '巡检充电区' },
            { kind: 'work', sec: 180, act: '巡检' },
          ],
        }),
      );
    }
  }

  sim.run(24 * H);
  const end = 24 * H;
  for (const r of ROLES) crew[r].close(end);
  online.close(end);
  shelf.close();

  // —— 汇总 ——
  const out = online.outcomes;
  const pickups = out.filter((o) => o.mode !== 'delivery');
  const waits = pickups.map((o) => o.waitMin);
  const items = out.reduce((a, o) => a + o.items, 0);
  const picked = out.reduce((a, o) => a + o.picked, 0);
  const sub = out.reduce((a, o) => a + o.substituted, 0);
  const short = out.reduce((a, o) => a + o.short, 0);
  const paid = paidHours(s, plan);
  const productive = Object.fromEntries(ROLES.map((r) => [r, crew[r].productiveSec / 3600])) as Record<Role, number>;
  // 站台拣货员、拆箱员固定在站台：有效工时 = 站台实际拣货 / 拆箱的时间
  if (mfc) {
    productive.porter = ((s.mfc.portPicker === 'arm' ? mfc.stats.armAssists * 15 : mfc.stats.portBusySec) + mfc.stats.decantBusySec) / 3600;
    productive.decanter = 0;
  }
  const scheduledSim = Object.fromEntries(ROLES.map((r) => [r, crew[r].onDutySec / 3600])) as Record<Role, number>;
  // 线上作业的工时：上一代是拣货员 + 交付员；本方案是站台（含拆箱）+ 生鲜拣选，加上门店作业员花在自提异常、年龄核验、配送装车上的时间
  const handoffSec = online.handoffSec;
  const onlineRoles: Role[] = gen1 ? ['picker', 'dispenser'] : ['porter', 'freshPicker'];
  const onlineProductive = onlineRoles.reduce((a, r) => a + productive[r], 0) + (gen1 ? 0 : handoffSec / 3600);
  const onlinePaid = onlineRoles.reduce((a, r) => a + paid.byRole[r], 0) + (gen1 ? 0 : (handoffSec / 3600) * (1 + s.staffing.shiftOverhead) / s.staffing.targetUtil);
  const simRoles = ROLES.filter((r) => scheduledSim[r] > 0);
  const util = simRoles.reduce((a, r) => a + productive[r], 0) / Math.max(1, simRoles.reduce((a, r) => a + scheduledSim[r], 0));
  const laborCost = ROLES.reduce((a, r) => a + paid.byRole[r] * (r === 'robotTech' ? TECH_WAGE : WAGE), 0) + (paid.night + paid.fixed) * WAGE;

  // 机器人
  const fleets: [string, Pool | undefined][] = [
    ['amr', amr],
    ['scanner', scanner],
    ['scrubber', scrubbers],
    ['cart', carts],
    ['loader', loaders],
    ['pallet', pallet],
  ];
  const robotCounts: Record<string, number> = { mfcBot: s.mfc.bots };
  const robotBusy: Record<string, number> = { mfcBot: mfc ? mfc.stats.botBusySec / 3600 : 0 };
  let failures = mfc ? mfc.stats.failures : 0;
  let downtime = mfc ? mfc.stats.downtimeSec : 0;
  const robotKwByHour = new Array<number>(24).fill(0);
  const robotsBusyByHour = new Array<number>(24).fill(0);
  for (const [k, p] of fleets) {
    robotCounts[k] = p?.size ?? 0;
    robotBusy[k] = p ? p.productiveSec / 3600 : 0;
    if (!p) continue;
    failures += p.failures;
    downtime += p.downtime;
    for (let h = 0; h < 24; h++) {
      const busy = (p.busyByHour[h] as number) / 3600;
      robotsBusyByHour[h] = (robotsBusyByHour[h] as number) + busy;
      robotKwByHour[h] = (robotKwByHour[h] as number) + busy * (ROBOT_KW[k] ?? 0.2) + (p.size - busy) * (ROBOT_KW[k] ?? 0.2) * 0.15;
    }
  }
  if (mfc) {
    const busyH = mfc.stats.botBusySec / 3600;
    // 货格机器人：按营业前后 16 小时平均分摊，外加货格仓冷藏区的保温
    for (let h = 5; h < 21; h++) {
      robotKwByHour[h] = (robotKwByHour[h] as number) + (busyH / 16) * (ROBOT_KW.mfcBot as number) + (s.mfc.bots - busyH / 16) * (ROBOT_KW.mfcBot as number) * 0.15;
      robotsBusyByHour[h] = (robotsBusyByHour[h] as number) + busyH / 16;
    }
  }
  const robotTotal = Object.values(robotCounts).reduce((a, b) => a + b, 0);

  // 生鲜损耗（按当天生鲜需求的件数）
  const perishUnits: Partial<Record<Category, number>> = {};
  for (const sh of shoppers) for (const k of sh.items) perishUnits[k.category] = (perishUnits[k.category] ?? 0) + 1;
  for (const o of orders) for (const l of o.lines) perishUnits[l.sku.category] = (perishUnits[l.sku.category] ?? 0) + l.qty;
  const fresh = freshWaste(s, perishUnits, rng.fork('fresh'));
  const shoppersByHour = new Array<number>(24).fill(0);
  for (const sh of shoppers) {
    const h = Math.floor(sh.arrival / H);
    shoppersByHour[h] = (shoppersByHour[h] as number) + 1;
  }
  const energy = energyModel(s, shoppersByHour, robotKwByHour);

  const ist = instore.stats;
  const allCheckout = [...ist.waits.staffed, ...ist.waits.self, ...ist.waits.gate];
  const lostMargin = shelf.lostSales * 0.27 + short * 4.5 * 0.27;
  const money = { labor: laborCost, energy: energy.costPerDay, freshLoss: fresh.wasteValue + fresh.markdownCost, lostMargin, total: 0 };
  money.total = money.labor + money.energy + money.freshLoss + money.lostMargin;
  const staffOnDuty = new Array<number>(24).fill(0);
  for (const r of ROLES) for (let h = 0; h < 24; h++) staffOnDuty[h] = (staffOnDuty[h] as number) + (crew[r].onDutyByHour[h] as number) / 3600;
  const byMode: Record<string, { n: number; waitAvg: number }> = {};
  for (const o of out) {
    const m = (byMode[o.mode] ??= { n: 0, waitAvg: 0 });
    m.n++;
    m.waitAvg += o.waitMin;
  }
  for (const m of Object.values(byMode)) m.waitAvg = m.n ? m.waitAvg / m.n : 0;
  const byKind: Record<string, { n: number; waitAvg: number; waitP95: number }> = {};
  for (const k of ['staffed', 'self', 'gate'] as const) byKind[k] = { n: ist.counts[k], waitAvg: mean(ist.waits[k]), waitP95: quantile(ist.waits[k], 0.95) };

  const floorItems = online.stats.walks.items;
  const floorPickHours = gen1 ? productive.picker : productive.freshPicker;
  return {
    name: s.name,
    generation: s.generation,
    seed: s.seed,
    demand: { orders: orders.length, items: orders.reduce((a, o) => a + o.items, 0), lines: orders.reduce((a, o) => a + o.lines.length, 0), shoppers: shoppers.length },
    online: {
      done: out.filter((o) => !Number.isNaN(o.doneAt)).length,
      onTimePct: (out.filter((o) => o.onTime).length / Math.max(1, out.length)) * 100,
      waitAvg: mean(waits),
      waitP80: quantile(waits, 0.8),
      waitP95: quantile(waits, 0.95),
      waitOver5Pct: (waits.filter((w) => w > 5).length / Math.max(1, waits.length)) * 100,
      dwellAvg: mean(pickups.map((o) => o.dwellMin)),
      fillPct: items > 0 ? ((picked + sub) / items) * 100 : 100,
      substitutionPct: items > 0 ? (sub / items) * 100 : 0,
      shortItems: short,
      totesPerOrder: mean(out.map((o) => o.totes)),
      floorItemsPerHour: floorPickHours > 0 ? floorItems / floorPickHours : 0,
      walkKm: online.stats.walks.meters / 1000,
      laborMinPerOrder: (onlineProductive * 60) / Math.max(1, orders.length),
      laborCostPerOrder: (onlinePaid * WAGE) / Math.max(1, orders.length),
      mfcLines: mfc?.stats.lines ?? 0,
      mfcBotUtil: mfc ? mfc.stats.botBusySec / (s.mfc.bots * 16 * H) : 0,
      mfcPortUtil: mfc ? mfc.stats.portBusySec / Math.max(1, scheduledSim.porter * 3600) : 0,
      mfcFailures: mfc?.stats.failures ?? 0,
      lockerPeak: online.stats.lockerPeak,
      lockerQueuedMax: online.stats.lockerQueuedMax,
      exceptions: online.stats.exceptions,
      fallbackItems: online.stats.fallback.items,
      byMode,
    },
    instore: { shoppers: ist.shoppers, sales: ist.sales, lostSales: shelf.lostSales, waitAvg: mean(allCheckout), waitP95: quantile(allCheckout, 0.95), byKind, interventions: ist.interventions },
    shelf: {
      outOfShelfPct: shelf.outOfShelfRate() * 100,
      outages: shelf.outages,
      restocks: shelf.restocks,
      failedTrips: shelf.failedTrips,
      recoverAvgMin: mean(shelf.recoverSec) / 60,
      lostItems: shelf.lostItems,
      lostSales: shelf.lostSales,
    },
    inbound: { trucks: inbound.stats.trucks, pallets: inbound.stats.pallets, cases: inbound.stats.cases, dockAvgMin: mean(inbound.stats.dockMin), decantCases: inbound.stats.decantCases },
    labor: {
      scheduled: paid.byRole,
      productive,
      night: paid.night,
      fixed: paid.fixed,
      paidTotal: paid.total,
      utilization: util,
      costPerDay: laborCost,
      fte: paid.total / 8,
    },
    robots: { counts: robotCounts, busyHours: robotBusy, failures, downtimeMin: downtime / 60, total: robotTotal },
    fresh,
    energy,
    money,
    hourly: {
      ordersDone: online.stats.doneByHour,
      pickupWait: online.stats.waitByHour.map((w, h) => w / Math.max(1, online.stats.doneByHour[h] as number)),
      checkoutWait: ist.waitByHour.map((w, h) => w / Math.max(1, ist.countByHour[h] as number)),
      staffOnDuty,
      robotsBusy: robotsBusyByHour,
      shelfOut: shelf.outSeries,
    },
    events: sim.executed,
    orders: out,
    ...(s.trace ? { trace: { agents: trace.agents, events: trace.events } } : {}),
  };
}

/** 洗地路线：卖场的几条主通道 */
function cleaningRoute(layout: Layout): Pt[] {
  const pts: Pt[] = [];
  for (let x = 18; x <= 74; x += 8) pts.push({ x, y: 46 }, { x, y: layout.generation === 'gen1' ? 20 : 24 });
  return pts.filter((p) => {
    const c = layout.cells[p.y * layout.width + p.x];
    return c === 1;
  });
}

export { CATEGORIES, CATEGORY };
