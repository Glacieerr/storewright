import * as THREE from 'three';
import { GeoBuilder, v3, type V3 } from './geo';
import type { BusStop } from './traffic';

/** 路面、人行道的高度（和 roadmesh 一致） */
const ROAD_Y = 0.3;
const WALK_TOP = ROAD_Y + 0.16;
/** 港湾两头的渐变段长（和 traffic.ts 一致）、停靠框宽 */
const TAPER = 14;
const BOX_W = 3.2;

/**
 * 公交站：港湾里的停靠框（黄色边线、深一点的路面、「公交」字样的横线）、人行道上的雨棚（立柱、顶棚、背板、座椅）和站牌。
 * 站的位置、港湾的形状由背景车流排公交线路时定（traffic.ts），这里只画。
 */
export function buildBusStops(stops: readonly BusStop[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'bus-stops';
  const g = new GeoBuilder();
  for (const st of stops) {
    const bay = st.bay.map((q) => v3(q.x, q.y, q.z));
    if (bay.length < 4) continue;
    // 港湾中间不渐变的那一截：停靠框
    const cum = [0];
    for (let i = 1; i < bay.length; i++) cum.push((cum[i - 1] as number) + (bay[i] as V3).distanceTo(bay[i - 1] as V3));
    const U = cum[cum.length - 1] as number;
    const flat = bay.filter((_, i) => (cum[i] as number) >= TAPER - 1 && (cum[i] as number) <= U - TAPER + 1);
    if (flat.length >= 2) {
      g.color('#4b4f55').strip(flat, -BOX_W / 2, BOX_W / 2, ROAD_Y + 0.012);
      g.color('#e8c54a').strip(flat, -BOX_W / 2, -BOX_W / 2 + 0.18, ROAD_Y + 0.02);
      g.color('#e8c54a').strip(flat, BOX_W / 2 - 0.18, BOX_W / 2, ROAD_Y + 0.02);
      // 两头的横线和中间几道斜线（停靠区标线）
      for (const end of [flat[0] as V3, flat[flat.length - 1] as V3]) {
        const i = bay.indexOf(end);
        const nb = (bay[Math.min(bay.length - 1, i + 1)] as V3).clone().sub(bay[Math.max(0, i - 1)] as V3).normalize();
        g.color('#e8c54a').box(end.x, ROAD_Y + 0.012, end.z, 0.22, 0.012, BOX_W, Math.atan2(-nb.z, nb.x));
      }
      for (let k = 2; k < flat.length - 2; k += 3) {
        const p = flat[k] as V3;
        const q = flat[k + 1] as V3;
        const d = q.clone().sub(p).normalize();
        g.color('#e8c54a').box(p.x, ROAD_Y + 0.012, p.z, 0.16, 0.01, BOX_W * 0.9, Math.atan2(-d.z, d.x) + 0.6);
      }
    }
    // 雨棚：沿行车方向 4 米长，背板在离路远的一侧
    const dx = Math.cos(st.heading);
    const dz = Math.sin(st.heading);
    const rot = Math.atan2(-dz, dx);
    const at = (along: number, out: number) => ({ x: st.shelter.x + dx * along - dz * out, z: st.shelter.z + dz * along + dx * out });
    const y = st.shelter.y + WALK_TOP;
    for (const a of [-1.8, 1.8]) {
      const p = at(a, 0.55);
      g.color('#5f666d').box(p.x, y, p.z, 0.1, 2.5, 0.1, rot);
    }
    const back = at(0, 0.6);
    g.color('#a9c4d2').box(back.x, y + 0.2, back.z, 3.8, 1.9, 0.05, rot);
    const roof = at(0, 0.1);
    g.color(st.terminal ? '#1f6fd0' : '#2f7d5b').box(roof.x, y + 2.5, roof.z, 4.1, 0.1, 1.5, rot);
    const bench = at(0, 0.3);
    g.color('#8a6a4a').box(bench.x, y + 0.42, bench.z, 3, 0.07, 0.42, rot);
    // 站牌：立杆 + 牌子（首末站的牌子大一点）
    g.color('#6d7378').box(st.sign.x, st.sign.y + WALK_TOP, st.sign.z, 0.09, 2.9, 0.09, rot);
    g.color(st.terminal ? '#1f6fd0' : '#2f7d5b').box(st.sign.x, st.sign.y + WALK_TOP + 2.2, st.sign.z, st.terminal ? 0.9 : 0.6, st.terminal ? 0.8 : 0.6, 0.06, rot + Math.PI / 2);
  }
  if (!g.empty) {
    const mesh = new THREE.Mesh(g.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    mesh.name = 'bus-stops';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
