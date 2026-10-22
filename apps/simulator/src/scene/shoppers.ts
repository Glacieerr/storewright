import { createRng } from '@storewright/domain';
import type { LotLayout } from './lot';
import { carColor, carType, type VehicleType } from './vehicleTypes';

/**
 * 到店购物顾客和员工的私家车：决定停车场在一天中各时段有多满。
 * 只用于画面（线上订单的取货车辆来自仿真结果），按种子生成，可复现。
 */

export interface Stay {
  spot: number;
  arrive: number;
  leave: number;
  type: VehicleType;
  color: string;
  fromLeft: boolean;
  toLeft: boolean;
  /** 员工的车（整班停放，不进店购物） */
  staff: boolean;
}

/** 各小时普通车位的占用比例（假设：午间和傍晚两个高峰） */
const OCCUPANCY = [0, 0, 0, 0, 0, 0, 0.04, 0.12, 0.2, 0.28, 0.35, 0.45, 0.55, 0.5, 0.45, 0.5, 0.6, 0.68, 0.62, 0.45, 0.3, 0.18, 0.06, 0];

export interface ShopperInput {
  lot: LotLayout;
  seed: number;
  /** 取货车辆溢出时预留的普通车位数（离门口最近的几个） */
  reserve: number;
  /** 客流倍数（订单高峰时到店购物的人也更多） */
  busyness: number;
  /** 不给购物顾客使用的车位（例如汽车快修中心的等候车位） */
  excluded?: ReadonlySet<number>;
  /** 营业时间（分钟），占用率曲线随之平移伸缩；默认 7:00–22:00 */
  hours?: { openMin: number; closeMin: number };
}

export function generateStays({ lot, seed, reserve, busyness, excluded, hours }: ShopperInput): Stay[][] {
  // 营业时间（小时）
  const open = (hours?.openMin ?? 420) / 60;
  const close = (hours?.closeMin ?? 1320) / 60;
  // 占用率曲线按 7:00–22:00 设计，映射到实际营业时间
  const occupancy = (t: number) => {
    const h = t / 3600;
    if (h < open - 0.5 || h > close) return 0;
    const src = 7 + (h - open) * (15 / Math.max(1, close - open));
    return OCCUPANCY[Math.min(23, Math.max(6, Math.floor(src)))] ?? 0;
  };
  const rng = createRng(seed * 31337 + 5);
  const out: Stay[][] = lot.spots.map(() => []);
  const first = lot.pickupCount + reserve;
  const general = lot.spots.length - first;
  // 离门口最远的约 8% 车位留给员工（早班 / 晚班整段停放）
  const staffFrom = lot.spots.length - Math.max(2, Math.round(general * 0.08));
  for (let i = first; i < lot.spots.length; i++) {
    if (excluded?.has(i)) continue;
    const list = out[i] as Stay[];
    const staff = i >= staffFrom;
    const mk = (arrive: number, leave: number): Stay => ({ spot: i, arrive, leave, type: carType(rng.next()), color: carColor(rng.next()), fromLeft: rng.chance(0.5), toLeft: rng.chance(0.5), staff });
    if (staff) {
      const mid = (open + close) / 2;
      list.push(mk((open - 1) * 3600 + rng.uniform(-900, 900), (mid + 0.1) * 3600 + rng.uniform(0, 900)));
      if (rng.chance(0.8)) list.push(mk((mid + 0.2) * 3600 + rng.uniform(0, 1200), (close + 0.6) * 3600 + rng.uniform(0, 900)));
      continue;
    }
    // 交替更新过程：停留 18–55 分钟，空闲间隔按目标占用率反推
    let t = (open - 1) * 3600 + rng.uniform(0, 3600);
    while (t < (close + 0.5) * 3600) {
      const p = Math.min(0.95, occupancy(t) * busyness);
      const stay = rng.uniform(18, 55) * 60;
      if (p <= 0.01) {
        t += 1800;
        continue;
      }
      const gap = rng.exponential(1 / ((stay * (1 - p)) / p));
      const arrive = t + gap;
      if (arrive > close * 3600) break;
      list.push(mk(arrive, arrive + stay));
      t = arrive + stay + 90;
    }
  }
  return out;
}

/** 在时间有序的停留列表中二分查找时刻 t 附近（含进出场动画余量 pad）的那一段 */
export function stayAt(list: readonly Stay[], t: number, pad: number): Stay | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid] as Stay;
    if (t < s.arrive - pad) hi = mid - 1;
    else if (t > s.leave + pad) lo = mid + 1;
    else return s;
  }
  return undefined;
}
