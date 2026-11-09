import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRACE_DAY } from '../src/analysis/studies';
import { setRegion } from '../src/region/network';
import { DEFAULT_REGION, regionSpecFrom, type RegionSpec } from '../src/region/regionGen';
import { g3 } from '../src/sim/config';
import { runChain } from '../src/sim/engine';
import type { WVehicle } from '../src/sim/trace';
import { yardSites } from '@storewright/yard';
import { buildMotion, DYN, roadRuns } from '../web/src/three/motion';
import { buildCity } from '../web/src/three/regionCity';
import { TrafficPlanner } from '../web/src/three/traffic';

/** 数值取到 0.01，类型化数组展开，拼成 JSON 取摘要 */
const md5 = (x: unknown): string =>
  createHash('md5')
    .update(JSON.stringify(x, (_k, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v)))
    .digest('hex')
    .slice(0, 12);
/** 对象只取两层（停车场、路边车位都是平的数据；更深的只记个数，不会绕圈） */
const flat = (o: unknown, depth = 0): unknown => {
  if (typeof o === 'function') return undefined;
  if (o === null || typeof o !== 'object') return o;
  if (depth >= 2) return Array.isArray(o) ? o.length : undefined;
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return Array.from(o as ArrayLike<unknown>, (x) => flat(x, depth + 1));
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, flat(v, depth + 1)]));
};

let day: WVehicle[] | undefined;
/** 默认区域一天的仿真车（链路的结果和三维布置无关，算一次两边共用） */
const vehicles = (): WVehicle[] => {
  if (!day) {
    const sc = g3(1);
    sc.traceDay = TRACE_DAY;
    day = (runChain(sc).trace?.vehicles ?? []).filter((v) => v.kind !== 'ship' && v.kind !== 'plane' && v.kind !== 'train');
  }
  return day;
};

/** 搭一座城：停车场、路边车位、场地、公交站、仿真车在路上的各段、背景车流（让着仿真车）各取一个摘要 */
function fingerprint(spec: RegionSpec, trucks: boolean): Record<string, string> {
  const { net } = buildCity(spec);
  const runs = (trucks ? vehicles() : []).map((v) => buildMotion(v, net, { L: 16.5, resolve: () => undefined, yard: v.id, lane: 0, dyn: DYN.heavy })).flatMap((m) => roadRuns(m));
  const tr = new TrafficPlanner(net);
  tr.simulate(9000, undefined, undefined, runs);
  const cars = tr.cars;
  return {
    lots: md5(net.lots.map((l) => flat(l))),
    curbs: md5(flat(net.curbs)),
    yards: md5(yardSites().map((s) => [s.key, flat(s.frame), s.doors.map((d) => d.id)])),
    stops: md5(tr.busStops.map((s) => [s.id, s.name, s.line, s.s, s.stopAt, s.lines])),
    truckRuns: `${runs.length}:${md5(runs)}`,
    traffic: `${cars.length}:${md5(cars.map((c) => [c.kind, c.segT0.length, c.segT0[0], c.segT1[c.segT1.length - 1], c.segP[c.segP.length - 1]]))}`,
  };
}

describe('一个区域的城市只看区域的写法', () => {
  it('默认区域单独搭、和搭过随机区域以后再搭：停车场、路边车位、场地、公交站、仿真车的路段、背景车流都一样', () => {
    const a = fingerprint(DEFAULT_REGION, true);
    const other = fingerprint(regionSpecFrom('random-3'), false);
    expect(other.lots).not.toBe(a.lots);
    const b = fingerprint(DEFAULT_REGION, true);
    expect(b).toEqual(a);
    setRegion(DEFAULT_REGION);
  }, 300_000);
});
