import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { env } from './environment';
import { customerEntrance } from './crowd';
import { cutX } from './BuildingShell';
import { Html } from '@react-three/drei';
import { useApp } from '../state/store';
import { SCENE, ZONE_COLOR } from './palette';
import { toonGradient } from './toon';
import { getLang, t } from '../i18n';

const WALL_H = 0.8;

/** 模板中的英文名称在界面上显示为中文 */
function displayRunLabel(label: string): string {
  const m = /^Aisle (\d+)$/.exec(label);
  if (m) return `A${m[1]}`;
  const map: Record<string, string> = {
    'Produce wall': '蔬果墙',
    'Back wall (produce & deli)': '后墙 · 蔬果熟食',
    'Back wall (dairy & meat)': '后墙 · 乳品肉类',
  };
  return getLang() === 'en' ? label : (map[label] ?? label);
}

/** 从矩形楼板中挖去若干开口（扶梯井），返回剩下的矩形块 [中心 x, 中心 z, 宽, 深] */
function slabPieces(f: { minX: number; maxX: number; minZ: number; maxZ: number }, holes: Array<{ x0: number; x1: number; z0: number; z1: number }>): number[][] {
  const zs = [...new Set([f.minZ, f.maxZ, ...holes.flatMap((h) => [h.z0, h.z1])])].filter((z) => z >= f.minZ && z <= f.maxZ).sort((a, b) => a - b);
  const out: number[][] = [];
  for (let i = 1; i < zs.length; i++) {
    const za = zs[i - 1] as number;
    const zb = zs[i] as number;
    const mid = (za + zb) / 2;
    let x0 = f.minX;
    for (const h of holes.filter((h) => mid > h.z0 && mid < h.z1).sort((a, b) => a.x0 - b.x0)) {
      if (h.x0 > x0) out.push([(x0 + h.x0) / 2, mid, h.x0 - x0, zb - za]);
      x0 = Math.max(x0, h.x1);
    }
    if (f.maxX > x0) out.push([(x0 + f.maxX) / 2, mid, f.maxX - x0, zb - za]);
  }
  return out;
}

/** 把正面墙按开口拆成若干段：[中心 x, z, 长度, 厚度] */
function frontWall(f: { minX: number; maxX: number; minZ: number }, gaps: Array<[number, number]>): number[][] {
  const out: number[][] = [];
  let x0 = f.minX;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > x0) out.push([(x0 + a) / 2, f.minZ, a - x0, 0.2]);
    x0 = Math.max(x0, b);
  }
  if (f.maxX > x0) out.push([(x0 + f.maxX) / 2, f.minZ, f.maxX - x0, 0.2]);
  return out;
}

/** 楼板、外墙、停车场与区域标签 */
export function Ground() {
  const geo = useApp((s) => s.geo);
  const model = useApp((s) => s.model);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const mode = useApp((s) => s.mode);
  const showAll = view === '3d' && floor === 'ALL';

  const visibleFloors = geo.floors.filter((f) => showAll || f.floorId === floor || (floor === 'ALL' && f.level === 0));
  const points = model.config.layout.points;
  const backroomY = geo.floorY.get(points.backroom.floorId) ?? 0;

  // 夜间店内灯光：楼板自发光，营造灯火通明的效果（不增加实时光源）
  const floorMats = useRef(new Set<THREE.MeshToonMaterial>());
  useFrame(() => {
    for (const m of floorMats.current) m.emissive.setRGB(0.42 * env.night, 0.39 * env.night, 0.3 * env.night);
  });

  // 上层楼板在扶梯上方留出开口
  const holesFor = (y: number) =>
    geo.connectors
      .filter((c) => c.kind === 'ESCALATOR' && c.bottom && c.top && Math.abs(c.y1 - y) < 0.5)
      .map((c) => ({ x0: (c.bottom?.x ?? 0) + 0.5, x1: (c.top?.x ?? 0) - 0.8, z0: c.z - 1.5, z1: c.z + 1.5 }));

  // 正面墙在顾客入口和交付门口处断开
  const gaps = useMemo<Array<[number, number]>>(() => {
    const ex = customerEntrance(model, geo).outside.x;
    return [
      [ex - 2.3, ex + 2.3],
      [geo.door.x - 1.4, geo.door.x + 1.4],
    ];
  }, [model, geo]);

  // 外观模式不显示店内标签；半剖时只显示内部一侧的标签
  const buildingView = useApp((s) => s.buildingView);
  const cutPos = useApp((s) => s.cutPos);
  const inside = (x: number) => buildingView === 'interior' || (buildingView === 'cutaway' && x < cutX(geo, cutPos));
  const labels = useMemo(
    () => geo.runLabels.filter((l) => visibleFloors.some((f) => f.floorId === l.floorId)),
    [geo, visibleFloors],
  );

  return (
    <group>
      {visibleFloors.map((f) => {
        const w = f.maxX - f.minX;
        const d = f.maxZ - f.minZ;
        const cx = (f.minX + f.maxX) / 2;
        const cz = (f.minZ + f.maxZ) / 2;
        return (
          <group key={f.floorId}>
            {(f.level > 0 ? slabPieces(f, holesFor(f.y)) : [[cx, cz, w, d]]).map(([px, pz, pw, pd], k) => (
            <mesh key={k} position={[px as number, f.y - 0.06, pz as number]} receiveShadow>
              <boxGeometry args={[pw as number, 0.12, pd as number]} />
              {/* 同时显示多层时，上层楼板半透明，能看到下层 */}
              <meshToonMaterial
                ref={(m: THREE.MeshToonMaterial | null) => {
                  if (m) floorMats.current.add(m);
                }}
                color={f.level === 0 ? SCENE.floor : SCENE.floorUpper}
                gradientMap={toonGradient()}
                transparent={showAll && f.level > 0}
                opacity={showAll && f.level > 0 ? 0.55 : 1}
              />
            </mesh>
            ))}
            {/* 矮墙：只勾勒轮廓，不遮挡视线 */}
            {[
              ...frontWall(f, f.level === 0 ? gaps : []),
              [cx, f.maxZ, w, 0.2],
              [f.minX, cz, 0.2, d],
              [f.maxX, cz, 0.2, d],
            ].map(([x, z, sx, sz], i) => (
              <mesh key={i} position={[x as number, f.y + WALL_H / 2, z as number]} castShadow receiveShadow>
                <boxGeometry args={[sx as number, WALL_H, sz as number]} />
                <meshToonMaterial color={SCENE.wall} gradientMap={toonGradient()} />
              </mesh>
            ))}
            {inside(f.minX) && <Html position={[f.minX + 1.5, f.y + 1.2, f.minZ + 1.5]} center className="scene-label floor-label">
              {model.config.layout.floors.find((x) => x.id === f.floorId)?.name ?? f.floorId}
            </Html>}
          </group>
        );
      })}

      {visibleFloors.some((f) => f.level === 0) && (
        <group>
          {/* 交付门口 */}
          <mesh position={[geo.door.x, 0.6, geo.door.z]}>
            <boxGeometry args={[2.4, 1.2, 0.3]} />
            <meshToonMaterial color={SCENE.door} gradientMap={toonGradient()} />
          </mesh>
          {mode === 'sim' && (
            <>
              <Html position={[geo.door.x, 2, geo.door.z]} center className="scene-label area-label">{t('交付门口')}</Html>
              {inside(points.backroom.x) && <Html position={[points.backroom.x, backroomY + 1.5, points.backroom.y]} center className="scene-label area-label">{t('后仓')}</Html>}
              {inside(points.staging.x + 5) && <Html position={[points.staging.x + 5, 2.6, points.staging.y + 1]} center className="scene-label area-label">{t('暂存区')}</Html>}
            </>
          )}
        </group>
      )}

      {labels.filter((l) => inside(l.x)).map((l) => (
        <Html key={l.runId} position={[l.x, l.y, l.z]} center className="scene-label run-label">
          <span className="dot" style={{ background: ZONE_COLOR[l.tempZone] }} />
          {displayRunLabel(l.label)}
        </Html>
      ))}
    </group>
  );
}
