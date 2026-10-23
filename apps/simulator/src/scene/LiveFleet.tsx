import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { handoffBoard } from '@storewright/ops';
import { backroomLayout } from '@storewright/store-config';
import { useApp } from '../state/store';
import { liveClient } from '../live/link';
import { entryPath, exitPaths, type ParkingSpot, type PathState } from './lot';
import { useSiteLayout } from './useSite';
import { SEMI, TRAILER_WHEELS, trailerGeometry, vehicleGeometry, WHEEL_LAYOUT, wheelGeometry, type VehicleType, type WheelSpec } from './vehicles';
import { toonGradient } from './toon';

/**
 * 门店实况里的车辆（决策记录 0013）：顾客到店签到后，按顾客填的车型和颜色开进取货车位，交付完成后倒出车位驶离；
 * 配送行程的司机开白色面包车；已到达还没收完的到货车停在卸货口。动画按真实时间播放（驶入、驶出各约 10 秒）。
 */

const ANIM_SEC = 10;
const COLOR_WORDS: Array<[RegExp, string]> = [
  [/red|红/i, '#a3262a'],
  [/blue|蓝/i, '#2f4f7f'],
  [/silver|银/i, '#bfc4c8'],
  [/white|白/i, '#f4f4f2'],
  [/black|黑/i, '#26282b'],
  [/green|绿/i, '#3f5a46'],
  [/gr[ae]y|灰/i, '#7b8188'],
];

/** 顾客填的车（例如 Blue hatchback）→ 车型和颜色 */
export function vehicleFromText(text: string | undefined, fallbackType: VehicleType = 'sedan'): { type: VehicleType; color: string } {
  const s = text ?? '';
  const type: VehicleType = /suv/i.test(s) ? 'suv' : /pickup|truck|皮卡/i.test(s) ? 'pickup' : /van|面包/i.test(s) ? 'van' : /hatch|两厢/i.test(s) ? 'hatch' : /sedan|轿车/i.test(s) ? 'sedan' : fallbackType;
  const color = COLOR_WORDS.find(([re]) => re.test(s))?.[1] ?? '#7b8188';
  return { type, color };
}

interface LiveCar {
  key: string;
  type: VehicleType;
  color: string;
  spot: ParkingSpot;
  spotIndex: number;
  /** 到店（真实时间，毫秒）与离开 */
  arrivedAt: number;
  leftAt?: number;
}

function Wheels({ type, specs }: { type: VehicleType; specs?: readonly WheelSpec[] }) {
  const g = wheelGeometry();
  return (
    <>
      {(specs ?? WHEEL_LAYOUT[type]).map((w, i) => (
        <mesh key={i} geometry={g} position={[w.x, w.r, w.z]} scale={[w.w, w.r, w.r]}>
          <meshToonMaterial vertexColors gradientMap={toonGradient()} />
        </mesh>
      ))}
    </>
  );
}

function Body({ type, color }: { type: VehicleType; color: string }) {
  const g = vehicleGeometry(type);
  return (
    <>
      <mesh geometry={g.paint} castShadow>
        <meshToonMaterial color={color} gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={g.detail} castShadow>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} />
      </mesh>
      <Wheels type={type} />
    </>
  );
}

export function LiveFleet() {
  const status = useApp((s) => s.live.status);
  const version = useApp((s) => s.liveVersion);
  const geo = useApp((s) => s.simGeo);
  const model = useApp((s) => s.simModel);
  const site = useSiteLayout();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const departed = useRef(new Map<string, LiveCar>());
  const lastCars = useRef(new Map<string, LiveCar>());
  const groups = useRef(new Map<string, THREE.Group>());
  const st = { x: 0, z: 0, heading: 0 } as PathState;

  const c = liveClient();
  const bays = geo.lot.spots.map((sp, i) => ({ sp, i })).filter(({ sp }) => sp.kind === 'pickup');

  // 当前在车位上的车（顾客与配送司机）；上一刻还在、这一刻不在了的车开始驶离
  const cars = useMemo(() => {
    const out = new Map<string, LiveCar>();
    if (status === 'off' || !c?.statics) return out;
    const s = c.state;
    const rows = handoffBoard(s, c.statics, now + c.offset).filter((r) => r.arrivedAt !== undefined);
    rows.forEach((r, k) => {
      const bayNo = Number(r.bay);
      const hit = bays.find(({ sp }) => sp.id !== undefined && sp.id === r.bay) ?? (Number.isInteger(bayNo) && bayNo >= 1 ? bays[bayNo - 1] : undefined) ?? bays[k % Math.max(1, bays.length)];
      if (!hit) return;
      const vehicleText = r.kind === 'TRIP' ? s.trips[r.key]?.vehicle : s.orders[r.key]?.vehicle;
      const v = r.kind === 'TRIP' ? { type: 'van' as VehicleType, color: '#f2f3ef' } : vehicleFromText(vehicleText, (['sedan', 'suv', 'hatch'] as VehicleType[])[k % 3]);
      out.set(r.key, { key: r.key, type: v.type, color: v.color, spot: hit.sp, spotIndex: hit.i, arrivedAt: (r.arrivedAt as number) - c.offset });
    });
    for (const [k, car] of lastCars.current) if (!out.has(k) && !departed.current.has(k)) departed.current.set(k, { ...car, leftAt: Date.now() });
    lastCars.current = out;
    for (const [k, car] of departed.current) if (Date.now() - (car.leftAt ?? 0) > ANIM_SEC * 1000 * 2) departed.current.delete(k);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, version, now, c, geo]);

  // 到货车：已到达、还没收完的收货单，按顺序停在卸货口
  const trucks = useMemo(() => {
    if (status === 'off' || !c) return [];
    const doors = backroomLayout(model.config).docks;
    const f0 = geo.floors[0];
    if (!f0 || !doors.length) return [];
    return Object.values(c.state.receipts)
      .filter((r) => r.arrivedAt !== undefined && r.closedAt === undefined)
      .slice(0, doors.length)
      .map((r, i) => {
        const d = doors[i] as { x: number; z: number; reefer?: boolean };
        return { id: r.id, x: d.x, z: f0.maxZ + 0.6 + SEMI.kingpinToRear, reefer: !!d.reefer };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, version, c, model, geo]);

  // 动画：刚到的车从路上开进车位，刚离开的车倒出车位驶离
  useFrame(() => {
    const t = Date.now();
    const all = [...cars.values(), ...departed.current.values()];
    for (const car of all) {
      const g = groups.current.get(car.key);
      if (!g) continue;
      if (car.leftAt !== undefined) {
        const [back, drive] = exitPaths(geo.lot, site.road, car.spot, car.spotIndex % 2 === 0);
        const total = back.duration + drive.duration;
        const tau = ((t - car.leftAt) / 1000 / ANIM_SEC) * total;
        if (tau <= back.duration) back.at(tau, st);
        else drive.at(Math.min(drive.duration, tau - back.duration), st);
        g.visible = tau < total;
      } else {
        const p = entryPath(geo.lot, site.road, car.spot, car.spotIndex % 2 === 1);
        const k = Math.min(1, (t - car.arrivedAt) / 1000 / ANIM_SEC);
        p.at(k * p.duration, st);
        g.visible = true;
      }
      g.position.set(st.x, 0, st.z);
      g.rotation.set(0, st.heading, 0);
    }
  });

  if (status === 'off') return null;
  const shown = [...cars.values(), ...departed.current.values()];
  const tg = { dry: trailerGeometry('dry'), reefer: trailerGeometry('reefer') };
  return (
    <group>
      {shown.map((car) => (
        <group
          key={`${car.key}${car.leftAt ? '-out' : ''}`}
          ref={(gr) => {
            if (gr) groups.current.set(car.key, gr);
            else groups.current.delete(car.key);
          }}
          position={[car.spot.x, 0, car.spot.z]}
          rotation={[0, car.spot.heading, 0]}
        >
          <Body type={car.type} color={car.color} />
        </group>
      ))}
      {trucks.map((tr) => (
        <group key={tr.id} position={[tr.x, 0, tr.z]}>
          <Body type="semi" color={tr.reefer ? '#2f6fb5' : '#c8433a'} />
          <mesh geometry={(tr.reefer ? tg.reefer : tg.dry).paint} castShadow>
            <meshToonMaterial color={tr.reefer ? '#eef3f7' : '#f3f4f1'} gradientMap={toonGradient()} />
          </mesh>
          <mesh geometry={(tr.reefer ? tg.reefer : tg.dry).detail} castShadow>
            <meshToonMaterial vertexColors gradientMap={toonGradient()} />
          </mesh>
          <Wheels type="semi" specs={TRAILER_WHEELS} />
        </group>
      ))}
    </group>
  );
}
