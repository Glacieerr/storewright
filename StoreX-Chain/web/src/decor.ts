import { currentRegion } from '../../src/region/network';
import { RAIL, type Km } from '../../src/region/region';
import { BOUNDS } from '../../src/region/regionGen';
import { toXZ, type WVehicle } from '../../src/sim/trace';
import { t as tr } from './i18n';

/**
 * 背景交通（不参与仿真，只让场景更像真的）：别家公司的货运班列沿铁路干线经过，城际客运列车开到城市客运站停靠、折返，
 * 过路的集装箱船沿着海岸外的航线航行。标签里写明「背景」，和仿真里自己的车船区分开。
 */
const flat = (pts: readonly Km[]) => pts.flatMap((p) => toXZ(p));
const dist = (a: Km, b: Km) => Math.hypot(a.x - b.x, a.y - b.y);

function railKm(pts: readonly Km[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += dist(pts[i] as Km, pts[i - 1] as Km);
  return km;
}

/** 铁路折线从出区域那头开到离起点 s 公里的地方（客运站） */
function railTo(s: number): { pts: Km[]; at: Km } {
  const out: Km[] = [];
  let acc = 0;
  for (let i = 1; i < RAIL.length; i++) {
    const a = RAIL[i - 1] as Km;
    const b = RAIL[i] as Km;
    const d = dist(a, b);
    if (acc + d >= s) {
      const t = (s - acc) / (d || 1);
      const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      return { pts: [at, ...RAIL.slice(i)].reverse(), at };
    }
    acc += d;
    out.push(a);
  }
  return { pts: [...RAIL].reverse(), at: RAIL[RAIL.length - 1] as Km };
}

export function decorVehicles(firstId: number): WVehicle[] {
  const out: WVehicle[] = [];
  const plan = currentRegion();
  const add = (kind: string, label: string, segs: WVehicle['segs']) => out.push({ id: firstId + out.length, kind, label, segs });
  // 货运班列：全线，时速约 55 公里
  const hours = railKm(RAIL) / 55;
  for (const [start, out1] of [
    [5.7, true],
    [11.3, false],
    [15.2, true],
    [20.5, false],
  ] as const) {
    const pts = out1 ? RAIL : [...RAIL].reverse();
    const t0 = start * 3600;
    add('train', tr('其他公司的货运班列（背景）· 12 箱'), [{ t0, t1: t0 + hours * 3600, pts: flat(pts), act: out1 ? tr('驶出区域') : tr('开往港口') }]);
  }
  // 城际客运列车：从区域外开到城市客运站，停 6 分钟上下客，折返（时速约 80 公里）
  const pax = plan.railPassenger;
  if (pax) {
    const r = railTo(pax.s);
    const h = railKm(r.pts) / 80;
    for (const start of [6.4, 8.1, 10.6, 13.2, 16.9, 18.5, 21.2]) {
      const t0 = start * 3600;
      const t1 = t0 + h * 3600;
      add('train', tr('城际客运列车（背景）· 停靠{name}', { name: pax.name }), [
        { t0, t1, pts: flat(r.pts), act: tr('开往{name}', { name: pax.name }) },
        { t0: t1, t1: t1 + 360, pts: flat([r.at]), act: tr('{name}上下客', { name: pax.name }) },
        { t0: t1 + 360, t1: t1 + 360 + h * 3600, pts: flat([...r.pts].reverse()), act: tr('驶出区域') },
      ]);
    }
  }
  // 过路的集装箱船：海岸线外大约 7 公里的航线，航速约 30 公里 / 小时
  const s = plan.seaDir;
  const lane: Km[] = [];
  for (let i = 0; i < plan.coast.length; i += 16) {
    const p = plan.coast[i] as Km;
    const q = { x: p.x + s.x * 7, y: p.y + s.y * 7 };
    if (q.x > BOUNDS.x0 - 12 && q.x < BOUNDS.x1 + 12 && q.y > BOUNDS.y0 - 12 && q.y < BOUNDS.y1 + 12) lane.push(q);
  }
  if (lane.length >= 2) {
    const km = railKm(lane);
    for (const [start, fwd] of [
      [1.5, true],
      [8.5, false],
      [14.0, true],
      [19.0, false],
    ] as const) {
      const pts = fwd ? lane : [...lane].reverse();
      const t0 = start * 3600;
      add('ship', tr('过路的集装箱船（背景）'), [{ t0, t1: t0 + (km / 30) * 3600, pts: flat(pts), act: tr('近海航行') }]);
    }
  }
  return out;
}
