import type { FloorBounds } from './layout';
import { roundCorners, TimedPath, type LotLayout, type Pt } from './lot';
import type { SiteLayout } from './site';
import { VEHICLE_LENGTH, type VehicleType } from './vehicles';

/**
 * 送货车辆到卸货区的动线：沿主路 → 右侧后勤通道 → 卸货区，向前驶过卸货门后倒车靠台；
 * 卸完后向前驶出，沿后勤通道回到主路离开。卸货门位置与建筑外壳中的卷帘门一致。
 */

export interface DockPlan {
  entry: TimedPath;
  back: TimedPath;
  leave: TimedPath;
  parked: { x: number; z: number; heading: number };
}

/** doorX：卸货门的 x 坐标（来自后仓布局） */
export function planDock(site: SiteLayout, lot: LotLayout, store: FloorBounds, doorX: number, type: VehicleType, fromLeft: boolean, toLeft: boolean): DockPlan {
  const L = VEHICLE_LENGTH[type];
  const serviceX = lot.maxX + 4;
  const zTurn = store.maxZ + L + 5;
  const parked = { x: doorX, z: store.maxZ + 0.6 + L / 2, heading: 0 };
  const speed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? 11 : 5);
  const inLane = fromLeft ? site.road.nearLaneZ : site.road.farLaneZ;
  const startX = fromLeft ? site.road.spawnMinX : site.road.spawnMaxX;
  const pull = doorX - 8;
  const entry = new TimedPath(
    roundCorners(
      [
        { x: startX, z: inLane },
        { x: serviceX, z: inLane },
        { x: serviceX, z: zTurn },
        { x: pull, z: zTurn },
      ],
      6,
    ),
    speed,
  );
  // 倒车靠台：车尾朝卸货门
  const back = new TimedPath(
    roundCorners(
      [
        { x: pull, z: zTurn },
        { x: doorX, z: zTurn - 0.5 },
        { x: doorX, z: parked.z },
      ],
      6,
    ),
    () => 1.5,
    true,
  );
  const outLane = toLeft ? site.road.farLaneZ : site.road.nearLaneZ;
  const endX = toLeft ? site.road.spawnMinX : site.road.spawnMaxX;
  const leave = new TimedPath(
    roundCorners(
      [
        { x: doorX, z: parked.z },
        { x: doorX, z: zTurn },
        { x: serviceX, z: zTurn },
        { x: serviceX, z: outLane },
        { x: endX, z: outLane },
      ],
      6,
    ),
    speed,
  );
  return { entry, back, leave, parked };
}
