import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import { planShopper, shopperPose, type ShopperPose, type ShopperTrack } from './crowd';
import { People, type PersonState } from './People';
import { useStays } from './useSite';
import type { Stay } from './shoppers';
import { activeFire, evacuate } from './evacuation';

const SHIRTS = ['#d9d4c7', '#9fb4c7', '#c7a3a3', '#a7bfa0', '#e0c79a', '#8f8fa8', '#c2b4d6', '#7f9aa8', '#e3b9a8', '#b0b0b0'].map((c) => new THREE.Color(c));
const PANTS = ['#3b4250', '#5a5040', '#2f3a4f', '#6b6f75', '#4a3f3a'].map((c) => new THREE.Color(c));
const KID_SHIRTS = ['#e74c3c', '#f1c40f', '#3498db', '#9b59b6', '#2ecc71', '#ff7fa8'].map((c) => new THREE.Color(c));
const MAX = 190;

/** 到店购物的顾客：与停车场里的私家车一一对应，下车走进门店，逛完再回到车上 */
export function Shoppers() {
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const floor = useApp((s) => s.floor);
  const view = useApp((s) => s.view);
  const stays = useStays();
  const entries = useMemo(() => {
    const out: Array<{ stay: Stay; key: number }> = [];
    stays.forEach((list, spot) => list.forEach((stay, k) => !stay.staff && out.push({ stay, key: spot * 64 + k })));
    return out.sort((a, b) => a.stay.arrive - b.stay.arrive);
  }, [stays]);
  const tracks = useMemo(() => new Map<number, ShopperTrack | null>(), [entries, model, geo]);
  const pose = useRef<ShopperPose>({ x: 0, y: 0, z: 0, heading: 0, moving: false, cart: false });
  const probe = useRef<ShopperPose>({ x: 0, y: 0, z: 0, heading: 0, moving: false, cart: false });
  const timeline = useApp((s) => s.timeline);

  const fill = (out: PersonState[]) => {
    const t = clock.time;
    const allFloors = view === '3d' && floor === 'ALL';
    const floorY = geo.floorY.get(floor) ?? 0;
    const fire = activeFire(timeline, t);
    let n = 0;
    for (const e of entries) {
      if (e.stay.arrive > t) break;
      if (t > e.stay.leave || n >= out.length) continue;
      let tr = tracks.get(e.key);
      if (tr === undefined) {
        tr = planShopper(model, geo, e.stay, e.key) ?? null;
        tracks.set(e.key, tr);
      }
      if (!tr || !shopperPose(tr, t, pose.current)) continue;
      const p = pose.current;
      const track = tr;
      // 火警时店里的顾客也走到集合点
      if (fire && p.y >= -0.1 && evacuate(p, 300 + (e.key % 400), t, fire, (tt) => (shopperPose(track, tt, probe.current) ? probe.current : undefined), geo.lot)) p.cart = false;
      if (!allFloors && Math.abs(p.y - floorY) > 0.5) continue;
      const o = out[n] as PersonState;
      o.x = p.x;
      o.y = p.y;
      o.z = p.z;
      o.heading = p.heading;
      o.moving = p.moving;
      o.shirt.copy(SHIRTS[e.key % SHIRTS.length] as THREE.Color);
      o.pants.copy(PANTS[(e.key >> 2) % PANTS.length] as THREE.Color);
      o.cart = p.cart ? 'shopping' : 'none';
      o.scale = 1.25;
      o.seed = e.key * 0.37;
      n++;
      // 约六分之一的顾客带着孩子：孩子走在大人左手边稍后一点
      if (e.key % 6 === 0 && n < out.length) {
        const k = out[n] as PersonState;
        const fx = Math.sin(p.heading);
        const fz = Math.cos(p.heading);
        k.x = p.x + fz * 0.75 - fx * 0.25;
        k.y = p.y;
        k.z = p.z - fx * 0.75 - fz * 0.25;
        k.heading = p.heading;
        k.moving = p.moving;
        k.shirt.copy(KID_SHIRTS[e.key % KID_SHIRTS.length] as THREE.Color);
        k.pants.copy(PANTS[(e.key >> 3) % PANTS.length] as THREE.Color);
        k.cart = 'none';
        k.scale = 0.78;
        k.seed = e.key * 0.37 + 5.1;
        n++;
      }
    }
    return n;
  };

  return <People max={MAX} fill={fill} />;
}
