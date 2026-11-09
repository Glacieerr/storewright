import { STORE } from '../region/network';
import { BASE_UNITS, casesPerPallet, FAMILIES, PALLETS_PER_FEU, PALLETS_PER_TRAILER, type Family } from '../region/products';
import { COSTS, scenarioFor, type ChainScenario, type Gen } from '../sim/config';

/**
 * 跨境：把仿真里已经用到的清关时间拆成一步一步（不改仿真的总数），列出每种来货要的单证、查验的概率，
 * 算税费和到岸成本，再看汇率变了到岸成本跟着变多少。
 *
 * 和仿真对得上的数字：跨境公路的供应商「过境清关多 2 天」；海运箱在港口堆场平均停留 dwellDays（清关、提箱，
 * 上一代 4.5 天，全链路靠预清关和预约 1.6 天）；铁路班列到物流园货运站后 terminalHours 小时进配送中心（查验、卸箱、调车，
 * 上一代 12 小时，全链路预清关 4 小时）；空运落地后 handlingHours 小时（上一代 8 小时，全链路预清关越库 2.5 小时）。
 * 每一步的时长按期望值算（查验 = 概率 × 时长），最后一步「等待 / 转运」是总数减去前面各步，所以加起来正好等于仿真用的数。
 *
 * 税率、费用、查验概率和汇率都是合成的示例（不是任何国家的实际税则）；货值和运价用仿真的参数（美元）。
 */
export type BorderMode = 'road' | 'sea' | 'rail' | 'air';
export const MODE_LABEL: Record<BorderMode, string> = { road: '跨境公路（整车）', sea: '海运（集装箱）', rail: '洲际铁路班列', air: '空运' };
export const MODES: BorderMode[] = ['road', 'sea', 'rail', 'air'];

/** 示例汇率：1 美元 = 7.20 本币 */
export const BASE_RATE = 7.2;

export interface ClearStep {
  label: string;
  /** 期望时长（小时）：查验类的步骤 = 概率 × 每次的时长 */
  hours: number;
  /** 查验类：发生的概率、每次多久 */
  prob?: number;
  each?: number;
  /** 海关的手续（否则是装卸、排队、等车） */
  customs: boolean;
  note: string;
}
export interface DocItem {
  label: string;
  detail: string;
  /** 哪些货要：全部、生鲜（卫生 / 检疫证书）、冷链（温度记录）、享受协定税率的 */
  need: 'all' | 'fresh' | 'reefer' | 'origin';
}
export interface FamilyCost {
  key: string;
  label: string;
  fresh: boolean;
  casesPerYear: number;
  /** 每箱（美元）：货值、国际运费、保险、关税；本币的口岸费用（报关、码头 / 场站、查验的期望） */
  goods: number;
  freight: number;
  insurance: number;
  duty: number;
  feesLcu: number;
  dutyRate: number;
  vatRate: number;
  /** 每箱到岸成本（本币，示例汇率）、进口增值税（本币，可以抵扣，不算进成本） */
  landedLcu: number;
  vatLcu: number;
}
export interface BorderFlow {
  mode: BorderMode;
  label: string;
  families: FamilyCost[];
  steps: ClearStep[];
  totalHours: number;
  /** 仿真里对应的数字 */
  sim: { label: string; hours: number };
  docs: DocItem[];
  /** 查验概率：单证审核、开箱查验、抽样检测（生鲜） */
  inspection: { docs: number; physical: number; lab: number };
  /** 每年（本币，示例汇率）：货值、运费、保险、关税、口岸费用、合计；可抵扣的增值税 */
  annual: { goods: number; freight: number; insurance: number; duty: number; fees: number; total: number; vat: number };
  /** 每年要报关几次（整车、整箱、航班的票数） */
  declarations: number;
  /** 清关期间压着的货：平均货值（本币）、每年的持有成本（按 22% / 年） */
  tied: { value: number; cost: number };
}
export interface FxScenario {
  change: number;
  rate: number;
  total: number;
  byMode: Record<BorderMode, number>;
}
export interface CrossBorder {
  gen: Gen;
  rate: number;
  flows: BorderFlow[];
  scenarios: FxScenario[];
  /** 汇率 ±shock 时每种来货每年到岸成本的变化（本币） */
  tornado: { mode: BorderMode; low: number; high: number }[];
  shock: number;
  /** 汇率每变 1%，每年到岸成本变多少（本币） */
  perPoint: number;
}

const modeOf = (f: Family): BorderMode | undefined => (f.supplier?.border ? 'road' : f.source === 'sea' ? 'sea' : f.source === 'rail' ? 'rail' : f.source === 'air' ? 'air' : undefined);
const isFresh = (f: Family) => f.life !== undefined || f.temp === 'frozen';
const isReefer = (f: Family) => f.temp !== 'ambient';

/** 示例关税税率（按大类）和进口增值税率 */
const DUTY: Record<string, number> = { ambient: 0.08, household: 0.065, beverage: 0.09, frozen: 0.1, produce: 0.05, meat: 0.07, dairy: 0.1, bakery: 0.08 };
const VAT = (f: Family) => (f.cat === 'household' ? 0.13 : 0.09);
/** 跨境公路的伙伴有贸易协定：凭原产地证书按协定税率（示例：普通税率的四成） */
const ORIGIN_FACTOR = 0.4;

/** 口岸费用（本币）：每票报关代理费；每车 / 每箱的口岸、码头、场站操作费；每次查验、抽样检测的费用 */
const FEES = {
  broker: 600,
  handling: { road: 300, sea: 1300, rail: 1000, air: 0 } as Record<BorderMode, number>,
  /** 空运按公斤收 */
  airPerKg: 1.2,
  physical: 2800,
  lab: 1500,
};
/** 每票空运货的重量（公斤） */
const AIR_SHIPMENT_KG = 1500;

/** 查验概率：上一代 / 全链路（预清关、信用好的进口商查得少） */
const INSPECT: Record<BorderMode, { g1: { docs: number; physical: number; lab: number }; g3: { docs: number; physical: number; lab: number } }> = {
  road: { g1: { docs: 0.2, physical: 0.06, lab: 0.1 }, g3: { docs: 0.12, physical: 0.03, lab: 0.06 } },
  sea: { g1: { docs: 0.15, physical: 0.05, lab: 0.1 }, g3: { docs: 0.1, physical: 0.03, lab: 0.06 } },
  rail: { g1: { docs: 0.15, physical: 0.06, lab: 0.1 }, g3: { docs: 0.08, physical: 0.03, lab: 0.06 } },
  air: { g1: { docs: 0.2, physical: 0.04, lab: 0.2 }, g3: { docs: 0.1, physical: 0.02, lab: 0.1 } },
};

/** 每票货（一车、一箱、一票空运）有多少箱 */
function casesPerShipment(f: Family, mode: BorderMode): number {
  const cpp = casesPerPallet(f);
  if (mode === 'road') return PALLETS_PER_TRAILER * 0.9 * cpp;
  if (mode === 'air') return AIR_SHIPMENT_KG / f.kg;
  return PALLETS_PER_FEU * cpp;
}

/** 国际运费（美元 / 箱） */
function freightPerCase(f: Family, mode: BorderMode): number {
  const cpp = casesPerPallet(f);
  if (mode === 'road') return (COSTS.inboundPerKm * ((f.supplier?.km ?? 0) + 25)) / (PALLETS_PER_TRAILER * 0.9 * cpp);
  if (mode === 'sea') return (COSTS.oceanPerFeu * (isReefer(f) ? 1.6 : 1)) / (PALLETS_PER_FEU * cpp);
  if (mode === 'rail') return (COSTS.railFreightPerFeu * (isReefer(f) ? 1.4 : 1)) / (PALLETS_PER_FEU * cpp);
  return COSTS.airPerKg * f.kg;
}

/** 清关的步骤：前面各步按期望值，最后一步是总数的余下部分（和仿真的总数对上） */
function steps(mode: BorderMode, s: ChainScenario, freshShare: number, insp: { docs: number; physical: number; lab: number }): { steps: ClearStep[]; sim: { label: string; hours: number } } {
  const g3 = s.gen === 'g3';
  const out: ClearStep[] = [];
  const add = (label: string, hours: number, customs: boolean, note: string, prob?: number, each?: number) => out.push({ label, hours, customs, note, ...(prob !== undefined ? { prob, each } : {}) });
  let sim: { label: string; hours: number };
  if (mode === 'road') {
    sim = { label: '仿真：跨境的供应商提前期多 2 天（过境清关）', hours: 48 };
    add('出口报关（起运地）', 3, true, '供应商的报关行办，车出发前放行');
    add('口岸排队过境', 10, false, '口岸车道、白天高峰排队');
    add('进口申报和单证审核', 5, true, '报关单、发票、装箱单、原产地证书');
    add('单证复核', insp.docs * 2, true, '海关要求补充材料', insp.docs, 2);
    add('开箱查验', insp.physical * 10, true, '卸货查验再装车', insp.physical, 10);
    add('缴税放行', 2, true, '电子缴税，放行指令发到口岸');
  } else if (mode === 'sea') {
    const dwell = s.port.dwellDays * 24;
    sim = { label: `仿真：集装箱在港口堆场平均停留 ${s.port.dwellDays} 天（清关、提箱）`, hours: dwell };
    add('卸船理货', 6, false, '船靠泊以后箱子落到堆场');
    if (g3) add('到港前预申报', 0, true, '开船后就提交舱单和报关单，到港时已审完');
    else add('到港后申报和单证审核', 24, true, '船到了才开始报关');
    add(g3 ? '审核放行' : '缴税放行', g3 ? 2 : 6, true, g3 ? '预申报的箱到港即放行' : '审完再缴税、放行');
    add('单证复核', insp.docs * (g3 ? 4 : 8), true, '海关要求补充材料', insp.docs, g3 ? 4 : 8);
    add('开箱查验', insp.physical * (g3 ? 24 : 36), true, '吊到查验场开箱，查完再封箱', insp.physical, g3 ? 24 : 36);
    add('抽样检测（生鲜）', freshShare * insp.lab * (g3 ? 36 : 48), true, '冷箱生鲜抽样送检', freshShare * insp.lab, g3 ? 36 : 48);
  } else if (mode === 'rail') {
    sim = { label: `仿真：班列到物流园货运站后 ${s.rail.terminalHours} 小时进配送中心（查验、卸箱、调车）`, hours: s.rail.terminalHours };
    if (g3) add('预清关', 0, true, '班列在途时已经报关');
    else add('到站申报', 3, true, '到站才报关');
    add('单证复核', insp.docs * (g3 ? 1 : 2), true, '海关要求补充材料', insp.docs, g3 ? 1 : 2);
    add('开箱查验', insp.physical * (g3 ? 6 : 10), true, '在货运站的查验线开箱', insp.physical, g3 ? 6 : 10);
    add('卸箱', g3 ? 2 : 3, false, '龙门吊把箱卸到挂车上');
  } else {
    sim = { label: `仿真：货运航班落地后 ${s.air.handlingHours} 小时货出货站（拆板、清关、转运）`, hours: s.air.handlingHours };
    add('拆板理货', g3 ? 1 : 2, false, '集装板拆开、点数');
    add(g3 ? '预清关放行' : '申报放行', g3 ? 0.3 : 3, true, g3 ? '起飞前已申报，落地核对放行' : '落地后申报');
    add('检疫抽样（生鲜）', freshShare * insp.lab * (g3 ? 3 : 4), true, '果蔬、海鲜抽样', freshShare * insp.lab, g3 ? 3 : 4);
    add('开箱查验', insp.physical * (g3 ? 3 : 4), true, '查验台开箱', insp.physical, g3 ? 3 : 4);
  }
  const used = out.reduce((a, x) => a + x.hours, 0);
  const rest = Math.max(0, sim.hours - used);
  const last: Record<BorderMode, [string, boolean, string]> = {
    road: ['转关运输、夜间不放行的等待', false, '口岸夜里不放行，车在监管场站等'],
    sea: [g3 ? '按预约提箱' : '等提箱预约和拖车', false, '不是海关的时间：等拖车、等堆场的提箱时段'],
    rail: ['调车进配送中心', false, '挂车从货运站开进配送中心的收货门'],
    air: ['装车转运', false, '冷链车从货站拉到配送中心'],
  };
  const [label, customs, note] = last[mode];
  out.push({ label, hours: rest, customs, note });
  return { steps: out, sim };
}

function docs(mode: BorderMode, g3: boolean): DocItem[] {
  const transport: Record<BorderMode, [string, string]> = {
    road: ['国际公路货运单', '承运人签发，随车走'],
    sea: ['海运提单', '船公司签发；提箱凭它'],
    rail: ['国际铁路联运运单', '始发站签发，随班列走'],
    air: ['航空运单', '航空公司或货代签发'],
  };
  const list: DocItem[] = [
    { label: '商业发票', detail: '货值、币种、成交条件（完税价格按它算）', need: 'all' },
    { label: '装箱单', detail: '每箱的件数、重量、体积，查验时按它点数', need: 'all' },
    { label: transport[mode][0], detail: transport[mode][1], need: 'all' },
    { label: '进口报关单', detail: g3 ? '到货前提交（预申报）' : '到货后提交', need: 'all' },
    { label: '保险单', detail: '到岸价成交时随附', need: 'all' },
    { label: '原产地证书', detail: mode === 'road' ? '贸易协定伙伴的货凭它按协定税率' : '要享受优惠税率时提供', need: 'origin' },
    { label: '卫生证书 / 植物检疫证书', detail: '肉类、海鲜、冷冻品要卫生证书，果蔬要植物检疫证书', need: 'fresh' },
    { label: '冷链温度记录', detail: '冷箱、冷藏车全程的温度曲线', need: 'reefer' },
  ];
  if (mode === 'sea' || mode === 'air') list.push({ label: mode === 'sea' ? '舱单（到港前申报）' : '电子舱单', detail: '承运人在到货前向海关申报', need: 'all' });
  return list;
}

export function crossBorder(gen: Gen = 'g3', opts: { rate?: number; shock?: number } = {}): CrossBorder {
  const s = scenarioFor(gen, 1);
  const rate = opts.rate ?? BASE_RATE;
  const shock = opts.shock ?? 0.1;
  const flows: BorderFlow[] = MODES.map((mode) => {
    const fams = FAMILIES.filter((f) => modeOf(f) === mode);
    const insp = INSPECT[mode][gen === 'g3' ? 'g3' : 'g1'];
    const families: FamilyCost[] = fams.map((f) => {
      const casesPerYear = ((BASE_UNITS * STORE.size * f.share) / f.unitsPerCase) * 365;
      const goods = f.caseCost;
      const freight = freightPerCase(f, mode);
      const insurance = 0.003 * (goods + freight);
      const dutyRate = (DUTY[f.cat] ?? 0.08) * (mode === 'road' ? ORIGIN_FACTOR : 1);
      const duty = dutyRate * (goods + freight + insurance);
      const per = casesPerShipment(f, mode);
      const handling = mode === 'air' ? FEES.airPerKg * f.kg * per : FEES.handling[mode];
      const feesLcu = (FEES.broker + handling + insp.physical * FEES.physical + (isFresh(f) ? insp.lab * FEES.lab : 0)) / per;
      const vatRate = VAT(f);
      return {
        key: f.key,
        label: f.label,
        fresh: isFresh(f),
        casesPerYear,
        goods,
        freight,
        insurance,
        duty,
        feesLcu,
        dutyRate,
        vatRate,
        landedLcu: (goods + freight + insurance + duty) * rate + feesLcu,
        vatLcu: vatRate * (goods + freight + insurance + duty) * rate,
      };
    });
    const cases = families.reduce((a, f) => a + f.casesPerYear, 0);
    const freshShare = cases ? families.filter((f) => f.fresh).reduce((a, f) => a + f.casesPerYear, 0) / cases : 0;
    const st = steps(mode, s, freshShare, insp);
    const sum = (pick: (f: FamilyCost) => number) => families.reduce((a, f) => a + pick(f) * f.casesPerYear, 0);
    const annual = {
      goods: sum((f) => f.goods * rate),
      freight: sum((f) => f.freight * rate),
      insurance: sum((f) => f.insurance * rate),
      duty: sum((f) => f.duty * rate),
      fees: sum((f) => f.feesLcu),
      total: 0,
      vat: sum((f) => f.vatLcu),
    };
    annual.total = annual.goods + annual.freight + annual.insurance + annual.duty + annual.fees;
    const declarations = fams.reduce((a, f, i) => a + (families[i] as FamilyCost).casesPerYear / casesPerShipment(f, mode), 0);
    const totalHours = st.steps.reduce((a, x) => a + x.hours, 0);
    const held = ((annual.goods + annual.freight + annual.insurance + annual.duty) * totalHours) / (365 * 24);
    return { mode, label: MODE_LABEL[mode], families, steps: st.steps, totalHours, sim: st.sim, docs: docs(mode, gen === 'g3'), inspection: insp, annual, declarations, tied: { value: held, cost: held * COSTS.carrying } };
  });
  // 汇率情景：本币贬值（1 美元换更多本币）时货值、运费、保险、关税都按美元折算变贵，口岸费用是本币的不变
  const at = (change: number): FxScenario => {
    const k = 1 + change;
    const byMode = Object.fromEntries(flows.map((f) => [f.mode, (f.annual.goods + f.annual.freight + f.annual.insurance + f.annual.duty) * k + f.annual.fees])) as Record<BorderMode, number>;
    return { change, rate: rate * k, total: Object.values(byMode).reduce((a, b) => a + b, 0), byMode };
  };
  const scenarios = [-0.2, -0.1, 0, 0.1, 0.2].map(at);
  const base = at(0);
  const lo = at(-shock);
  const hi = at(shock);
  const tornado = flows.map((f) => ({ mode: f.mode, low: lo.byMode[f.mode] - base.byMode[f.mode], high: hi.byMode[f.mode] - base.byMode[f.mode] })).sort((a, b) => b.high - b.low - (a.high - a.low));
  return { gen, rate, flows, scenarios, tornado, shock, perPoint: (at(0.01).total - base.total) };
}
