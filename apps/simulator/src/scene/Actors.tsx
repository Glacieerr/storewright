import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { MotionIndex, type Pose } from './motion';
import { ROLE_COLOR } from './palette';
import type { Vec3 } from './layout';
import { People, type PersonState } from './People';
import { armMenu } from './contextTarget';
import { activeFire, evacuate } from './evacuation';
import { makePolyPose, polyPose } from './polyTrace';


/** 当前帧各对象的位置，供选中标记和镜头跟随使用 */
export { framePositions } from './framePositions';
import { framePositions } from './framePositions';

const PANTS = new THREE.Color('#353c48');

/** 员工：按岗位着色的工作服，拣货员推着拣货车；四肢随走动摆动 */
export function Associates() {
  const timeline = useApp((s) => s.timeline);
  const model = useApp((s) => s.simModel);
  const geo = useApp((s) => s.simGeo);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const motion = useMemo(() => (timeline ? new MotionIndex(model, geo, timeline) : undefined), [timeline, model, geo]);
  const list = useMemo(() => timeline?.associates ?? [], [timeline]);
  const shirts = useMemo(() => list.map((a) => new THREE.Color(ROLE_COLOR[a.role])), [list]);
  const pose = useMemo<Pose>(() => ({ visible: false, x: 0, y: 0, z: 0, heading: 0, moving: false, withCart: false }), []);
  const slots = useRef<string[]>([]);

  const probe = useMemo<Pose>(() => ({ visible: false, x: 0, y: 0, z: 0, heading: 0, moving: false, withCart: false }), []);
  const fill = (out: PersonState[]) => {
    if (!motion) return 0;
    const t = clock.time;
    const allFloors = view === '3d' && floor === 'ALL';
    const fire = activeFire(timeline, t);
    let n = 0;
    list.forEach((a, i) => {
      motion.associatePose(a, t, pose);
      // 火警：走到停车场集合点，解除后走回
      if (fire && pose.visible && evacuate(pose, i, t, fire, (tt) => (motion.associatePose(a, tt, probe).visible ? probe : undefined), geo.lot)) pose.withCart = false;
      // 按高度判断所在楼层（乘电梯途中不显示在任何单一楼层视图里）
      const onFloor = allFloors || Math.abs(pose.y - (geo.floorY.get(floor) ?? 0)) < 0.5;
      if (!pose.visible || !onFloor || n >= out.length) {
        framePositions.delete(a.id);
        return;
      }
      const p = out[n] as PersonState;
      p.x = pose.x;
      p.y = pose.y;
      p.z = pose.z;
      p.heading = pose.heading;
      p.moving = pose.moving;
      p.shirt.copy(shirts[i] as THREE.Color);
      p.pants.copy(PANTS);
      p.cart = pose.withCart ? 'picking' : 'none';
      // 人物按约 1.4 倍显示，远景也能看清（模拟经营游戏的常见做法）
      p.scale = 1.4;
      p.seed = i * 1.7;
      slots.current[n] = a.id;
      framePositions.set(a.id, { x: pose.x, y: pose.y, z: pose.z });
      n++;
    });
    return n;
  };

  const id = (i: number) => slots.current[i];
  return (
    <People
      max={Math.max(1, list.length)}
      fill={fill}
      onSelect={(i) => id(i) && useApp.getState().select({ type: 'associate', id: id(i) as string })}
      onContext={(i, e) => id(i) && armMenu({ type: 'associate', id: id(i) as string }, e)}
    />
  );
}

const NIGHT_SHIRT = new THREE.Color('#2f5d8a');
const RECV_SHIRT = new THREE.Color('#c98b2c');
/** 开叉车时人在叉车上（叉车模型里有司机），不单独画 */
const ON_FORKLIFT = new Set(['叉车进车厢', '叉车卸货', '叉车去叉托盘', '叉车放进货架', '叉车举升放货', '叉车去高层货位', '叉车把高层托盘放到地面']);

/** 后仓人员：早班收货员（叉车、搬运车卸货、点数贴标）与夜班补货组（推货上架） */
export function BackroomCrew() {
  const timeline = useApp((s) => s.timeline);
  const geo = useApp((s) => s.simGeo);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const workers = useMemo(() => timeline?.inbound.workers ?? [], [timeline]);
  const pose = useMemo(() => makePolyPose(), []);
  const probe = useMemo(() => makePolyPose(), []);
  const slots = useRef<string[]>([]);
  const fill = (out: PersonState[]) => {
    const t = clock.time;
    const allFloors = view === '3d' && floor === 'ALL';
    const fire = activeFire(timeline, t);
    let n = 0;
    workers.forEach((w, i) => {
      if (!w.shifts.some(([a, b]) => t >= a && t < b) || !polyPose(w.segments, t, pose) || ON_FORKLIFT.has(pose.activity)) {
        framePositions.delete(w.id);
        return;
      }
      const p3 = { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, moving: pose.moving };
      if (fire) evacuate(p3, 400 + i, t, fire, (tt) => (polyPose(w.segments, tt, probe) ? { x: probe.x, y: probe.y, z: probe.z } : undefined), geo.lot);
      if (!allFloors && Math.abs(p3.y - (geo.floorY.get(floor) ?? 0)) > 0.5) return;
      const o = out[n];
      if (!o) return;
      o.x = p3.x;
      o.y = p3.y;
      o.z = p3.z;
      o.heading = p3.heading;
      o.moving = p3.moving;
      o.shirt.copy(w.role === 'night' ? NIGHT_SHIRT : RECV_SHIRT);
      o.pants.copy(PANTS);
      o.cart = pose.carry === 'cases' ? 'stocking' : 'none';
      o.scale = 1.4;
      o.seed = i * 2.3 + 0.7;
      slots.current[n] = w.id;
      framePositions.set(w.id, { x: p3.x, y: p3.y, z: p3.z });
      n++;
    });
    return n;
  };
  if (!workers.length) return null;
  const id = (i: number) => slots.current[i];
  return (
    <People
      max={workers.length}
      fill={fill}
      onSelect={(i) => id(i) && useApp.getState().select({ type: 'associate', id: id(i) as string })}
      onContext={(i, e) => id(i) && armMenu({ type: 'associate', id: id(i) as string }, e)}
    />
  );
}
