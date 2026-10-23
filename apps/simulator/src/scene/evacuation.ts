import type { Timeline } from '../sim/protocol';
import { roundCorners, TimedPath, type LotLayout, type Pt, type RoadAccess } from './lot';

/**
 * 火警疏散的画面：警报响起时，店内的人从当前位置走到停车场靠路一侧的集合点，
 * 警报解除后走回原来的工作位置。只改变画面上的位置，作业暂停与顺延由仿真引擎计算。
 */

export interface Window {
  start: number;
  end: number;
}

const WALK = 1.4;
/** 解除后走回原位最多用多久（仿真秒） */
const RETURN_PAD = 600;

export function activeFire(tl: Timeline | undefined, t: number): Window | undefined {
  for (const d of tl?.incidents.disruptions ?? []) if (d.kind === 'FIRE_ALARM' && t >= d.start && t < d.end + RETURN_PAD) return d;
  return undefined;
}

export function activeDisruption(tl: Timeline | undefined, t: number, kind: string): Window | undefined {
  for (const d of tl?.incidents.disruptions ?? []) if (d.kind === kind && t >= d.start && t < d.end) return d;
  return undefined;
}

/** 集合点：停车场最外侧车道附近，每人一个位置，排成方阵 */
export function assemblySpot(slot: number, lot: LotLayout): Pt {
  const perRow = 24;
  const cx = (lot.minX + lot.maxX) / 2;
  return { x: cx - (perRow / 2) * 1.2 + (slot % perRow) * 1.2, z: lot.edgeZ + 2.5 + Math.floor(slot / perRow) * 1.2 };
}

interface P {
  x: number;
  y: number;
  z: number;
  heading: number;
  moving: boolean;
}

/**
 * 按疏散改写人物位置。poseAt(t) 返回此人按正常作业在时刻 t 的位置。
 * 返回 false 表示不在疏散过程中（保持原位置）。
 */
export function evacuate(out: P, slot: number, t: number, fire: Window, poseAt: (tt: number) => { x: number; y: number; z: number } | undefined, lot: LotLayout): boolean {
  const spot = assemblySpot(slot, lot);
  const p0 = poseAt(fire.start);
  if (!p0) return false;
  const walkOut = Math.hypot(spot.x - p0.x, spot.z - p0.z) / WALK;
  if (t < fire.start) return false;
  if (t < fire.start + walkOut) {
    const k = (t - fire.start) / walkOut;
    out.x = p0.x + (spot.x - p0.x) * k;
    out.y = p0.y * (1 - Math.min(1, k * 3));
    out.z = p0.z + (spot.z - p0.z) * k;
    out.heading = Math.atan2(spot.x - p0.x, spot.z - p0.z);
    out.moving = true;
    return true;
  }
  if (t < fire.end) {
    out.x = spot.x;
    out.y = 0;
    out.z = spot.z;
    // 面向门店
    out.heading = 0;
    out.moving = false;
    return true;
  }
  const p1 = poseAt(t);
  if (!p1) return false;
  const walkBack = Math.hypot(spot.x - p1.x, spot.z - p1.z) / WALK;
  if (t < fire.end + walkBack) {
    const k = (t - fire.end) / walkBack;
    out.x = spot.x + (p1.x - spot.x) * k;
    out.y = p1.y * Math.max(0, k * 3 - 2);
    out.z = spot.z + (p1.z - spot.z) * k;
    out.heading = Math.atan2(p1.x - spot.x, p1.z - spot.z);
    out.moving = true;
    return true;
  }
  return false;
}

/** 消防车、警车的动线：沿主路驶入 → 环形车道 → 门前消防车道停靠；离开时继续沿消防车道从另一侧驶出 */
export function emergencyPaths(lot: LotLayout, road: RoadAccess, stopX: number, fromLeft: boolean): { entry: TimedPath; leave: TimedPath } {
  const [left, right] = lot.perimeterX;
  const px = fromLeft ? left : right;
  const other = fromLeft ? right : left;
  const lane = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
  const fire = lot.fireLaneZ;
  const speed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? 16 : 7);
  const entry = new TimedPath(
    roundCorners(
      [
        { x: startX, z: lane },
        { x: px, z: lane },
        { x: px, z: lot.edgeZ },
        { x: px, z: fire },
        { x: stopX, z: fire },
      ],
      4,
    ),
    speed,
    false,
    { v0: 'cap', accel: 3, decel: 4, lat: 2.8, wheelbase: 4.5 },
  );
  const outLane = fromLeft ? road.nearLaneZ : road.farLaneZ;
  const endX = fromLeft ? road.spawnMaxX : road.spawnMinX;
  const leave = new TimedPath(
    roundCorners(
      [
        { x: stopX, z: fire },
        { x: other, z: fire },
        { x: other, z: lot.edgeZ },
        { x: other, z: outLane },
        { x: endX, z: outLane },
      ],
      4,
    ),
    speed,
    false,
    { v1: 'cap', accel: 3, decel: 4, lat: 2.8, wheelbase: 4.5 },
  );
  return { entry, leave };
}
