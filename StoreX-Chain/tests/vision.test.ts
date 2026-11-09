import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { detect, type VisionObject } from '../web/src/three/vision';

/** 监控画面识别：投影、置信度、漏检和误检按时刻确定、靠台和排队的计数 */
describe('监控画面识别', () => {
  const cam = new THREE.PerspectiveCamera(48, 16 / 9, 2, 6000);
  cam.position.set(0, 20, 60);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const truck = (id: number, x: number, z: number, extra: Partial<VisionObject> = {}): VisionObject => ({ id, cls: '半挂车', x, y: 0, z, yaw: 0, len: 16, wid: 2.6, hgt: 4, ...extra });

  it('画面里的车框在 0–1 之内；镜头后面和太远的不报', () => {
    const r = detect(cam, [truck(1, 0, 0), truck(2, 0, 200), truck(3, 0, -3000)], 3600, 1);
    const ids = r.dets.filter((d) => !d.fp).map((d) => d.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
    for (const d of r.dets) for (const x of d.box) expect(x >= 0 && x <= 1).toBe(true);
  });

  it('同一个时刻每次一样；靠台、排队按目标的标记数', () => {
    const objs = [truck(1, -10, 0, { dock: 'ok' }), truck(2, 10, 0, { dock: 'off' }), truck(3, 0, 15, { queued: true })];
    const a = detect(cam, objs, 7200, 2);
    const b = detect(cam, objs, 7200, 2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // 一天里大多数时刻三辆都认得出来（偶尔漏检一个）
    let full = 0;
    for (let t = 0; t < 86400; t += 600) {
      const r = detect(cam, objs, t, 2);
      if (r.vehicles === 3) {
        full++;
        expect(r.docked).toBe(1);
        expect(r.misaligned).toBe(1);
        expect(r.queued).toBe(1);
      }
    }
    expect(full).toBeGreaterThan(110);
  });
});
