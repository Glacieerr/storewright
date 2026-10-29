import { createRng } from '@storewright/domain';
import { trafficDelaySec, type TrafficParams } from './traffic';

/**
 * 到货排班（决策记录 0019）：一天里有哪些车、几点到。全部为按公开资料和通用经验设定的假设参数。
 *
 * - 配送中心（DC）：冷藏半挂车每天清晨一车（大型店中午再来一车）；常温长途半挂车关门后陆续到（每周 6 晚，
 *   约 18 托一车，几车间隔 4–18 分钟）；有百货的超市每周 3 次（大型店每天）下午来一辆百货半挂车，托盘进后仓货架。
 * - 供应商直送（DSD）：面包、乳品、鸡蛋、饮料、饮用水、零食、饼干、啤酒、冰品、鲜花、杂志贺卡、熟食、药品……
 *   每家有固定的频次（每周几次，按星期几排开）和送货时段，大多在早上 4:30–12:00；车型是厢式货车或面包车，
 *   饮用水、整车直送用半挂车。货白天直接送上货架。
 * - 快递面包车每天来取送线上包裹（门店自提的包裹）。
 * - 准点：按预约时刻正态起伏（配送中心 σ 15 分钟、供应商 σ 20 分钟），约 4% 的供应商晚到 1–2 小时；
 *   车到早了也只能在场内排队，等收货员上班、卸货门空出来。
 * - 季节：夏天冰品、饮用水、啤酒多跑几趟，春天鲜花和园艺多，冬天（年末旺季）百货车多一趟。
 * - 门店规模（scale，中型店 = 1）：频次按 scale^0.6 伸缩（每周最多 7 次），托盘数按 √scale；小店有的供应商不来。
 * 建材店是另一套供应商（板材、建材整车直送，家电、油漆、园艺厢式货车），没有冷藏车。
 * 同一家门店每周的排班固定（按供应商编号决定星期几、几点），每天只有准点起伏随种子变化。
 */

export type DeliveryKind = 'SEMI' | 'REEFER' | 'BOX' | 'VAN';
export type DeliverySource = 'DC' | 'DC_GM' | 'VENDOR' | 'PARCEL';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface VendorSpec {
  id: string;
  label: string;
  kind: DeliveryKind;
  /** 每周来几次（中型店） */
  perWeek: number;
  /** 送货时段（小时） */
  window: [number, number];
  /** 每次的托盘数（含笼车、周转架，按托盘计） */
  pallets: [number, number];
  /** 季节加减几趟 */
  season?: Partial<Record<Season, number>>;
  /** 只有有这项设施的门店才来 */
  needs?: 'pharmacy';
  /** 门店小于这个规模时不来 */
  minScale?: number;
  /** 半挂车整车直送（托盘多，叉车卸货） */
  semi?: boolean;
  source?: DeliverySource;
}

/** 超市的供应商直送（DSD）与快递 */
export const GROCERY_VENDORS: VendorSpec[] = [
  { id: 'BREAD-A', label: '面包直送', kind: 'BOX', perWeek: 6, window: [5, 7.5], pallets: [1, 2] },
  { id: 'BREAD-B', label: '面包直送', kind: 'VAN', perWeek: 4, window: [5.5, 8], pallets: [1, 1], minScale: 0.6 },
  { id: 'DAIRY', label: '乳品直送', kind: 'BOX', perWeek: 6, window: [4.5, 7], pallets: [2, 4] },
  { id: 'SWEETS', label: '糕点直送', kind: 'VAN', perWeek: 3, window: [5.5, 8.5], pallets: [1, 1] },
  { id: 'EGGS', label: '鸡蛋直送', kind: 'VAN', perWeek: 2, window: [6, 9], pallets: [1, 1] },
  { id: 'SODA-A', label: '饮料直送', kind: 'BOX', perWeek: 3, window: [6, 10], pallets: [3, 6], season: { summer: 1 } },
  { id: 'SODA-B', label: '饮料直送', kind: 'BOX', perWeek: 2, window: [7, 11], pallets: [2, 4], minScale: 0.6 },
  { id: 'WATER', label: '饮用水直送', kind: 'SEMI', perWeek: 1, window: [8, 12], pallets: [8, 14], season: { summer: 1 }, semi: true, minScale: 0.8 },
  { id: 'JUICE', label: '果汁直送', kind: 'BOX', perWeek: 2, window: [7, 11], pallets: [1, 3] },
  { id: 'CHIPS-A', label: '零食直送', kind: 'BOX', perWeek: 3, window: [7, 11], pallets: [1, 2] },
  { id: 'CHIPS-B', label: '零食直送', kind: 'VAN', perWeek: 2, window: [8, 12], pallets: [1, 1], minScale: 0.6 },
  { id: 'COOKIES', label: '饼干直送', kind: 'VAN', perWeek: 2, window: [8, 12], pallets: [1, 1] },
  { id: 'BEER-A', label: '啤酒直送', kind: 'BOX', perWeek: 2, window: [7, 11], pallets: [3, 6], season: { summer: 1 } },
  { id: 'BEER-B', label: '啤酒直送', kind: 'BOX', perWeek: 1, window: [8, 12], pallets: [2, 5], minScale: 0.8 },
  { id: 'ICE', label: '冰品直送', kind: 'BOX', perWeek: 2, window: [9, 13], pallets: [1, 3], season: { summer: 3, winter: -1 } },
  { id: 'FLORAL', label: '鲜花直送', kind: 'VAN', perWeek: 2, window: [8, 11], pallets: [1, 1], season: { spring: 1, winter: -1 } },
  { id: 'CARDS', label: '杂志贺卡直送', kind: 'VAN', perWeek: 1, window: [9, 14], pallets: [1, 1] },
  { id: 'WINE', label: '葡萄酒直送', kind: 'VAN', perWeek: 1, window: [9, 13], pallets: [1, 2], minScale: 0.8 },
  { id: 'DELI', label: '熟食直送', kind: 'VAN', perWeek: 3, window: [5, 8], pallets: [1, 1] },
  { id: 'PHARMACY', label: '药品配送', kind: 'VAN', perWeek: 6, window: [9, 11], pallets: [1, 1], needs: 'pharmacy' },
  { id: 'PARCEL', label: '快递取送', kind: 'VAN', perWeek: 6, window: [10, 16], pallets: [1, 1], source: 'PARCEL' },
];

/** 建材店的供应商直送与快递（决策记录 0011 的第二个行业） */
export const HARDWARE_VENDORS: VendorSpec[] = [
  { id: 'LUMBER', label: '板材直送', kind: 'SEMI', perWeek: 2, window: [6, 10], pallets: [10, 16], semi: true },
  { id: 'BUILDING', label: '建材直送', kind: 'SEMI', perWeek: 1, window: [7, 11], pallets: [8, 14], semi: true },
  { id: 'APPLIANCE', label: '家电直送', kind: 'BOX', perWeek: 3, window: [8, 12], pallets: [2, 4] },
  { id: 'PAINT', label: '油漆直送', kind: 'BOX', perWeek: 2, window: [7, 11], pallets: [2, 3] },
  { id: 'GARDEN', label: '园艺直送', kind: 'BOX', perWeek: 2, window: [7, 11], pallets: [2, 5], season: { spring: 3, summer: 1, winter: -1 } },
  { id: 'TOOLS', label: '工具直送', kind: 'VAN', perWeek: 2, window: [8, 12], pallets: [1, 1] },
  { id: 'PARCEL', label: '快递取送', kind: 'VAN', perWeek: 6, window: [10, 16], pallets: [1, 1], source: 'PARCEL' },
];

export interface DeliveryInput {
  industry?: 'GROCERY' | 'HARDWARE';
  /** 门店规模（中型店 = 1） */
  scale: number;
  /** 星期几（0 = 周一） */
  weekday: number;
  season: Season;
  /** 营业时间（当天的秒数） */
  open: number;
  close: number;
  /** 夜间常温半挂车、清晨冷藏半挂车的托盘数 */
  dcPallets: number;
  reeferPallets: number;
  /** 有百货（GM）商品 */
  gm: boolean;
  pharmacy: boolean;
  seed: number;
  /** 路况（拥堵、学校、铁路道口）：车辆按预约出发，路上的延误让到达推后（最后一程约 30 分钟） */
  traffic?: TrafficParams;
}

export interface DeliveryPlan {
  id: string;
  kind: DeliveryKind;
  label: string;
  source: DeliverySource;
  /** 预约时刻与实际到达卸货场入口的时刻（秒） */
  appt: number;
  arrive: number;
  pallets: number;
  /** 供应商直送：托盘白天直接送上货架 */
  vendor?: boolean;
  /** 供应商的送货时段（小时）：预约可以在这个时段里调整（AI 建议挪预约时用，决策记录 0020） */
  window?: [number, number];
  /** 路上的延误（秒，已经算进 arrive） */
  delay?: number;
}

/** 供应商编号的稳定哈希：决定每周哪几天来、时段里几点来 */
function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 每周 n 次排在星期几（0 = 周一）：每天来的才在周日来，其余在周一到周六里均匀错开
 * （例如 3 次 = 周一、周三、周五或周二、周四、周六），起点按供应商编号。所以周日的到货最少。
 */
export function visitDays(id: string, n: number): number[] {
  const k = Math.max(0, Math.min(7, Math.round(n)));
  if (k === 7) return [0, 1, 2, 3, 4, 5, 6];
  const off = hashId(id) % 6;
  const days = new Set<number>();
  for (let i = 0; i < k; i++) days.add((off + Math.floor((i * 6) / k)) % 6);
  return [...days].sort((a, b) => a - b);
}

/** 季节和门店规模调整后的每周次数 */
export function weeklyVisits(v: VendorSpec, scale: number, season: Season): number {
  if (v.minScale !== undefined && scale < v.minScale) return 0;
  const base = v.perWeek * Math.min(1.8, Math.max(0.5, scale ** 0.6)) + (v.season?.[season] ?? 0);
  return Math.max(0, Math.min(7, Math.round(base)));
}

export function planDeliveries(input: DeliveryInput): DeliveryPlan[] {
  const rng = createRng(input.seed * 7349 + 113);
  const k = Math.max(0.3, input.scale);
  const hw = input.industry === 'HARDWARE';
  const out: DeliveryPlan[] = [];
  const gauss = () => {
    // Box–Muller
    const u = Math.max(1e-9, rng.next());
    const w = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
  };
  // 1. 配送中心：清晨冷藏车（超市），大型店中午再来一车
  if (!hw) {
    const appt = input.open - 90 * 60;
    out.push({ id: 'TRUCK-REEFER', kind: 'REEFER', label: '配送中心冷藏半挂车', source: 'DC', appt, arrive: appt + gauss() * 15 * 60, pallets: Math.max(2, input.reeferPallets) });
    if (k >= 1.6) {
      const a2 = input.open + 4.5 * 3600;
      out.push({ id: 'TRUCK-REEFER-2', kind: 'REEFER', label: '配送中心冷藏半挂车', source: 'DC', appt: a2, arrive: a2 + gauss() * 15 * 60, pallets: Math.max(2, Math.round(input.reeferPallets * 0.6)) });
    }
  }
  // 2. 百货半挂车：每周 3 次（大型店每天），下午到；年末旺季多一趟
  if (input.gm && !hw) {
    const n = Math.min(7, (k >= 1.6 ? 7 : 3) + (input.season === 'winter' ? 1 : 0));
    if (visitDays('DC-GM', n).includes(input.weekday)) {
      const appt = 13.5 * 3600;
      out.push({ id: 'TRUCK-GM', kind: 'SEMI', label: '配送中心百货半挂车', source: 'DC_GM', appt, arrive: appt + gauss() * 15 * 60, pallets: Math.max(4, Math.round(rng.int(10, 16) * Math.sqrt(k))) });
    }
  }
  // 3. 供应商直送与快递
  for (const v of hw ? HARDWARE_VENDORS : GROCERY_VENDORS) {
    if (v.needs === 'pharmacy' && !input.pharmacy) continue;
    const n = weeklyVisits(v, k, input.season);
    if (!visitDays(v.id, n).includes(input.weekday)) continue;
    const h = hashId(`${v.id}#t`);
    const appt = (v.window[0] + ((h % 1000) / 1000) * (v.window[1] - v.window[0])) * 3600;
    const late = rng.chance(0.04) ? rng.uniform(60, 120) * 60 : 0;
    const arrive = appt + gauss() * 20 * 60 + late;
    const pallets = Math.max(1, Math.round(rng.int(v.pallets[0], v.pallets[1]) * Math.sqrt(k)));
    out.push({ id: `VENDOR-${v.id}`, kind: v.kind, label: v.label, source: v.source ?? 'VENDOR', appt, arrive, pallets, vendor: true, window: [v.window[0], v.window[1]] });
  }
  // 4. 夜间配送中心的长途半挂车：约 18 托一车，第一车关门后 20 分钟到，之后每隔 4–18 分钟一车（每周 6 晚，周六晚没有）
  if (input.weekday !== 5 && input.dcPallets > 0) {
    const nightTrucks = Math.max(1, Math.ceil(input.dcPallets / 18));
    let nightAt = input.close + 20 * 60;
    for (let i = 0; i < nightTrucks; i++) {
      const n = Math.floor(input.dcPallets / nightTrucks) + (i < input.dcPallets % nightTrucks ? 1 : 0);
      out.push({ id: nightTrucks === 1 ? 'TRUCK-NIGHT' : `TRUCK-NIGHT-${i + 1}`, kind: 'SEMI', label: '配送中心长途半挂车', source: 'DC', appt: nightAt, arrive: nightAt, pallets: n });
      nightAt += rng.uniform(4, 18) * 60;
    }
  }
  if (input.traffic)
    for (const d of out) {
      const delay = trafficDelaySec(input.traffic, d.arrive - 1800, 1800, rng.next());
      d.arrive += delay;
      d.delay = delay;
    }
  return out.sort((a, b) => a.arrive - b.arrive);
}

/**
 * 把一辆车的预约挪到 appt（AI 建议「挪预约」，决策记录 0020）：准点的起伏不变，路上的延误按新时刻的路况重新估（取中位数）。
 */
export function moveDelivery(d: DeliveryPlan, appt: number, traffic?: TrafficParams): DeliveryPlan {
  const punctual = d.arrive - (d.delay ?? 0) - d.appt;
  const delay = traffic ? trafficDelaySec(traffic, appt + punctual - 1800, 1800, 0.5) : 0;
  return { ...d, appt, arrive: appt + punctual + delay, delay };
}
