import type { PolySegment } from '@storewright/sim-engine';
import type { LotLayout } from './lot';
import type { Stay } from './shoppers';

/**
 * 停车场的购物车回收：
 * - 推车购物的顾客（约六成）回到车上后，把购物车推到离车最近的回收栏；
 * - 购物车回收员在营业时间里大约每 25 分钟出去一趟：沿门前消防通道走到侧边环形车道，
 *   再进车道把车多的回收栏清空，把套在一起的一串购物车推回门口（一串最多 20 辆）。
 * 全部按顾客停车记录推算，是时间的纯函数（拖动时间轴也一致）。
 */

export interface Corral {
  x: number;
  z: number;
  d: number;
  aisleZ: number;
}

export interface CartDeposit {
  t: number;
  corral: number;
}

export interface CartPickup {
  t: number;
  corral: number;
  count: number;
}

/** 回收员的轨迹片段：carry 为身后推着的购物车数量（字符串化的数字） */
export interface CartPlan {
  corrals: Corral[];
  deposits: CartDeposit[];
  pickups: CartPickup[];
  segments: PolySegment[];
  /** 门口的购物车存放区 */
  bay: { x: number; z: number };
  shift: [number, number];
}

const WALK = 1.25;
const PUSH = 0.9;
const ROUND = 25 * 60;
const MAX_CHAIN = 20;

function hash(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function planCarts(lot: LotLayout, stays: Stay[][], entrance: { x: number; z: number }, openSec: number, closeSec: number): CartPlan {
  const corrals: Corral[] = lot.corrals.map((c) => ({ x: c.x, z: c.z, d: c.d, aisleZ: c.aisleZ }));
  const bay = { x: entrance.x + 3.2, z: lot.frontZ + 1.2 };
  const shift: [number, number] = [openSec + 30 * 60, closeSec];
  const plan: CartPlan = { corrals, deposits: [], pickups: [], segments: [], bay, shift };
  if (!corrals.length) return plan;

  // 1. 顾客放车：离开前约 1 分钟放进最近的回收栏
  stays.forEach((list, idx) => {
    const spot = lot.spots[idx];
    if (!spot) return;
    let best = 0;
    let bd = Infinity;
    corrals.forEach((c, ci) => {
      const d = Math.hypot(c.x - spot.x, c.z - spot.z);
      if (d < bd) {
        bd = d;
        best = ci;
      }
    });
    list.forEach((s, k) => {
      if (s.staff || hash(idx * 131 + k) % 100 >= 60) return;
      const t = s.leave - 60;
      if (t > s.arrive) plan.deposits.push({ t, corral: best });
    });
  });
  plan.deposits.sort((a, b) => a.t - b.t);

  // 2. 回收员巡回：按回收栏里的数量决定去哪几个
  const counts = corrals.map(() => 0);
  let di = 0;
  const advanceTo = (t: number) => {
    while (di < plan.deposits.length && (plan.deposits[di] as CartDeposit).t <= t) {
      const c = (plan.deposits[di++] as CartDeposit).corral;
      counts[c] = (counts[c] ?? 0) + 1;
    }
  };
  // 门口 → 消防通道 → 环形车道 → 车道 → 回收栏口
  const sideX = (x: number) => (Math.abs(x - lot.perimeterX[0]) < Math.abs(x - lot.perimeterX[1]) ? lot.perimeterX[0] : lot.perimeterX[1]);
  const route = (from: { x: number; z: number }, c: Corral): Array<{ x: number; z: number }> => {
    const px = sideX(c.x);
    return [
      { x: from.x, z: from.z },
      { x: from.x, z: lot.fireLaneZ },
      { x: px, z: lot.fireLaneZ },
      { x: px, z: c.aisleZ },
      { x: c.x, z: c.aisleZ },
      { x: c.x, z: c.z + c.d / 2 - 0.6 },
    ];
  };
  const len = (pts: Array<{ x: number; z: number }>) => pts.reduce((n, p, i) => (i ? n + Math.hypot(p.x - (pts[i - 1] as { x: number }).x, p.z - (pts[i - 1] as { z: number }).z) : 0), 0);
  const seg = (t0: number, pts: Array<{ x: number; z: number }>, speed: number, chain: number, activity: string): number => {
    const d = len(pts);
    const t1 = t0 + Math.max(1, d / speed);
    plan.segments.push({ t0, t1, pts: pts.map((p) => ({ x: p.x, z: p.z, y: 0 })), activity, carry: String(chain) });
    return t1;
  };

  let t = shift[0];
  while (t < shift[1]) {
    advanceTo(t);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 4) {
      t += ROUND;
      continue;
    }
    // 先去车多的；同样多时先去近的
    const order = corrals
      .map((c, ci) => ({ ci, n: counts[ci] as number, d: Math.hypot(c.x - bay.x, c.z - bay.z) }))
      .filter((o) => o.n >= 2)
      .sort((a, b) => b.n - a.n || a.d - b.d);
    if (!order.length) {
      t += ROUND;
      continue;
    }
    let chain = 0;
    let at = { x: bay.x, z: bay.z };
    let now = t;
    for (const o of order) {
      if (chain >= MAX_CHAIN) break;
      const c = corrals[o.ci] as Corral;
      const pts = chain === 0 ? route(at, c) : [at, { x: at.x, z: c.aisleZ }, { x: c.x, z: c.aisleZ }, { x: c.x, z: c.z + c.d / 2 - 0.6 }];
      now = seg(now, pts, chain ? PUSH : WALK, chain, chain ? '推着购物车去下一个回收栏' : '走去购物车回收栏');
      advanceTo(now);
      const take = Math.min(counts[o.ci] as number, MAX_CHAIN - chain);
      if (take <= 0) continue;
      const stand = { x: c.x, z: c.z + c.d / 2 - 0.6 };
      now = seg(now, [stand], 1, chain, `收拢 ${take} 辆购物车`) + 6 + take * 1.5;
      (plan.segments[plan.segments.length - 1] as PolySegment).t1 = now;
      counts[o.ci] = (counts[o.ci] as number) - take;
      chain += take;
      plan.pickups.push({ t: now, corral: o.ci, count: take });
      // 退出回收栏回到车道
      now = seg(now, [stand, { x: c.x, z: c.aisleZ }], PUSH, chain, '把购物车推出回收栏');
      at = { x: c.x, z: c.aisleZ };
    }
    // 推回门口
    const px = sideX(at.x);
    now = seg(now, [at, { x: px, z: at.z }, { x: px, z: lot.fireLaneZ }, { x: bay.x, z: lot.fireLaneZ }, { x: bay.x, z: bay.z }], PUSH, chain, `把 ${chain} 辆购物车推回门口`);
    now = seg(now, [{ x: bay.x, z: bay.z }], 1, 0, '把购物车放回门口');
    (plan.segments[plan.segments.length - 1] as PolySegment).t1 = now + 20;
    t = Math.max(t + ROUND, now + 5 * 60);
  }
  return plan;
}

/** 回收栏在时刻 t 里的购物车数量 */
export function corralCounts(plan: CartPlan, t: number): number[] {
  const n = plan.corrals.map(() => 0);
  for (const d of plan.deposits) {
    if (d.t > t) break;
    n[d.corral] = (n[d.corral] ?? 0) + 1;
  }
  for (const p of plan.pickups) if (p.t <= t) n[p.corral] = Math.max(0, (n[p.corral] ?? 0) - p.count);
  return n;
}
