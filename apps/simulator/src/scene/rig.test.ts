import { describe, expect, it } from 'vitest';
import { roundCorners, TimedPath, type PathState } from './lot';
import { ForwardRig, planSemiDock, type RigPose } from './rig';
import { SEMI } from './vehicles';

const ang = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

describe('vehicle kinematics (decision 0013)', () => {
  it('speed profile: starts from rest, respects the cap, slows for corners, stops at the end', () => {
    const p = new TimedPath(
      roundCorners(
        [
          { x: 0, z: 0 },
          { x: 60, z: 0 },
          { x: 60, z: 40 },
        ],
        6,
      ),
      () => 10,
    );
    const st = { x: 0, z: 0, heading: 0 } as PathState;
    const speeds: number[] = [];
    for (let t = 0; t <= p.duration; t += 0.25) {
      p.at(t, st);
      speeds.push(st.speed ?? 0);
      expect(st.speed ?? 0).toBeLessThanOrEqual(10.01);
    }
    expect(speeds[0]).toBeLessThan(0.6);
    expect(speeds.at(-1)).toBeLessThan(0.6);
    // 转角处（半径 6 米，侧向 2 m/s²）不超过 √12 ≈ 3.5 m/s
    p.at(0, st);
    let atCorner = Infinity;
    for (let t = 0; t <= p.duration; t += 0.1) {
      p.at(t, st);
      if (Math.abs(st.x - 57) < 1.2 && Math.abs(st.z - 3) < 3) atCorner = Math.min(atCorner, st.speed ?? 0);
    }
    expect(atCorner).toBeLessThan(4);
    // 车头朝向连续
    let prev: number | undefined;
    for (let t = 0; t <= p.duration; t += 0.05) {
      p.at(t, st);
      if (prev !== undefined) expect(Math.abs(ang(prev, st.heading))).toBeLessThan(0.25);
      prev = st.heading;
    }
  });

  it('trailer off-tracks into a turn and straightens afterwards', () => {
    const rig = new ForwardRig(
      new TimedPath(
        roundCorners(
          [
            { x: 0, z: 0 },
            { x: 40, z: 0 },
            { x: 40, z: 80 },
          ],
          10,
        ),
        () => 6,
      ),
    );
    const r = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false } as RigPose;
    let maxHitch = 0;
    for (let t = 0; t <= rig.duration; t += 0.2) {
      rig.at(t, r);
      maxHitch = Math.max(maxHitch, Math.abs(ang(r.trailer, r.heading)));
    }
    expect(maxHitch).toBeGreaterThan(0.3);
    expect(maxHitch).toBeLessThan(1.4);
    rig.at(rig.duration, r);
    expect(Math.abs(ang(r.trailer, r.heading))).toBeLessThan(0.15);
  });

  it('semi docking: continuous hand-over to reversing, bounded hitch angle, trailer square to the door at the wall', () => {
    const plan = planSemiDock({ startX: 200, inLane: -40, outLane: -36, endX: -100, serviceX: 90, zTurn: 65, doorX: 61, wallZ: 38.5, roadEdgeZ: -30 });
    const a = plan.entry.end();
    const b = { x: 0, z: 0, heading: 0, trailer: 0, reversing: true } as RigPose;
    plan.back.at(0, b);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.5);
    expect(Math.abs(ang(a.trailer, b.trailer))).toBeLessThan(0.05);
    for (let t = 0; t <= plan.back.duration; t += 0.2) {
      plan.back.at(t, b);
      expect(Math.abs(ang(b.trailer, b.heading))).toBeLessThan(1.1);
    }
    const p = plan.parked;
    expect(Math.abs(ang(p.trailer, 0))).toBeLessThan(0.05);
    expect(p.x).toBeCloseTo(61, 0);
    // 挂车车尾离后墙约 0.6 米
    const rearZ = p.z - SEMI.kingpinToRear * Math.cos(p.trailer);
    expect(rearZ).toBeGreaterThan(38.5);
    expect(rearZ).toBeLessThan(39.6);
    // 驶离时从停靠位置开始
    const l = { x: 0, z: 0, heading: 0, trailer: 0, reversing: false } as RigPose;
    plan.leave.at(0, l);
    expect(Math.hypot(l.x - p.x, l.z - p.z)).toBeLessThan(0.3);
  });
});
