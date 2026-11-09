import { crf } from '../../../StoreX/src/analysis/economics';
import { BASE_UNITS, casesPerPallet, FAMILIES, PALLETS_PER_FEU, PALLETS_PER_MULTI_TEMP, PALLETS_PER_TRAILER, type Source } from '../region/products';
import { COSTS, g3 } from '../sim/config';
import type { Distances, Leg } from './graph';
import type { NetSite, NetStore, SiteKind } from './sites';

/**
 * 网络规划的成本模型（每年，美元，2026 年不变价格；数字是合成的，按公开资料里的常见区间取）：
 *
 * - 货量：门店按规模折算（规模 1 的店每天经配送中心约 33 托），只算要经过仓的货——
 *   长途整车直送门店的商品族（全链路方案的规划）不经过仓，选址不影响它们；
 * - 固定成本：新建配送中心、中转仓、物流园扩建按投资的年金（7%）加每年的固定运营费，乘地价系数；物流园现有的运营费也算上（各方案都有）；
 * - 进仓：海运从港口（拖车，或者铁路到物流园货运站再转）、铁路班列从物流园货运站、空运从机场、长途公路和区域生鲜从高速口、面包房从物流园；
 *   中转仓的货由物流园拣好、整车转运过去（物流园要多拣这部分货，占物流园的能力）；
 * - 外送：多温区车（24 托）从仓开到门店，按里程、司机工时、每车每天的固定成本；选址时按每托分摊估算，选定以后按实际排的线路算；
 * - 处理：每托的装卸、拣货（配送中心按全链路的自动化水平；中转仓只是换车）；
 * - 能力：每个仓每天能出多少托；超出的部分交第三方仓（每托多付一笔），所以哪种方案都排得出来；
 * - 库存：配送中心存安全库存，分成几个仓存时按「平方根定律」变多（中转仓不存货）；
 * - 时效：门店离仓的车程超过 1 小时，每托每多一小时按一笔罚分算（生鲜损耗、要更早出车）。
 */
export interface NetParams {
  /** 需求增长（1 = 现在） */
  growth: number;
  /** 运价倍数（油价、司机工资一起涨跌） */
  freight: number;
  /** 物流园能不能扩建（没有扩建用地时只能另选新址） */
  allowExpand: boolean;
}
export const DEFAULT_PARAMS: NetParams = { growth: 1.3, freight: 1, allowExpand: true };

const C = COSTS;
const S3 = g3(1);
/** 全链路方案的配送车：六成电动、四成柴油，多温区挂车 */
const EV = S3.fleet.evShare;
export const NET = {
  days: 365,
  rate: 0.07,
  truckPallets: PALLETS_PER_MULTI_TEMP,
  loadFactor: 0.9,
  perKm: EV * C.ev.perKm + (1 - EV) * C.diesel.perKm,
  driverHour: C.driverHour,
  vehicleDay: EV * C.ev.perDay + (1 - EV) * C.diesel.perDay + C.trailerPerDay.multi,
  /** 每站卸货（分钟）、每托多几分钟，在仓里装车（小时） */
  unloadMin: S3.store.unloadMin,
  unloadMinPerPallet: S3.store.unloadMinPerPallet,
  loadHours: 0.5,
  /** 一辆车一天能跑多久：出车时段 2:30–10:00，再加回场的 1.5 小时 */
  shiftHours: S3.fleet.windows.multi[1] - S3.fleet.windows.multi[0] + 1.5,
  /** 一趟最长（含装卸） */
  maxTripHours: 6,
  /** 进仓的整车：每车公里的运费按九成装载摊到每托 */
  inboundPerPalletKm: C.inboundPerKm / (PALLETS_PER_TRAILER * 0.9),
  /** 物流园 → 中转仓的干线：双挂车（一车 52 托，按九成装），柴油多耗 35%，时速 70 公里，空车回来；摊到每托每公里 */
  shuttlePerPalletKm: ((C.diesel.perKm * 1.35 + C.driverHour / 70) * 2) / (PALLETS_PER_TRAILER * 2 * 0.9),
  drayage: C.drayage,
  /** 港口铁路接驳每箱的运费（到物流园货运站） */
  railPerContainer: C.railPerContainer,
  /** 每托的处理成本：物流园和新配送中心（收货、上架、拣货、装车），中转仓（换车） */
  handling: { park: 7.5, dc: 8.5, xd: 2.8 } as Record<SiteKind, number>,
  /** 能力（每天出多少托）：物流园现有、扩建能多出的，新配送中心，中转仓 */
  capacity: { park: 260, expand: 200, dc: 300, xd: 160 },
  /** 投资（美元）、年限，每年的固定运营费 */
  capex: { expand: { cost: 9_000_000, life: 20, opex: 350_000 }, dc: { cost: 14_000_000, life: 25, opex: 900_000 }, xd: { cost: 3_200_000, life: 20, opex: 300_000 } },
  /** 物流园现有的固定运营费（每个方案都有，不影响选择） */
  parkOpex: 1_600_000,
  /** 超出能力交第三方仓：每托多付 */
  overflowPerPallet: 28,
  /** 时效：车程超过 1 小时，每托每小时 4 美元 */
  serviceHours: 1,
  servicePerPalletHour: 4,
  /** 安全库存：全部在一个仓时约 2 天的货，持有成本每年 22% */
  safetyDays: 2,
  carrying: C.carrying,
} as const;

/** 规模 1 的店每天经配送中心的托数（按货源）和每托的货值 */
export const PER_SIZE = (() => {
  const by: Record<Source, number> = { domestic: 0, local: 0, bakery: 0, sea: 0, rail: 0, air: 0 };
  let value = 0;
  let pallets = 0;
  let domesticEast = 0;
  for (const f of FAMILIES) {
    if (S3.flow.direct.includes(f.key)) continue;
    const units = BASE_UNITS * f.share;
    const p = units / (casesPerPallet(f) * f.unitsPerCase);
    by[f.source] += p;
    pallets += p;
    value += (units / f.unitsPerCase) * f.caseCost;
    if (f.source === 'domestic' && f.supplier?.via === 'EAST') domesticEast += p;
  }
  return { pallets, by, value, domesticEast };
})();

export const palletsOf = (s: NetStore, p: NetParams): number => s.size * p.growth * PER_SIZE.pallets;

/** 一个仓每年的固定成本 */
export function fixedCost(site: NetSite | 'expand'): number {
  if (site === 'expand') return NET.capex.expand.cost * crf(NET.rate, NET.capex.expand.life) + NET.capex.expand.opex;
  if (site.kind === 'park') return NET.parkOpex;
  const c = NET.capex[site.kind];
  return (c.cost * crf(NET.rate, c.life) + c.opex) * site.land;
}

export const capacityOf = (site: NetSite, expanded: boolean): number => (site.kind === 'park' ? NET.capacity.park + (expanded ? NET.capacity.expand : 0) : NET.capacity[site.kind]);

/**
 * 规模 1 的店的货进一个配送中心，每天的进仓运费：
 * 海运箱从港口拖车过去，或者（物流园）大部分走铁路接驳；铁路班列的箱在物流园货运站，别的仓要再拖过去；
 * 空运从机场、长途公路和区域生鲜从高速口、面包房从物流园。
 */
export function inboundPerSize(d: Distances, site: NetSite, gate: Record<'PORT' | 'AIR' | 'NORTH' | 'EAST' | 'DC', import('./graph').NetPoint>): number {
  const k = (g: keyof typeof gate) => d.leg(gate[g], site.point).km;
  const pk = NET.inboundPerPalletKm;
  const by = PER_SIZE.by;
  const dray = (km: number) => (NET.drayage.base + NET.drayage.perKm * km) / PALLETS_PER_FEU;
  const railShare = S3.port.railShare;
  // 海运：拖车直接去，或者铁路接驳到物流园货运站再拖过去（取便宜的组合；物流园就是货运站）
  const seaRail = NET.railPerContainer / PALLETS_PER_FEU + (site.kind === 'park' ? 0 : dray(k('DC')));
  const sea = by.sea * (railShare * Math.min(seaRail, dray(k('PORT'))) + (1 - railShare) * dray(k('PORT')));
  const rail = by.rail * (site.kind === 'park' ? 0 : dray(k('DC')));
  const air = by.air * k('AIR') * pk;
  const east = PER_SIZE.domesticEast;
  const domestic = (by.domestic - east) * k('NORTH') * pk + east * k('EAST') * pk;
  const local = by.local * k('NORTH') * pk;
  const bakery = by.bakery * k('DC') * pk;
  return sea + rail + air + domestic + local + bakery;
}

/** 选址时估算的外送成本（每天，规模不同按托数）：按九成装载的整车往返摊到每托，加上每站的卸货 */
export function outboundPerDay(leg: Leg, pallets: number, p: NetParams): number {
  const trips = pallets / (NET.truckPallets * NET.loadFactor);
  const hours = 2 * leg.hours + NET.loadHours + (NET.unloadMin + NET.unloadMinPerPallet * NET.truckPallets * NET.loadFactor) / 60;
  const perTrip = 2 * leg.km * NET.perKm + hours * NET.driverHour + NET.vehicleDay * Math.min(1, hours / NET.shiftHours);
  return trips * perTrip * p.freight;
}

export const servicePenaltyPerDay = (hours: number, pallets: number): number => Math.max(0, hours - NET.serviceHours) * NET.servicePerPalletHour * pallets;

/** 安全库存的持有成本（每年）：各配送中心分到的货量占比 share（中转仓不算） */
export function inventoryCost(shares: readonly number[], p: NetParams, totalSize: number): number {
  const base = PER_SIZE.value * totalSize * p.growth * NET.safetyDays;
  return base * shares.reduce((a, s) => a + Math.sqrt(Math.max(0, s)), 0) * NET.carrying;
}
