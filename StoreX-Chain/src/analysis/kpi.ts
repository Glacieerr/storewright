import type { ChainResult } from '../sim/engine';
import { STORES } from '../region/network';

/** 全链路的指标：名称、单位、取值、越大越好还是越小越好、属于哪个环节 */
export interface Kpi {
  key: string;
  label: string;
  unit: string;
  group: '门店' | '配送中心' | '干线与配送' | '港口与机场' | '成本' | '排放' | '全系统';
  better: 'lower' | 'higher' | 'none';
  get: (r: ChainResult) => number;
  digits?: number;
}

/** 门店的人工和能耗（来自 StoreX 报告：规模 1.0 的门店每天的成本；综合店按规模折算），全系统对比用 */
export const STORE_OPEX = {
  g1: { labor: 13_894, energy: 908 },
  g2: { labor: 8_827, energy: 473 },
  g3: { labor: 8_827, energy: 473 },
} as const;
export const TOTAL_SIZE = STORES.reduce((a, s) => a + s.size, 0);
/** 按当前的门店规模折算（设施管理台可以改规模，所以每次现算） */
export const storeOpex = (r: ChainResult): number => (STORE_OPEX[r.gen].labor + STORE_OPEX[r.gen].energy) * STORES.reduce((a, s) => a + s.size, 0);

export const KPIS: readonly Kpi[] = [
  { key: 'service', label: '门店服务水平（需求满足）', unit: '%', group: '门店', better: 'higher', get: (r) => r.store.service, digits: 2 },
  { key: 'stockout', label: '收市时卖空的商品位', unit: '%', group: '门店', better: 'lower', get: (r) => r.store.stockoutSlotPct, digits: 2 },
  { key: 'storeInv', label: '门店库存', unit: '天', group: '门店', better: 'lower', get: (r) => r.store.invDays, digits: 2 },
  { key: 'waste', label: '门店生鲜损耗（报废 / 到货）', unit: '%', group: '门店', better: 'lower', get: (r) => r.store.wastePct, digits: 2 },
  { key: 'freshRemain', label: '生鲜到店时剩余的保质期', unit: '%', group: '门店', better: 'higher', get: (r) => r.store.freshRemainPct, digits: 1 },
  { key: 'arrivals', label: '到店卸货的车次（配送车、面包车、长途直送）', unit: '次 / 天', group: '门店', better: 'lower', get: (r) => r.store.arrivals, digits: 1 },
  { key: 'onTime', label: '准时送达', unit: '%', group: '门店', better: 'higher', get: (r) => r.store.onTimePct, digits: 1 },
  { key: 'peakAmbient', label: '门店常温货最多的时候（货架 + 后仓）', unit: '托', group: '门店', better: 'lower', get: (r) => r.store.peakPallets.ambient, digits: 0 },
  { key: 'peakChilled', label: '门店冷藏货最多的时候（货架 + 冷藏库）', unit: '托', group: '门店', better: 'lower', get: (r) => r.store.peakPallets.chilled, digits: 0 },
  { key: 'peakFrozen', label: '门店冷冻货最多的时候（货架 + 冷冻库）', unit: '托', group: '门店', better: 'lower', get: (r) => r.store.peakPallets.frozen, digits: 0 },
  { key: 'dcInv', label: '配送中心库存', unit: '天', group: '配送中心', better: 'lower', get: (r) => r.dc.invDays, digits: 2 },
  { key: 'dcFill', label: '配送中心订单满足率', unit: '%', group: '配送中心', better: 'higher', get: (r) => r.dc.fillPct, digits: 2 },
  { key: 'dcLabor', label: '配送中心工时', unit: '小时 / 天', group: '配送中心', better: 'lower', get: (r) => r.dc.laborHours, digits: 0 },
  { key: 'casesPerHour', label: '配送中心每工时处理的箱数', unit: '箱', group: '配送中心', better: 'higher', get: (r) => r.dc.casesPerHour, digits: 0 },
  { key: 'trips', label: '配送车次（不含面包车）', unit: '车 / 天', group: '干线与配送', better: 'lower', get: (r) => r.outbound.trips, digits: 1 },
  { key: 'vanTrips', label: '面包房直送小货车', unit: '车 / 天', group: '干线与配送', better: 'lower', get: (r) => r.outbound.vanTrips, digits: 1 },
  { key: 'outKm', label: '配送里程（含面包车）', unit: '公里 / 天', group: '干线与配送', better: 'lower', get: (r) => r.outbound.km + r.outbound.vanKm, digits: 0 },
  { key: 'fill', label: '配送车装载率', unit: '%', group: '干线与配送', better: 'higher', get: (r) => r.outbound.fillPct, digits: 1 },
  { key: 'fleet', label: '配送车队（最多同时用车）', unit: '辆', group: '干线与配送', better: 'lower', get: (r) => r.outbound.fleet, digits: 0 },
  { key: 'evShare', label: '电动车承担的配送里程', unit: '%', group: '干线与配送', better: 'higher', get: (r) => (r.outbound.km > 0 ? (r.outbound.evKm / r.outbound.km) * 100 : 0), digits: 0 },
  { key: 'inboundLoads', label: '长途整车（进配送中心 + 直送门店，不含回程顺带）', unit: '车 / 天', group: '干线与配送', better: 'lower', get: (r) => r.inbound.truckloads + r.inbound.directLoads, digits: 1 },
  { key: 'directShare', label: '长途整车直送门店的比例', unit: '%', group: '干线与配送', better: 'none', get: (r) => (r.inbound.truckloads + r.inbound.directLoads > 0 ? (r.inbound.directLoads / (r.inbound.truckloads + r.inbound.directLoads)) * 100 : 0), digits: 0 },
  { key: 'inboundKm', label: '进货里程（长途整车 + 区域生鲜 + 机场）', unit: '公里 / 天', group: '干线与配送', better: 'lower', get: (r) => r.inbound.km + r.inbound.directKm + r.inbound.milkKm, digits: 0 },
  { key: 'domLead', label: '长途公路：下单到到货（配送中心或门店）', unit: '天', group: '干线与配送', better: 'lower', get: (r) => r.leadTime.domesticDays, digits: 2 },
  { key: 'dwell', label: '集装箱在港口堆场停留', unit: '天', group: '港口与机场', better: 'lower', get: (r) => r.inbound.portDwellDays, digits: 2 },
  { key: 'railShare', label: '走铁路的集装箱', unit: '%', group: '港口与机场', better: 'higher', get: (r) => (r.inbound.containers > 0 ? (r.inbound.railContainers / r.inbound.containers) * 100 : 0), digits: 0 },
  { key: 'seaLead', label: '海运：下单到进配送中心', unit: '天', group: '港口与机场', better: 'lower', get: (r) => r.leadTime.seaDays, digits: 1 },
  { key: 'railLead', label: '铁路班列：下单到进配送中心', unit: '天', group: '港口与机场', better: 'lower', get: (r) => r.leadTime.railDays, digits: 1 },
  { key: 'airLead', label: '空运：下单到进配送中心', unit: '天', group: '港口与机场', better: 'lower', get: (r) => r.leadTime.airDays, digits: 2 },
  { key: 'demurrage', label: '港口滞箱费', unit: '美元 / 天', group: '港口与机场', better: 'lower', get: (r) => r.inbound.demurrage, digits: 0 },
  { key: 'costTransport', label: '运输成本（配送 + 面包车 + 进货 + 港口拖车和铁路）', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.outbound + r.cost.vans + r.cost.inbound + r.cost.drayageRail, digits: 0 },
  { key: 'costDc', label: '配送中心人工', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.dcLabor, digits: 0 },
  { key: 'costCarrying', label: '库存持有成本', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.carrying, digits: 0 },
  { key: 'costWaste', label: '生鲜报废和打折', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.waste, digits: 0 },
  { key: 'costLost', label: '缺货流失的毛利', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.lostMargin, digits: 0 },
  { key: 'costFreight', label: '海运、班列、空运运费', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.freight, digits: 0 },
  { key: 'costTotal', label: '供应链成本合计', unit: '美元 / 天', group: '成本', better: 'lower', get: (r) => r.cost.total, digits: 0 },
  { key: 'costPerCase', label: '每箱的供应链成本', unit: '美元 / 箱', group: '成本', better: 'lower', get: (r) => r.cost.perCase, digits: 2 },
  { key: 'workingCapital', label: '库存资金（门店 + 配送中心）', unit: '百万美元', group: '成本', better: 'lower', get: (r) => (r.store.invValue + r.dc.invValue) / 1e6, digits: 2 },
  { key: 'co2Local', label: '本地运输排放（配送、进货、港口）', unit: '吨 / 天', group: '排放', better: 'lower', get: (r) => (r.co2.outbound + r.co2.vans + r.co2.inbound + r.co2.portRail) / 1000, digits: 2 },
  { key: 'co2Long', label: '远洋、班列和航空排放（分摊到自己的货）', unit: '吨 / 天', group: '排放', better: 'lower', get: (r) => r.co2.longHaul / 1000, digits: 1 },
  { key: 'co2PerCase', label: '每箱的本地运输排放', unit: '克 / 箱', group: '排放', better: 'lower', get: (r) => (r.casesDelivered > 0 ? ((r.co2.outbound + r.co2.vans + r.co2.inbound + r.co2.portRail) / r.casesDelivered) * 1000 : 0), digits: 0 },
  { key: 'storeOpex', label: '门店人工 + 能耗（来自 StoreX 报告）', unit: '美元 / 天', group: '全系统', better: 'lower', get: (r) => storeOpex(r), digits: 0 },
  { key: 'systemTotal', label: '全系统运营成本（供应链 + 门店人工能耗）', unit: '美元 / 天', group: '全系统', better: 'lower', get: (r) => r.cost.total + storeOpex(r), digits: 0 },
];

export function kpi(key: string): Kpi {
  const k = KPIS.find((x) => x.key === key);
  if (!k) throw new Error(`unknown kpi ${key}`);
  return k;
}
