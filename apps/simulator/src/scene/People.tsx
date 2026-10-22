import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { SCENE } from './palette';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';

/**
 * 人物：躯干、头、头发（短发 / 长发 / 帽子 / 光头）、双臂、双腿和可选的手推车，全部实例化绘制。
 * 走路时手臂和腿交替摆动（按真实时间摆动，高倍速播放时也不会抽搐），站立时自然下垂。
 * 发型、发色、肤色和身高由 seed 决定（同一个人始终一样）；孩子用较小的 scale。
 */

export interface PersonState {
  x: number;
  y: number;
  z: number;
  heading: number;
  moving: boolean;
  shirt: THREE.Color;
  pants: THREE.Color;
  /** 推车（拣货车、购物车或夜班补货用的高货车） */
  cart: 'none' | 'picking' | 'shopping' | 'stocking';
  scale: number;
  seed: number;
}

export function makePeople(n: number): PersonState[] {
  return Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, heading: 0, moving: false, shirt: new THREE.Color(), pants: new THREE.Color('#3b4250'), cart: 'none', scale: 1, seed: 0 }));
}

const base = new THREE.Object3D();
const part = new THREE.Object3D();
const m4 = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const CART_PICK = new THREE.Color(SCENE.cart);
const CART_SHOP = new THREE.Color('#b8c2cc');
const CART_STOCK = new THREE.Color('#3f6b4f');
const SKINS = ['#f1d3b8', '#e8bf9a', '#d6a37c', '#b9805a', '#8d5a3b', '#f5dcc6'].map((c) => new THREE.Color(c));
const HAIRS = ['#2b2420', '#4a3426', '#6b4a2f', '#a07a4f', '#d8c090', '#8a8a8a', '#1c1c1c'].map((c) => new THREE.Color(c));
const CAPS = ['#c0392b', '#2c3e50', '#27ae60', '#f39c12', '#ecf0f1'].map((c) => new THREE.Color(c));

/** 由 seed 得到稳定的外貌：发型 0 光头 / 1 短发 / 2 长发 / 3 帽子，肤色、发色、身高系数 */
function looks(seed: number): { hair: number; skin: THREE.Color; hairColor: THREE.Color; height: number } {
  let h = Math.floor(Math.abs(seed) * 1000 + 17) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  // 0 ≤ r < 1（除以 256，保证下标不越界）
  const r = (k: number) => ((h >>> k) & 0xff) / 256;
  const hs = r(0);
  const hair = hs < 0.08 ? 0 : hs < 0.55 ? 1 : hs < 0.85 ? 2 : 3;
  return {
    hair,
    skin: SKINS[Math.floor(r(8) * SKINS.length)] as THREE.Color,
    hairColor: hair === 3 ? (CAPS[Math.floor(r(16) * CAPS.length)] as THREE.Color) : (HAIRS[Math.floor(r(16) * HAIRS.length)] as THREE.Color),
    height: 0.92 + r(24) * 0.16,
  };
}

interface Props {
  max: number;
  /** 每帧填充人物状态，返回人数 */
  fill: (out: PersonState[]) => number;
  onSelect?: (index: number) => void;
  /** 右键：登记菜单目标 */
  onContext?: (index: number, e: ThreeEvent<MouseEvent>) => void;
}

export function People({ max, fill, onSelect, onContext }: Props) {
  const people = useMemo(() => makePeople(max), [max]);
  const torso = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const legs = useRef<THREE.InstancedMesh>(null);
  const arms = useRef<THREE.InstancedMesh>(null);
  const cart = useRef<THREE.InstancedMesh>(null);
  const hairTop = useRef<THREE.InstancedMesh>(null);
  const hairBack = useRef<THREE.InstancedMesh>(null);
  const glowHair = useNightGlow<THREE.MeshToonMaterial>(0.3);
  const glowT = useNightGlow<THREE.MeshToonMaterial>(0.35);
  const glowH = useNightGlow<THREE.MeshToonMaterial>(0.35);
  const glowL = useNightGlow<THREE.MeshToonMaterial>(0.3);
  const glowA = useNightGlow<THREE.MeshToonMaterial>(0.35);
  const glowC = useNightGlow<THREE.MeshToonMaterial>(0.3);

  useFrame(() => {
    const T = torso.current;
    const H = head.current;
    const L = legs.current;
    const A = arms.current;
    const C = cart.current;
    const HT = hairTop.current;
    const HB = hairBack.current;
    if (!T || !H || !L || !A || !C || !HT || !HB) return;
    const n = Math.min(max, fill(people));
    const now = performance.now() / 1000;
    let carts = 0;
    let tops = 0;
    let backs = 0;
    for (let i = 0; i < n; i++) {
      const p = people[i] as PersonState;
      const s = p.scale;
      const look = looks(p.seed);
      // 孩子（scale 小）走得快一点、摆得更频
      const freq = s < 1 ? 10 : 8;
      const swing = p.moving ? Math.sin(now * freq + p.seed) * 0.55 : 0;
      const bob = p.moving ? Math.abs(Math.cos(now * freq + p.seed)) * 0.04 * s : 0;
      base.position.set(p.x, p.y + bob, p.z);
      base.rotation.set(0, p.heading, 0);
      base.scale.set(s, s * look.height, s);
      base.updateMatrix();
      // 部件在人物局部坐标中的位置；四肢几何体的原点在关节处，绕关节摆动
      const put = (mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rx: number, sx: number, sy: number, sz: number) => {
        part.position.set(x, y, z);
        part.rotation.set(rx, 0, 0);
        part.scale.set(sx, sy, sz);
        part.updateMatrix();
        mesh.setMatrixAt(idx, m4.multiplyMatrices(base.matrix, part.matrix));
      };
      put(T, i, 0, 0.98, 0, 0, 1, 1, 1);
      T.setColorAt(i, p.shirt);
      put(H, i, 0, 1.56, 0, 0, 1, 1, 1);
      H.setColorAt(i, look.skin);
      // 头发：短发和长发是头顶的半球，长发再加脑后一片；帽子是彩色帽顶加帽檐
      if (look.hair > 0 && tops < max) {
        put(HT, tops, 0, look.hair === 3 ? 1.61 : 1.6, -0.01, 0, look.hair === 3 ? 1.12 : 1.08, look.hair === 3 ? 0.78 : 0.8, look.hair === 3 ? 1.12 : 1.08);
        HT.setColorAt(tops++, look.hairColor);
      }
      if (look.hair === 2 && backs < max * 2) {
        put(HB, backs, 0, 1.5, -0.13, 0, 0.3, 0.32, 0.1);
        HB.setColorAt(backs++, look.hairColor);
      }
      if (look.hair === 3 && backs < max * 2) {
        put(HB, backs, 0, 1.63, 0.15, 0, 0.26, 0.03, 0.16);
        HB.setColorAt(backs++, look.hairColor);
      }
      // 腿：髋关节在 0.72 米高处；推车时手臂前伸
      put(L, i * 2, 0.1, 0.72, 0, swing, 0.13, 0.7, 0.15);
      put(L, i * 2 + 1, -0.1, 0.72, 0, -swing, 0.13, 0.7, 0.15);
      L.setColorAt(i * 2, p.pants);
      L.setColorAt(i * 2 + 1, p.pants);
      const armRest = p.cart !== 'none' ? -1.1 : 0;
      put(A, i * 2, 0.27, 1.28, 0, armRest + (p.cart !== 'none' ? 0 : -swing), 0.1, 0.55, 0.1);
      put(A, i * 2 + 1, -0.27, 1.28, 0, armRest + (p.cart !== 'none' ? 0 : swing), 0.1, 0.55, 0.1);
      A.setColorAt(i * 2, p.shirt);
      A.setColorAt(i * 2 + 1, p.shirt);
      if (p.cart !== 'none' && carts < max) {
        // 补货车更高，装满纸箱
        if (p.cart === 'stocking') put(C, carts, 0, 0.75, 0.85, 0, 0.62, 1.3, 1.0);
        else put(C, carts, 0, 0.5, 0.75, 0, 0.55, 0.55, 0.8);
        C.setColorAt(carts, p.cart === 'picking' ? CART_PICK : p.cart === 'stocking' ? CART_STOCK : CART_SHOP);
        carts++;
      }
    }
    for (let i = n; i < max; i++) {
      T.setMatrixAt(i, HIDDEN);
      H.setMatrixAt(i, HIDDEN);
    }
    T.count = n;
    H.count = n;
    L.count = n * 2;
    A.count = n * 2;
    C.count = carts;
    HT.count = tops;
    HB.count = backs;
    for (const m of [T, H, L, A, C, HT, HB]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!onSelect || e.instanceId === undefined) return;
    e.stopPropagation();
    onSelect(e.instanceId);
  };
  const context = (e: ThreeEvent<MouseEvent>) => {
    if (!onContext || e.instanceId === undefined) return;
    onContext(e.instanceId, e);
  };

  // 腿和手臂的几何体原点在顶端（关节处），向下延伸
  const limb = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0), []);
  return (
    <group>
      <instancedMesh ref={torso} args={[undefined, undefined, max]} frustumCulled={false} castShadow onClick={click} onContextMenu={context}>
        <capsuleGeometry args={[0.2, 0.42, 4, 10]} />
        <meshToonMaterial ref={glowT} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, max]} frustumCulled={false} castShadow onClick={click} onContextMenu={context}>
        <sphereGeometry args={[0.16, 12, 10]} />
        <meshToonMaterial ref={glowH} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={hairTop} args={[undefined, undefined, max]} frustumCulled={false}>
        <sphereGeometry args={[0.16, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshToonMaterial ref={glowHair} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={hairBack} args={[undefined, undefined, max * 2]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshToonMaterial color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={legs} args={[limb, undefined, max * 2]} frustumCulled={false} castShadow>
        <meshToonMaterial ref={glowL} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={arms} args={[limb, undefined, max * 2]} frustumCulled={false}>
        <meshToonMaterial ref={glowA} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={cart} args={[undefined, undefined, max]} frustumCulled={false} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshToonMaterial ref={glowC} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}
