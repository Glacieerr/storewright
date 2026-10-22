import { useMemo } from 'react';
import * as THREE from 'three';
import { useApp } from '../state/store';
import { People, type PersonState } from './People';
import { useSiteLayout } from './useSite';
import { trafficFor } from './traffic';

const MAX = 80;
const KID_SHIRTS = ['#e74c3c', '#f1c40f', '#3498db', '#9b59b6', '#2ecc71', '#ff7fa8'];

/** 路边行人：沿人行道走、在路口等行人绿灯过马路（与背景车流共用时钟） */
export function StreetPedestrians() {
  const site = useSiteLayout();
  const siteSeed = useApp((s) => s.site.seed);
  const traffic = useApp((s) => s.site.traffic);
  const floor = useApp((s) => s.floor);
  const geo = useApp((s) => s.simGeo);
  const colors = useMemo(() => new Map<string, THREE.Color>(), []);
  const visible = floor === 'ALL' || geo.floors.find((f) => f.floorId === floor)?.level === 0;
  const col = (hex: string) => {
    let c = colors.get(hex);
    if (!c) colors.set(hex, (c = new THREE.Color(hex)));
    return c;
  };

  const fill = (out: PersonState[]) => {
    if (!visible) return 0;
    const sim = trafficFor(site, siteSeed, traffic * 0.5);
    let n = 0;
    for (const w of sim.peds.walkers) {
      if (n >= out.length) break;
      const o = out[n] as PersonState;
      o.x = w.x;
      o.y = 0;
      o.z = w.z;
      o.heading = w.heading;
      o.moving = !w.waiting;
      o.shirt.copy(col(w.shirt));
      o.pants.copy(col(w.pants));
      o.cart = 'none';
      o.scale = 1.25 * w.scale;
      o.seed = w.seed;
      n++;
      if (w.kid && n < out.length) {
        const k = out[n] as PersonState;
        const fx = Math.sin(w.heading);
        const fz = Math.cos(w.heading);
        k.x = w.x + fz * 0.7 - fx * 0.2;
        k.y = 0;
        k.z = w.z - fx * 0.7 - fz * 0.2;
        k.heading = w.heading;
        k.moving = !w.waiting;
        k.shirt.copy(col(KID_SHIRTS[w.id % KID_SHIRTS.length] as string));
        k.pants.copy(col(w.pants));
        k.cart = 'none';
        k.scale = 0.78;
        k.seed = w.seed + 3.3;
        n++;
      }
    }
    return n;
  };

  return <People max={MAX} fill={fill} />;
}
