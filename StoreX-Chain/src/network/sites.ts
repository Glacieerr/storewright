import { currentRegion, STORE, type Graph } from '../region/network';
import { NODES, type Km } from '../region/region';
import { BOUNDS, DIR_LABEL, dirOf } from '../region/regionGen';
import { attach, type NetPoint } from './graph';

/**
 * 网络规划的门店和候选仓（按当前区域生成，同一个区域每次一样）：
 *
 * - 门店：现有的综合店，加上城区里的几家（在城区干道的路口附近，尽量分散）、沿高速的镇（区域里高速两侧）、
 *   出了高速口再往外的远郊镇（区域外，离高速口的距离可以调）；按「城区、镇、城区、远郊……」交替排，取前 N 家；
 * - 候选仓：现有的物流园配送中心（可以扩建），港口后方、离物流园最远的绕城立交（新建配送中心），
 *   两个高速口和机场物流区（中转仓：不存货，物流园拣好的货在这里换小车送店）。
 */
export type StoreKind = 'existing' | 'city' | 'town' | 'outer';
export interface NetStore {
  key: string;
  name: string;
  km: Km;
  /** 规模（销量相对 StoreX 报告里那家店） */
  size: number;
  kind: StoreKind;
  /** 区域外的远郊镇：从哪个高速口出去、出口外多少公里（地图上画在区域边上） */
  outer?: { via: 'NORTH' | 'EAST'; km: number; dir: Km };
  point: NetPoint;
}
export type SiteKind = 'park' | 'dc' | 'xd';
export interface NetSite {
  key: string;
  name: string;
  short: string;
  kind: SiteKind;
  km: Km;
  point: NetPoint;
  /** 地价系数（影响固定成本） */
  land: number;
}
export const SITE_KIND_LABEL: Record<SiteKind, string> = { park: '物流园（现有）', dc: '新建配送中心', xd: '中转仓（不存货）' };
export const STORE_KIND_LABEL: Record<StoreKind, string> = { existing: '综合店（现有）', city: '城区店', town: '高速沿线镇店', outer: '远郊镇店（区域外）' };

const CITY_SIZES = [1.4, 1.2, 1.0, 1.3, 0.9, 1.1];
const TOWN_SIZES = [0.8, 0.7, 0.9];
const OUTER_SIZES = [0.9, 0.8];
export const MAX_STORES = 12;

const dist = (a: Km, b: Km) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (v: Km): Km => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
const NUM = ['', '二', '三', '四', '五'];

/** 给名字去重：城东店、城东二店…… */
function namer(): (base: string, tail: string) => string {
  const used = new Map<string, number>();
  return (base, tail) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return `${base}${NUM[n] ?? String(n + 1)}${tail}`;
  };
}

/** 从候选点里挑 k 个，每次挑离已选的点最远的（分散开） */
function spread<T extends { km: Km }>(cands: readonly T[], taken: Km[], k: number, minGap: number): T[] {
  const out: T[] = [];
  const left = [...cands];
  while (out.length < k && left.length) {
    let bi = -1;
    let bd = -Infinity;
    left.forEach((c, i) => {
      const d = Math.min(...taken.map((t) => dist(t, c.km)));
      if (d > bd + 1e-9) [bi, bd] = [i, d];
    });
    if (bi < 0 || bd < minGap) break;
    const c = left.splice(bi, 1)[0] as T;
    out.push(c);
    taken.push(c.km);
  }
  return out;
}

export function networkSites(g: Graph, opts: { outerKm: number }): { stores: NetStore[]; sites: NetSite[] } {
  const plan = currentRegion();
  const center = plan.city.center;
  const R = plan.city.radius;
  const name = namer();
  const dirName = (p: Km) => DIR_LABEL[dirOf({ x: p.x - center.x, y: p.y - center.y })];
  const facilities = ['PORT', 'AIR', 'DC', 'NORTH', 'EAST'].map((k) => NODES[k] as Km);
  const inside = (p: Km, m: number) => p.x > BOUNDS.x0 + m && p.x < BOUNDS.x1 - m && p.y > BOUNDS.y0 + m && p.y < BOUNDS.y1 - m;

  // —— 现有的综合店 ——
  const flagship: NetStore = { key: 'S01', name: STORE.name, km: { ...STORE.km }, size: STORE.size, kind: 'existing', point: attach(g, 'S01', STORE.km, { node: STORE.key, linkKm: 0 }) };
  const taken: Km[] = [flagship.km];

  // —— 城区店：城区干道的路口附近，尽量分散 ——
  const cityNodes = plan.city.nodes.filter((n) => g.nodes.has(n)).map((n, i) => ({ n, i, km: g.nodes.get(n) as Km }));
  const cityPick = spread(
    cityNodes.filter((c) => facilities.every((f) => dist(f, c.km) > 2)),
    taken,
    CITY_SIZES.length,
    2.2,
  );
  const city: NetStore[] = cityPick.map((c, k) => {
    // 店在街区里：离路口 300 米
    const a = ((c.i * 137.5 + 40) * Math.PI) / 180;
    const km = { x: c.km.x + Math.cos(a) * 0.3, y: c.km.y + Math.sin(a) * 0.3 };
    const near = dist(km, center) < R * 0.3;
    return { key: '', name: name(near ? '城中' : `城${dirName(km)}`, '店'), km, size: CITY_SIZES[k] as number, kind: 'city', point: attach(g, `st-c${k}`, km, { node: c.n }) };
  });

  // —— 高速沿线的镇：城区外、离设施和高速口远一点，在高速旁边 600 米 ——
  const townCands: { km: Km; node: string; along: number }[] = [];
  for (const e of g.edges) {
    if (e.cls !== 'highway') continue;
    const total = e.pts.reduce((s, p, i) => (i ? s + dist(e.pts[i - 1] as Km, p) : 0), 0);
    let s = 0;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1] as Km;
      const b = e.pts[i] as Km;
      const d = dist(a, b);
      for (let u = 0; u < d; u += 0.5) {
        const p = { x: a.x + ((b.x - a.x) * u) / d, y: a.y + ((b.y - a.y) * u) / d };
        const along = s + u;
        if (dist(p, center) < R + 3 || !inside(p, 2) || facilities.some((f) => dist(f, p) < 4)) continue;
        const n = unit({ x: -(b.y - a.y), y: b.x - a.x });
        const side = dist({ x: p.x + n.x, y: p.y + n.y }, center) > dist(p, center) ? 1 : -1;
        const km = { x: p.x + n.x * 0.6 * side, y: p.y + n.y * 0.6 * side };
        // 镇从离得近的那头的立交上下高速
        townCands.push(along <= total - along ? { km, node: e.a, along } : { km, node: e.b, along: total - along });
      }
      s += d;
    }
  }
  const townPick = spread(townCands, taken, TOWN_SIZES.length, 6);
  const towns: NetStore[] = townPick.map((c, k) => ({
    key: '',
    name: name(`${dirName(c.km)}镇`, '店'),
    km: c.km,
    size: TOWN_SIZES[k] as number,
    kind: 'town',
    point: attach(g, `st-t${k}`, c.km, { node: c.node, cls: 'highway', linkKm: c.along * 1.06 + 0.8 }),
  }));

  // —— 远郊镇：出了高速口再往外 ——
  const outer: NetStore[] = (['NORTH', 'EAST'] as const).map((via, k) => {
    const ex = NODES[via] as Km;
    const dir = unit({ x: plan.offmap[via].x - ex.x, y: plan.offmap[via].y - ex.y });
    const km = { x: ex.x + dir.x * opts.outerKm, y: ex.y + dir.y * opts.outerKm };
    return { key: '', name: name(`${DIR_LABEL[dirOf(dir)]}郊`, '镇店'), km, size: OUTER_SIZES[k] as number, kind: 'outer', outer: { via, km: opts.outerKm, dir }, point: attach(g, `st-o${k}`, km, { node: via, cls: 'highway', linkKm: opts.outerKm * 1.06 }) };
  });

  // 交替排：城区、城区、镇、城区、远郊、城区、镇、城区、远郊、城区、镇
  const order: (NetStore | undefined)[] = [flagship, city[0], city[1], towns[0], city[2], outer[0], city[3], towns[1], city[4], outer[1], city[5], towns[2]];
  const rest = [...city.slice(6), ...towns.slice(3)];
  const stores = [...order.filter((s): s is NetStore => !!s), ...rest].slice(0, MAX_STORES);
  stores.forEach((s, i) => {
    s.key = `S${String(i + 1).padStart(2, '0')}`;
    s.point = { ...s.point, id: s.key };
  });

  // —— 候选仓 ——
  const park = NODES.DC as Km;
  const sites: NetSite[] = [{ key: 'park', name: '物流园配送中心', short: '物流园', kind: 'park', km: { ...park }, point: attach(g, 'park', park, { node: 'DC', linkKm: 0 }), land: 1 }];
  const add = (key: string, nm: string, short: string, kind: SiteKind, km: Km, land: number, node?: string) => {
    if (!inside(km, 0.5) || sites.some((s) => dist(s.km, km) < 4)) return;
    sites.push({ key, name: nm, short, kind, km, point: attach(g, key, km, node ? { node } : {}), land });
  };
  const port = NODES.PORT as Km;
  const toCenter = unit({ x: center.x - port.x, y: center.y - port.y });
  add('port', '港口后方物流区', '港口后方', 'dc', { x: port.x + toCenter.x * 2.5, y: port.y + toCenter.y * 2.5 }, 1.1);
  const ring = [...plan.ics].filter((n) => NODES[n]).sort((a, b) => dist(NODES[b] as Km, park) - dist(NODES[a] as Km, park))[0];
  if (ring) {
    const r = NODES[ring] as Km;
    const out = unit({ x: r.x - center.x, y: r.y - center.y });
    add('ring', `${dirName(r)}绕城立交物流用地`, `${dirName(r)}立交`, 'dc', { x: r.x + out.x * 1.2, y: r.y + out.y * 1.2 }, 1.0, ring);
  }
  for (const via of ['NORTH', 'EAST'] as const) {
    const ex = NODES[via] as Km;
    const back = unit({ x: center.x - ex.x, y: center.y - ex.y });
    const d = DIR_LABEL[dirOf({ x: ex.x - center.x, y: ex.y - center.y })];
    add(via === 'NORTH' ? 'north' : 'east', `${d}高速口中转仓`, `${d}高速口`, 'xd', { x: ex.x + back.x * 0.8, y: ex.y + back.y * 0.8 }, 0.8, via);
  }
  const air = NODES.AIR as Km;
  const ab = unit({ x: center.x - air.x, y: center.y - air.y });
  add('air', '机场物流区中转仓', '机场物流区', 'xd', { x: air.x + ab.x * 1.5, y: air.y + ab.y * 1.5 }, 1.0);
  return { stores, sites };
}
