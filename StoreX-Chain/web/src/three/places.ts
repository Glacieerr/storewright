import * as THREE from 'three';
import { FRAMES, NODES, type Km } from '../../../src/region/region';
import { toWorld, type Frame } from '../../../src/region/frames';
import { LOCAL } from '../../../src/region/regionGen';
import type { V3 } from './geo';
import type { Place, RoadNet } from './roadnet';
import type { PlaceExit } from './motion';
import { planStores, type Site } from './stores';
import { registerLandsideYard, standLayout, terminalLayout, TERM } from '../../../src/hub/airport';
import { currentFacilities } from '../../../src/facility/state';

/**
 * 车辆在三维里停靠的地点：门店的收货口和线上配送位（stores 模块）、配送中心的月台门（开过门再倒车靠台）、
 * 回场车位、港口堆场、机场货站、面包房、出区域的高速口。三维场景和孪生服务（server/）共用这一份，
 * 所以服务给虚幻引擎发的车辆位置和网页里画的完全一样。
 *
 * 港口、机场、物流园里的路径按各自的局部坐标写（设施内部的布局），再按坐标系换到区域里。
 */
const P = (k: Km): THREE.Vector3 => new THREE.Vector3(k.x * 100, 0, -k.y * 100);
/** 局部坐标（沙盘米）→ 区域 */
const W = (f: Frame, x: number, z: number): THREE.Vector3 => {
  const p = toWorld(f, { x, z });
  return new THREE.Vector3(p.x, 0, p.z);
};

/** 配送中心（局部坐标）：位置、月台那面墙的 z、干货门和冷链门的 x（沙盘米） */
export function dcLayout(): { dc: THREE.Vector3; wallZ: number; dryDoors: number[]; coldDoors: number[] } {
  const dc = P(LOCAL.park.node);
  return { dc, wallZ: dc.z - 75, dryDoors: Array.from({ length: 26 }, (_, i) => dc.x - 120 + i * 10), coldDoors: Array.from({ length: 12 }, (_, i) => dc.x + 196 + i * 11) };
}
/** 配送中心月台门在区域里的位置（孪生服务发给外部引擎用） */
export function dcDoorsWorld(): { id: string; x: number; z: number }[] {
  const { wallZ, dryDoors, coldDoors } = dcLayout();
  const f = FRAMES.park;
  return [...dryDoors.map((x, i) => [`D${String(i + 1).padStart(2, '0')}`, x] as const), ...coldDoors.map((x, i) => [`C${String(i + 1).padStart(2, '0')}`, x] as const)].map(([id, x]) => {
    const p = toWorld(f, { x, z: wallZ });
    return { id, x: p.x, z: p.z };
  });
}

export function registerPlaces(net: RoadNet): Map<string, Site> {
  const sites = planStores(net);
  const { dc, wallZ, dryDoors, coldDoors } = dcLayout();
  const pf = FRAMES.park;
  // 月台门的停靠位：进园区 → 沿车道开过门 → 倒车靠台（局部坐标）
  const laneZ = wallZ + 40;
  const dockPlace = (key: string, x: number) => {
    const west = x < dc.x;
    net.places.set(key, {
      junction: 'DC',
      path: [W(pf, dc.x, dc.z - 4), W(pf, dc.x + (west ? -8 : 8), laneZ + 10), W(pf, x + (west ? -26 : 26), laneZ)],
      reverse: [W(pf, x, wallZ + 20), W(pf, x, wallZ + 0.6)],
    });
  };
  dryDoors.forEach((x, i) => dockPlace(`DC#${i}`, x));
  coldDoors.forEach((x, i) => dockPlace(`DCC#${i}`, x));
  // 车场：回来的配送车停到月台前停车坪外边的一排车位（车头朝着库房）
  for (let k = 0; k < 24; k++) {
    const x = dc.x + 40 + k * 5;
    net.places.set(`DC:yard#${k}`, { junction: 'DC', path: [W(pf, dc.x, dc.z - 4), W(pf, dc.x + 20, dc.z - 10), W(pf, x, dc.z - 10), W(pf, x, dc.z - 24)] });
  }
  // 港口：集装箱拖车进闸后沿车道、通道开到中间那排箱区的集卡道，停在最里头那个贝位旁边（本店的箱堆在那里），龙门吊把箱放上车
  const po = FRAMES.port;
  const port = P(LOCAL.port.node);
  net.places.set('PORT', { junction: 'PORT', path: [W(po, port.x, port.z), W(po, port.x + 12, 1244), W(po, -1835, 1244), W(po, -1835, 1310.5), W(po, -1860, 1310.5), W(po, -1870.85, 1310.5)] });
  // 机场货站：空运冷藏车开到进场路尽头的回车场向左掉头（走外圈，和外来货车进场一样：ops/extTrucks.ts），沿出场一侧往北开到陆侧卡车场的进场点；
  // 走的时候从驶出点沿进场一侧往南开到回车场，再掉头，往北并进出场的车道（离尽头 40 米）
  const ao = FRAMES.airport;
  const air = P(LOCAL.airport.node);
  const R = 8.6;
  const turn = Array.from({ length: 11 }, (_, k) => W(ao, air.x - R * Math.cos((k / 10) * Math.PI), air.z + 1 + R * Math.sin((k / 10) * Math.PI)));
  // 外圈：圆心在尽头往南 8 米，半径 12.5 米
  const outer = Array.from({ length: 13 }, (_, k) => W(ao, air.x + 12.5 * Math.cos(Math.PI - (k / 12) * Math.PI), air.z + 8 + 12.5 * Math.sin(Math.PI - (k / 12) * Math.PI)));
  const airPlace: Place & PlaceExit = {
    junction: 'AIR',
    path: [W(ao, air.x - R, air.z + 1), W(ao, air.x - R - 2.4, air.z + 4), ...outer, W(ao, air.x + R + 2.4, air.z + 4), W(ao, air.x + R, air.z - 4), W(ao, air.x + R, air.z - 20), W(ao, air.x + R, TERM.zLand + 60), W(ao, air.x + R, TERM.zLand)],
    exit: [W(ao, air.x - R, TERM.zLand), W(ao, air.x - R, TERM.zLand + 60), W(ao, air.x - R, air.z - 9), ...turn, W(ao, air.x + R, air.z - 9), W(ao, air.x + R, air.z - 40)],
    joinS: 40,
  };
  // 陆侧卡车场：车道、排队、倒车靠台由收货场引擎排（src/hub/airport.ts），地点的路到场地的进场点为止
  const sl = standLayout(currentFacilities().airport.stands ?? 2);
  registerLandsideYard(terminalLayout(sl.docks, sl.x1), ao);
  net.places.set('AIR', airPlace);
  const bk = P(LOCAL.park.bakery);
  net.places.set('BAKERY', { junction: 'BAKERY', path: [W(pf, bk.x - 30, bk.z + 30), W(pf, bk.x - 8, bk.z + 30)] });
  // 出区域的高速：开出去走去程的最右车道，开进来走回程的；区域边界以外的延长段给车接着开出视野（开进来的从远处开过来）
  for (const [key, map] of [['NORTH', 'MAP_N'], ['EAST', 'MAP_E']] as const) {
    const line = net.lines.find((l) => l.ja === key && l.jb === map);
    if (line) {
      const e = line.edgeS ?? line.len;
      net.places.set(key, { junction: key, path: net.lanePath(line, 0, e, 0), leave: net.lanePath(line, e, 0, 0), ...(e < line.len - 1 ? { offOut: net.lanePath(line, e, line.len, 0), offIn: net.lanePath(line, line.len, e, 0) } : {}) });
    } else net.places.set(key, { junction: key, path: [P(NODES[key] as Km), (net.junctions.get(map) as { pos: V3 }).pos.clone()] });
  }
  return sites;
}
