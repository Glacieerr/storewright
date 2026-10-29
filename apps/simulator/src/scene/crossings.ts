import { createRng } from '@storewright/domain';

/**
 * 周边的问题（决策记录 0019）：铁路道口与学校护导。纯函数，按仿真时刻（当天的秒数）确定，可以拖动时间轴。
 * - 火车：5:00–24:00 平均约 12 分钟一趟（8–16 分钟随机），南北方向交替；七成是 4–6 节的通勤列车（16 米/秒），
 *   三成是长货车（11 米/秒）。车头到道口前 25 秒栏杆放下，车尾过去 5 秒后抬起；与仿真里的道口参数一致。
 * - 学校：上学（7:15–8:30）、放学（14:45–15:45）时护导员每 90 秒拦一次车，学生过马路 25 秒。
 */

export interface Train {
  /** 车头到达道口（主路中线）的时刻 */
  t0: number;
  /** +1 向北（+Z），−1 向南 */
  dir: 1 | -1;
  /** 列车长度（米）、车速（米/秒）、每节车厢长 */
  len: number;
  speed: number;
  car: number;
  kind: 'commuter' | 'freight';
}

/** 栏杆提前放下、车过后再抬起的秒数 */
export const GATE_LEAD = 25;
export const GATE_TAIL = 5;

export function trainsFor(seed: number): Train[] {
  const rng = createRng(seed * 4241 + 61);
  const out: Train[] = [];
  let t = 5 * 3600 + rng.uniform(0, 600);
  let dir: 1 | -1 = rng.chance(0.5) ? 1 : -1;
  while (t < 24 * 3600) {
    const freight = rng.chance(0.3);
    const car = freight ? 15.5 : 20;
    const cars = freight ? rng.int(12, 20) : rng.int(4, 6);
    out.push({ t0: t, dir, len: cars * car + (freight ? 22 : 0), speed: freight ? 11 : 16, car, kind: freight ? 'freight' : 'commuter' });
    dir = dir > 0 ? -1 : 1;
    t += rng.uniform(8, 16) * 60;
  }
  return out;
}

/** 道口这时候关着吗（栏杆放下） */
export function railClosed(trains: readonly Train[], t: number): boolean {
  return trains.some((tr) => t >= tr.t0 - GATE_LEAD && t <= tr.t0 + tr.len / tr.speed + GATE_TAIL);
}

/** 这时候在场地里的列车：车头相对道口的位置（沿行驶方向，米） */
export function trainsAt(trains: readonly Train[], t: number, reach: number): Array<{ train: Train; head: number }> {
  const out: Array<{ train: Train; head: number }> = [];
  for (const tr of trains) {
    const head = (t - tr.t0) * tr.speed;
    if (head < -reach || head - tr.len > reach) continue;
    out.push({ train: tr, head });
  }
  return out;
}

/** 学校的上学、放学时段（小时） */
export const SCHOOL_WINDOWS: Array<[number, number]> = [
  [7.25, 8.5],
  [14.75, 15.75],
];

/** 护导员在不在路口（上学、放学时段） */
export function guardOnDuty(t: number): boolean {
  const h = (((t / 3600) % 24) + 24) % 24;
  return SCHOOL_WINDOWS.some(([a, b]) => h >= a && h <= b);
}

/** 护导员这时候在拦车（学生过马路）：值班时每 90 秒拦一次，每次 25 秒 */
export function guardStopping(t: number): boolean {
  return guardOnDuty(t) && ((t % 90) + 90) % 90 < 25;
}
