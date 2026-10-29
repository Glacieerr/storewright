import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { SiteLayout } from '../site';
import { clock } from '../../state/clock';
import { guardOnDuty, guardStopping } from '../crossings';
import { toonGradient } from '../toon';
import { t } from '../../i18n';
import { Slabs } from './Slabs';

/**
 * 学校（决策记录 0019）：教学楼（在周边建筑里）、操场（草地上的跑道白线、足球门）、旗杆和校牌，
 * 门前人行横道旁的护导员：上学、放学时段站在路口，拦车时举起停车牌走到路中间；
 * 学生在路边攒几个人，护导员拦住车后排着过马路（上学往学校那边走，放学往回走）。
 */

const MAX_KIDS = 7;
/** 学生过马路：拦车后第几秒开始走、前后相隔几秒、步速（米/秒） */
const KID_START = 3;
const KID_GAP = 1.2;
const KID_SPEED = 1.1;
const SHIRTS = ['#e0533d', '#3f7fd0', '#f2c230', '#43a35a', '#9a5ac8', '#f08a3c', '#2fa3a3'];
const PACKS = ['#2d3a4a', '#c8453f', '#3a6f3a', '#4a4f9a', '#7a4a2a'];

/** 这一轮过马路的学生人数（3–7，按拦车的轮次变化） */
function kidsFor(cycle: number): number {
  const h = Math.imul(cycle ^ 0x9e3779b9, 2654435761) >>> 0;
  return 3 + (h % 5);
}

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#2f5d8a';
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = '#ffffff';
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.fillText(t('学校'), 128, 46);
    g.font = '20px sans-serif';
    g.fillText(t('上学放学时请慢行'), 128, 80);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function School({ site }: { site: SiteLayout }) {
  const s = site.school;
  const lines = useMemo(() => {
    if (!s) return [];
    const f = s.field;
    const out: Array<{ x: number; z: number; w: number; d: number }> = [];
    // 跑道外圈与中线、两个球门区
    out.push({ x: f.x, z: f.z - f.d / 2 + 1, w: f.w - 2, d: 0.14 }, { x: f.x, z: f.z + f.d / 2 - 1, w: f.w - 2, d: 0.14 });
    out.push({ x: f.x - f.w / 2 + 1, z: f.z, w: 0.14, d: f.d - 2 }, { x: f.x + f.w / 2 - 1, z: f.z, w: 0.14, d: f.d - 2 });
    out.push({ x: f.x, z: f.z, w: 0.14, d: f.d - 2 });
    for (const sx of [-1, 1]) out.push({ x: f.x + sx * (f.w / 2 - 5), z: f.z, w: 0.14, d: 9 });
    return out;
  }, [s]);
  const tex = useMemo(() => signTexture(), []);
  const guard = useRef<THREE.Group>(null);
  const flag = useRef<THREE.Mesh>(null);
  const kidBody = useRef<THREE.InstancedMesh>(null);
  const kidHead = useRef<THREE.InstancedMesh>(null);
  const kidPack = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  // 学生的身体、头和书包共用一个变换：几何体各自抬到身高位置，书包在背后（−Z，行走方向的反面）
  const kidGeo = useMemo(
    () => ({
      body: new THREE.CylinderGeometry(0.12, 0.14, 0.85, 8).translate(0, 0.5, 0),
      head: new THREE.SphereGeometry(0.11, 10, 8).translate(0, 1.05, 0),
      pack: new THREE.BoxGeometry(0.24, 0.3, 0.13).translate(0, 0.62, -0.18),
    }),
    [],
  );
  useLayoutEffect(() => {
    for (const m of [kidBody.current, kidHead.current, kidPack.current]) if (m) m.count = 0;
  }, []);
  useFrame(({ clock: tc }) => {
    if (!s) return;
    const g = guard.current;
    const time = clock.time;
    placeKids(time);
    if (g) {
      g.visible = guardOnDuty(time);
      // 拦车时走到人行横道中间（主路靠学校的一半），平时站在路边
      const stop = guardStopping(time);
      const zSide = site.roadBottomZ - 1.2;
      const zMid = (site.roadBottomZ + site.roadTopZ) / 2;
      const target = stop ? zMid : zSide;
      g.position.z += (target - g.position.z) * 0.05;
      g.position.x = s.crossX + 2.1;
    }
    if (flag.current) flag.current.rotation.y = Math.sin(tc.elapsedTime * 1.6) * 0.25;
  });

  /** 学生：值班时在起点一侧的路边攒人，拦车时一个接一个走过人行横道 */
  function placeKids(time: number) {
    const body = kidBody.current;
    const head = kidHead.current;
    const pack = kidPack.current;
    if (!s || !body || !head || !pack) return;
    let n = 0;
    if (guardOnDuty(time)) {
      const morning = ((((time / 3600) % 24) + 24) % 24) < 12;
      // 上学从门店这一侧走向学校（−Z），放学反过来
      const z0 = morning ? site.roadTopZ + 1.4 : site.roadBottomZ - 1.4;
      const z1 = morning ? site.roadBottomZ - 1.4 : site.roadTopZ + 1.4;
      const dir = Math.sign(z1 - z0);
      const len = Math.abs(z1 - z0);
      const phase = ((time % 90) + 90) % 90;
      const crossing = phase < 25;
      // 拦车这一轮过马路的人；不拦车时为下一轮攒人（陆续走到路边）
      const cycle = Math.floor(time / 90) + (crossing ? 0 : 1);
      const count = kidsFor(cycle);
      for (let i = 0; i < count && n < MAX_KIDS; i++) {
        const lane = (i % 3) - 1;
        let z = z0 - dir * (0.4 + Math.floor(i / 3) * 0.7);
        if (crossing) {
          const walked = (phase - KID_START - i * KID_GAP) * KID_SPEED;
          if (walked > 0) z = z0 + dir * Math.min(len, walked);
        } else if (phase < 25 + 65 * ((i + 1) / (count + 1))) continue;
        const x = s.crossX + lane * 1.05 + (i % 2) * 0.2;
        tmp.position.set(x, 0.08, z);
        tmp.rotation.set(0, dir > 0 ? 0 : Math.PI, 0);
        tmp.scale.set(1, 1, 1);
        tmp.updateMatrix();
        body.setMatrixAt(n, tmp.matrix);
        head.setMatrixAt(n, tmp.matrix);
        pack.setMatrixAt(n, tmp.matrix);
        body.setColorAt(n, col.set(SHIRTS[(cycle + i) % SHIRTS.length] as string));
        pack.setColorAt(n, col.set(PACKS[(cycle * 3 + i) % PACKS.length] as string));
        n++;
      }
    }
    for (const m of [body, head, pack]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  if (!s) return null;
  return (
    <group>
      <Slabs items={lines} y={0.03} h={0.012} color="#f4f3ec" />
      {/* 足球门 */}
      {[-1, 1].map((sx) => (
        <group key={sx} position={[s.field.x + sx * (s.field.w / 2 - 1.6), 0, s.field.z]}>
          {[-1.8, 1.8].map((dz) => (
            <mesh key={dz} position={[0, 1, dz]}>
              <cylinderGeometry args={[0.05, 0.05, 2, 6]} />
              <meshToonMaterial color="#f4f4f0" gradientMap={toonGradient()} />
            </mesh>
          ))}
          <mesh position={[0, 2, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 3.6, 6]} />
            <meshToonMaterial color="#f4f4f0" gradientMap={toonGradient()} />
          </mesh>
        </group>
      ))}
      {/* 旗杆和旗 */}
      <group position={[s.flag.x, 0, s.flag.z]}>
        <mesh position={[0, 4.5, 0]} castShadow>
          <cylinderGeometry args={[0.06, 0.08, 9, 8]} />
          <meshToonMaterial color="#d6dadd" gradientMap={toonGradient()} />
        </mesh>
        <mesh ref={flag} position={[0.65, 8.3, 0]}>
          <boxGeometry args={[1.3, 0.8, 0.02]} />
          <meshToonMaterial color="#d6453a" gradientMap={toonGradient()} />
        </mesh>
      </group>
      {/* 校牌 */}
      <group position={[s.sign.x, 0, s.sign.z]}>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[2.8, 1, 0.3]} />
          <meshToonMaterial color="#b9b1a3" gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0, 1.45, -0.02]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[2.6, 0.98]} />
          <meshToonMaterial map={tex} gradientMap={toonGradient()} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {/* 学生：上衣、头、书包（书包在背后，朝行走方向的反面） */}
      <instancedMesh ref={kidBody} args={[kidGeo.body, undefined, MAX_KIDS]} frustumCulled={false} castShadow>
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={kidHead} args={[kidGeo.head, undefined, MAX_KIDS]} frustumCulled={false}>
        <meshToonMaterial color="#e2b48f" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={kidPack} args={[kidGeo.pack, undefined, MAX_KIDS]} frustumCulled={false}>
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      {/* 护导员：荧光背心、手举停车牌 */}
      <group ref={guard} position={[s.crossX + 2.1, 0.08, site.roadBottomZ - 1.2]} visible={false}>
        <mesh position={[0, 0.45, 0]}>
          <cylinderGeometry args={[0.13, 0.15, 0.9, 8]} />
          <meshToonMaterial color="#2d3a4a" gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0, 1.2, 0]}>
          <cylinderGeometry args={[0.2, 0.18, 0.62, 8]} />
          <meshToonMaterial color="#d7f23a" gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0, 1.66, 0]}>
          <sphereGeometry args={[0.13, 10, 8]} />
          <meshToonMaterial color="#e2b48f" gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0.32, 1.7, 0]}>
          <cylinderGeometry args={[0.02, 0.02, 1.1, 5]} />
          <meshToonMaterial color="#5b6168" gradientMap={toonGradient()} />
        </mesh>
        <mesh position={[0.32, 2.3, 0]} rotation={[0, Math.PI / 2, 0]}>
          <cylinderGeometry args={[0.28, 0.28, 0.03, 8]} />
          <meshToonMaterial color="#d6332a" gradientMap={toonGradient()} />
        </mesh>
      </group>
    </group>
  );
}
