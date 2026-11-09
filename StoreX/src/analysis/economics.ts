/**
 * 商业分析：把仿真得到的每天的成本（人工、电费、生鲜损耗、缺货毛利）换成 10 年的现金流。
 *
 * 口径：
 * - 把一家正在用上一代流程的门店改造成 StoreX（改造期间照常营业），只算增量投资和增量收益；
 * - 2026 年改造（第 0 年），2027–2036 年运营 10 年；按 2026 年不变价格计算（实际值），折现率 7%；
 * - 设备价格是公开资料里的常见区间（基准 / 低 / 高），不是任何供应商的报价；
 * - 不算税、补贴和融资；线上订单增长带来的销售额两代一样（需求相同），不算成收益。
 */

export interface Money {
  labor: number;
  energy: number;
  freshLoss: number;
  lostMargin: number;
  total: number;
}

export interface CurvePoint {
  volume: number;
  gen1: Money;
  storex: Money;
  /** 同样的 StoreX，但不建货格仓（算货格仓本身的账） */
  noMfc: Money;
  gen1Hours: number;
  storexHours: number;
  noMfcHours: number;
}

export type CapexGroup = '线上履约' | '货架与补货' | '出口与收银' | '能源' | '平台与改造';

export interface CapexItem {
  key: string;
  label: string;
  group: CapexGroup;
  qty: number;
  /** 单价：基准 / 低 / 高（美元） */
  unit: number;
  low: number;
  high: number;
  /** 购买年份（2026 = 开业前改造） */
  year: number;
  /** 使用年限；到期在分析期内要重新买 */
  life: number;
  /** 每年的维护费（占购买价） */
  maint: number;
  /** 机器人类设备：后买的、换新的按每年降价计 */
  robot?: boolean;
  /** 属于货格仓系统（算货格仓本身的账） */
  mfc?: boolean;
}

const c = (key: string, label: string, group: CapexGroup, qty: number, unit: number, low: number, high: number, year: number, life: number, maint: number, flags: { robot?: boolean; mfc?: boolean } = {}): CapexItem => ({
  key,
  label,
  group,
  qty,
  unit,
  low,
  high,
  year,
  life,
  maint,
  ...flags,
});

/** 投资清单（单价按公开资料的常见区间取，美元，2026 年价格） */
export const CAPEX: readonly CapexItem[] = [
  c('mfcGrid', '立体货格仓：货格结构、约 9,000 个货箱、格内消防、安装', '线上履约', 1, 950_000, 700_000, 1_400_000, 2026, 20, 0.01, { mfc: true }),
  c('mfcBots', '货格机器人（开业 12 台）', '线上履约', 12, 30_000, 20_000, 45_000, 2026, 8, 0.06, { robot: true, mfc: true }),
  c('mfcBots28', '货格机器人（2028 年加 4 台）', '线上履约', 4, 30_000, 20_000, 45_000, 2028, 8, 0.06, { robot: true, mfc: true }),
  c('mfcBots30', '货格机器人（2030 年再加 4 台）', '线上履约', 4, 30_000, 20_000, 45_000, 2030, 8, 0.06, { robot: true, mfc: true }),
  c('mfcPorts', '拣货站台 3 个 + 拆箱站 1 个', '线上履约', 4, 55_000, 40_000, 80_000, 2026, 12, 0.04, { mfc: true }),
  c('mfcSoftware', '货格仓控制软件与系统集成（一次性）', '线上履约', 1, 200_000, 120_000, 350_000, 2026, 10, 0, { mfc: true }),
  c('conveyor', '生鲜投放口到合流台的输送线、合流台', '线上履约', 1, 120_000, 80_000, 180_000, 2026, 15, 0.03),
  c('lockersAmb', '自提柜常温格口（开业 60 个）', '线上履约', 60, 900, 650, 1_300, 2026, 12, 0.03),
  c('lockersChill', '自提柜冷藏格口（开业 48 个）', '线上履约', 48, 1_800, 1_300, 2_600, 2026, 12, 0.03),
  c('lockersFrz', '自提柜冷冻格口（开业 24 个）', '线上履约', 24, 2_400, 1_700, 3_400, 2026, 12, 0.03),
  c('lockers30', '自提柜扩容（2030 年加 12 / 8 / 4 个格口）', '线上履约', 1, 34_800, 25_000, 50_000, 2030, 12, 0.03),
  c('loader', '装柜机器人', '线上履约', 1, 140_000, 90_000, 220_000, 2026, 10, 0.06, { robot: true }),
  c('drive', '免下车取货车道改造：顶棚、取货窗口、引导屏', '线上履约', 1, 180_000, 120_000, 280_000, 2026, 20, 0.01),
  c('carts', '送框小车（开业 2 台）', '线上履约', 2, 25_000, 15_000, 40_000, 2026, 7, 0.08, { robot: true }),
  c('carts28', '送框小车（2028 年加 1 台）', '线上履约', 1, 25_000, 15_000, 40_000, 2028, 7, 0.08, { robot: true }),
  c('amr', '补货机器人', '货架与补货', 3, 35_000, 25_000, 55_000, 2026, 7, 0.08, { robot: true }),
  c('scanner', '盘点机器人', '货架与补货', 1, 55_000, 35_000, 80_000, 2026, 6, 0.1, { robot: true }),
  c('smartShelf', '智能货架传感器（热销 25% 的商品 + 生鲜）', '货架与补货', 1, 140_000, 90_000, 250_000, 2026, 8, 0.05),
  c('esl', '电子价签（约 10,000 个 + 基站）', '货架与补货', 1, 110_000, 80_000, 160_000, 2026, 8, 0.03),
  c('rfid', '后仓 RFID 与视觉收货门', '货架与补货', 1, 90_000, 60_000, 140_000, 2026, 10, 0.04),
  c('pallet', '自动托盘车', '货架与补货', 1, 60_000, 40_000, 90_000, 2026, 8, 0.06, { robot: true }),
  c('scrubbers', '洗地机器人', '货架与补货', 2, 30_000, 22_000, 45_000, 2026, 6, 0.08, { robot: true }),
  c('vision', '视觉免排队系统：摄像头、边缘计算、2 条出口闸机', '出口与收银', 1, 650_000, 400_000, 1_200_000, 2026, 8, 0.08),
  c('visionSco', '视觉辅助自助结账（相对普通自助机的增量）', '出口与收银', 6, 12_000, 8_000, 18_000, 2026, 8, 0.05),
  c('solar', '屋顶光伏 250 千瓦峰值', '能源', 250, 1_700, 1_400, 2_200, 2026, 25, 0.01),
  c('battery', '储能 500 千瓦时', '能源', 500, 420, 300, 600, 2026, 12, 0.02),
  c('refrigeration', '冷柜加门、二氧化碳制冷、热回收（相对常规更新的增量）', '能源', 1, 420_000, 280_000, 600_000, 2026, 15, 0.02),
  c('lighting', 'LED 照明与日光调光', '能源', 1, 60_000, 40_000, 90_000, 2026, 12, 0.01),
  c('building', '后仓改造：货格仓地坪、消防、动线', '平台与改造', 1, 300_000, 180_000, 450_000, 2026, 20, 0, { mfc: true }),
  c('platform', '数字孪生与 AI 平台实施：门店服务器、网络、系统集成', '平台与改造', 1, 180_000, 120_000, 300_000, 2026, 6, 0),
  c('training', '培训与上线（一次性）', '平台与改造', 1, 90_000, 60_000, 140_000, 2026, 99, 0),
  c('disruption', '改造期间的营业影响（一次性）', '平台与改造', 1, 150_000, 80_000, 300_000, 2026, 99, 0),
];

/** 每年的订阅和服务费（美元） */
export interface Subscription {
  label: string;
  base: number;
  low: number;
  high: number;
  mfc?: boolean;
}
export const SUBSCRIPTIONS: readonly Subscription[] = [
  { label: '数字孪生与 AI 平台订阅', base: 60_000, low: 40_000, high: 100_000 },
  { label: '视觉免排队与视觉自助结账软件', base: 90_000, low: 60_000, high: 150_000 },
  { label: '货格仓软件与远程支持', base: 45_000, low: 30_000, high: 70_000, mfc: true },
  { label: '电子价签、智能货架云服务', base: 15_000, low: 10_000, high: 25_000 },
  { label: '盘点机器人数据服务', base: 12_000, low: 8_000, high: 20_000 },
];

export interface Assumptions {
  /** 时薪（含社保福利的综合成本）相对仿真里 22 美元的倍数 */
  wage: number;
  /** 实际工资每年上涨 */
  wageGrowth: number;
  energyPrice: number;
  /** 生鲜损耗改善实现了仿真结果的多少 */
  freshBenefit: number;
  capex: 'base' | 'low' | 'high';
  /** 维护费倍数 */
  maint: number;
  subscriptions: 'base' | 'low' | 'high';
  discount: number;
  /** 前两年的爬坡（实现稳态收益的比例） */
  ramp: [number, number];
  /** 2027 年和 2030 年的线上订单量（中间按几何增长，之后每年 +3%） */
  orders2027: number;
  orders2030: number;
  /** 机器人每年降价 */
  robotPriceDecline: number;
  /** 每年营业天数 */
  days: number;
  /** 洗地机器人替代的夜间人工洗地（小时 / 晚，仿真外） */
  cleaningHours: number;
}

export const BASE: Assumptions = {
  wage: 1,
  wageGrowth: 0,
  energyPrice: 1,
  freshBenefit: 1,
  capex: 'base',
  maint: 1,
  subscriptions: 'base',
  discount: 0.07,
  ramp: [0.6, 0.85],
  orders2027: 266,
  orders2030: 532,
  robotPriceDecline: 0.04,
  days: 360,
  cleaningHours: 3,
};

export const START = 2026;
export const YEARS = 10;
const WAGE = 22;

export function ordersIn(year: number, a: Assumptions): number {
  const y0 = 2027;
  const v0 = a.orders2027;
  if (year <= y0) return v0;
  if (year <= 2030) return v0 * Math.pow(a.orders2030 / v0, (year - y0) / (2030 - y0));
  return a.orders2030 * Math.pow(1.03, year - 2030);
}

/** 在容量曲线上按订单量线性插值（超出范围时用两端的斜率外推） */
export function interp(curve: readonly CurvePoint[], v: number, f: (p: CurvePoint) => number): number {
  const pts = [...curve].sort((a, b) => a.volume - b.volume);
  let i = pts.findIndex((p) => p.volume >= v);
  if (i < 0) i = pts.length - 1;
  if (i === 0) i = 1;
  const a = pts[i - 1] as CurvePoint;
  const b = pts[i] as CurvePoint;
  const t = (v - a.volume) / (b.volume - a.volume);
  return f(a) + (f(b) - f(a)) * t;
}

/**
 * 算哪一笔账：full = StoreX 对上一代；mfc = 货格仓本身（StoreX 对「不建货格仓」）；
 * package = 不建货格仓的方案对上一代（给订单少的门店）
 */
export type Mode = 'full' | 'mfc' | 'package';

/** 每天省下的钱（对照 − 方案），按假设调整各项 */
export function dailySaving(curve: readonly CurvePoint[], v: number, a: Assumptions, year: number, mode: Mode = 'full'): Money {
  const wageF = a.wage * Math.pow(1 + a.wageGrowth, year - START);
  const from = (p: CurvePoint) => (mode === 'mfc' ? p.noMfc : p.gen1);
  const to = (p: CurvePoint) => (mode === 'package' ? p.noMfc : p.storex);
  const pick = (k: keyof Money) => interp(curve, v, (p) => from(p)[k] - to(p)[k]);
  const labor = pick('labor') * wageF;
  const energy = pick('energy') * a.energyPrice;
  const freshLoss = pick('freshLoss') * a.freshBenefit;
  const lostMargin = pick('lostMargin');
  return { labor, energy, freshLoss, lostMargin, total: labor + energy + freshLoss + lostMargin };
}

const price = (it: CapexItem, a: Assumptions) => (a.capex === 'low' ? it.low : a.capex === 'high' ? it.high : it.unit) * it.qty;

export interface YearRow {
  year: number;
  orders: number;
  saving: Money;
  /** 仿真外的节省（夜间人工洗地） */
  extra: number;
  gross: number;
  maintenance: number;
  subscriptions: number;
  insurance: number;
  capex: number;
  replacement: number;
  residual: number;
  net: number;
  cumulative: number;
  discounted: number;
}

export interface EconResult {
  assumptions: Assumptions;
  capexTotal: number;
  capexOpening: number;
  capexByGroup: Record<CapexGroup, number>;
  rows: YearRow[];
  npv: number;
  irr: number;
  payback: number;
  discountedPayback: number;
  /** 稳态（2030 年）每年的毛节省、运营成本 */
  steady: { gross: number; opex: number; net: number };
}

/** 10 年现金流（mode 见上） */
export function cashflow(curve: readonly CurvePoint[], a: Assumptions = BASE, mode: Mode = 'full'): EconResult {
  const keep = (mfc: boolean | undefined) => (mode === 'full' ? true : mode === 'mfc' ? !!mfc : !mfc);
  const items = CAPEX.filter((it) => keep(it.mfc));
  const subs = SUBSCRIPTIONS.filter((s) => keep(s.mfc));
  const subCost = subs.reduce((t, s) => t + (a.subscriptions === 'low' ? s.low : a.subscriptions === 'high' ? s.high : s.base), 0);
  const rows: YearRow[] = [];
  let cumulative = 0;
  let discounted = 0;
  const purchases: { it: CapexItem; year: number; cost: number }[] = [];
  const buy = (it: CapexItem, year: number) => {
    const decline = it.robot ? Math.pow(1 - a.robotPriceDecline, year - START) : 1;
    const cost = price(it, a) * decline;
    purchases.push({ it, year, cost });
    return cost;
  };
  const end = START + YEARS;
  for (let year = START; year <= end; year++) {
    const t = year - START;
    let capex = 0;
    let replacement = 0;
    for (const it of items) {
      if (it.year === year) capex += buy(it, year);
    }
    // 到期换新（分析期内）
    for (const p of [...purchases]) {
      if (p.it.life < 99 && p.year + p.it.life === year && year < end) replacement += buy(p.it, year);
    }
    // 在用的设备：已经买了、还没到年限（到年限的那一年由新买的接替）
    const inService = purchases.filter((p) => p.year < year && (p.it.life >= 99 || year <= p.year + p.it.life));
    const maintenance = t === 0 ? 0 : inService.reduce((s, p) => s + p.cost * p.it.maint, 0) * a.maint;
    const insurance = t === 0 ? 0 : inService.reduce((s, p) => s + (p.it.life < 99 ? p.cost : 0), 0) * 0.005;
    const orders = t === 0 ? 0 : ordersIn(year, a);
    const ramp = t === 1 ? a.ramp[0] : t === 2 ? a.ramp[1] : 1;
    const saving = t === 0 ? { labor: 0, energy: 0, freshLoss: 0, lostMargin: 0, total: 0 } : scale(dailySaving(curve, orders, a, year, mode), a.days * ramp);
    const extra = t === 0 || mode === 'mfc' ? 0 : a.cleaningHours * WAGE * a.wage * a.days;
    const gross = saving.total + extra;
    const subscriptions = t === 0 ? 0 : subCost;
    // 期末残值：还没用完的年限按直线折算
    let residual = 0;
    if (year === end) {
      for (const p of purchases) {
        if (p.it.life >= 99) continue;
        const used = end - p.year;
        if (used < p.it.life) residual += p.cost * (1 - used / p.it.life);
      }
    }
    const net = gross - maintenance - subscriptions - insurance - capex - replacement + residual;
    cumulative += net;
    discounted += net / Math.pow(1 + a.discount, t);
    rows.push({ year, orders, saving, extra, gross, maintenance, subscriptions, insurance, capex, replacement, residual, net, cumulative, discounted });
  }
  const flows = rows.map((r) => r.net);
  const capexByGroup = { 线上履约: 0, 货架与补货: 0, 出口与收银: 0, 能源: 0, 平台与改造: 0 } as Record<CapexGroup, number>;
  for (const it of items) capexByGroup[it.group] += price(it, a) * (it.robot ? Math.pow(1 - a.robotPriceDecline, it.year - START) : 1);
  const steadyRow = rows.find((r) => r.year === 2030) as YearRow;
  return {
    assumptions: a,
    capexTotal: Object.values(capexByGroup).reduce((s, x) => s + x, 0),
    capexOpening: items.filter((it) => it.year === START).reduce((s, it) => s + price(it, a), 0),
    capexByGroup,
    rows,
    npv: rows.reduce((s, r) => s + r.net / Math.pow(1 + a.discount, r.year - START), 0),
    irr: irr(flows),
    payback: payback(rows.map((r) => r.cumulative)),
    discountedPayback: payback(rows.map((r) => r.discounted)),
    steady: { gross: steadyRow.gross, opex: steadyRow.maintenance + steadyRow.subscriptions + steadyRow.insurance, net: steadyRow.gross - steadyRow.maintenance - steadyRow.subscriptions - steadyRow.insurance },
  };
}

function scale(m: Money, k: number): Money {
  return { labor: m.labor * k, energy: m.energy * k, freshLoss: m.freshLoss * k, lostMargin: m.lostMargin * k, total: m.total * k };
}

/** 内部收益率（二分法） */
export function irr(flows: readonly number[]): number {
  const npv = (r: number) => flows.reduce((s, f, t) => s + f / Math.pow(1 + r, t), 0);
  let lo = -0.9;
  let hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** 回收期（年，线性插值）：累计现金流第一次回正 */
export function payback(cum: readonly number[]): number {
  for (let t = 1; t < cum.length; t++) {
    const a = cum[t - 1] as number;
    const b = cum[t] as number;
    if (a < 0 && b >= 0) return t - 1 + -a / (b - a);
  }
  return (cum[0] as number) >= 0 ? 0 : NaN;
}

/** 资本回收系数：把一次投资摊成每年等额 */
export function crf(r: number, n: number): number {
  return (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

/**
 * 货格仓的盈亏平衡订单量：每年摊销 + 运营成本 = 每年比「不建货格仓」省下的钱。
 * 按稳态（满负荷收益、不算爬坡）算，单位是单 / 天。
 */
export function mfcBreakEven(curve: readonly CurvePoint[], a: Assumptions = BASE): { volume: number; annualCost: number } {
  const items = CAPEX.filter((it) => it.mfc);
  // 按 2030 年的设备（20 台机器人）摊销
  const annualCost =
    items.reduce((s, it) => s + price(it, a) * (crf(a.discount, Math.min(it.life, 20)) + it.maint * a.maint + 0.005), 0) +
    SUBSCRIPTIONS.filter((s) => s.mfc).reduce((t, s) => t + (a.subscriptions === 'low' ? s.low : a.subscriptions === 'high' ? s.high : s.base), 0);
  const f = (v: number) => dailySaving(curve, v, a, 2030, 'mfc').total * a.days - annualCost;
  let lo = 0;
  let hi = 1200;
  if (f(hi) < 0) return { volume: NaN, annualCost };
  if (f(lo) > 0) return { volume: 0, annualCost };
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return { volume: (lo + hi) / 2, annualCost };
}

/** 单变量敏感性（龙卷风图）：每个假设取低 / 高值，其余不变 */
export interface Sensitivity {
  label: string;
  low: { label: string; npv: number };
  high: { label: string; npv: number };
}

export function sensitivity(curve: readonly CurvePoint[], a: Assumptions = BASE): Sensitivity[] {
  const npv = (patch: Partial<Assumptions>) => cashflow(curve, { ...a, ...patch }).npv;
  const rows: [string, [string, Partial<Assumptions>], [string, Partial<Assumptions>]][] = [
    ['综合时薪（基准 22 美元）', ['18 美元', { wage: 18 / 22 }], ['28 美元', { wage: 28 / 22 }]],
    ['2030 年线上订单（基准 532 单 / 天）', ['400 单', { orders2030: 400 }], ['660 单', { orders2030: 660 }]],
    ['投资额', ['低值', { capex: 'low' }], ['高值', { capex: 'high' }]],
    ['维护费', ['× 0.7', { maint: 0.7 }], ['× 1.5', { maint: 1.5 }]],
    ['订阅费', ['低值', { subscriptions: 'low' }], ['高值', { subscriptions: 'high' }]],
    ['电价', ['× 0.7', { energyPrice: 0.7 }], ['× 1.5', { energyPrice: 1.5 }]],
    ['生鲜损耗改善的实现程度', ['50%', { freshBenefit: 0.5 }], ['125%', { freshBenefit: 1.25 }]],
    ['折现率（基准 7%）', ['5%', { discount: 0.05 }], ['10%', { discount: 0.1 }]],
    ['爬坡（基准 60% / 85%）', ['40% / 70%', { ramp: [0.4, 0.7] }], ['80% / 95%', { ramp: [0.8, 0.95] }]],
    ['实际工资年增长（基准 0）', ['0', { wageGrowth: 0 }], ['+2%', { wageGrowth: 0.02 }]],
  ];
  return rows
    .map(([label, [ll, lp], [hl, hp]]) => ({ label, low: { label: ll, npv: npv(lp) }, high: { label: hl, npv: npv(hp) } }))
    .sort((x, y) => Math.abs(y.high.npv - y.low.npv) - Math.abs(x.high.npv - x.low.npv));
}

export const SCENARIOS: { key: string; label: string; detail: string; patch: Partial<Assumptions> }[] = [
  {
    key: 'conservative',
    label: '保守',
    detail: '投资取高值、2030 年只有 400 单、时薪 19 美元、维护费 × 1.5、订阅费高值、爬坡慢、生鲜改善只实现一半',
    patch: { capex: 'high', orders2030: 400, wage: 19 / 22, maint: 1.5, subscriptions: 'high', ramp: [0.4, 0.7], freshBenefit: 0.5 },
  },
  { key: 'base', label: '基准', detail: '本报告的基准假设', patch: {} },
  {
    key: 'optimistic',
    label: '乐观',
    detail: '投资取低值、2030 年 660 单、时薪 25 美元、实际工资每年 +2%、爬坡快',
    patch: { capex: 'low', orders2030: 660, wage: 25 / 22, wageGrowth: 0.02, ramp: [0.8, 0.95] },
  },
];
