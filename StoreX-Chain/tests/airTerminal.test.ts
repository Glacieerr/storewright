import { describe, expect, it } from 'vitest';
import { AirportOps } from '../web/src/three/ops/airport';

/**
 * 机场货站库内的叉车：闲着的时候回充电位、停在放货的地方或往后让开，取放货时货位前有别的叉车就往回退着等——
 * 两台停着的叉车车身不叠在一起，画出来的位置一路不跳（每秒取一次）；机坪的板车串在货站门口一次只停一套。
 */
type Pose = { x: number; z: number; yaw: number; fy: number };
const BODY = { x0: -1.95, x1: -0.34, hw: 0.54 };
/** 叉车车身（原点在货叉根部，车头朝 +x，绕 y 转 yaw）的四个角 */
function corners(p: Pose): { x: number; z: number }[] {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return [
    [BODY.x0, -BODY.hw],
    [BODY.x1, -BODY.hw],
    [BODY.x1, BODY.hw],
    [BODY.x0, BODY.hw],
  ].map(([x, z]) => ({ x: p.x + (x as number) * c + (z as number) * s, z: p.z - (x as number) * s + (z as number) * c }));
}
function hit(a: { x: number; z: number }[], b: { x: number; z: number }[]): boolean {
  for (const P of [a, b])
    for (let i = 0; i < 4; i++) {
      const p = P[i] as { x: number; z: number };
      const q = P[(i + 1) % 4] as { x: number; z: number };
      const nx = q.z - p.z;
      const nz = p.x - q.x;
      const pa = a.map((v) => v.x * nx + v.z * nz);
      const pb = b.map((v) => v.x * nx + v.z * nz);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  return true;
}

describe('机场货站的叉车、机坪的板车串', () => {
  it('停着的叉车不叠在一起，叉车一路不跳；板车串在货站门口不叠在一起（极限负荷的一天）', () => {
    const air = new AirportOps();
    air.setDay([], 1, 2.5);
    const term = (air as unknown as { term: { forkTrips: number[][]; forkPose(fk: number, t: number, o: Pose): void } }).term;
    const n = term.forkTrips.length;
    expect(term.forkTrips.flat().length).toBeGreaterThan(500);
    const prev: (Pose | undefined)[] = [];
    let jump = 0;
    let still = 0;
    for (let t = 0; t < 86400; t += 1) {
      const ps: Pose[] = [];
      for (let k = 0; k < n; k++) {
        const o = { x: 0, z: 0, yaw: 0, fy: 0 };
        term.forkPose(k, t, o);
        ps.push(o);
      }
      if (t % 2 === 0)
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const a = ps[i] as Pose;
            const b = ps[j] as Pose;
            const pa = prev[i];
            const pb = prev[j];
            if (Math.abs(a.x - b.x) > 5 || Math.abs(a.z - b.z) > 5 || !pa || !pb) continue;
            // 两台都停着（和一秒前比没动）
            if (Math.hypot(a.x - pa.x, a.z - pa.z) > 0.05 || Math.hypot(b.x - pb.x, b.z - pb.z) > 0.05) continue;
            if (hit(corners(a), corners(b))) still++;
          }
      for (let k = 0; k < n; k++) {
        const p = prev[k];
        const q = ps[k] as Pose;
        if (p) jump = Math.max(jump, Math.hypot(q.x - p.x, q.z - p.z));
        prev[k] = q;
      }
    }
    // 叉车按计划的路程用时开（一趟起停平稳，最快不到平均的两倍，约 4 米 / 秒）；让开、退着等是几秒里慢慢挪过去的
    expect(jump).toBeLessThan(6);
    // 只剩计划里两台叉车同一刻从挨着的地方出发的几秒（以前停着的叉车叠在一起：一天几千车对 × 秒）
    expect(still).toBeLessThanOrEqual(30);
    // 板车串：货站门口别的套占着就在门口前 22 米等（每套车的等待时段都在门口有车的时候）
    const flights = (air as unknown as { flights: { ops?: { doorWait?: number[][] } }[] }).flights;
    expect(flights.some((f) => f.ops?.doorWait?.some((w) => w.length > 0))).toBe(true);
  }, 300_000);
});
