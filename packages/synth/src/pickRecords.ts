import { createRng, hashString } from '@storewright/domain';

/**
 * 合成拣货记录（决策记录 0021 · 拣货时长预测）。
 *
 * 每个拣货批次由若干「行」组成，每一行的真实用时 =
 *   走动（与上一站的距离 ÷ 步速 × 时段拥挤）+ 找货取货（按商品类型、货架层高）+ 每件扫描放框，
 * 再乘以拣货员的熟练度组和噪声；偶尔被叫去帮忙，这一行多出 1–3 分钟。
 * 模型看得到的：距离、商品类型、层高、件数、时段、熟练度组；看不到的：
 * - 每个货位自己的难度（有的货位就是难找，对数正态，σ = 0.28）；
 * - 被打断（约 2.5% 的行）。
 * 批次的标准工时沿用分批算法的标准值（180 秒 + 每行 18 秒 + 每件 4 秒 + 每条通道 30 秒），作为对照。
 * 全部为假设参数。
 */

export type PickKind = 'SHELF' | 'CHILLED_DOOR' | 'FROZEN_DOOR' | 'PRODUCE' | 'BULKY';
export const PICK_KINDS: readonly PickKind[] = ['SHELF', 'CHILLED_DOOR', 'FROZEN_DOOR', 'PRODUCE', 'BULKY'];
/** 熟练度组：按入职时长分组，不按个人（决策记录 0010 第 9 节） */
export type Tenure = 'NEW' | 'MID' | 'SENIOR';

export interface PickLocationInfo {
  locationId: string;
  kind: PickKind;
  level: number;
  x: number;
  y: number;
  /** 通道序号（路线按通道、再按位置排序） */
  run: number;
  zone: 'AMBIENT' | 'CHILLED' | 'FROZEN';
}

export interface PickLineRecord {
  locationId: string;
  kind: PickKind;
  level: number;
  /** 与上一站（第一行是推车起点）的步行距离（米） */
  distM: number;
  qty: number;
  sec: number;
}

export interface PickWalkRecord {
  id: string;
  day: number;
  hour: number;
  tenure: Tenure;
  zone: 'AMBIENT' | 'CHILLED' | 'FROZEN';
  lines: PickLineRecord[];
  /** 批次开销：领车、贴标签绑定框、回暂存区 */
  overheadSec: number;
  standardSec: number;
  actualSec: number;
  runs: number;
  units: number;
}

/** 每小时客流系数（相对日均，与门店客流仿真一致） */
export const STORE_TRAFFIC = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.7, 0.9, 1, 1.1, 1.3, 1.4, 1.2, 1.1, 1.1, 1.3, 1.6, 1.7, 1.5, 1.2, 0.9, 0.6, 0.3];

/** 分批算法的标准工时（与 algorithms 的 DEFAULT_PICK_STANDARDS 相同） */
export const PICK_STANDARD = { baseSec: 180, perLineSec: 18, perUnitSec: 4, perRunSec: 30 };

const HANDLE_SEC: Record<PickKind, number> = { SHELF: 14, CHILLED_DOOR: 20, FROZEN_DOOR: 24, PRODUCE: 32, BULKY: 30 };
const TENURE_FACTOR: Record<Tenure, number> = { NEW: 1.3, MID: 1.05, SENIOR: 0.92 };
const WALK_SPEED = 0.9;

export interface PickTruth {
  locationFactor: Record<string, number>;
}

export interface PickRecordOptions {
  seed: number;
  days: number;
  walksPerDay?: number;
  /** 推车起点（米） */
  depot?: { x: number; y: number };
  /** 被打断的概率（每行） */
  interruptP?: number;
}

/** 商品的拣货类型：冷藏 / 冷冻要开柜门，称重生鲜要装袋称重，大件要搬 */
export function pickKindOf(item: { tempZone: string; categoryId: string; pricing: string; handling: readonly string[]; weightKg: number }): PickKind {
  if (item.handling.includes('OVERSIZED') || item.handling.includes('TEAM_LIFT') || item.weightKg >= 8) return 'BULKY';
  if (item.tempZone === 'FROZEN') return 'FROZEN_DOOR';
  if (item.tempZone === 'CHILLED') return 'CHILLED_DOOR';
  if (item.pricing === 'WEIGHT' || /produce/i.test(item.categoryId)) return 'PRODUCE';
  return 'SHELF';
}

/** 门店里每个陈列货位的拣货信息（每个货位按它的主商品定类型） */
export function pickLocationsFromModel(
  model: { locations: ReadonlyMap<string, { id: string; x: number; y: number; level: number; runSequence: number }> },
  items: Iterable<{ tempZone: string; categoryId: string; pricing: string; handling: readonly string[]; weightKg: number; locationIds: readonly string[] }>,
): PickLocationInfo[] {
  const out = new Map<string, PickLocationInfo>();
  for (const it of items) {
    const id = it.locationIds[0];
    const loc = id ? model.locations.get(id) : undefined;
    if (!loc || out.has(loc.id)) continue;
    const zone = it.tempZone === 'CHILLED' || it.tempZone === 'FROZEN' ? it.tempZone : 'AMBIENT';
    out.set(loc.id, { locationId: loc.id, kind: pickKindOf(it), level: loc.level, x: loc.x, y: loc.y, run: loc.runSequence, zone });
  }
  return [...out.values()].sort((a, b) => a.locationId.localeCompare(b.locationId));
}

/** 曼哈顿距离：货架通道里只能横竖走 */
export function aisleDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** 拣货路线的近似顺序：按通道、再按通道里的位置（与分批算法的 S 形路线一致的粗略版本） */
export function routeOrder<T extends { run: number; x: number; y: number }>(locs: readonly T[]): T[] {
  return [...locs].sort((a, b) => a.run - b.run || (a.run % 2 === 0 ? a.y - b.y : b.y - a.y) || a.x - b.x);
}

export function standardSec(lines: number, units: number, runs: number): number {
  return PICK_STANDARD.baseSec + lines * PICK_STANDARD.perLineSec + units * PICK_STANDARD.perUnitSec + runs * PICK_STANDARD.perRunSec;
}

export function generatePickRecords(locations: readonly PickLocationInfo[], opts: PickRecordOptions): { walks: PickWalkRecord[]; truth: PickTruth } {
  const rng = createRng(opts.seed);
  const depot = opts.depot ?? { x: 0, y: 0 };
  const interruptP = opts.interruptP ?? 0.025;
  const perDay = opts.walksPerDay ?? 40;
  // 每个货位自己的难度：按编号取独立的随机数，换种子不会让同一个货位的难度乱跳
  const locationFactor: Record<string, number> = {};
  for (const l of locations) {
    const u = createRng(hashString(`${opts.seed}:loc:${l.locationId}`));
    locationFactor[l.locationId] = Math.exp(0.28 * u.normal(0, 1));
  }
  const byZone: Record<PickLocationInfo['zone'], PickLocationInfo[]> = { AMBIENT: [], CHILLED: [], FROZEN: [] };
  for (const l of locations) byZone[l.zone].push(l);
  const walks: PickWalkRecord[] = [];
  const tenures: Tenure[] = ['NEW', 'MID', 'MID', 'SENIOR', 'SENIOR'];
  for (let day = 0; day < opts.days; day++) {
    for (let k = 0; k < perDay; k++) {
      const r = rng.next();
      const zone: PickLocationInfo['zone'] = r < 0.6 || !byZone.CHILLED.length ? 'AMBIENT' : r < 0.85 || !byZone.FROZEN.length ? 'CHILLED' : 'FROZEN';
      const pool = byZone[zone].length ? byZone[zone] : locations;
      if (!pool.length) break;
      // 拣货多在 7–20 点，跟着线上订单的时段
      const hour = 7 + Math.floor(rng.next() * 14);
      const tenure = tenures[Math.floor(rng.next() * tenures.length)] as Tenure;
      const n = Math.max(2, Math.min(pool.length, 4 + Math.floor(rng.next() * 15)));
      const chosen = new Map<string, PickLocationInfo>();
      while (chosen.size < n) {
        const l = pool[Math.floor(rng.next() * pool.length)] as PickLocationInfo;
        chosen.set(l.locationId, l);
      }
      const stops = routeOrder([...chosen.values()]);
      const crowd = 1 + 0.25 * ((STORE_TRAFFIC[hour] ?? 1) - 1);
      let prev = depot;
      let units = 0;
      const runs = new Set<number>();
      const lines: PickLineRecord[] = stops.map((l) => {
        const qty = rng.next() < 0.7 ? 1 : rng.next() < 0.7 ? 2 : 3;
        const distM = Math.round(aisleDistance(prev, l) * 10) / 10;
        prev = l;
        units += qty;
        runs.add(l.run);
        const handle = HANDLE_SEC[l.kind] * (locationFactor[l.locationId] ?? 1) + (l.level >= 4 ? 6 : l.level <= 1 ? 3 : 0) + 3.5 * qty;
        let sec = ((distM / WALK_SPEED) * crowd + handle) * TENURE_FACTOR[tenure] * Math.exp(0.18 * rng.normal(0, 1) - 0.0162);
        if (rng.next() < interruptP) sec += 60 + rng.next() * 140;
        return { locationId: l.locationId, kind: l.kind, level: l.level, distM, qty, sec: Math.round(sec * 10) / 10 };
      });
      const back = aisleDistance(prev, depot) / WALK_SPEED;
      const overheadSec = Math.round((90 + back) * Math.exp(0.15 * rng.normal(0, 1)) + 12 * Math.ceil(units / 8));
      const actualSec = Math.round(overheadSec + lines.reduce((a, l) => a + l.sec, 0));
      walks.push({ id: `PW${day}-${k}`, day, hour, tenure, zone, lines, overheadSec, standardSec: standardSec(lines.length, units, runs.size), actualSec, runs: runs.size, units });
    }
  }
  return { walks, truth: { locationFactor } };
}
