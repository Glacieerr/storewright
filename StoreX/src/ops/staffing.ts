import type { Rng } from '../core/rng';
import { H } from '../core/sim';
import { CATEGORY } from '../world/catalog';
import { ROLES, type Role, type Scenario } from '../world/config';
import type { Order, Shopper } from '../world/demand';

/**
 * 排班：两代流程用同一个方法。按预测的每小时工作量（分钟）和每个岗位的工时标准，
 * 除以目标利用率得到需要的人数，再加最低在岗人数。预测有误差（本方案的 AI 预测误差更小），
 * 所以排班和实际工作量不完全吻合，事件仿真里会体现出忙闲。
 */
export type Schedule = Record<Role, number[]>;

export interface StaffPlan {
  schedule: Schedule;
  /** 夜班上架工时（不进事件仿真） */
  nightHours: number;
  /** 地面需要补的箱数、拆箱入格的箱数（夜班和白天的上架、拆箱都按这个算） */
  floorCases: number;
  decantCases: number;
}

const zero = (): number[] => new Array<number>(24).fill(0);

export function planStaff(s: Scenario, orders: readonly Order[], shoppers: readonly Shopper[], rng: Rng): StaffPlan {
  const err = () => Math.max(0.3, 1 + rng.normal(0, s.staffing.forecastError));
  const work: Record<Role, number[]> = Object.fromEntries(ROLES.map((r) => [r, zero()])) as Record<Role, number[]>;
  const add = (role: Role, hour: number, minutes: number) => {
    const h = Math.max(0, Math.min(23, Math.floor(hour)));
    (work[role] as number[])[h] = ((work[role] as number[])[h] as number) + minutes;
  };
  const gen1 = s.generation === 'gen1';
  // 线上订单：按时段汇总件数，拣货摊到时段前 1–3 小时
  const spread = [0.45, 0.35, 0.2];
  let mfcItems = 0;
  let floorOnlineItems = 0;
  for (const o of orders) {
    const dueH = dueTime(o) / H;
    let mfcLines = 0;
    let mfcIt = 0;
    let freshIt = 0;
    for (const l of o.lines) {
      if (!gen1 && l.sku.inMfc) {
        mfcLines++;
        mfcIt += l.qty;
      } else freshIt += l.qty;
    }
    mfcItems += mfcIt;
    floorOnlineItems += freshIt;
    spread.forEach((w, k) => {
      const h = dueH - 1 - k;
      if (gen1) add('picker', h, ((o.items * 60) / 72) * w);
      else {
        add('porter', h, ((mfcLines * (s.mfc.humanLineSec + s.mfc.humanItemSec * 1.5)) / 60) * w * (s.mfc.portPicker === 'arm' ? 0.35 : 1));
        add('freshPicker', h, ((freshIt * 60) / 95) * w);
      }
    });
    const arriveH = o.delivery ? deliveryHour(o.slot) : o.arrival / H;
    if (gen1) add('dispenser', arriveH, o.delivery ? s.online.deliveryLoadSec / 60 : 4.3);
    else add('handoff', arriveH, o.delivery ? s.online.deliveryLoadSec / 60 : 0.05 * 5 + (o.ageRestricted ? 1.5 : 0));
  }
  // 到店顾客：结账、补货
  let floorShopperItems = 0;
  for (const sh of shoppers) {
    const h = sh.arrival / H + 0.3;
    floorShopperItems += sh.items.length;
    const gate = !gen1 && sh.frictionless && s.checkout.gates > 0;
    const staffed = gen1 ? sh.items.length > 15 || sh.choice > 0.55 : !gate && (sh.items.length > 20 ? sh.choice > 0.4 : sh.choice > 0.8);
    if (staffed) add('cashier', h, (s.checkout.staffedBaseSec + s.checkout.staffedItemSec * sh.items.length + s.checkout.payTimeSec) / 60);
  }
  // 白天补货：每个商品卖到补货点就要补一趟（开门时约九成满，卖掉 55% 的容量后第一次补，之后每卖掉 60% 补一次）；
  // 白天没补回来的量由夜班补满。员工自己去后仓取箱每趟多约 130 秒；有补货机器人送箱时只剩放下、开箱的约 25 秒
  const floorBySku = new Map<number, { units: number; cap: number; caseQty: number }>();
  const addFloor = (sku: { id: number; shelfCap: number; caseQty: number }, n: number) => {
    const e = floorBySku.get(sku.id) ?? { units: 0, cap: sku.shelfCap, caseQty: sku.caseQty };
    e.units += n;
    floorBySku.set(sku.id, e);
  };
  for (const sh of shoppers) for (const k of sh.items) addFloor(k, 1);
  for (const o of orders) for (const l of o.lines) if (gen1 || !l.sku.inMfc) addFloor(l.sku, l.qty);
  let tripSec = 0;
  let dayUnits = 0;
  let nightCases = 0;
  for (const e of floorBySku.values()) {
    const trips = e.units > 0.55 * e.cap ? 1 + Math.floor((e.units - 0.55 * e.cap) / (0.6 * e.cap)) : 0;
    const refill = Math.min(e.units, trips * 0.6 * e.cap);
    dayUnits += refill;
    tripSec += trips * ((s.robots.amr > 0 ? 25 : 130) + 0.6 * e.cap * s.shelf.stockSecPerUnit);
    nightCases += Math.ceil(Math.max(0, e.units - refill) / e.caseQty);
  }
  const curve = [3, 5, 6, 7, 9, 9, 7, 6, 7, 9, 10, 9, 7, 4, 2];
  const curveSum = curve.reduce((a, b) => a + b, 0);
  curve.forEach((w, i) => add('stocker', 7 + i + 0.5, ((tripSec / 60) * w) / curveSum));
  const floorItems = floorShopperItems + floorOnlineItems;
  // 没有盘点机器人时，巡店查缺货由员工走
  if (s.robots.scanners === 0) for (const t of s.shelf.scanTimes) add('stocker', t / H, s.shelf.scanDurationSec / 60);
  // 收货
  for (const tr of s.inbound.trucks) {
    const min = (tr.pallets * (s.inbound.unloadSecPerPallet * (gen1 ? 1 : 0.25) + s.inbound.putawaySecPerPallet) + tr.cases * s.inbound.checkSecPerCase + (tr.kind === 'dsd' ? s.inbound.dsdCheckSec : 0)) / 60;
    add('receiver', tr.time / H, min);
  }
  // 拆箱入格（本方案）：线上货格仓商品当天卖掉的量，开门前和上午拆完
  const avgCaseQty = 12;
  const decantCases = gen1 ? 0 : Math.ceil(mfcItems / avgCaseQty);
  if (!gen1) for (const h of [6, 7, 8, 9, 13, 14]) add('decanter', h, (decantCases * s.mfc.decantSecPerCase) / 60 / 6);
  // 夜班上架：白天没补回来的量
  const floorCases = Math.ceil(floorItems / avgCaseQty);
  const nightHours = (nightCases * s.inbound.nightSecPerCase) / 3600;
  void dayUnits;

  if (!gen1) {
    for (let h = 0; h < 24; h++) {
      work.porter[h] = (work.porter[h] as number) + (work.decanter[h] as number);
      work.decanter[h] = 0;
      work.stocker[h] = (work.stocker[h] as number) + (work.handoff[h] as number) + (work.host[h] as number);
      work.handoff[h] = 0;
      work.host[h] = 0;
    }
  }
  const schedule = Object.fromEntries(ROLES.map((r) => [r, zero()])) as Schedule;
  const util = s.staffing.targetUtil;
  for (const r of ROLES) {
    for (let h = 0; h < 24; h++) {
      const need = Math.ceil((((work[r] as number[])[h] as number) * err() * s.staffing.planBias) / (60 * util) - 1e-9);
      (schedule[r] as number[])[h] = Math.max(need, minStaff(s, r, h));
    }
  }
  return { schedule, nightHours, floorCases, decantCases };
}

/** 最低在岗人数（营业时间里至少有人） */
function minStaff(s: Scenario, r: Role, h: number): number {
  const gen1 = s.generation === 'gen1';
  const within = (a: number, b: number) => (h >= a && h < b ? 1 : 0);
  switch (r) {
    // 拣货岗位排到最后一个取货时段结束（21 点）：晚了的订单也有人拣完
    case 'picker':
      return gen1 ? within(6, 21) : 0;
    case 'dispenser':
      return gen1 ? within(8, 22) : 0;
    case 'porter':
      return gen1 || s.mfc.bots === 0 ? 0 : within(6, 21);
    case 'decanter':
      return 0;
    case 'freshPicker':
      return gen1 ? 0 : within(6, 21);
    case 'handoff':
      return 0;
    case 'stocker':
      // 本方案的门店作业员同时负责补货、自提异常、出口和自提柜服务：营业时间至少 2 人，中午到傍晚 3 人
      return gen1 ? within(6, 22) : within(6, 22) + within(7, 22) + within(11, 19);
    case 'receiver':
      return within(5, 12);
    case 'cashier':
      return within(7, 22);
    case 'host':
      return gen1 ? within(7, 22) : 0;
    case 'robotTech':
      // 每班一名机器人值班员（早班 5–14 点、晚班 14–23 点），负责货箱卡滞、机器人救援和日常保养
      return gen1 ? 0 : within(5, 23);
  }
}

/** 配送单在哪个发车时刻装车：时段开始前最近的一班（10、13、16、19 点） */
export const DEPARTURES = [10 * H, 13 * H, 16 * H, 19 * H];
export function scheduledDeparture(slot: number): number {
  let best = DEPARTURES[0] as number;
  for (const d of DEPARTURES) if (d <= slot) best = d;
  return best;
}
export function deliveryHour(slot: number): number {
  return scheduledDeparture(slot) / H;
}
/** 订单要备好的时刻：自提单是取货时段开始，配送单是发车时刻（放单、排优先级、算按时率都按这个） */
export function dueTime(o: Order): number {
  return o.delivery ? scheduledDeparture(o.slot) : o.slot;
}

/** 一天的带薪工时：排班人时 × (1 + 班次颗粒度) + 夜班 + 固定岗位 */
export function paidHours(s: Scenario, plan: StaffPlan): { byRole: Record<Role, number>; night: number; fixed: number; total: number } {
  const byRole = Object.fromEntries(ROLES.map((r) => [r, ((plan.schedule[r] as number[]).reduce((a, b) => a + b, 0) * (1 + s.staffing.shiftOverhead))])) as Record<Role, number>;
  const fixed = s.staffing.fixedHours.fresh + s.staffing.fixedHours.service + s.staffing.fixedHours.management;
  const total = ROLES.reduce((a, r) => a + byRole[r], 0) + plan.nightHours + fixed;
  return { byRole, night: plan.nightHours, fixed, total };
}

export { CATEGORY };
