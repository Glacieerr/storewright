import { useMemo } from 'react';
import * as THREE from 'three';
import { boatGeometry, BOAT_SPEC, type BoatKind } from '../vehicles/boats';
import { HITCH, SEMI, TOW, TRAILER_WHEELS, towGeometry, trailerGeometry, vehicleGeometry, VEHICLE_LENGTH, WHEEL_LAYOUT, wheelGeometry, type TowKind, type TrailerKind, type VehicleType, type WheelSpec } from '../vehicles';
import { toonGradient } from '../toon';

/**
 * 开发用的车辆陈列（地址栏带 ?gallery 时挂在场景上方 300 米处）：所有车型、挂车、拖车和小船并排摆放，
 * 用来检查外形、车漆与细节的分区、车轮位置。不进入正式构建。
 */

export const GALLERY_Y = 300;

function Wheels({ specs }: { specs: readonly WheelSpec[] }) {
  return (
    <>
      {specs.map((w, i) => (
        <mesh key={i} geometry={wheelGeometry(w.truck ? 'truck' : 'car')} position={[w.x, w.r, w.z]} scale={[w.w, w.r, w.r]} castShadow>
          <meshToonMaterial vertexColors gradientMap={toonGradient()} />
        </mesh>
      ))}
    </>
  );
}

function Body({ geo, color }: { geo: { paint: THREE.BufferGeometry; detail: THREE.BufferGeometry }; color: string }) {
  return (
    <>
      <mesh geometry={geo.paint} castShadow>
        <meshToonMaterial color={color} gradientMap={toonGradient()} />
      </mesh>
      <mesh geometry={geo.detail} castShadow>
        <meshToonMaterial vertexColors gradientMap={toonGradient()} />
      </mesh>
    </>
  );
}

const CARS: Array<[VehicleType, string]> = [
  ['sedan', '#a3262a'],
  ['hatch', '#2f4f7f'],
  ['suv', '#7b8188'],
  ['pickup', '#26282b'],
  ['van', '#f4f4f2'],
  ['truck', '#d0573a'],
  ['rv', '#ece4d2'],
];

export default function VehicleGallery() {
  const cars = useMemo(() => {
    let x = -40;
    return CARS.map(([type, color]) => {
      const out = { type, color, x };
      x += 4.5;
      return out;
    });
  }, []);
  const rigs: Array<{ x: number; kind: TrailerKind }> = [
    { x: -38, kind: 'dry' },
    { x: -33, kind: 'reefer' },
  ];
  const tows: Array<{ x: number; car: VehicleType; kind: TowKind; color: string }> = [
    { x: -24, car: 'pickup', kind: 'camper', color: '#7b8188' },
    { x: -19, car: 'suv', kind: 'boat', color: '#3f7fb8' },
    { x: -14, car: 'pickup', kind: 'utility', color: '#a3262a' },
  ];
  const boats: Array<{ kind: BoatKind; x: number; color: string }> = [
    { kind: 'row', x: -40, color: '#3f7fb8' },
    { kind: 'motor', x: -35, color: '#c8453f' },
    { kind: 'sail', x: -29, color: '#26354f' },
    { kind: 'kayak', x: -24, color: '#e0a42f' },
    { kind: 'pontoon', x: -20, color: '#2f8f8f' },
  ];
  return (
    <group position={[0, GALLERY_Y, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-20, -0.01, -6]} receiveShadow>
        <planeGeometry args={[60, 50]} />
        <meshToonMaterial color="#6b7076" gradientMap={toonGradient()} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-28, 0.0, 14]}>
        <planeGeometry args={[30, 10]} />
        <meshToonMaterial color="#3f7f9f" gradientMap={toonGradient()} />
      </mesh>
      {cars.map((c) => (
        <group key={c.type} position={[c.x, 0, 0]}>
          <Body geo={vehicleGeometry(c.type)} color={c.color} />
          <Wheels specs={WHEEL_LAYOUT[c.type]} />
        </group>
      ))}
      {rigs.map((r) => (
        <group key={r.kind} position={[r.x, 0, -14]}>
          <Body geo={vehicleGeometry('semi')} color={r.kind === 'dry' ? '#c8433a' : '#2f6fb5'} />
          <Wheels specs={WHEEL_LAYOUT.semi} />
          <Body geo={trailerGeometry(r.kind)} color="#f3f4f1" />
          <Wheels specs={TRAILER_WHEELS} />
        </group>
      ))}
      {tows.map((tw) => {
        const hitch = HITCH[tw.car]?.z ?? -VEHICLE_LENGTH[tw.car] / 2;
        return (
          <group key={tw.kind} position={[tw.x, 0, -8]}>
            <Body geo={vehicleGeometry(tw.car)} color={tw.color} />
            <Wheels specs={WHEEL_LAYOUT[tw.car]} />
            <group position={[0, 0, hitch]}>
              <Body geo={towGeometry(tw.kind)} color={tw.kind === 'boat' ? '#c8453f' : '#f1efe8'} />
              <Wheels specs={TOW[tw.kind].wheels} />
            </group>
          </group>
        );
      })}
      {boats.map((bt) => (
        <group key={bt.kind} position={[bt.x, -BOAT_SPEC[bt.kind].waterline + 0.02, 14]}>
          <Body geo={boatGeometry(bt.kind)} color={bt.color} />
        </group>
      ))}
      <mesh position={[-5, 0.5, 0]}>
        <boxGeometry args={[0.1, 1, 0.1]} />
        <meshBasicMaterial color="#ff00ff" />
      </mesh>
      <group position={[-5, 0, -14]}>
        <mesh position={[0, 0.02, SEMI.kingpinToFront]}>
          <boxGeometry args={[3, 0.04, 0.05]} />
          <meshBasicMaterial color="#ffff00" />
        </mesh>
      </group>
    </group>
  );
}
