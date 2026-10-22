import { shortCode, type Item, type Order } from '@storewright/domain';
import { codeHashInput, type AssociateInfo, type OrderInfo, type StoreStatic } from '@storewright/ops';
import { buildBins, buildPlanogram, initialInventory, orderInfoFrom, type OpsContext } from '@storewright/ops/server';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { createTemplate, StoreModel, type TemplateName } from '@storewright/store-config';
import { DEFAULT_DEMAND, DELI_MENU, generateCatalog, generateOrders } from '@storewright/synth';
import { randomInt, toHex, type HubPlatform } from './platform';

/**
 * 演示门店：中型超市模板（或家居建材模板）+ 合成商品目录 + 虚构员工名单。姓名和商品都是合成数据。
 */

/** 去掉易混淆字符的字母表（与订单短号相同） */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(p: HubPlatform, length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(p, CODE_ALPHABET.length)];
  return s;
}

export function makeHasher(p: HubPlatform, salt: string): (input: string) => string {
  return (input) => p.sha256Hex(`${salt}:${input}`);
}

export function newSalt(p: HubPlatform): string {
  return toHex(p.randomBytes(16));
}

const ROSTER: AssociateInfo[] = [
  { id: 'A01', name: 'Avery', role: 'PICK', exceptionAuthorized: false },
  { id: 'A02', name: 'Jordan', role: 'PICK', exceptionAuthorized: false },
  { id: 'A03', name: 'Sam', role: 'PICK', exceptionAuthorized: false },
  { id: 'A04', name: 'Riley', role: 'STAGE', exceptionAuthorized: false },
  { id: 'A05', name: 'Morgan', role: 'HANDOFF', exceptionAuthorized: false },
  { id: 'A06', name: 'Casey', role: 'HANDOFF', exceptionAuthorized: false },
  { id: 'A07', name: 'Quinn', role: 'HANDOFF', exceptionAuthorized: false },
  { id: 'A08', name: 'Taylor', role: 'LEAD', exceptionAuthorized: true },
  { id: 'A09', name: 'Drew', role: 'BACKROOM', exceptionAuthorized: true },
  { id: 'A10', name: 'Robin', role: 'RESTOCK', exceptionAuthorized: false },
  { id: 'A11', name: 'Jamie', role: 'DELI', exceptionAuthorized: false },
];

/** 建材店没有熟食区：第 11 位员工在后仓（板材和建材的装车也归后仓） */
const HARDWARE_ROSTER: AssociateInfo[] = ROSTER.map((a) => (a.role === 'DELI' ? { ...a, role: 'BACKROOM' as const } : a));

export interface DemoStore {
  id: string;
  ctx: OpsContext;
  statics: StoreStatic;
  catalog: ReadonlyMap<string, Item>;
  /** 生成一张演示订单（不含大件），时段从 slotStart 开始 */
  makeOrder(opts: { index: number; type: 'PICKUP' | 'DELIVERY'; slotStart: number; maxLines?: number; oversized?: boolean }): { info: OrderInfo; code: string; codeHash: string };
  hashCode(key: string, code: string): string;
  /** 期初库存（建店时载入一次） */
  openingInventory(at: number): ReturnType<typeof initialInventory>;
}

export function createDemoStore(opts: { id: string; template?: TemplateName; seed?: number; salt: string; platform: HubPlatform }): DemoStore {
  // 演示门店打开全部扩展模块（模板默认值不变，Phase 1 的仿真不受影响）；建材店没有熟食现做
  const template = opts.template ?? 'medium';
  const config = createTemplate(template);
  const hw = config.industry === 'HARDWARE';
  config.modules = { ...config.modules, mto: !hw, parcelHub: true, returns: true, gm: true };
  const model = new StoreModel(config);
  const catalog = generateCatalog(model, { seed: opts.seed ?? 7 });
  const hash = makeHasher(opts.platform, opts.salt);
  const rules = model.config.rules;
  const statics: StoreStatic = {
    storeId: opts.id,
    name: model.config.name,
    rules: {
      approachingMin: rules.handoff.approachingMin,
      longWaitMin: rules.handoff.longWaitMin,
      codeAttempts: rules.handoff.codeAttempts,
      occupancyAlert: rules.staging.occupancyAlert,
      slotLengthMin: rules.slotLengthMin,
      lockLeadMin: rules.lockLeadMin,
    },
    slots: model.stagingSlots.map((s) => ({ code: s.code, tempZone: s.tempZone, capacity: s.capacityTotes, area: s.area, purpose: s.purpose })),
    roster: hw ? HARDWARE_ROSTER : ROSTER,
    bins: buildBins(model),
    planogram: buildPlanogram(model, catalog.byId),
    replenish: DEFAULT_REPLENISH_RULES,
    modules: { mto: model.config.modules.mto, returns: model.config.modules.returns, oversized: model.config.modules.gm, parcel: model.config.modules.parcelHub },
    ...(hw ? {} : { mtoMenu: DELI_MENU.map((d) => ({ ...d })), hotSlots: ['H-01', 'H-02', 'H-03', 'H-04'] }),
    parcelSlots: [
      ...['P01', 'P02', 'P03', 'P04'].map((code) => ({ code, capacity: 6, size: 'S' as const })),
      ...['P05', 'P06', 'P07', 'P08', 'P09'].map((code) => ({ code, capacity: 4, size: 'M' as const })),
      ...['P10', 'P11', 'P12'].map((code) => ({ code, capacity: 2, size: 'L' as const })),
    ],
    oversizedAreas: hw ? ['BULK-1', 'BULK-2', 'BULK-3', 'YARD-1', 'YARD-2'] : ['BULK-1', 'BULK-2', 'BULK-3'],
  };
  const bigItems = catalog.items.filter((i) => i.handling.includes('OVERSIZED') || i.weightKg > 14);
  const pool: Order[] = generateOrders(model, catalog, DEFAULT_DEMAND[template], { seed: (opts.seed ?? 7) + 1 }).filter(
    (o) => o.fulfillmentType === 'GROCERY' && o.lines.every((l) => !catalog.byId.get(l.itemId)?.handling.some((h) => h === 'OVERSIZED' || h === 'TEAM_LIFT')),
  );
  const byType = { PICKUP: pool.filter((o) => o.type === 'PICKUP'), DELIVERY: pool.filter((o) => o.type === 'DELIVERY' && o.destinationKm) };
  return {
    id: opts.id,
    ctx: { model, items: catalog.byId, hash, statics },
    openingInventory: (at) => initialInventory(statics.planogram, statics.bins, catalog.byId, (opts.seed ?? 7) + 2, at),
    statics,
    catalog: catalog.byId,
    makeOrder({ index, type, slotStart, maxLines, oversized }) {
      const list = byType[type].length ? byType[type] : pool;
      const src = list[index % list.length] as Order;
      const id = `D${String(index + 1).padStart(4, '0')}`;
      const base = maxLines ? src.lines.slice(0, maxLines) : src.lines;
      // 演示「大件」：加一行大件商品（2 件）
      const big = oversized && bigItems.length ? (bigItems[index % bigItems.length] as Item) : undefined;
      const lines = big ? [...base, { lineId: 'x', itemId: big.id, qty: 2, allowSubstitution: false }] : base;
      const order: Order = { ...src, id, shortCode: shortCode(`${opts.salt}:${opts.id}:${id}`), type, lines: lines.map((l, i) => ({ ...l, lineId: `${id}-L${i + 1}` })) };
      const info = orderInfoFrom(order, catalog.byId, slotStart, rules.slotLengthMin);
      const code = randomCode(opts.platform);
      return { info, code, codeHash: hash(codeHashInput(id, code)) };
    },
    hashCode: (key, code) => hash(codeHashInput(key, code)),
  };
}
