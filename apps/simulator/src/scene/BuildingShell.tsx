import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useApp } from '../state/store';
import { FLOOR_HEIGHT, type FloorBounds } from './layout';
import { customerEntrance } from './crowd';
import { toonGradient } from './toon';

/**
 * 建筑外壳：外墙（顾客入口、交付门口、卸货门处开洞）、女儿墙、屋顶（空调机组、采光天窗）。
 * 三种查看方式：
 * - 内部：不显示外壳（默认，像模拟经营游戏一样看店内）；
 * - 外观：完整的建筑外观；
 * - 半剖：用一个竖直剖切面把建筑分成两半，一半看外观，一半看内部，剖切位置可拖动。
 */

const WALL = '#e7e2d8';
const ACCENT = '#2f7d55';
const ROOF = '#c9ccc9';
const T = 0.3;

interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
  opacity?: number;
}

/** 剖切面：保留 x ≥ cut 的部分（外观一侧） */
export const cutPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

/** 当前剖切位置对应的世界坐标 x（供标签等判断在哪一侧） */
export function cutX(geo: { floors: FloorBounds[]; facilities: Array<{ x0: number; x1: number }> }, cutPos: number): number {
  const minX = Math.min(...geo.floors.map((f) => f.minX), ...geo.facilities.map((f) => f.x0));
  const maxX = Math.max(...geo.floors.map((f) => f.maxX), ...geo.facilities.map((f) => f.x1));
  return minX + (maxX - minX) * cutPos;
}

function frontSegments(f: FloorBounds, gaps: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x0 = f.minX;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > x0) out.push([x0, a]);
    x0 = Math.max(x0, b);
  }
  if (f.maxX > x0) out.push([x0, f.maxX]);
  return out;
}

export function BuildingShell() {
  const mode = useApp((s) => s.buildingView);
  const cutPos = useApp((s) => s.cutPos);
  const geo = useApp((s) => s.geo);
  const model = useApp((s) => s.model);
  const floor = useApp((s) => s.floor);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    gl.localClippingEnabled = true;
  }, [gl]);

  const x = cutX(geo, cutPos);
  useEffect(() => {
    cutPlane.constant = -x;
  }, [x]);

  const boxes = useMemo<Box[]>(() => {
    const out: Box[] = [];
    // 选中某一层时只显示到这一层（上面的楼层像被揭开一样）
    const topLevel = floor === 'ALL' ? Infinity : (geo.floors.find((f) => f.floorId === floor)?.level ?? Infinity);
    const floors = geo.floors.filter((f) => f.level <= topLevel).sort((a, b) => a.level - b.level);
    const entrance = customerEntrance(model, geo).outside.x;
    floors.forEach((f, i) => {
      const y = f.y;
      const H = FLOOR_HEIGHT;
      const w = f.maxX - f.minX;
      const d = f.maxZ - f.minZ;
      const cx = (f.minX + f.maxX) / 2;
      const cz = (f.minZ + f.maxZ) / 2;
      // 正面：一楼在入口和交付门口开洞，洞口上方有门楣
      const gaps: Array<[number, number]> = f.level === 0 ? [[entrance - 2.4, entrance + 2.4], [geo.door.x - 1.5, geo.door.x + 1.5]] : [];
      for (const [a, b] of frontSegments(f, gaps)) out.push({ x: (a + b) / 2, y, z: f.minZ, w: b - a, h: H, d: T, color: WALL });
      for (const [a, b] of gaps) out.push({ x: (a + b) / 2, y: y + 3.4, z: f.minZ, w: b - a, h: H - 3.4, d: T, color: WALL });
      // 一楼正面的玻璃幕墙（入口两侧）
      if (f.level === 0) out.push({ x: entrance, y: 0.2, z: f.minZ - 0.18, w: 14, h: 3.2, d: 0.08, color: '#a9d3ea', opacity: 0.55 });
      // 后墙、两侧墙
      out.push({ x: cx, y, z: f.maxZ, w, h: H, d: T, color: WALL });
      out.push({ x: f.minX, y, z: cz, w: T, h: H, d, color: WALL });
      out.push({ x: f.maxX, y, z: cz, w: T, h: H, d, color: WALL });
      // 每层顶部的装饰色带
      out.push({ x: cx, y: y + H - 0.9, z: f.minZ - 0.05, w: w + 0.2, h: 0.5, d: T + 0.1, color: ACCENT });
      // 屋顶：最上面一层整块；下层只覆盖上层没有盖住的部分
      const above = floors[i + 1];
      const roofY = y + H;
      const pieces: Array<[number, number, number, number]> = [];
      if (!above) pieces.push([f.minX, f.maxX, f.minZ, f.maxZ]);
      else {
        if (above.maxX < f.maxX) pieces.push([above.maxX, f.maxX, f.minZ, f.maxZ]);
        if (above.maxZ < f.maxZ) pieces.push([f.minX, Math.min(above.maxX, f.maxX), above.maxZ, f.maxZ]);
      }
      for (const [x0, x1, z0, z1] of pieces) {
        out.push({ x: (x0 + x1) / 2, y: roofY, z: (z0 + z1) / 2, w: x1 - x0, h: 0.25, d: z1 - z0, color: ROOF });
        // 女儿墙
        out.push({ x: (x0 + x1) / 2, y: roofY, z: z0, w: x1 - x0, h: 1.0, d: 0.25, color: WALL });
        out.push({ x: (x0 + x1) / 2, y: roofY, z: z1, w: x1 - x0, h: 1.0, d: 0.25, color: WALL });
        out.push({ x: x0, y: roofY, z: (z0 + z1) / 2, w: 0.25, h: 1.0, d: z1 - z0, color: WALL });
        out.push({ x: x1, y: roofY, z: (z0 + z1) / 2, w: 0.25, h: 1.0, d: z1 - z0, color: WALL });
        // 空调机组与采光天窗，按网格排布
        for (let gx = x0 + 6; gx < x1 - 4; gx += 12) {
          for (let gz = z0 + 6; gz < z1 - 4; gz += 10) {
            const k = Math.round(gx * 7 + gz * 3) % 3;
            if (k === 0) out.push({ x: gx, y: roofY + 0.25, z: gz, w: 2.6, h: 1.3, d: 1.8, color: '#aeb4b8' });
            else out.push({ x: gx, y: roofY + 0.25, z: gz, w: 3.2, h: 0.3, d: 1.6, color: '#9cc6dd' });
          }
        }
      }
    });
    // 卸货门由 DockDoors 画（卷帘门随靠台车辆升降）
    // 汽车服务中心：外墙与屋顶（正面是卷帘门工位，保持敞开）
    for (const fac of geo.facilities) {
      const w = fac.x1 - fac.x0;
      const d = fac.z1 - fac.z0;
      const cx = (fac.x0 + fac.x1) / 2;
      out.push({ x: cx, y: fac.height, z: (fac.z0 + fac.z1) / 2, w: w + 0.4, h: 0.3, d: d + 0.4, color: ROOF });
      out.push({ x: fac.side === 'LEFT' ? fac.x1 : fac.x0, y: 0, z: (fac.z0 + fac.z1) / 2, w: 0.3, h: fac.height, d, color: WALL });
      for (const b of fac.bays) out.push({ x: b.x, y: fac.height - 1.6, z: 0.05, w: 4.2, h: 0.5, d: 0.2, color: '#d0d4d8' });
    }
    return out;
  }, [geo, model, floor]);

  if (mode === 'interior') return null;
  const clip = mode === 'cutaway' ? [cutPlane] : [];
  return (
    <group>
      {boxes.map((b, i) => (
        <mesh key={i} position={[b.x, b.y + b.h / 2, b.z]} castShadow={b.opacity === undefined} receiveShadow>
          <boxGeometry args={[b.w, b.h, b.d]} />
          {b.opacity !== undefined ? (
            <meshStandardMaterial color={b.color} transparent opacity={b.opacity} clippingPlanes={clip} />
          ) : (
            <meshToonMaterial color={b.color} gradientMap={toonGradient()} clippingPlanes={clip} />
          )}
        </mesh>
      ))}
      {mode === 'cutaway' && (
        <mesh position={[x, FLOOR_HEIGHT * geo.floors.length / 2, (geo.floors[0]?.maxZ ?? 40) / 2]}>
          <boxGeometry args={[0.06, FLOOR_HEIGHT * geo.floors.length + 1.2, (geo.floors[0]?.maxZ ?? 40) + 0.6]} />
          <meshBasicMaterial color="#e5484d" transparent opacity={0.25} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
