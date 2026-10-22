import type { ServiceJob } from '@storewright/sim-engine';
import type { FacilityGeometry } from './layout';
import { entryPath, roundCorners, TimedPath, type LotLayout, type Pt, type RoadAccess } from './lot';

/**
 * 汽车快修中心的车辆动线：从道路驶入 → 在等候车位（或消防车道上排队）等待 →
 * 开进工位 → 作业 → 倒出工位 → 驶离。只用于画面，时间完全来自仿真结果。
 */

export interface ServiceVisit {
  job: ServiceJob;
  entry: TimedPath;
  wait: { x: number; z: number; heading: number };
  toBay: TimedPath;
  back: TimedPath;
  drive: TimedPath;
  bay: { x: number; z: number; kind: 'OIL' | 'TIRE' };
}

const SLOW = 3;
const ROAD = 11;
const LOT = 4.2;

export function planServiceVisits(fac: FacilityGeometry, lot: LotLayout, road: RoadAccess, jobs: readonly ServiceJob[]): ServiceVisit[] {
  // 离设施近的一侧出入口
  const facX = (fac.x0 + fac.x1) / 2;
  const side = Math.abs(facX - lot.perimeterX[0]) <= Math.abs(facX - lot.perimeterX[1]) ? 0 : 1;
  const px = lot.perimeterX[side];
  const toLeft = side === 0;
  const laneZ = toLeft ? road.farLaneZ : road.nearLaneZ;
  const endX = toLeft ? road.spawnMinX : road.spawnMaxX;
  const fire = lot.fireLaneZ;
  const outward = fac.side === 'LEFT' ? -1 : 1;
  const outerX = fac.side === 'LEFT' ? fac.x0 : fac.x1;
  const speed = (a: Pt, b: Pt) => (Math.max(a.z, b.z) < lot.edgeZ - 1 ? ROAD : LOT);

  // 按到达顺序分配等候车位；车位满了就在消防车道上从设施外侧向外排队
  const spotFree: number[] = fac.waitingSpots.map(() => -Infinity);
  const laneFree: number[] = [];
  const out: ServiceVisit[] = [];
  for (const job of [...jobs].filter((j) => !j.balked && j.start !== undefined && j.end !== undefined && j.bay !== undefined).sort((a, b) => a.arrive - b.arrive)) {
    const bay = fac.bays[job.bay as number];
    if (!bay) continue;
    const fromLeft = job.id.charCodeAt(job.id.length - 1) % 2 === 0;
    const k = spotFree.findIndex((until) => until + 20 <= job.arrive);
    let entry: TimedPath;
    let wait: ServiceVisit['wait'];
    let toBay: TimedPath;
    if (k >= 0) {
      spotFree[k] = job.start as number;
      const spot = lot.spots[fac.waitingSpots[k] as number];
      if (!spot) continue;
      entry = entryPath(lot, road, spot, fromLeft);
      wait = { x: spot.x, z: spot.z, heading: spot.heading };
      toBay = new TimedPath(
        roundCorners(
          [
            { x: spot.x, z: spot.z },
            { x: spot.x, z: fire },
            { x: bay.x, z: fire },
            { x: bay.x, z: -1 },
            { x: bay.x, z: bay.z },
          ],
          2.5,
        ),
        () => SLOW,
      );
    } else {
      let q = laneFree.findIndex((until) => until + 20 <= job.arrive);
      if (q < 0) {
        q = laneFree.length;
        laneFree.push(0);
      }
      laneFree[q] = job.start as number;
      const slotX = outerX + outward * (4 + q * 6.5);
      const startX = fromLeft ? road.spawnMinX : road.spawnMaxX;
      const inLane = fromLeft ? road.nearLaneZ : road.farLaneZ;
      entry = new TimedPath(
        roundCorners(
          [
            { x: startX, z: inLane },
            { x: px, z: inLane },
            { x: px, z: lot.edgeZ },
            { x: px, z: fire },
            { x: slotX, z: fire },
          ],
          3,
        ),
        speed,
      );
      wait = { x: slotX, z: fire, heading: Math.atan2(-outward, 0) };
      toBay = new TimedPath(
        roundCorners(
          [
            { x: slotX, z: fire },
            { x: bay.x, z: fire },
            { x: bay.x, z: -1 },
            { x: bay.x, z: bay.z },
          ],
          2.5,
        ),
        () => SLOW,
      );
    }
    const dir = Math.sign(px - bay.x) || 1;
    const back = new TimedPath(
      roundCorners(
        [
          { x: bay.x, z: bay.z },
          { x: bay.x, z: fire + 1.2 },
          { x: bay.x - dir * 2.6, z: fire },
        ],
        2.4,
      ),
      () => 1.6,
      true,
    );
    const drive = new TimedPath(
      roundCorners(
        [
          { x: bay.x - dir * 2.6, z: fire },
          { x: px, z: fire },
          { x: px, z: lot.edgeZ },
          { x: px, z: laneZ },
          { x: endX, z: laneZ },
        ],
        3,
      ),
      speed,
    );
    out.push({ job, entry, wait, toBay, back, drive, bay });
  }
  return out;
}
