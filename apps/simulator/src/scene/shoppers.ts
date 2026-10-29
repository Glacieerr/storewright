import { createRng } from '@storewright/domain';
import type { LotLayout } from './lot';
import { carColor, carType, rvColor, type VehicleType } from './vehicleTypes';
import { bayCovers, facingSpot, longBays, type LongKind } from './parking';

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
  /** 停车方式：倒车入位、穿过对面空车位停进来（都是车头朝外）；不给时车头朝里（决策记录 0018） */
  mode?: 'back' | 'through';
  /** 房车或带拖车的车：停在哪个长车位（longBays 下标），占用的车位见 bayCovers */
  long?: { kind: LongKind; bay: number };
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

  // 1. 房车和带拖车的车（决策记录 0018）：最远一排两端的长车位，一天几次；还有在停车场过夜的房车
  const bays = longBays(lot);
  const blocked: Array<Array<[number, number]>> = lot.spots.map(() => []);
  const bayIdx = new Set(bays.flatMap((b) => b.spots));
  const lr = createRng(seed * 7121 + 3);
  /** 每个长车位最后一辆长车离开的时刻：后到的长车不和它重叠 */
  const bayFree: number[] = bays.map(() => -Infinity);
  const longStay = (bi: number, kind: LongKind, arrive: number, leave: number) => {
    const bay = bays[bi];
    if (!bay) return;
    bayFree[bi] = Math.max(bayFree[bi] ?? -Infinity, leave);
    const covers = bayCovers(bay, kind);
    const anchor = covers[Math.floor(covers.length / 2)] as number;
    const type: VehicleType = kind === 'rv' ? 'rv' : kind === 'camper' || lr.chance(0.6) ? 'pickup' : 'suv';
    (out[anchor] as Stay[]).push({ spot: anchor, arrive, leave, type, color: kind === 'rv' ? rvColor(lr.next()) : carColor(lr.next()), fromLeft: bay.dir > 0, toLeft: bay.dir < 0, staff: false, long: { kind, bay: bi } });
    for (const i of covers) (blocked[i] as Array<[number, number]>).push([arrive - 150, leave + 150]);
  };
  bays.forEach((bay, bi) => {
    void bay;
    let t = (open + 0.6) * 3600 + lr.uniform(0, 2.5) * 3600;
    while (t < (close - 1.5) * 3600) {
      const u = lr.next();
      const kind: LongKind = u < 0.35 ? 'rv' : u < 0.65 ? 'camper' : u < 0.85 ? 'boat' : 'utility';
      const dur = (kind === 'rv' ? lr.uniform(25, 70) : lr.uniform(15, 45)) * 60;
      longStay(bi, kind, t, t + dur);
      t += dur + lr.uniform(50, 160) * 60;
    }
  });
  // 过夜的房车：一辆前一晚就停着、早上开走；一辆关门前到、停到第二天早上
  if (bays.length) {
    longStay(bays.length - 1, 'rv', (open - 11) * 3600, (open - 0.4) * 3600 + lr.uniform(0, 1800));
    // 关门前到的那辆要等白天最后一辆长车开走（留 10 分钟）
    longStay(0, 'rv', Math.max((close - 0.6) * 3600 + lr.uniform(0, 1800), (bayFree[0] ?? -Infinity) + 600), (open + 23.4) * 3600);
  }

  // 2. 普通车位：越靠近门口越容易停满；离门口最远的约 8% 车位留给员工（早班 / 晚班整段停放，长车位除外）
  const farthest = lot.spots.map((_, i) => i).filter((i) => i >= first && !bayIdx.has(i) && !excluded?.has(i));
  const staffSet = new Set(farthest.slice(farthest.length - Math.max(2, Math.round(general * 0.08))));
  const free = (i: number, a: number, b: number) => !(blocked[i] as Array<[number, number]>).some(([x, y]) => a < y && b > x);
  for (let i = first; i < lot.spots.length; i++) {
    if (excluded?.has(i)) continue;
    const list = out[i] as Stay[];
    const staff = staffSet.has(i);
    const mk = (arrive: number, leave: number): Stay => ({ spot: i, arrive, leave, type: carType(rng.next()), color: carColor(rng.next()), fromLeft: rng.chance(0.5), toLeft: rng.chance(0.5), staff });
    if (staff) {
      const mid = (open + close) / 2;
      const early = mk((open - 1) * 3600 + rng.uniform(-900, 900), (mid + 0.1) * 3600 + rng.uniform(0, 900));
      list.push(early);
      // 晚班的车等早班的车开走（交接班时前后脚）
      if (rng.chance(0.8)) list.push(mk(Math.max((mid + 0.2) * 3600 + rng.uniform(0, 1200), early.leave + 120), (close + 0.6) * 3600 + rng.uniform(0, 900)));
      continue;
    }
    // 靠近门口的车位更抢手：占用率按离门口的远近在 1.3 倍到 0.7 倍之间
    const near = 1.3 - 0.6 * ((i - first) / Math.max(1, general));
    // 交替更新过程：停留 18–55 分钟，空闲间隔按目标占用率反推
    let t = (open - 1) * 3600 + rng.uniform(0, 3600);
    while (t < (close + 0.5) * 3600) {
      const p = Math.min(0.95, occupancy(t) * busyness * near);
      const stay = rng.uniform(18, 55) * 60;
      if (p <= 0.01) {
        t += 1800;
        continue;
      }
      const gap = rng.exponential(1 / ((stay * (1 - p)) / p));
      const arrive = t + gap;
      if (arrive > close * 3600) break;
      // 长车停在这里的时候不能停
      if (!free(i, arrive - 60, arrive + stay + 90)) {
        const end = Math.max(...(blocked[i] as Array<[number, number]>).filter(([x, y]) => arrive - 60 < y && arrive + stay + 90 > x).map(([, y]) => y));
        t = end + 60;
        continue;
      }
      list.push(mk(arrive, arrive + stay));
      t = arrive + stay + 90;
    }
  }
  for (const list of out) list.sort((a, b) => a.arrive - b.arrive);

  // 3. 停车方式：约 12% 倒车入位，约 8% 穿过对面的空车位停进来（到达时对面车位得空着），其余车头朝里
  const mr = createRng(seed * 977 + 41);
  out.forEach((list, i) => {
    if (i < lot.pickupCount) return;
    const face = facingSpot(lot, i);
    for (const s of list) {
      if (s.long) continue;
      const u = mr.next();
      if (u < 0.08 && face >= 0 && !(out[face] as Stay[]).some((o) => o.arrive - 150 < s.arrive + 30 && o.leave + 150 > s.arrive - 90) && free(face, s.arrive - 90, s.arrive + 30)) s.mode = 'through';
      else if (u < 0.2) s.mode = 'back';
    }
  });
  return out;
}

/** 在时间有序的停留列表中二分查找时刻 t 附近（含进出场动画余量 pad）的那一段 */
export function stayAt(list: readonly Stay[], t: number, pad: number | ((s: Stay) => number)): Stay | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid] as Stay;
    const p = typeof pad === 'number' ? pad : pad(s);
    if (t < s.arrive - p) hi = mid - 1;
    else if (t > s.leave + p) lo = mid + 1;
    else return s;
  }
  return undefined;
}
