import { crf, irr, payback } from '../../../StoreX/src/analysis/economics';
import { STORES } from '../region/network';
import type { Gen } from '../sim/config';

/**
 * 全链路的商业分析：
 * - 上游这一步（StoreX → StoreX 全链路）：门店已经是 StoreX，只算上游的投资和节省；
 * - 全系统（上一代 → StoreX 全链路）：加上门店改造成 StoreX 的投资（按 StoreX 报告里那家店的投资、按规模折算）。
 * 投资按给一家综合店供货的规模估：配送中心每天几千箱、配送车队几辆、铁路专用线和平台按这家店的量分摊。
 * 2026 年建设，2027–2036 年运营 10 年，2026 年不变价格，折现率 7%；设备价格是公开资料里的常见区间，不是报价。
 * 库存持有成本 22% / 年里有 8 个百分点是资金成本：库存减少一次性释放的资金单独算成现金流入，
 * 每年的节省里只算其余 14 个百分点（仓储、保险、损坏、过时），不重复计算。
 */
export interface DayCost {
  outbound: number;
  vans: number;
  inbound: number;
  drayageRail: number;
  freight: number;
  dcLabor: number;
  carrying: number;
  waste: number;
  lostMargin: number;
  total: number;
  storeOpex: number;
  inventory: number;
}

export interface CurvePoint {
  scale: number;
  gen: Record<Gen, DayCost>;
}

export interface CapexItem {
  key: string;
  label: string;
  group: '配送中心' | '车队与运输' | '港口与铁路' | '平台' | '门店' | '实施';
  base: number;
  low: number;
  high: number;
  life: number;
  maint: number;
}

export const CAPEX: readonly CapexItem[] = [
  { key: 'automation', label: '配送中心自动化：货到人拣选、机器人拆零和码垛、自动收货（约 6,000 箱 / 天）', group: '配送中心', base: 6_000_000, low: 3_500_000, high: 9_000_000, life: 15, maint: 0.04 },
  { key: 'crossdock', label: '生鲜越库区、冷链门封和冷库扩容', group: '配送中心', base: 800_000, low: 500_000, high: 1_200_000, life: 20, maint: 0.015 },
  { key: 'charging', label: '电动卡车充电站和电网扩容（约 4 个快充位）', group: '车队与运输', base: 500_000, low: 350_000, high: 800_000, life: 12, maint: 0.02 },
  { key: 'rail', label: '物流园铁路专用线接入和装卸设备（按本店的量分摊）', group: '港口与铁路', base: 500_000, low: 300_000, high: 800_000, life: 25, maint: 0.01 },
  { key: 'platform', label: '全链路数字孪生：控制塔、供应商管理库存平台、港口 / 班列 / 机场货运系统对接、车辆遥测', group: '平台', base: 2_500_000, low: 1_600_000, high: 4_000_000, life: 8, maint: 0 },
  { key: 'receiving', label: '门店无人值守收货区（4 个收货口）', group: '门店', base: 250_000, low: 150_000, high: 400_000, life: 15, maint: 0.02 },
  { key: 'training', label: '培训和组织调整（一次性）', group: '实施', base: 300_000, low: 200_000, high: 500_000, life: 99, maint: 0 },
  { key: 'cutover', label: '自动化切换期间的效率损失和双轨运行（一次性）', group: '实施', base: 400_000, low: 200_000, high: 800_000, life: 99, maint: 0 },
];

/** 每年的订阅和服务费 */
export const SUBSCRIPTIONS = { base: 450_000, low: 300_000, high: 700_000 };

/** StoreX 报告里那家店（规模 1.0）的改造投资；综合店按规模的 0.75 次方折算（货格仓等固定部分不随规模线性增加） */
export const STORE_CAPEX_FLAGSHIP = 5_866_000;
export const storeProgramCapex = (factor = 1): number => STORES.reduce((a, s) => a + STORE_CAPEX_FLAGSHIP * Math.pow(s.size, 0.75), 0) * factor;
/** 门店改造每年的维护和订阅（StoreX 报告：规模 1.0 的店约 43 万美元 / 年，按规模折算） */
export const storeProgramOpex = (): number => STORES.reduce((a, s) => a + 430_000 * Math.pow(s.size, 0.75), 0);

export interface Assumptions {
  wage: number;
  capex: 'base' | 'low' | 'high';
  subscriptions: 'base' | 'low' | 'high';
  maint: number;
  discount: number;
  ramp: [number, number];
  /** 2030 年的需求倍数（线上订单翻倍 ≈ 1.24），之后每年 +2% */
  scale2030: number;
  /** 库存持有成本里不含资金成本的部分（占 22% 的比例） */
  carryingOther: number;
  energy: number;
  days: number;
}

export const BASE: Assumptions = { wage: 1, capex: 'base', subscriptions: 'base', maint: 1, discount: 0.07, ramp: [0.5, 0.85], scale2030: 1.24, carryingOther: 14 / 22, energy: 1, days: 360 };
export const START = 2026;
export const YEARS = 10;

export function scaleIn(year: number, a: Assumptions): number {
  if (year <= 2027) return 1;
  if (year <= 2030) return Math.pow(a.scale2030, (year - 2027) / 3);
  return a.scale2030 * Math.pow(1.02, year - 2030);
}

function interp(curve: readonly CurvePoint[], v: number, f: (p: CurvePoint) => number): number {
  const pts = [...curve].sort((a, b) => a.scale - b.scale);
  let i = pts.findIndex((p) => p.scale >= v);
  if (i < 0) i = pts.length - 1;
  if (i === 0) i = 1;
  const a = pts[i - 1] as CurvePoint;
  const b = pts[i] as CurvePoint;
  return f(a) + ((f(b) - f(a)) * (v - a.scale)) / (b.scale - a.scale);
}

export type Step = 'upstream' | 'system';

/** 每天省下的钱（按假设调整）：上游这一步 = StoreX − 全链路；全系统 = 上一代 − 全链路 */
export function dailySaving(curve: readonly CurvePoint[], scale: number, a: Assumptions, step: Step): { labor: number; transport: number; carrying: number; waste: number; lost: number; freight: number; store: number; total: number } {
  const from: Gen = step === 'upstream' ? 'g2' : 'g1';
  const d = (k: keyof DayCost) => interp(curve, scale, (p) => p.gen[from][k] - p.gen.g3[k]);
  const labor = d('dcLabor') * a.wage;
  const transport = (d('outbound') + d('vans') + d('inbound') + d('drayageRail')) * a.energy;
  const carrying = d('carrying') * a.carryingOther;
  const waste = d('waste');
  const lost = d('lostMargin');
  const freight = d('freight');
  const store = d('storeOpex') * a.wage;
  return { labor, transport, carrying, waste, lost, freight, store, total: labor + transport + carrying + waste + lost + freight + store };
}

export interface YearRow {
  year: number;
  scale: number;
  gross: number;
  opex: number;
  capex: number;
  workingCapital: number;
  residual: number;
  net: number;
  cumulative: number;
}

export interface EconResult {
  step: Step;
  capexTotal: number;
  rows: YearRow[];
  npv: number;
  irr: number;
  payback: number;
  workingCapital: number;
  steady: { gross: number; opex: number; net: number; parts: ReturnType<typeof dailySaving> };
}

/** exclude：不做的投资项目（例如不上配送中心自动化时去掉 automation 和 cutover） */
export function cashflow(curve: readonly CurvePoint[], a: Assumptions = BASE, step: Step = 'upstream', exclude: readonly string[] = []): EconResult {
  const price = (it: CapexItem) => (a.capex === 'low' ? it.low : a.capex === 'high' ? it.high : it.base);
  const items = CAPEX.filter((it) => !exclude.includes(it.key));
  const upstreamCapex = items.reduce((s, it) => s + price(it), 0);
  const storeCapex = step === 'system' ? storeProgramCapex(a.capex === 'low' ? 0.8 : a.capex === 'high' ? 1.35 : 1) : 0;
  const subs = a.subscriptions === 'low' ? SUBSCRIPTIONS.low : a.subscriptions === 'high' ? SUBSCRIPTIONS.high : SUBSCRIPTIONS.base;
  const maint = items.reduce((s, it) => s + price(it) * it.maint, 0) * a.maint;
  const storeOpex = step === 'system' ? storeProgramOpex() * a.maint : 0;
  // 库存释放：在 2027 年的需求量下比较库存资金
  const from: Gen = step === 'upstream' ? 'g2' : 'g1';
  const wc = interp(curve, 1, (p) => p.gen[from].inventory - p.gen.g3.inventory);
  const rows: YearRow[] = [];
  let cumulative = 0;
  for (let year = START; year <= START + YEARS; year++) {
    const t = year - START;
    const scale = t === 0 ? 0 : scaleIn(year, a);
    const ramp = t === 1 ? a.ramp[0] : t === 2 ? a.ramp[1] : 1;
    const gross = t === 0 ? 0 : dailySaving(curve, scale, a, step).total * a.days * ramp;
    const opex = t === 0 ? 0 : subs + maint + storeOpex;
    const capex = t === 0 ? upstreamCapex + storeCapex : 0;
    // 平台八年到期、换新一次（按原价的 70%）
    const replace = year === START + 8 ? items.filter((it) => it.life === 8).reduce((s, it) => s + price(it) * 0.7, 0) : 0;
    const workingCapital = t === 1 ? wc * (a.ramp[0] + 1) / 2 : t === 2 ? wc * (1 - (a.ramp[0] + 1) / 2) : 0;
    // 期末残值：没用完的年限按直线折算（门店改造部分按 40% 估）
    const residual = year === START + YEARS ? items.filter((it) => it.life < 99).reduce((s, it) => s + price(it) * Math.max(0, 1 - YEARS / it.life), 0) + storeCapex * 0.4 : 0;
    const net = gross - opex - capex - replace + workingCapital + residual;
    cumulative += net;
    rows.push({ year, scale, gross, opex, capex: capex + replace, workingCapital, residual, net, cumulative });
  }
  const flows = rows.map((r) => r.net);
  const steadyRow = rows.find((r) => r.year === 2030) as YearRow;
  return {
    step,
    capexTotal: upstreamCapex + storeCapex,
    rows,
    npv: rows.reduce((s, r) => s + r.net / Math.pow(1 + a.discount, r.year - START), 0),
    irr: irr(flows),
    payback: payback(rows.map((r) => r.cumulative)),
    workingCapital: wc,
    steady: { gross: steadyRow.gross, opex: steadyRow.opex, net: steadyRow.gross - steadyRow.opex, parts: dailySaving(curve, scaleIn(2030, a), a, step) },
  };
}

export interface Sensitivity {
  label: string;
  low: { label: string; npv: number };
  high: { label: string; npv: number };
}

export function sensitivity(curve: readonly CurvePoint[], a: Assumptions = BASE, step: Step = 'upstream'): Sensitivity[] {
  const npv = (patch: Partial<Assumptions>) => cashflow(curve, { ...a, ...patch }, step).npv;
  const rows: [string, [string, Partial<Assumptions>], [string, Partial<Assumptions>]][] = [
    ['配送中心综合时薪（基准 28 美元）', ['22 美元', { wage: 22 / 28 }], ['34 美元', { wage: 34 / 28 }]],
    ['投资额', ['低值', { capex: 'low' }], ['高值', { capex: 'high' }]],
    ['2030 年的需求（基准 +24%）', ['+10%', { scale2030: 1.1 }], ['+40%', { scale2030: 1.4 }]],
    ['折现率（基准 7%）', ['5%', { discount: 0.05 }], ['10%', { discount: 0.1 }]],
    ['爬坡（基准 50% / 85%）', ['30% / 70%', { ramp: [0.3, 0.7] }], ['70% / 95%', { ramp: [0.7, 0.95] }]],
    ['订阅费', ['低值', { subscriptions: 'low' }], ['高值', { subscriptions: 'high' }]],
    ['维护费', ['× 0.7', { maint: 0.7 }], ['× 1.5', { maint: 1.5 }]],
    ['燃油和电价', ['× 0.8', { energy: 0.8 }], ['× 1.3', { energy: 1.3 }]],
  ];
  return rows.map(([label, [ll, lp], [hl, hp]]) => ({ label, low: { label: ll, npv: npv(lp) }, high: { label: hl, npv: npv(hp) } })).sort((x, y) => Math.abs(y.high.npv - y.low.npv) - Math.abs(x.high.npv - x.low.npv));
}

export const SCENARIOS: { key: string; label: string; detail: string; patch: Partial<Assumptions> }[] = [
  { key: 'conservative', label: '保守', detail: '投资取高值、2030 年需求只 +10%、时薪 24 美元、维护费 × 1.5、订阅费高值、爬坡慢', patch: { capex: 'high', scale2030: 1.1, wage: 24 / 28, maint: 1.5, subscriptions: 'high', ramp: [0.3, 0.7] } },
  { key: 'base', label: '基准', detail: '本报告的基准假设', patch: {} },
  { key: 'optimistic', label: '乐观', detail: '投资取低值、2030 年需求 +40%、时薪 32 美元、爬坡快', patch: { capex: 'low', scale2030: 1.4, wage: 32 / 28, ramp: [0.7, 0.95] } },
];

/** 两个方案逐年净现金流的差（例如「上自动化」减「不上自动化」）：增量投资的净现值、内部收益率、回收期 */
export function increment(withIt: EconResult, without: EconResult, a: Assumptions = BASE): { npv: number; irr: number; payback: number; flows: number[] } {
  const flows = withIt.rows.map((r, i) => r.net - (without.rows[i] as YearRow).net);
  let cum = 0;
  const cumulative = flows.map((f) => (cum += f));
  return { npv: flows.reduce((s, f, i) => s + f / Math.pow(1 + a.discount, i), 0), irr: irr(flows), payback: payback(cumulative), flows };
}

export { crf };
