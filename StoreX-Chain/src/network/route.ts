import type { Km } from '../region/region';
import type { Distances, NetPoint } from './graph';
import { NET, type NetParams } from './model';

/**
 * 一个仓每天的配送线路：门店一天的货超过一整车的部分先单独整车送（一店一车），剩下的用节约里程法拼线路
 * （两家店拼进一趟能省的往返越多越先拼，一趟不超过 24 托、不超过 6 小时），每趟再用两两交换（2-opt）理顺顺序；
 * 车数按每辆车一天能跑的时长把各趟装进去（先排长的）。
 */
export interface Stop {
  key: string;
  pallets: number;
}
export interface Trip {
  site: string;
  stops: Stop[];
  pallets: number;
  km: number;
  /** 含装车、卸货的总时长 */
  hours: number;
  /** 一店一整车 */
  full: boolean;
  pts: Km[];
}
export interface SiteRoutes {
  trips: Trip[];
  vehicles: number;
  km: number;
  hours: number;
  /** 每天的外送成本（美元） */
  cost: number;
}

interface Node {
  key: string;
  point: NetPoint;
  pallets: number;
}

export function routeSite(d: Distances, site: { key: string; point: NetPoint }, stores: readonly { key: string; point: NetPoint; pallets: number }[], p: NetParams): SiteRoutes {
  const Q = NET.truckPallets;
  const trips: Trip[] = [];
  const unload = (pallets: number) => (NET.unloadMin + NET.unloadMinPerPallet * pallets) / 60;
  const legOf = (a: NetPoint, b: NetPoint) => d.leg(a, b);
  const varCost = (km: number, h: number) => km * NET.perKm + h * NET.driverHour;
  const tripOf = (seq: Node[], full: boolean): Trip => {
    let km = 0;
    let h = NET.loadHours;
    const pts: Km[] = [];
    let at = site.point;
    for (const n of [...seq, { key: site.key, point: site.point, pallets: 0 }]) {
      const l = legOf(at, n.point);
      km += l.km;
      h += l.hours;
      pts.push(...(pts.length ? l.pts.slice(1) : l.pts));
      at = n.point;
    }
    const pallets = seq.reduce((a, n) => a + n.pallets, 0);
    for (const n of seq) h += unload(n.pallets);
    return { site: site.key, stops: seq.map((n) => ({ key: n.key, pallets: n.pallets })), pallets, km, hours: h, full, pts };
  };

  // 整车：一店一车
  const rest: Node[] = [];
  for (const s of stores) {
    const full = Math.floor(s.pallets / Q);
    const rem = s.pallets - full * Q;
    for (let k = 0; k < full; k++) trips.push(tripOf([{ key: s.key, point: s.point, pallets: Q }], true));
    // 剩下的快满一车了：也单独一车送（不再和别的店拼）
    if (rem > Q * 0.85) trips.push(tripOf([{ key: s.key, point: s.point, pallets: rem }], true));
    else if (rem > 1e-6) rest.push({ key: s.key, point: s.point, pallets: rem });
  }

  // 节约里程法
  const routes: Node[][] = rest.map((n) => [n]);
  const load = (r: Node[]) => r.reduce((a, n) => a + n.pallets, 0);
  const duration = (r: Node[]) => tripOf(r, false).hours;
  const c0 = new Map(rest.map((n) => [n.key, legOf(site.point, n.point)] as const));
  const savings: { a: Node; b: Node; s: number }[] = [];
  for (let i = 0; i < rest.length; i++)
    for (let j = i + 1; j < rest.length; j++) {
      const a = rest[i] as Node;
      const b = rest[j] as Node;
      const la = c0.get(a.key) as { km: number; hours: number };
      const lb = c0.get(b.key) as { km: number; hours: number };
      const ab = legOf(a.point, b.point);
      savings.push({ a, b, s: varCost(la.km + lb.km - ab.km, la.hours + lb.hours - ab.hours) });
    }
  savings.sort((x, y) => y.s - x.s || x.a.key.localeCompare(y.a.key) || x.b.key.localeCompare(y.b.key));
  for (const { a, b, s } of savings) {
    if (s <= 0) break;
    const ra = routes.find((r) => r.includes(a)) as Node[];
    const rb = routes.find((r) => r.includes(b)) as Node[];
    if (ra === rb) continue;
    if (load(ra) + load(rb) > Q + 1e-9) continue;
    const aEnd = ra[ra.length - 1] === a;
    const aStart = ra[0] === a;
    const bEnd = rb[rb.length - 1] === b;
    const bStart = rb[0] === b;
    let merged: Node[] | undefined;
    if (aEnd && bStart) merged = [...ra, ...rb];
    else if (bEnd && aStart) merged = [...rb, ...ra];
    else if (aEnd && bEnd) merged = [...ra, ...[...rb].reverse()];
    else if (aStart && bStart) merged = [...[...ra].reverse(), ...rb];
    if (!merged || duration(merged) > NET.maxTripHours) continue;
    routes.splice(routes.indexOf(ra), 1);
    routes.splice(routes.indexOf(rb), 1);
    routes.push(merged);
  }

  // 2-opt：一趟里的顺序
  for (const r of routes) {
    let improved = true;
    const cost = (seq: Node[]) => {
      const t = tripOf(seq, false);
      return varCost(t.km, t.hours);
    };
    let best = cost(r);
    while (improved && r.length > 2) {
      improved = false;
      for (let i = 0; i < r.length - 1; i++)
        for (let j = i + 1; j < r.length; j++) {
          const cand = [...r.slice(0, i), ...r.slice(i, j + 1).reverse(), ...r.slice(j + 1)];
          const c = cost(cand);
          if (c < best - 1e-9) {
            r.splice(0, r.length, ...cand);
            best = c;
            improved = true;
          }
        }
    }
    trips.push(tripOf(r, false));
  }

  // 车数：各趟装进每辆车一天的时长（先排长的）
  const bins: number[] = [];
  for (const h of trips.map((t) => t.hours).sort((x, y) => y - x)) {
    const k = bins.findIndex((b) => b + h <= NET.shiftHours + 1e-9);
    if (k >= 0) bins[k] = (bins[k] as number) + h;
    else bins.push(h);
  }
  const km = trips.reduce((a, t) => a + t.km, 0);
  const hours = trips.reduce((a, t) => a + t.hours, 0);
  const cost = (varCost(km, hours) + bins.length * NET.vehicleDay) * p.freight;
  return { trips, vehicles: bins.length, km, hours, cost };
}
