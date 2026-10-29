import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useApp } from '../state/store';
import { FLOOR_HEIGHT, type FloorBounds } from './layout';
import { customerEntrance } from './crowd';
import { toonGradient } from './toon';
import { boxGeo, mergeAll } from './terrain/geom';
import { makeTriplanarMaterial, makeWorldTexMaterial } from './terrain/terrainMaterial';
import { panelTexture, roofTexture, stoneTexture } from './terrain/textures';
import { signTexture } from './Storefront';
import { env } from './environment';

/**
 * 建筑外壳（超市的外立面）：
 * - 石材勒脚、金属板外墙、竖向壁柱、高窗带、顶部的品牌色檐口带、女儿墙与压顶石；
 * - 正面入口两侧是通高的玻璃幕墙，上方升起一段门头墙，挂着店招（夜里发光）；
 * - 屋顶：卷材屋面、空调机组（风扇格栅、侧面百叶）、采光天窗、检修口；后墙角有落水管。
 * 三种查看方式：
 * - 内部：不显示外壳（默认，像模拟经营游戏一样看店内）；
 * - 外观：完整的建筑外观；
 * - 半剖：用一个竖直剖切面把建筑分成两半，一半看外观，一半看内部，剖切位置可拖动。
 * 同一种材质的构件合并成一个几何体，绘制次数很少。
 */

const T = 0.3;

/** 剖切面：保留 x ≥ cut 的部分（外观一侧） */
export const cutPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

/** 当前剖切位置对应的世界坐标 x（供标签等判断在哪一侧） */
export function cutX(geo: { floors: FloorBounds[]; facilities: Array<{ x0: number; x1: number }> }, cutPos: number): number {
  const minX = Math.min(...geo.floors.map((f) => f.minX), ...geo.facilities.map((f) => f.x0));
  const maxX = Math.max(...geo.floors.map((f) => f.maxX), ...geo.facilities.map((f) => f.x1));
  return minX + (maxX - minX) * cutPos;
}

function frontSegments(x0: number, x1: number, gaps: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x = x0;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > x) out.push([x, a]);
    x = Math.max(x, b);
  }
  if (x1 > x) out.push([x, x1]);
  return out;
}

/** 沿一段墙均匀分布壁柱：返回壁柱中心位置（避开开口） */
function pilasterPositions(a: number, b: number, spacing: number, avoid: Array<[number, number]>): number[] {
  const n = Math.max(1, Math.round((b - a) / spacing));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const p = a + ((b - a) * i) / n;
    if (avoid.some(([u, v]) => p > u - 0.6 && p < v + 0.6)) continue;
    out.push(p);
  }
  return out;
}

type Kind = 'wall' | 'plinth' | 'pilaster' | 'accent' | 'coping' | 'roof' | 'glass' | 'metal' | 'unit' | 'grill' | 'skylight';

interface Shell {
  parts: Record<Kind, THREE.BufferGeometry[]>;
  sign?: { x: number; y: number; z: number; w: number; h: number };
}

function buildShell(floors: FloorBounds[], entrance: number, doorX: number, facilities: Array<{ x0: number; x1: number; z0: number; z1: number; height: number; side: string; bays: Array<{ x: number }> }>): Shell {
  const parts: Record<Kind, THREE.BufferGeometry[]> = { wall: [], plinth: [], pilaster: [], accent: [], coping: [], roof: [], glass: [], metal: [], unit: [], grill: [], skylight: [] };
  const P = parts;
  let sign: Shell['sign'];
  floors.forEach((f, i) => {
    const y = f.y;
    const H = FLOOR_HEIGHT;
    const top = y + H;
    const ground = f.level === 0;
    const gaps: Array<[number, number]> = ground
      ? [
          [entrance - 2.4, entrance + 2.4],
          [doorX - 1.5, doorX + 1.5],
        ]
      : [];
    const portal: [number, number] = [entrance - 6.6, entrance + 6.6];
    const zf = f.minZ;
    const zb = f.maxZ;
    // ---------- 正面 ----------
    for (const [a, b] of frontSegments(f.minX, f.maxX, gaps)) {
      P.wall.push(boxGeo(a, b, y, top, zf - T / 2, zf + T / 2));
      P.plinth.push(boxGeo(a, b, y, y + 0.55, zf - T / 2 - 0.07, zf + T / 2));
    }
    for (const [a, b] of gaps) P.wall.push(boxGeo(a, b, y + 3.4, top, zf - T / 2, zf + T / 2));
    // 壁柱（避开开口和入口幕墙）
    const front = pilasterPositions(f.minX + 0.35, f.maxX - 0.35, 8, ground ? [...gaps, portal] : gaps);
    for (const px of front) P.pilaster.push(boxGeo(px - 0.38, px + 0.38, y, top - 1.25, zf - T / 2 - 0.22, zf));
    // 高窗带：壁柱之间，入口幕墙上方不重复
    const posts = [f.minX, ...front, f.maxX].sort((a, b) => a - b);
    for (let k = 1; k < posts.length; k++) {
      const a = (posts[k - 1] as number) + 0.6;
      const b = (posts[k] as number) - 0.6;
      if (b - a < 2.2) continue;
      if (ground && b > portal[0] - 0.5 && a < portal[1] + 0.5) continue;
      if (gaps.some(([u, v]) => b > u - 0.4 && a < v + 0.4) && ground) continue;
      const y0 = y + (ground ? 4.0 : 2.0);
      const y1 = y + (ground ? 5.3 : 4.6);
      P.glass.push(boxGeo(a, b, y0, y1, zf - T / 2 - 0.05, zf - T / 2 - 0.01));
      P.metal.push(boxGeo(a - 0.08, b + 0.08, y0 - 0.12, y0, zf - T / 2 - 0.12, zf - T / 2), boxGeo(a - 0.08, b + 0.08, y1, y1 + 0.1, zf - T / 2 - 0.1, zf - T / 2));
      const n = Math.max(1, Math.round((b - a) / 1.6));
      for (let m = 0; m <= n; m++) {
        const x = a + ((b - a) * m) / n;
        P.metal.push(boxGeo(x - 0.05, x + 0.05, y0, y1, zf - T / 2 - 0.1, zf - T / 2));
      }
    }
    // 入口：通高玻璃幕墙（门洞两侧）+ 上方升起的门头墙
    if (ground) {
      for (const [a, b] of [
        [portal[0], entrance - 2.4],
        [entrance + 2.4, portal[1]],
      ] as const) {
        P.glass.push(boxGeo(a, b, y + 0.15, y + 4.6, zf - T / 2 - 0.08, zf - T / 2 - 0.03));
        const n = Math.max(1, Math.round((b - a) / 1.2));
        for (let m = 0; m <= n; m++) {
          const x = a + ((b - a) * m) / n;
          P.metal.push(boxGeo(x - 0.05, x + 0.05, y + 0.15, y + 4.6, zf - T / 2 - 0.14, zf - T / 2));
        }
        P.metal.push(boxGeo(a, b, y + 2.55, y + 2.65, zf - T / 2 - 0.14, zf - T / 2));
        P.metal.push(boxGeo(a, b, y + 4.6, y + 4.75, zf - T / 2 - 0.16, zf - T / 2));
        P.metal.push(boxGeo(a, b, y + 0.05, y + 0.15, zf - T / 2 - 0.16, zf - T / 2));
      }
      // 门头墙：高出屋面 2.6 米，正面挑出，顶部压顶
      P.accent.push(boxGeo(portal[0] - 0.6, portal[1] + 0.6, top - 1.6, top + 2.6, zf - T / 2 - 0.45, zf + 0.6));
      P.coping.push(boxGeo(portal[0] - 0.75, portal[1] + 0.75, top + 2.6, top + 2.8, zf - T / 2 - 0.6, zf + 0.75));
      P.pilaster.push(boxGeo(portal[0] - 0.9, portal[0] - 0.1, y, top + 2.6, zf - T / 2 - 0.5, zf + 0.3), boxGeo(portal[1] + 0.1, portal[1] + 0.9, y, top + 2.6, zf - T / 2 - 0.5, zf + 0.3));
      sign = { x: entrance, y: top + 0.55, z: zf - T / 2 - 0.47, w: (portal[1] - portal[0]) * 0.86, h: 2.6 };
    }
    // 品牌色檐口带（正面宽、侧面和背面窄）
    P.accent.push(boxGeo(f.minX - 0.12, f.maxX + 0.12, top - 1.2, top - 0.3, zf - T / 2 - 0.14, zf + T / 2));
    // ---------- 侧面与背面 ----------
    const cz = (zf + zb) / 2;
    for (const x of [f.minX, f.maxX]) {
      const s = x === f.minX ? -1 : 1;
      P.wall.push(boxGeo(x - T / 2, x + T / 2, y, top, zf, zb));
      P.plinth.push(boxGeo(x - T / 2 + (s > 0 ? 0 : -0.07), x + T / 2 + (s > 0 ? 0.07 : 0), y, y + 0.55, zf, zb));
      P.accent.push(boxGeo(x - T / 2 - (s < 0 ? 0.1 : 0), x + T / 2 + (s > 0 ? 0.1 : 0), top - 0.85, top - 0.45, zf, zb));
      for (const pz of pilasterPositions(zf + 0.4, zb - 0.4, 8, [])) P.pilaster.push(boxGeo(x - (s < 0 ? T / 2 + 0.2 : -T / 2), x + (s > 0 ? T / 2 + 0.2 : -T / 2), y, top - 0.9, pz - 0.35, pz + 0.35));
      // 侧面高窗
      if (zb - zf > 20) {
        for (let z = zf + 6; z < zb - 6; z += 8) {
          const xf = x + s * (T / 2 + 0.03);
          P.glass.push(boxGeo(Math.min(xf, xf + s * 0.04), Math.max(xf, xf + s * 0.04), y + 4.2, y + 5.2, z + 1.2, z + 6.8));
        }
      }
    }
    P.wall.push(boxGeo(f.minX, f.maxX, y, top, zb - T / 2, zb + T / 2));
    P.plinth.push(boxGeo(f.minX, f.maxX, y, y + 0.55, zb - T / 2, zb + T / 2 + 0.07));
    P.accent.push(boxGeo(f.minX, f.maxX, top - 0.85, top - 0.45, zb - T / 2, zb + T / 2 + 0.1));
    for (const px of pilasterPositions(f.minX + 0.4, f.maxX - 0.4, 10, [])) P.pilaster.push(boxGeo(px - 0.35, px + 0.35, y, top - 0.9, zb, zb + T / 2 + 0.2));
    // 落水管（后墙两角）
    if (ground) for (const x of [f.minX + 0.6, f.maxX - 0.6]) P.metal.push(boxGeo(x - 0.09, x + 0.09, y, top + 0.3, zb + T / 2 + 0.05, zb + T / 2 + 0.23));
    void cz;
    // ---------- 屋顶 ----------
    const above = floors[i + 1];
    const pieces: Array<[number, number, number, number]> = [];
    if (!above) pieces.push([f.minX, f.maxX, f.minZ, f.maxZ]);
    else {
      if (above.maxX < f.maxX) pieces.push([above.maxX, f.maxX, f.minZ, f.maxZ]);
      if (above.maxZ < f.maxZ) pieces.push([f.minX, Math.min(above.maxX, f.maxX), above.maxZ, f.maxZ]);
    }
    for (const [x0, x1, z0, z1] of pieces) {
      P.roof.push(boxGeo(x0, x1, top, top + 0.25, z0, z1));
      // 女儿墙与压顶石
      for (const [a, b, c, d] of [
        [x0, x1, z0 - T / 2, z0 + T / 2],
        [x0, x1, z1 - T / 2, z1 + T / 2],
        [x0 - T / 2, x0 + T / 2, z0, z1],
        [x1 - T / 2, x1 + T / 2, z0, z1],
      ] as const) {
        P.wall.push(boxGeo(a, b, top, top + 1.0, c, d));
        P.coping.push(boxGeo(a - 0.1, b + 0.1, top + 1.0, top + 1.14, c - 0.1, d + 0.1));
      }
      // 空调机组、采光天窗、检修口，按网格排布
      for (let gx = x0 + 6; gx < x1 - 4; gx += 12) {
        for (let gz = z0 + 6; gz < z1 - 4; gz += 10) {
          const k = Math.abs(Math.round(gx * 7 + gz * 3)) % 4;
          const yb = top + 0.25;
          if (k === 0 || k === 2) {
            P.unit.push(boxGeo(gx - 1.4, gx + 1.4, yb, yb + 1.25, gz - 0.95, gz + 0.95));
            P.metal.push(boxGeo(gx - 1.5, gx + 1.5, yb, yb + 0.12, gz - 1.05, gz + 1.05));
            // 两个风扇格栅
            for (const dx of [-0.68, 0.68]) {
              const fan = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 16);
              fan.translate(gx + dx, yb + 1.28, gz);
              P.grill.push(fan);
              const hub = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 8);
              hub.translate(gx + dx, yb + 1.32, gz);
              P.metal.push(hub);
            }
            // 侧面百叶
            for (let m = 0; m < 4; m++) P.grill.push(boxGeo(gx - 1.2, gx + 1.2, yb + 0.25 + m * 0.22, yb + 0.33 + m * 0.22, gz - 0.97, gz - 0.95));
          } else if (k === 1) {
            P.metal.push(boxGeo(gx - 1.75, gx + 1.75, yb, yb + 0.35, gz - 0.95, gz + 0.95));
            P.skylight.push(boxGeo(gx - 1.55, gx + 1.55, yb + 0.35, yb + 0.55, gz - 0.75, gz + 0.75));
          } else {
            P.metal.push(boxGeo(gx - 0.5, gx + 0.5, yb, yb + 0.5, gz - 0.5, gz + 0.5));
            P.unit.push(boxGeo(gx - 0.45, gx + 0.45, yb + 0.5, yb + 0.58, gz - 0.45, gz + 0.45));
          }
        }
      }
    }
  });
  // 汽车服务中心：外墙、屋顶与工位门头（正面是卷帘门工位，保持敞开）
  for (const fac of facilities) {
    const w = fac.x1 - fac.x0;
    const d = fac.z1 - fac.z0;
    const cx = (fac.x0 + fac.x1) / 2;
    const czf = (fac.z0 + fac.z1) / 2;
    P.roof.push(boxGeo(cx - w / 2 - 0.2, cx + w / 2 + 0.2, fac.height, fac.height + 0.3, czf - d / 2 - 0.2, czf + d / 2 + 0.2));
    P.coping.push(boxGeo(cx - w / 2 - 0.3, cx + w / 2 + 0.3, fac.height + 0.3, fac.height + 0.5, czf - d / 2 - 0.3, czf - d / 2 + 0.1));
    const xs = fac.side === 'LEFT' ? fac.x1 : fac.x0;
    P.wall.push(boxGeo(xs - T / 2, xs + T / 2, 0, fac.height, czf - d / 2, czf + d / 2));
    P.plinth.push(boxGeo(xs - T / 2 - 0.05, xs + T / 2 + 0.05, 0, 0.55, czf - d / 2, czf + d / 2));
    for (const b of fac.bays) P.accent.push(boxGeo(b.x - 2.1, b.x + 2.1, fac.height - 1.85, fac.height - 1.35, -0.05, 0.15));
  }
  return { parts, sign };
}

export function BuildingShell() {
  const mode = useApp((s) => s.buildingView);
  const cutPos = useApp((s) => s.cutPos);
  const geo = useApp((s) => s.geo);
  const model = useApp((s) => s.model);
  const floor = useApp((s) => s.floor);
  const name = useApp((s) => s.config.name);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);

  const x = cutX(geo, cutPos);
  useEffect(() => {
    cutPlane.constant = -x;
  }, [x]);

  const shell = useMemo(() => {
    // 选中某一层时只显示到这一层（上面的楼层像被揭开一样）
    const topLevel = floor === 'ALL' ? Infinity : (geo.floors.find((f) => f.floorId === floor)?.level ?? Infinity);
    const floors = geo.floors.filter((f) => f.level <= topLevel).sort((a, b) => a.level - b.level);
    const entrance = customerEntrance(model, geo).outside.x;
    const s = buildShell(floors, entrance, geo.door.x, geo.facilities);
    const merged = Object.fromEntries(Object.entries(s.parts).map(([k, list]) => [k, list.length ? mergeAll(list) : undefined])) as Record<Kind, THREE.BufferGeometry | undefined>;
    return { merged, sign: s.sign };
  }, [geo, model, floor]);

  const mats = useMemo(() => {
    const m = {
      wall: makeTriplanarMaterial(panelTexture(), 4.8, '#efe7d6'),
      plinth: makeTriplanarMaterial(stoneTexture(), 2.4, '#b9ae9c'),
      pilaster: makeTriplanarMaterial(panelTexture(), 4.8, '#e2d6c0'),
      accent: new THREE.MeshToonMaterial({ color: '#2f7d55', gradientMap: toonGradient() }),
      coping: makeTriplanarMaterial(stoneTexture(), 2, '#f1ece2'),
      roof: makeWorldTexMaterial(roofTexture(), 8, '#d4d7d6'),
      glass: new THREE.MeshToonMaterial({ color: '#7fb3cf', gradientMap: toonGradient(), emissive: '#000000' }),
      metal: new THREE.MeshToonMaterial({ color: '#59626b', gradientMap: toonGradient() }),
      unit: new THREE.MeshToonMaterial({ color: '#c9ced2', gradientMap: toonGradient() }),
      grill: new THREE.MeshToonMaterial({ color: '#3e454b', gradientMap: toonGradient() }),
      skylight: new THREE.MeshToonMaterial({ color: '#9fcbe2', gradientMap: toonGradient(), emissive: '#000000' }),
    } satisfies Record<Kind, THREE.Material>;
    return m;
  }, []);
  const signTex = useMemo(() => signTexture('MARKET', name, 1024, 320), [name]);
  const signMat = useMemo(() => new THREE.MeshBasicMaterial({ map: signTex, transparent: true }), [signTex]);
  // 夜里：玻璃透出店内的暖光、店招变亮
  const warm = useMemo(() => new THREE.Color('#ffd9a0'), []);
  useFrame(() => {
    mats.glass.emissive.copy(warm).multiplyScalar(0.9 * env.night);
    mats.skylight.emissive.copy(warm).multiplyScalar(0.5 * env.night);
    signMat.color.setScalar(0.85 + 1.6 * env.night);
  });
  const clip = useMemo(() => (mode === 'cutaway' ? [cutPlane] : []), [mode]);
  useEffect(() => {
    for (const m of [...Object.values(mats), signMat]) {
      m.clippingPlanes = clip;
      m.needsUpdate = true;
    }
  }, [clip, mats, signMat]);

  if (mode === 'interior') return null;
  const s = shell.sign;
  return (
    <group>
      {(Object.keys(shell.merged) as Kind[]).map((k) => {
        const g = shell.merged[k];
        if (!g) return null;
        const solid = k !== 'glass' && k !== 'skylight';
        return <mesh key={k} geometry={g} material={mats[k]} castShadow={solid} receiveShadow />;
      })}
      {s && (
        <mesh position={[s.x, s.y, s.z]} rotation={[0, Math.PI, 0]} material={signMat}>
          <planeGeometry args={[s.w, s.h * 0.8]} />
        </mesh>
      )}
      {mode === 'cutaway' && (
        <mesh position={[x, (FLOOR_HEIGHT * geo.floors.length) / 2, (geo.floors[0]?.maxZ ?? 40) / 2]}>
          <boxGeometry args={[0.06, FLOOR_HEIGHT * geo.floors.length + 1.2, (geo.floors[0]?.maxZ ?? 40) + 0.6]} />
          <meshBasicMaterial color="#e5484d" transparent opacity={0.25} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
