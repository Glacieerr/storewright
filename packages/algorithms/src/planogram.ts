import { caseId, createRng, gtin14, type Item, type TempZone } from '@storewright/domain';
import { backroomLayout, storeAreas, type StoreModel } from '@storewright/store-config';
import { classifyAbc, suggestBins, type AbcClass, type BinRule, type InventoryStatus } from './replenish';

/**
 * 门店静态库存数据：后仓库位、陈列表、期初库存。实时系统（建店时）和模拟器（货架存量模块）共用。
 * 全部是确定性的：同一门店配置、同一商品目录、同一种子得到同样的结果。
 */

/** 后仓库位 */
export interface BinInfo {
  code: string;
  tempZone: TempZone;
  status: InventoryStatus;
  /** 存储分区：大类分区，CHEM 为化学品隔离区 */
  area: string;
  capacityCases: number;
  /** 所在区域（决策记录 0013）：货架区、冷藏库、冷冻库、待检区…… */
  areaId?: string;
}

export type DisplayMethod = 'PUSHER' | 'STACK' | 'HANG' | 'BULK';

/** 陈列表：货位上放什么商品、能放多少、用什么方式感知（决策 R-02） */
export interface PlanogramEntry {
  locationId: string;
  itemId: string;
  gtin: string;
  name: string;
  /** 所在通道（补货任务按通道合并成批） */
  runId: string;
  tempZone: TempZone;
  capacity: number;
  display: DisplayMethod;
  sensor?: 'tof' | 'weight';
  abc: AbcClass;
  unitPrice: number;
  /** 后仓存储分区 */
  area: string;
  chemical: boolean;
  /** 每箱件数 */
  packQty: number;
  /** 预期销售速度（件 / 小时），作为估算的初值 */
  baseVelocity: number;
}

export interface OpeningCase {
  caseId: string;
  itemId: string;
  gtin: string;
  name: string;
  packQty: number;
  units: number;
  binCode: string;
}

/** 商品类别 → 后仓存储分区（大类分区，决策 I-03） */
const AREA_OF: Record<string, string> = {
  'dry-goods': 'DRY',
  canned: 'DRY',
  breakfast: 'DRY',
  snacks: 'DRY',
  bakery: 'DRY',
  'produce-amb': 'DRY',
  beverages: 'BEV',
  water: 'BEV',
  alcohol: 'BEV',
  household: 'HOME',
  paper: 'HOME',
  'health-beauty': 'HOME',
  baby: 'HOME',
  pet: 'HOME',
  cleaning: 'CHEM',
  // 家居建材（决策记录 0011）
  fasteners: 'HW',
  plumbing: 'HW',
  electrical: 'HW',
  lighting: 'HW',
  storage: 'HW',
  'kitchen-bath': 'HW',
  'garden-supplies': 'HW',
  hvac: 'HW',
  'hand-tools': 'TOOLS',
  'power-tools': 'TOOLS',
  lumber: 'BULK',
  building: 'BULK',
  flooring: 'BULK',
};

export function storageArea(item: Item): string {
  if (item.tempZone === 'CHILLED') return 'COLD';
  if (item.tempZone === 'FROZEN') return 'FROZEN';
  if (item.handling.includes('CHEMICAL')) return 'CHEM';
  return AREA_OF[item.categoryId] ?? 'GM';
}

/** 常温货架区按分区切成连续的段；冷库、冷冻库、待检 / 退供应商 / 报废区单独编码 */
export function buildBins(model: StoreModel): BinInfo[] {
  const layout = backroomLayout(model.config);
  const locs = [...layout.locations].sort((a, b) => a.row - b.row || a.bay - b.bay || a.level - b.level || a.side - b.side);
  const hw = model.config.industry === 'HARDWARE';
  // 分区比例按行业：建材店没有食品和饮料，板材建材占大量托盘位，也没有冷库
  const shares: Array<[string, number]> = hw
    ? [
        ['HW', 0.3],
        ['TOOLS', 0.14],
        ['BULK', 0.3],
        ['GM', 0.14],
        ['CHEM', 0.12],
      ]
    : [
        ['DRY', 0.34],
        ['BEV', 0.24],
        ['HOME', 0.2],
        ['GM', 0.14],
        ['CHEM', 0.08],
      ];
  const bins: BinInfo[] = [];
  let i = 0;
  shares.forEach(([area, share], k) => {
    const n = k === shares.length - 1 ? locs.length - i : Math.max(1, Math.round(locs.length * share));
    for (const l of locs.slice(i, i + n)) bins.push({ code: l.id, tempZone: 'AMBIENT', status: 'SELLABLE', area, capacityCases: 60, areaId: l.areaId });
    i += n;
  });
  // 冷藏库、冷冻库：每个区域按容量切成 30 箱一个的库位（默认冷藏 12 个、冷冻 10 个）
  const { areas } = storeAreas(model.config);
  const cold: Array<['COOLER' | 'FREEZER', string, 'CHILLED' | 'FROZEN', string]> = [
    ['COOLER', 'CLR', 'CHILLED', 'COLD'],
    ['FREEZER', 'FRZ', 'FROZEN', 'FROZEN'],
  ];
  for (const [kind, prefix, tempZone, area] of cold) {
    let k = 0;
    for (const a of areas.filter((x) => x.kind === kind)) {
      const n = Math.max(1, Math.round(a.capacity / 30));
      for (let j = 0; j < n; j++) bins.push({ code: `${prefix}-${String(++k).padStart(2, '0')}`, tempZone, status: 'SELLABLE', area, capacityCases: 30, areaId: a.id });
    }
  }
  // 大件区（建材店的板材、建材地面堆放）
  let bulk = 0;
  for (const a of areas.filter((x) => x.kind === 'BULK')) {
    const n = Math.max(1, Math.round(a.capacity / 10));
    for (let j = 0; j < n; j++) bins.push({ code: `BLK-${String(++bulk).padStart(2, '0')}`, tempZone: 'AMBIENT', status: 'SELLABLE', area: 'BULK', capacityCases: 40, areaId: a.id });
  }
  // 待检、退供应商、报废：每个温区一个库位，放在对应的区域里（报废放在纸箱回收 / 垃圾区）
  const hasCold = areas.some((x) => x.kind === 'COOLER' || x.kind === 'FREEZER');
  const zones = hw && !hasCold
    ? ([['AMB', 'AMBIENT']] as const)
    : ([
        ['AMB', 'AMBIENT'],
        ['CHL', 'CHILLED'],
        ['FRZ', 'FROZEN'],
      ] as const);
  const areaOf = (kind: string) => areas.find((x) => x.kind === kind)?.id;
  const holds: Array<['QA' | 'RTV' | 'SCRAP', string | undefined]> = [
    ['QA', areaOf('QA')],
    ['RTV', areaOf('RTV')],
    ['SCRAP', areaOf('BALER')],
  ];
  for (const [code, zone] of zones) {
    for (const [status, areaId] of holds) {
      const b: BinInfo = { code: `${status}-${code}`, tempZone: zone, status, area: status, capacityCases: 80 };
      if (areaId) b.areaId = areaId;
      bins.push(b);
    }
  }
  return bins;
}

function display(item: Item): DisplayMethod {
  if (item.categoryId === 'water' || item.categoryId.startsWith('produce')) return 'BULK';
  if (item.categoryId === 'lumber' || item.categoryId === 'building' || item.categoryId === 'flooring') return 'BULK';
  // 五金和手动工具挂在洞洞板上
  if (item.categoryId === 'fasteners' || item.categoryId === 'hand-tools') return 'HANG';
  if (item.categoryId === 'beverages' || item.categoryId === 'dairy' || item.categoryId === 'canned') return 'PUSHER';
  if (item.categoryId === 'health-beauty' || item.categoryId === 'apparel') return 'HANG';
  return 'STACK';
}

function packQty(item: Item): number {
  const vol = item.dims.l * item.dims.w * item.dims.h;
  if (vol < 500) return 24;
  if (vol < 2000) return 12;
  if (vol < 6000) return 6;
  return 4;
}

export interface PlanogramOptions {
  /** 全店每天卖出的件数（决定各商品的预期销售速度）；默认按商品数 × 3 */
  dailyUnits?: number;
  /** 配传感器的货位占比（决策 R-01：只给高周转、高价值的少数货位） */
  sensorShare?: number;
}

export function buildPlanogram(model: StoreModel, items: ReadonlyMap<string, Item>, opts: PlanogramOptions = {}): PlanogramEntry[] {
  const hours = Math.max(1, (model.config.hours.closeMin - model.config.hours.openMin) / 60);
  const list = [...items.values()].filter((it) => it.tempZone !== 'HOT' && it.locationIds[0] && model.locations.has(it.locationIds[0]));
  const totalPop = list.reduce((n, it) => n + it.popularity, 0) || 1;
  // 每个商品平均每天约卖 3 件（合成目录只是真实门店商品的一部分）
  const daily = opts.dailyUnits ?? list.length * 3;
  const velocity = (it: Item) => (daily * it.popularity) / totalPop / hours;
  const abc = classifyAbc(list.map((it) => ({ id: it.id, value: velocity(it) * it.unitPrice })));
  // 传感器：推进器陈列（测距）和散装重货（称重）里价值最高的一小部分
  const sensorWanted = Math.round(list.length * (opts.sensorShare ?? 0.02));
  const ranked = [...list].filter((it) => display(it) === 'PUSHER' || display(it) === 'BULK').sort((a, b) => velocity(b) * b.unitPrice - velocity(a) * a.unitPrice || a.id.localeCompare(b.id));
  const sensors = new Map<string, 'tof' | 'weight'>();
  for (const it of ranked.slice(0, sensorWanted)) sensors.set(it.id, display(it) === 'BULK' ? 'weight' : 'tof');
  return list.map((it) => {
    const loc = model.location(it.locationIds[0] as string);
    const depthUnits = Math.max(1, Math.min(10, Math.floor(45 / Math.max(5, it.dims.l))));
    const facings = Math.max(2, Math.min(5, Math.round(2 + 3 * Math.sqrt(it.popularity / (totalPop / list.length) / 4))));
    const entry: PlanogramEntry = {
      locationId: loc.id,
      itemId: it.id,
      gtin: gtin14(it.gtin),
      name: it.name,
      runId: loc.runId,
      tempZone: it.tempZone,
      // 满架大约能卖 1.5 天（夜班补满，白天只给快销商品补货）；最少 4 件，最多 200 件
      capacity: Math.min(200, Math.max(4, Math.min(60, depthUnits * facings), Math.ceil(velocity(it) * hours * 1.5))),
      display: display(it),
      abc: abc.get(it.id) ?? ('C' as AbcClass),
      unitPrice: it.unitPrice,
      area: storageArea(it),
      chemical: it.handling.includes('CHEMICAL'),
      packQty: packQty(it),
      baseVelocity: Math.round(velocity(it) * 1000) / 1000,
    };
    const sensor = sensors.get(it.id);
    if (sensor) entry.sensor = sensor;
    return entry;
  });
}

/**
 * 期初库存：后仓只放一部分商品的备货（按「后仓有货概率」的一半抽取），每个商品 1 箱（A 类 2 箱），按上架规则放进库位。
 */
export function initialInventory(planogram: readonly PlanogramEntry[], bins: readonly BinInfo[], items: ReadonlyMap<string, Item>, seed: number, at: number): { cases: OpeningCase[] } {
  const rng = createRng(seed);
  const used = new Map<string, number>();
  const rules: BinRule[] = bins.filter((b) => b.status === 'SELLABLE');
  const cases: OpeningCase[] = [];
  for (const p of planogram) {
    const it = items.get(p.itemId);
    if (!it || rng.next() >= it.backroomAvailability * 0.5) continue;
    const n = p.abc === 'A' ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const bin = suggestBins(rules, (c) => used.get(c) ?? 0, { tempZone: p.tempZone, chemical: p.chemical, area: p.area }, 1)[0];
      if (!bin) break;
      used.set(bin, (used.get(bin) ?? 0) + 1);
      cases.push({ caseId: caseId(at, cases.length + 1), itemId: p.itemId, gtin: p.gtin, name: p.name, packQty: p.packQty, units: p.packQty, binCode: bin });
    }
  }
  return { cases };
}
