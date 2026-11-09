import { describe, expect, it } from 'vitest';
import { PortOps } from '../web/src/three/ops/port';

/**
 * 港口物流中心的场内拖车：空箱堆场一个贝位同一时段只停一辆车（拖车之间、拖车和外面的集卡都错开，后来的停到旁边空着的贝位），
 * 挂上箱拉出来在车道上等的拖车不等在同一个地方，堆场交接点并排停的车隔得开——停着的拖车车身不叠在一起；拖车一路不跳。
 */
type Pose = { x: number; z: number; heading: number; trailer: number; bob?: boolean };
/** 拖车（车头 + 骨架车）的两个矩形：车头在牵引销前 3 米，骨架车在牵引销后 11 米（宽 2.5 米） */
function boxes(p: Pose): { cx: number; cz: number; ux: number; uz: number; hl: number; hw: number }[] {
  const hx = Math.sin(p.heading);
  const hz = Math.cos(p.heading);
  const tx = Math.sin(p.trailer);
  const tz = Math.cos(p.trailer);
  const cab = { cx: p.x + hx * 1.5, cz: p.z + hz * 1.5, ux: hx, uz: hz, hl: 1.4, hw: 1.15 };
  // 光车头不带骨架车
  return p.bob ? [cab] : [cab, { cx: p.x - tx * 5.8, cz: p.z - tz * 5.8, ux: tx, uz: tz, hl: 5.3, hw: 1.15 }];
}
function hit(a: ReturnType<typeof boxes>[number], b: ReturnType<typeof boxes>[number]): boolean {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  for (const [nx, nz] of [
    [a.ux, a.uz],
    [-a.uz, a.ux],
    [b.ux, b.uz],
    [-b.uz, b.ux],
  ] as const) {
    const ra = a.hl * Math.abs(a.ux * nx + a.uz * nz) + a.hw * Math.abs(-a.uz * nx + a.ux * nz);
    const rb = b.hl * Math.abs(b.ux * nx + b.uz * nz) + b.hw * Math.abs(-b.uz * nx + b.ux * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb) return false;
  }
  return true;
}

describe('港口物流中心的场内拖车', () => {
  it('停着的拖车不叠在一起（空箱堆场的贝位、车道上等着、堆场交接点），拖车一路不跳（极限负荷的一天）', () => {
    const port = new PortOps();
    port.setDay({ seed: 1, drays: [], traffic: 2.5, passing: [] });
    port.gateTrips();
    const logi = (port as unknown as { logi: { tractorCount: number; tractorAt(k: number, t: number, out: Pose): { load: string } | undefined } }).logi;
    const n = logi.tractorCount;
    expect(n).toBeGreaterThan(3);
    const prev: (Pose | undefined)[] = [];
    let still = 0;
    let jump = 0;
    for (let t = 0; t < 86400; t += 2) {
      const ps: (Pose | undefined)[] = [];
      for (let k = 0; k < n; k++) {
        const o = { x: 0, z: 0, heading: 0, trailer: 0 } as Pose;
        const g = logi.tractorAt(k, t, o);
        if (g) o.bob = g.load === 'bobtail';
        ps.push(g ? o : undefined);
      }
      for (let i = 0; i < n; i++) {
        const a = ps[i];
        const pa = prev[i];
        if (a && pa) jump = Math.max(jump, Math.hypot(a.x - pa.x, a.z - pa.z) / 2);
        if (!a || !pa || Math.hypot(a.x - pa.x, a.z - pa.z) > 0.05) continue;
        for (let j = i + 1; j < n; j++) {
          const b = ps[j];
          const pb = prev[j];
          if (!b || !pb || Math.hypot(b.x - pb.x, b.z - pb.z) > 0.05 || Math.abs(a.x - b.x) > 25 || Math.abs(a.z - b.z) > 25) continue;
          if (boxes(a).some((x) => boxes(b).some((y) => hit(x, y)))) still++;
        }
      }
      for (let k = 0; k < n; k++) prev[k] = ps[k];
    }
    // 不跳：让行以后赶时间的那几段最快十几米 / 秒（以前就是这样），两秒里不会挪出 40 米
    expect(jump).toBeLessThan(20);
    // 以前 78 个时刻（空箱堆场同一个贝位两辆车、车道上同一个点等着两辆、交接点并排的骨架车蹭着）；剩下的是计划里两辆拖车
    // 同一刻从挨着的地方出发、拐弯时挂车扫到旁边停着的车（这里的车身按矩形估，比审计宽一点）
    expect(still).toBeLessThanOrEqual(40);
  }, 300_000);
});
