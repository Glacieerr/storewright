import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { SCENE } from './palette';
import { toonGradient } from './toon';
import { useNightGlow } from './environment';

/**
 * 人物（基础轮廓）：上身（衣服颜色）、下身（裤子颜色）和头三个圆润的部件，加上可选的手推车，全部实例化绘制。
 * 不画四肢和五官，只保留能看出岗位颜色和朝向的轮廓；走路时身体轻微起伏、前倾。
 * 肤色和身高由 seed 决定（同一个人始终一样）；孩子用较小的 scale。
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

/** 由 seed 得到稳定的外貌：肤色、身高系数 */
function looks(seed: number): { skin: THREE.Color; height: number } {
  let h = Math.floor(Math.abs(seed) * 1000 + 17) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  // 0 ≤ r < 1（除以 256，保证下标不越界）
  const r = (k: number) => ((h >>> k) & 0xff) / 256;
  return { skin: SKINS[Math.floor(r(8) * SKINS.length)] as THREE.Color, height: 0.92 + r(24) * 0.16 };
}

interface Props {
  max: number;
  /** 每帧填充人物状态，返回人数 */
  fill: (out: PersonState[]) => number;
  onSelect?: (index: number) => void;
  /** 右键：登记菜单目标 */
  onContext?: (index: number, e: ThreeEvent<MouseEvent>) => void;
}

/** 购物车 / 拣货车：车筐（四面细框 + 底）、推把、底架和四个小轮（单位尺寸，按 cart 类型缩放） */
function cartGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g.toNonIndexed());
  };
  // 车筐：底、两侧、前后（细框，看起来是空的）
  add(0.52, 0.03, 0.78, 0, 0.62, 0);
  for (const sx of [-0.26, 0.26]) {
    add(0.03, 0.34, 0.78, sx, 0.79, 0);
    add(0.03, 0.03, 0.78, sx, 0.97, 0);
  }
  add(0.52, 0.34, 0.03, 0, 0.79, 0.39);
  add(0.52, 0.03, 0.03, 0, 0.97, -0.39);
  // 推把
  add(0.56, 0.04, 0.04, 0, 1.04, -0.46);
  for (const sx of [-0.25, 0.25]) add(0.03, 0.12, 0.03, sx, 0.99, -0.43);
  // 底架与轮子
  add(0.4, 0.03, 0.7, 0, 0.18, 0.02);
  for (const sx of [-0.2, 0.2]) for (const sz of [-0.3, 0.32]) add(0.04, 0.1, 0.1, sx, 0.06, sz);
  for (const sx of [-0.2, 0.2]) add(0.03, 0.46, 0.03, sx, 0.4, -0.3);
  const merged = new THREE.BufferGeometry();
  let n = 0;
  for (const g of parts) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nrm.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return merged;
}

export function People({ max, fill, onSelect, onContext }: Props) {
  const people = useMemo(() => makePeople(max), [max]);
  const upper = useRef<THREE.InstancedMesh>(null);
  const lower = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const cart = useRef<THREE.InstancedMesh>(null);
  const glowU = useNightGlow<THREE.MeshToonMaterial>(0.35);
  const glowL = useNightGlow<THREE.MeshToonMaterial>(0.3);
  const glowH = useNightGlow<THREE.MeshToonMaterial>(0.35);
  const glowC = useNightGlow<THREE.MeshToonMaterial>(0.3);

  useFrame(() => {
    const U = upper.current;
    const L = lower.current;
    const H = head.current;
    const C = cart.current;
    if (!U || !L || !H || !C) return;
    const n = Math.min(max, fill(people));
    const now = performance.now() / 1000;
    let carts = 0;
    for (let i = 0; i < n; i++) {
      const p = people[i] as PersonState;
      const s = p.scale;
      const look = looks(p.seed);
      // 走路：按真实时间起伏（高倍速播放时也不会抽搐），身体略微前倾、左右轻晃
      const freq = s < 1 ? 10 : 8;
      const ph = now * freq + p.seed;
      const bob = p.moving ? Math.abs(Math.cos(ph)) * 0.035 * s : 0;
      const lean = p.moving ? 0.07 : 0;
      const sway = p.moving ? Math.sin(ph) * 0.035 : 0;
      base.position.set(p.x, p.y + bob, p.z);
      base.rotation.set(lean, p.heading, sway, 'YXZ');
      base.scale.set(s, s * look.height, s);
      base.updateMatrix();
      const put = (mesh: THREE.InstancedMesh, idx: number, y: number, z = 0) => {
        part.position.set(0, y, z);
        part.rotation.set(0, 0, 0);
        part.scale.set(1, 1, 1);
        part.updateMatrix();
        mesh.setMatrixAt(idx, m4.multiplyMatrices(base.matrix, part.matrix));
      };
      put(U, i, 1.12);
      U.setColorAt(i, p.shirt);
      put(L, i, 0.47);
      L.setColorAt(i, p.pants);
      put(H, i, 1.6);
      H.setColorAt(i, look.skin);
      if (p.cart !== 'none' && carts < max) {
        // 推车：车放在人前面（不跟着身体前倾），补货车更高
        base.rotation.set(0, p.heading, 0);
        base.position.set(p.x, p.y, p.z);
        base.scale.setScalar(s);
        base.updateMatrix();
        part.position.set(0, 0, p.cart === 'stocking' ? 0.82 : 0.72);
        part.rotation.set(0, 0, 0);
        part.scale.set(p.cart === 'stocking' ? 1.15 : 1, p.cart === 'stocking' ? 1.45 : 1, p.cart === 'stocking' ? 1.2 : 1);
        part.updateMatrix();
        C.setMatrixAt(carts, m4.multiplyMatrices(base.matrix, part.matrix));
        C.setColorAt(carts, p.cart === 'picking' ? CART_PICK : p.cart === 'stocking' ? CART_STOCK : CART_SHOP);
        carts++;
      }
    }
    for (let i = n; i < max; i++) {
      U.setMatrixAt(i, HIDDEN);
      H.setMatrixAt(i, HIDDEN);
    }
    U.count = n;
    L.count = n;
    H.count = n;
    C.count = carts;
    for (const m of [U, L, H, C]) {
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

  const cartGeo = useMemo(() => cartGeometry(), []);
  return (
    <group>
      <instancedMesh ref={upper} args={[undefined, undefined, max]} frustumCulled={false} castShadow onClick={click} onContextMenu={context}>
        <capsuleGeometry args={[0.2, 0.34, 6, 16]} />
        <meshToonMaterial ref={glowU} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={lower} args={[undefined, undefined, max]} frustumCulled={false} castShadow onClick={click} onContextMenu={context}>
        <capsuleGeometry args={[0.16, 0.58, 6, 14]} />
        <meshToonMaterial ref={glowL} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, max]} frustumCulled={false} castShadow onClick={click} onContextMenu={context}>
        <sphereGeometry args={[0.165, 18, 14]} />
        <meshToonMaterial ref={glowH} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
      <instancedMesh ref={cart} args={[cartGeo, undefined, max]} frustumCulled={false} castShadow>
        <meshToonMaterial ref={glowC} color="#ffffff" gradientMap={toonGradient()} />
      </instancedMesh>
    </group>
  );
}
