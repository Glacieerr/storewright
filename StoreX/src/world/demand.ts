import { H } from '../core/sim';
import type { Rng } from '../core/rng';
import { sampleSku, type Catalog, type Sku, type Temp } from './catalog';

/**
 * 一天的需求：线上订单（自提 / 配送，带取货时段）和到店顾客。
 * 需求只用 demand 子流生成，两代流程在同一个种子下面对的是一模一样的订单和顾客。
 */
export interface OrderLine {
  sku: Sku;
  qty: number;
}

export type PickupMode = 'curbside' | 'locker' | 'drive' | 'delivery';

export interface Order {
  id: number;
  /** 取货时段开始（秒） */
  slot: number;
  delivery: boolean;
  lines: OrderLine[];
  items: number;
  /** 顾客到店时刻（配送单没有） */
  arrival: number;
  /** 顾客发出「我在路上」或位置估算的时刻（不提前告知的等于到店时刻） */
  notice: number;
  /** 本方案里自提顾客的偏好：自提柜还是免下车取货（订单里有年龄限制商品时走有人值守的免下车取货） */
  prefersLocker: boolean;
  ageRestricted: boolean;
}

export interface Shopper {
  id: number;
  arrival: number;
  items: Sku[];
  ageRestricted: boolean;
  /** 本方案：注册了免排队出口（刷脸 / 应用） */
  frictionless: boolean;
  /** 0–1 的随机数，用来选择结账方式（同一个种子下两代流程一致） */
  choice: number;
}

export interface DemandOptions {
  ordersPerDay: number;
  shoppersPerDay: number;
  deliveryShare: number;
  linesPerOrder: number;
  /** 本方案：注册免排队出口的顾客比例 */
  frictionlessShare: number;
  /** 本方案：自提顾客里选自提柜的比例 */
  lockerShare: number;
}

export const DEFAULT_DEMAND: DemandOptions = {
  ordersPerDay: 266,
  shoppersPerDay: 1800,
  deliveryShare: 0.2,
  linesPerOrder: 18.83,
  frictionlessShare: 0.45,
  lockerShare: 0.65,
};

/** 取货时段（8–20 点开始，每段 1 小时）的订单比例：傍晚最多 */
export const SLOT_WEIGHTS: readonly number[] = [3, 4, 5, 6, 6, 6, 7, 8, 10, 11, 11, 9, 6];
export const FIRST_SLOT = 8;
/** 到店顾客的小时曲线（7–21 点，营业到 22 点） */
export const SHOPPER_CURVE: readonly number[] = [3, 5, 6, 7, 9, 9, 7, 6, 7, 9, 10, 9, 7, 4, 2];
export const OPEN = 7 * H;
/** 到店顾客的平均篮子件数 */
export const BASKET_MEAN = 13;
/** 线上订单的平均件数（与上一代 7537 件 / 266 单一致） */
export const ORDER_ITEMS_MEAN = 28.3;
export const CLOSE = 22 * H;

export function generateOrders(cat: Catalog, rng: Rng, opts: DemandOptions): Order[] {
  const orders: Order[] = [];
  for (let i = 0; i < opts.ordersPerDay; i++) {
    const slotIdx = rng.weighted(SLOT_WEIGHTS);
    const delivery = rng.chance(opts.deliveryShare);
    // 配送车 10 点才发第一班：配送单的时段从 10 点开始
    const slot = (FIRST_SLOT + (delivery ? Math.max(2, slotIdx) : slotIdx)) * H;
    const nLines = Math.max(1, Math.round(rng.logNormal(opts.linesPerOrder, 0.55)));
    const bySku = new Map<number, OrderLine>();
    for (let k = 0; k < nLines; k++) {
      const sku = sampleSku(cat, rng);
      const qty = 1 + rng.poisson(0.505);
      const line = bySku.get(sku.id);
      if (line) line.qty += qty;
      else bySku.set(sku.id, { sku, qty });
    }
    const lines = [...bySku.values()];
    const items = lines.reduce((s, l) => s + l.qty, 0);
    // 到店：时段内均匀；10% 早到（最多 20 分钟），5% 迟到（最多 30 分钟）
    let arrival = slot + rng.next() * H;
    const r = rng.next();
    if (r < 0.1) arrival = slot - rng.next() * 20 * 60;
    else if (r < 0.15) arrival = slot + H + rng.next() * 30 * 60;
    // 85% 的顾客会提前告知（应用里点「我在路上」或共享位置），提前 5–15 分钟
    const notice = rng.chance(0.85) ? arrival - (5 + rng.next() * 10) * 60 : arrival;
    const ageRestricted = lines.some((l) => l.sku.ageRestricted);
    orders.push({
      id: i,
      slot,
      delivery,
      lines,
      items,
      arrival: delivery ? 0 : arrival,
      notice: delivery ? 0 : notice,
      prefersLocker: rng.chance(opts.lockerShare),
      ageRestricted,
    });
  }
  orders.sort((a, b) => a.slot - b.slot || a.id - b.id);
  return orders;
}

export function generateShoppers(cat: Catalog, rng: Rng, opts: DemandOptions): Shopper[] {
  const shoppers: Shopper[] = [];
  const total = SHOPPER_CURVE.reduce((s, x) => s + x, 0);
  let id = 0;
  SHOPPER_CURVE.forEach((w, h) => {
    const n = rng.poisson((opts.shoppersPerDay * w) / total);
    for (let k = 0; k < n; k++) {
      const arrival = OPEN + h * H + rng.next() * H;
      const basket = Math.min(80, Math.max(1, Math.round(rng.logNormal(BASKET_MEAN, 0.75))));
      const items: Sku[] = [];
      for (let j = 0; j < basket; j++) items.push(sampleSku(cat, rng));
      shoppers.push({
        id: id++,
        arrival,
        items,
        ageRestricted: items.some((s) => s.ageRestricted),
        frictionless: rng.chance(opts.frictionlessShare),
        choice: rng.next(),
      });
    }
  });
  shoppers.sort((a, b) => a.arrival - b.arrival);
  return shoppers;
}

/** 一张订单按温区分开的件数（拣货、装框、放自提柜都按温区） */
export function itemsByTemp(lines: readonly OrderLine[]): Record<Temp, number> {
  const out: Record<Temp, number> = { ambient: 0, chilled: 0, frozen: 0 };
  for (const l of lines) out[l.sku.temp] += l.qty;
  return out;
}
