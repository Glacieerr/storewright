import { buildGraph, Routes, STORE } from '../region/network';
import { BASE_UNITS, casesPerPallet, FAMILIES, PALLETS_PER_TRAILER, type Family } from '../region/products';
import type { ChainScenario } from './config';

/**
 * 货流规划：长途公路（含跨境 / 洲际）来的整车，直送门店还是先进配送中心。
 *
 * 海运、铁路班列、空运的货都要先进配送中心（拆箱、分拣、按温区配车），没得选；区域生鲜和面包房的货量小、要每天送，
 * 跟配送中心的车走。只有长途整车有两条路：
 *
 * - 进配送中心：卸车、上架、拣货、装车（配送中心工时），和别的货拼成每天的配送车送店，门店每天收一点，库存少；
 * - 直送门店：门店的库存降到订货点就订一整车（满载），平均 interval 天来一车；省掉配送中心的工时和送店那一段，
 *   但门店一次收一整车、店里多压几天的货，收货口占得久。
 *
 * 能直送的条件：不是易腐品（保质期 20 天以上，否则要每天小批量送）、不是长尾（单品太多、每个单品的量太小）、
 * 一车的量门店后仓放得下（常温 4 天以内，冷冻 3 天以内）。满足条件的再按每天的成本比：直送便宜就直送。
 */
export interface FlowDecision {
  key: string;
  label: string;
  via: 'direct' | 'dc';
  /** 每天多少托 */
  palletsPerDay: number;
  /** 直送时一次订几车（满载）、平均几天来一次 */
  loads: number;
  interval: number;
  /** 每天的成本（美元）：进配送中心、直送；以及分项 */
  costDc: number;
  costDirect: number;
  parts: { dcInbound: number; dcLabor: number; dcOutbound: number; dcCarry: number; directInbound: number; directReceive: number; directCarry: number };
  reason: string;
}

const routes = new Routes(buildGraph());

/** 直送一次订几整车：每天的量不到一车就订一车，超过就按天订整数车 */
export function directLoads(s: ChainScenario, fam: Family): number {
  return Math.max(1, Math.round(palletsPerDay(s, fam) / PALLETS_PER_TRAILER));
}

export function palletsPerDay(s: ChainScenario, fam: Family): number {
  return (BASE_UNITS * s.demand.scale * STORE.size * fam.share) / (casesPerPallet(fam) * fam.unitsPerCase);
}

export function planFlows(s: ChainScenario): FlowDecision[] {
  const C = s.costs;
  const dcStore = routes.get('DC', STORE.key);
  // 配送中心 → 门店一趟（往返、装卸约 1 小时）的成本，按 24 托分摊到每托
  const tripCost = dcStore.km * 2 * C.diesel.perKm + (dcStore.hours * 2 + 1) * C.driverHour + C.diesel.perDay / 2;
  const perPalletOut = tripCost / 24;
  return FAMILIES.filter((f) => f.source === 'domestic').map((fam) => {
    const pallets = palletsPerDay(s, fam);
    const loads = directLoads(s, fam);
    const interval = (loads * PALLETS_PER_TRAILER) / pallets;
    const via = fam.supplier?.via ?? 'NORTH';
    const off = fam.supplier?.km ?? 150;
    const units = BASE_UNITS * s.demand.scale * STORE.size * fam.share;
    const value = (units * fam.caseCost) / fam.unitsPerCase;
    const cases = units / fam.unitsPerCase;
    // 进配送中心：整车到配送中心（按九成装载）、配送中心工时、送店那一段分摊、配送中心按补货周期多放的库存
    const dcInbound = (pallets / (PALLETS_PER_TRAILER * 0.9)) * (off + routes.get(via, 'DC').km) * C.inboundPerKm;
    const dcLabor = (pallets / s.dc.receiveRate + cases / s.dc.pickRate + pallets / s.dc.loadRate) * C.dcLaborHour;
    const dcOutbound = pallets * perPalletOut;
    const dcCarry = value * (s.dc.reviewDays.domestic / 2 + 1 + 1.5) * (C.carrying / 365);
    // 直送：满载开到门店、门店收货（按每托卸货分钟算人工）、门店多放半个直送周期的货
    const directInbound = (pallets / PALLETS_PER_TRAILER) * (off + routes.get(via, STORE.key).km) * C.inboundPerKm;
    const directReceive = pallets * (s.store.unloadMinPerPallet / 60) * C.driverHour;
    const directCarry = value * (interval / 2 + 1) * (C.carrying / 365);
    const costDc = dcInbound + dcLabor + dcOutbound + dcCarry;
    const costDirect = directInbound + directReceive + directCarry;
    let reason: string;
    let direct = false;
    if (fam.life !== undefined && fam.life < 20) reason = `易腐（保质期 ${fam.life} 天），要每天小批量送，跟配送中心的车走`;
    else if (fam.cv >= 0.55) reason = '长尾商品（单品多、每个单品量小），在配送中心拼箱更合适';
    else if (interval > (fam.temp === 'frozen' ? 3 : 4)) reason = `一车是 ${interval.toFixed(1)} 天的量，门店${fam.temp === 'frozen' ? '冷冻库' : '后仓'}放不下`;
    else if (costDirect >= costDc) reason = `直送每天 ${Math.round(costDirect)} 美元，比进配送中心（${Math.round(costDc)}）贵`;
    else {
      direct = true;
      reason = `约 ${interval.toFixed(1)} 天来${loads > 1 ? ` ${loads} 车` : '一车'}（满载），直送每天省 ${Math.round(costDc - costDirect)} 美元`;
    }
    return { key: fam.key, label: fam.label, via: direct ? 'direct' : 'dc', palletsPerDay: pallets, loads, interval, costDc, costDirect, parts: { dcInbound, dcLabor, dcOutbound, dcCarry, directInbound, directReceive, directCarry }, reason };
  });
}
