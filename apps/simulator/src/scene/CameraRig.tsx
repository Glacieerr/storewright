import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { MapControls, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useApp, type ViewMode } from '../state/store';
import { activeControls } from './drag';
import { framePositions } from './Actors';

/**
 * 镜头：三种视角各自的相机与控制器，加上
 * - 默认取景：正对门店右前方，门店和停车场完整入画（透视视角按视场角计算距离）；
 * - 滚轮朝光标位置缩放；键盘 WASD / 方向键平移，Q / E 旋转，R / F 俯仰，+ / − 缩放；
 * - 90° 旋转、预设机位（正面、侧面、鸟瞰、复位），平滑过渡；
 * - 跟随选中的员工或车辆；平移范围限制在场地内。
 */

// 从门店右前方看过去：停车场和交付门口在近处，店内在后面
export const ISO_DIR = new THREE.Vector3(1, 1.15, -1).normalize();
const FOV = 42;

/** 两种控制器共有的最小接口 */
export interface ControlsLike {
  target: THREE.Vector3;
  object: THREE.Camera;
  update(): void;
  enabled: boolean;
}

/** 当前镜头在地面上的可视范围（小地图用）：四个角的 (x, z)，以及目标点 */
export { cameraState } from './cameraState';
import { cameraState } from './cameraState';
import { useSiteLayout } from './useSite';

const ndc = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

function updateFootprint(camera: THREE.Camera, target: THREE.Vector3): void {
  cameraState.footprint = ndc.flatMap(([x, y]) => {
    ray.setFromCamera(new THREE.Vector2(x, y), camera);
    const p = ray.ray.intersectPlane(ground, hit);
    if (!p) return [];
    // 透视相机看向地平线时交点会非常远，限制一下
    const dx = p.x - target.x;
    const dz = p.z - target.z;
    const d = Math.hypot(dx, dz);
    const k = d > 400 ? 400 / d : 1;
    return [{ x: target.x + dx * k, z: target.z + dz * k }];
  });
  cameraState.target = { x: target.x, z: target.z };
  const dir = new THREE.Vector3().subVectors(camera.position, target);
  cameraState.azimuth = Math.atan2(dir.x, dir.z);
  const r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).setY(0);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).setY(0);
  if (r.lengthSq() > 1e-8) r.normalize();
  if (u.lengthSq() > 1e-8) u.normalize();
  cameraState.right = { x: r.x, z: r.z };
  cameraState.up = { x: u.x, z: u.z };
}

function useFrameBounds(view: ViewMode) {
  const geo = useApp((s) => s.geo);
  const floor = useApp((s) => s.floor);
  const { size } = useThree();
  const box = useMemo(() => {
    const fb = geo.floors.find((f) => f.floorId === floor) ?? (geo.floors[0] as (typeof geo.floors)[number]);
    let { minX, maxX, minZ, maxZ } = fb;
    for (const f of geo.facilities) {
      minX = Math.min(minX, f.x0);
      maxX = Math.max(maxX, f.x1);
    }
    if (fb.level === 0 || floor === 'ALL') {
      for (const p of geo.parking) {
        minX = Math.min(minX, p.x - 2);
        maxX = Math.max(maxX, p.x + 2);
        minZ = Math.min(minZ, p.z - 3.5);
        maxZ = Math.max(maxZ, p.z + 3.5);
      }
    }
    const top = floor === 'ALL' ? Math.max(...geo.floors.map((f) => f.y)) + 3 : fb.y + 3;
    return { minX, maxX, minZ, maxZ, y: floor === 'ALL' ? 0 : fb.y, top };
  }, [geo, floor]);

  const frame = useMemo(() => {
    const c0 = new THREE.Vector3((box.minX + box.maxX) / 2, box.y, (box.minZ + box.maxZ) / 2);
    const span = Math.max(box.maxX - box.minX, box.maxZ - box.minZ);
    const fwd = (view === 'top' ? new THREE.Vector3(0, 1, 0) : ISO_DIR.clone()).negate();
    const up0 = view === 'top' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, up0).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let r0 = Infinity;
    let r1 = -Infinity;
    let u0 = Infinity;
    let u1 = -Infinity;
    const p = new THREE.Vector3();
    for (const x of [box.minX, box.maxX])
      for (const y of [box.y, box.top])
        for (const z of [box.minZ, box.maxZ]) {
          p.set(x, y, z).sub(c0);
          const r = p.dot(right);
          const u = p.dot(up);
          r0 = Math.min(r0, r);
          r1 = Math.max(r1, r);
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
        }
    const center = view === '3d' ? c0 : c0.clone().addScaledVector(right, (r0 + r1) / 2).addScaledVector(up, (u0 + u1) / 2);
    return { center, span, w: r1 - r0, h: u1 - u0, box };
  }, [box, view]);

  const aspect = size.width / Math.max(1, size.height);
  const zoom = Math.max(2, Math.min(size.width / frame.w, size.height / frame.h) * 0.9);
  // 透视：按视场角求出能完整看到投影范围所需的距离
  const vfov = (FOV * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const distance = Math.max(frame.h / 2 / Math.tan(vfov / 2), frame.w / 2 / Math.tan(hfov / 2)) * 1.05;
  return { center: frame.center, span: frame.span, zoom, distance, box: frame.box };
}

/** 平滑过渡：位置和目标点在 0.6 秒内插值到新值 */
interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom?: number;
  toZoom?: number;
  t: number;
}

const KEYS = new Set<string>();
function isTyping(e: KeyboardEvent): boolean {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
}

function ViewRig({ view }: { view: ViewMode }) {
  const { center, span, zoom, distance, box } = useFrameBounds(view);
  const ground = useSiteLayout().ground;
  const camRef = useRef<THREE.Camera | null>(null);
  const controls = useRef<ControlsLike | null>(null);
  const [camera, setCamera] = useState<THREE.Camera | null>(null);
  useLayoutEffect(() => setCamera(camRef.current), []);
  const tween = useRef<Tween | null>(null);
  const homePos = (c: THREE.Vector3) => (view === 'top' ? new THREE.Vector3(c.x, c.y + 200, c.z) : view === 'iso' ? c.clone().add(ISO_DIR.clone().multiplyScalar(300)) : c.clone().add(new THREE.Vector3(0.62, 0.72, -1).normalize().multiplyScalar(distance)));
  // 相机的初始位置和缩放只在挂载时设定，之后增量调整，不覆盖用户的平移和缩放
  const [initial] = useState(() => ({ center: center.clone(), zoom, pos: homePos(center) }));

  const startTween = (toPos: THREE.Vector3, toTarget: THREE.Vector3, toZoom?: number) => {
    const c = controls.current;
    if (!c) return;
    const cam = c.object;
    tween.current = {
      fromPos: cam.position.clone(),
      toPos,
      fromTarget: c.target.clone(),
      toTarget,
      fromZoom: cam instanceof THREE.OrthographicCamera ? cam.zoom : undefined,
      toZoom,
      t: 0,
    };
  };

  // 画面中心变化（换楼层、改布局）时整体平移，保持当前视线方向
  const lastCenter = useRef<THREE.Vector3 | null>(null);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (!lastCenter.current) c.target.copy(center);
    else {
      const d = center.clone().sub(lastCenter.current);
      c.target.add(d);
      c.object.position.add(d);
    }
    lastCenter.current = center.clone();
    c.update();
    activeControls.current = c;
  }, [center, camera]);

  // 窗口或分屏比例变化：按适配缩放的比例同步调整，保留用户自己的放大倍数
  const lastFit = useRef(zoom);
  useEffect(() => {
    const cam = controls.current?.object;
    if (cam instanceof THREE.OrthographicCamera && lastFit.current > 0) {
      cam.zoom = Math.min(400, Math.max(2, cam.zoom * (zoom / lastFit.current)));
      cam.updateProjectionMatrix();
    }
    lastFit.current = zoom;
  }, [zoom]);

  // 镜头指令：缩放、复位、旋转 90°、预设机位
  const cmd = useApp((s) => s.zoomCmd);
  useEffect(() => {
    const c = controls.current;
    if (!cmd || !c) return;
    const cam = c.object;
    const offset = cam.position.clone().sub(c.target);
    if (cmd.kind === 'in' || cmd.kind === 'out') {
      const k = cmd.kind === 'in' ? 1.35 : 1 / 1.35;
      if (cam instanceof THREE.OrthographicCamera) startTween(cam.position.clone(), c.target.clone(), Math.min(400, Math.max(2, cam.zoom * k)));
      else startTween(c.target.clone().add(offset.multiplyScalar(1 / k)), c.target.clone());
    } else if (cmd.kind === 'reset') {
      startTween(homePos(center), center.clone(), cam instanceof THREE.OrthographicCamera ? zoom : undefined);
    } else if (cmd.kind === 'rotateLeft' || cmd.kind === 'rotateRight') {
      if (view === 'top') {
        // 俯视图绕竖直轴转动「上」方向
        const up = cam.up.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), cmd.kind === 'rotateLeft' ? Math.PI / 2 : -Math.PI / 2);
        cam.up.copy(up);
        c.update();
      } else {
        const rotated = offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), cmd.kind === 'rotateLeft' ? Math.PI / 2 : -Math.PI / 2);
        startTween(c.target.clone().add(rotated), c.target.clone());
      }
    } else if (view === '3d') {
      const t = center.clone();
      const d = distance;
      const dir = cmd.kind === 'front' ? new THREE.Vector3(0, 0.55, -1) : cmd.kind === 'side' ? new THREE.Vector3(1, 0.5, -0.15) : cmd.kind === 'bird' ? new THREE.Vector3(0.15, 2.4, -0.6) : new THREE.Vector3(0.3, 0.12, -1);
      const dist = cmd.kind === 'street' ? d * 0.35 : d;
      startTween(t.clone().add(dir.normalize().multiplyScalar(dist)), cmd.kind === 'street' ? t.clone().setY(2) : t);
    }
  }, [cmd]);

  // 取景：保持视线方向，让半径 radius 的范围填满画面
  const frameCmd = useApp((s) => s.frameCmd);
  const { size } = useThree();
  useEffect(() => {
    const c = controls.current;
    if (!c || !frameCmd) return;
    const to = new THREE.Vector3(frameCmd.x, frameCmd.y, frameCmd.z);
    const cam = c.object;
    if (cam instanceof THREE.OrthographicCamera) {
      const z = Math.min(400, Math.max(2, Math.min(size.width, size.height) / (2.3 * frameCmd.radius)));
      startTween(cam.position.clone().add(to.clone().sub(c.target)), to, z);
    } else {
      const dir = cam.position.clone().sub(c.target).normalize();
      const dist = frameCmd.radius / Math.tan(((FOV * Math.PI) / 180) / 2) * 1.15;
      startTween(to.clone().addScaledVector(dir, Math.max(6, dist)), to);
    }
  }, [frameCmd]);

  // 定位：保持视线方向，把目标点平移到指定位置
  const focus = useApp((s) => s.focus);
  useEffect(() => {
    const c = controls.current;
    if (!c || !focus) return;
    const to = new THREE.Vector3(focus.x, focus.y, focus.z);
    startTween(c.object.position.clone().add(to.clone().sub(c.target)), to);
  }, [focus]);

  // 跟随：目标点平滑跟随选中的员工或车辆
  const follow = useApp((s) => s.follow);

  // 键盘镜头控制
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      // 编辑中选中了通道：方向键用来微调通道，不平移镜头
      const st = useApp.getState();
      if (k.startsWith('arrow') && st.mode === 'edit' && st.editSel.length) return;
      if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '=', '+', '-'].includes(k)) {
        KEYS.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => KEYS.delete(e.key.toLowerCase());
    const blur = () => KEYS.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const tmpV = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const cam = c.object;
    const dt = Math.min(delta, 0.05);
    let changed = false;
    // 自动巡游时镜头由巡游导演控制
    if (useApp.getState().cinematic) {
      tween.current = null;
      updateFootprint(cam, c.target);
      return;
    }

    // 过渡动画
    const tw = tween.current;
    if (tw) {
      tw.t = Math.min(1, tw.t + dt / 0.6);
      const k = 1 - Math.pow(1 - tw.t, 3);
      cam.position.lerpVectors(tw.fromPos, tw.toPos, k);
      c.target.lerpVectors(tw.fromTarget, tw.toTarget, k);
      if (cam instanceof THREE.OrthographicCamera && tw.fromZoom !== undefined && tw.toZoom !== undefined) {
        cam.zoom = tw.fromZoom + (tw.toZoom - tw.fromZoom) * k;
        cam.updateProjectionMatrix();
      }
      if (tw.t >= 1) tween.current = null;
      changed = true;
    }

    // 键盘：平移速度与可视范围成正比
    if (KEYS.size) {
      const offset = tmpV.subVectors(cam.position, c.target);
      const scale = cam instanceof THREE.OrthographicCamera ? 600 / cam.zoom : offset.length();
      const fwd = view === 'top' ? cam.up.clone().setY(0).normalize() : new THREE.Vector3(-offset.x, 0, -offset.z).normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (KEYS.has('w') || KEYS.has('arrowup')) move.add(fwd);
      if (KEYS.has('s') || KEYS.has('arrowdown')) move.sub(fwd);
      if (KEYS.has('d') || KEYS.has('arrowright')) move.add(right);
      if (KEYS.has('a') || KEYS.has('arrowleft')) move.sub(right);
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(scale * 0.8 * dt);
        c.target.add(move);
        cam.position.add(move);
      }
      if (view !== 'top' && (KEYS.has('q') || KEYS.has('e'))) {
        const ang = (KEYS.has('q') ? 1 : -1) * dt * 1.4;
        const o = cam.position.clone().sub(c.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        cam.position.copy(c.target).add(o);
      }
      if (view === '3d' && (KEYS.has('r') || KEYS.has('f'))) {
        const o = cam.position.clone().sub(c.target);
        const sph = new THREE.Spherical().setFromVector3(o);
        sph.phi = Math.min(Math.PI / 2.15, Math.max(0.15, sph.phi + (KEYS.has('r') ? -1 : 1) * dt * 0.9));
        cam.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph));
      }
      if (KEYS.has('=') || KEYS.has('+') || KEYS.has('-')) {
        const k = Math.exp((KEYS.has('-') ? -1 : 1) * dt * 1.6);
        if (cam instanceof THREE.OrthographicCamera) {
          cam.zoom = Math.min(400, Math.max(2, cam.zoom * k));
          cam.updateProjectionMatrix();
        } else cam.position.copy(c.target).add(cam.position.clone().sub(c.target).multiplyScalar(1 / k));
      }
      changed = true;
    }

    // 跟随
    if (follow) {
      const p = framePositions.get(follow);
      if (p) {
        const want = new THREE.Vector3(p.x, p.y, p.z);
        const d = want.sub(c.target).multiplyScalar(Math.min(1, dt * 4));
        c.target.add(d);
        cam.position.add(d);
        changed = true;
      }
    }

    // 平移范围：目标点不离开沙盘（周边街区；有出海口时包括海湾，决策记录 0019），也不小于门店本身
    const cx = Math.min(Math.max(box.maxX, ground.x + ground.w / 2), Math.max(Math.min(box.minX, ground.x - ground.w / 2), c.target.x));
    const cz = Math.min(Math.max(box.maxZ, ground.z + ground.d / 2), Math.max(Math.min(box.minZ, ground.z - ground.d / 2), c.target.z));
    if (cx !== c.target.x || cz !== c.target.z) {
      const d = new THREE.Vector3(cx - c.target.x, 0, cz - c.target.z);
      c.target.add(d);
      cam.position.add(d);
      changed = true;
    }
    if (changed) c.update();
    updateFootprint(cam, c.target);
  });

  const p0 = initial.pos;
  return (
    <>
      {view === '3d' && <PerspectiveCamera ref={camRef as never} makeDefault fov={FOV} near={0.5} far={3000} position={[p0.x, p0.y, p0.z]} />}
      {view === 'top' && <OrthographicCamera ref={camRef as never} makeDefault zoom={initial.zoom} near={-500} far={2000} position={[p0.x, p0.y, p0.z]} up={[0, 0, 1]} />}
      {view === 'iso' && <OrthographicCamera ref={camRef as never} makeDefault zoom={initial.zoom} near={-500} far={3000} position={[p0.x, p0.y, p0.z]} />}
      {camera && view === '3d' && (
        <OrbitControls
          ref={controls as never}
          camera={camera}
          makeDefault
          enableDamping
          dampingFactor={0.1}
          rotateSpeed={0.6}
          panSpeed={0.9}
          zoomSpeed={0.9}
          zoomToCursor
          screenSpacePanning={false}
          maxPolarAngle={Math.PI / 2.15}
          minDistance={4}
          maxDistance={span * 4}
        />
      )}
      {camera && view === 'top' && <MapControls ref={controls as never} camera={camera} makeDefault enableRotate={false} zoomToCursor screenSpacePanning enableDamping dampingFactor={0.15} />}
      {camera && view === 'iso' && <MapControls ref={controls as never} camera={camera} makeDefault enableRotate minPolarAngle={0.55} maxPolarAngle={1.15} zoomToCursor screenSpacePanning enableDamping dampingFactor={0.15} />}
    </>
  );
}

export function CameraRig() {
  const view = useApp((s) => s.view);
  return <ViewRig key={view} view={view} />;
}
