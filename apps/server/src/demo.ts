import { shortCode, type Item, type Order } from '@storewright/domain';
import { codeHashInput, type AssociateInfo, type OrderInfo, type StoreStatic } from '@storewright/ops';
import { buildBins, buildPlanogram, initialInventory, orderInfoFrom, type OpsContext } from '@storewright/ops/server';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { createTemplate, storeAreas, StoreModel, type StoreConfig, type TemplateName } from '@storewright/store-config';
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

/** 工作日上午 7–15 点（兼职员工的可上班时间示例，决策记录 0022） */
const WEEKDAY_MORNINGS = [0, 1, 2, 3, 4].map((day) => ({ day, from: 7 * 60, to: 15 * 60 }));
/** 工作日傍晚 15–22 点、周末全天 */
const EVENINGS_AND_WEEKENDS = [0, 1, 2, 3, 4, 5, 6].map((day) => (day >= 5 ? { day, from: 8 * 60, to: 21 * 60 } : { day, from: 15 * 60, to: 22 * 60 }));

/**
 * 入职日期只用来分熟练度组（新人 / 中等 / 熟手，决策记录 0021），不对个人建模；
 * 技能、可上班时间、雇佣类型给排班和补位用（决策记录 0022）
 */
const ROSTER: AssociateInfo[] = [
  { id: 'A01', name: 'Avery', role: 'PICK', exceptionAuthorized: false, hiredAt: '2024-03-11', skills: ['STAGE'] },
  { id: 'A02', name: 'Jordan', role: 'PICK', exceptionAuthorized: false, hiredAt: '2026-09-14' },
  { id: 'A03', name: 'Sam', role: 'PICK', exceptionAuthorized: false, hiredAt: '2025-11-03', employment: 'PART_TIME', skills: ['HANDOFF'], availability: WEEKDAY_MORNINGS },
  { id: 'A04', name: 'Riley', role: 'STAGE', exceptionAuthorized: false, hiredAt: '2023-06-19', skills: ['PICK', 'HANDOFF'] },
  { id: 'A05', name: 'Morgan', role: 'HANDOFF', exceptionAuthorized: false, hiredAt: '2025-04-07', skills: ['STAGE'] },
  { id: 'A06', name: 'Casey', role: 'HANDOFF', exceptionAuthorized: false, hiredAt: '2026-08-24', employment: 'PART_TIME' },
  { id: 'A07', name: 'Quinn', role: 'HANDOFF', exceptionAuthorized: false, hiredAt: '2022-10-03', skills: ['PICK', 'AGE_CHECK'] },
  { id: 'A08', name: 'Taylor', role: 'LEAD', exceptionAuthorized: true, hiredAt: '2021-05-17', skills: ['PICK', 'HANDOFF', 'AGE_CHECK', 'FORKLIFT'] },
  { id: 'A09', name: 'Drew', role: 'BACKROOM', exceptionAuthorized: true, hiredAt: '2023-02-06', skills: ['RESTOCK', 'FORKLIFT'] },
  { id: 'A10', name: 'Robin', role: 'RESTOCK', exceptionAuthorized: false, hiredAt: '2025-07-21', skills: ['BACKROOM', 'PICK'] },
  { id: 'A11', name: 'Jamie', role: 'DELI', exceptionAuthorized: false, hiredAt: '2024-09-09', skills: ['HANDOFF'] },
  // 学生兼职工（决策记录 0020）：放学后来，每天 4 小时
  { id: 'A12', name: 'Skyler', role: 'PICK', exceptionAuthorized: false, hiredAt: '2026-09-28', employment: 'STUDENT', shift: { from: 16 * 60, to: 20 * 60 } },
  { id: 'A13', name: 'Rowan', role: 'HANDOFF', exceptionAuthorized: false, hiredAt: '2026-06-15', employment: 'STUDENT', shift: { from: 17 * 60, to: 21 * 60 } },
  // 中型店的完整班组（决策记录 0022）：每天约 260 单线上订单，高峰要 10 人以上拣货，排班和补位要有足够的人可排
  { id: 'A14', name: 'Harper', role: 'PICK', exceptionAuthorized: false, hiredAt: '2023-09-04', skills: ['STAGE'] },
  { id: 'A15', name: 'Logan', role: 'PICK', exceptionAuthorized: false, hiredAt: '2024-11-18' },
  { id: 'A16', name: 'Emery', role: 'PICK', exceptionAuthorized: false, hiredAt: '2025-02-24', skills: ['HANDOFF'] },
  { id: 'A17', name: 'Finley', role: 'PICK', exceptionAuthorized: false, hiredAt: '2022-04-11', skills: ['STAGE', 'AGE_CHECK'] },
  { id: 'A18', name: 'Sage', role: 'PICK', exceptionAuthorized: false, hiredAt: '2026-07-06' },
  { id: 'A19', name: 'Reese', role: 'PICK', exceptionAuthorized: false, hiredAt: '2024-06-03', skills: ['RESTOCK'] },
  { id: 'A20', name: 'Dakota', role: 'PICK', exceptionAuthorized: false, hiredAt: '2025-08-25' },
  { id: 'A21', name: 'Kendall', role: 'PICK', exceptionAuthorized: false, hiredAt: '2025-01-13', employment: 'PART_TIME', availability: WEEKDAY_MORNINGS },
  { id: 'A22', name: 'Parker', role: 'PICK', exceptionAuthorized: false, hiredAt: '2024-10-07', employment: 'PART_TIME', availability: EVENINGS_AND_WEEKENDS },
  { id: 'A23', name: 'Ellis', role: 'PICK', exceptionAuthorized: false, hiredAt: '2026-09-21', employment: 'STUDENT' },
  { id: 'A24', name: 'Remy', role: 'PICK', exceptionAuthorized: false, hiredAt: '2026-05-11', employment: 'STUDENT' },
  { id: 'A25', name: 'Hayden', role: 'STAGE', exceptionAuthorized: false, hiredAt: '2023-12-04', skills: ['PICK'] },
  { id: 'A26', name: 'Marlowe', role: 'HANDOFF', exceptionAuthorized: false, hiredAt: '2024-02-19', skills: ['STAGE', 'AGE_CHECK'] },
  { id: 'A27', name: 'Jesse', role: 'LEAD', exceptionAuthorized: true, hiredAt: '2022-08-29', skills: ['PICK', 'HANDOFF', 'AGE_CHECK'] },
  { id: 'A28', name: 'Shiloh', role: 'BACKROOM', exceptionAuthorized: true, hiredAt: '2024-03-25', skills: ['RESTOCK', 'FORKLIFT'] },
  { id: 'A29', name: 'Arden', role: 'RESTOCK', exceptionAuthorized: false, hiredAt: '2025-10-06', employment: 'PART_TIME', skills: ['BACKROOM'] },
  { id: 'A30', name: 'Lane', role: 'DELI', exceptionAuthorized: false, hiredAt: '2025-05-19', employment: 'PART_TIME', skills: ['HANDOFF'] },
];

/** 建材店没有熟食区：第 11 位员工在后仓（板材和建材的装车也归后仓） */
const HARDWARE_ROSTER: AssociateInfo[] = ROSTER.map((a) => (a.role === 'DELI' ? { ...a, role: 'BACKROOM' as const } : a));

const FIRST = ['Alex', 'Blake', 'Cameron', 'Dakota', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jules', 'Kai', 'Logan', 'Marlowe', 'Noel', 'Oakley', 'Parker', 'Reese', 'Sage', 'Tatum', 'Urban', 'Val', 'Wren', 'Yael', 'Zion'];
// 大型店的岗位比例（合计 1）：拣货最多，其次交付、补货
const ROLE_SHARE: Array<[AssociateInfo['role'], number]> = [
  ['PICK', 0.38],
  ['HANDOFF', 0.18],
  ['RESTOCK', 0.14],
  ['STAGE', 0.1],
  ['BACKROOM', 0.09],
  ['DELI', 0.07],
  ['LEAD', 0.04],
];

/**
 * 大型店的员工名单（决策记录 0014）：前 11 位与演示门店相同，其余按岗位比例生成，编号 A012 起。
 * 名字确定生成（同样的人数得到同样的名单）；带班负责人和后仓员工有后仓补取权限。
 */
export function largeRoster(size: number, hardware = false): AssociateInfo[] {
  const base = hardware ? HARDWARE_ROSTER : ROSTER;
  const out = base.slice(0, Math.min(size, base.length));
  const counts = ROLE_SHARE.map(([role, share]) => [role, Math.round(share * size)] as const);
  const pool: AssociateInfo['role'][] = [];
  for (const [role, n] of counts) {
    const have = out.filter((a) => a.role === role).length;
    for (let i = have; i < n; i++) pool.push(hardware && role === 'DELI' ? 'BACKROOM' : role);
  }
  for (let i = 0; out.length < size; i++) {
    const n = out.length + 1;
    const role = pool[i] ?? 'PICK';
    out.push({ id: `A${String(n).padStart(3, '0')}`, name: `${FIRST[n % FIRST.length]} ${String.fromCharCode(65 + (Math.floor(n / FIRST.length) % 26))}.`, role, exceptionAuthorized: role === 'LEAD' || role === 'BACKROOM' });
  }
  return out;
}

export interface DemoStore {
  id: string;
  ctx: OpsContext;
  statics: StoreStatic;
  catalog: ReadonlyMap<string, Item>;
  /** 生成一张演示订单（不含大件），时段从 slotStart 开始；code 不给时随机生成；track = AUTO 是自动运营的订单 */
  makeOrder(opts: { index: number; type: 'PICKUP' | 'DELIVERY'; slotStart: number; maxLines?: number; oversized?: boolean; code?: string; track?: 'AUTO' }): { info: OrderInfo; code: string; codeHash: string };
  hashCode(key: string, code: string): string;
  /** 自动运营用的取货码 / 司机验证码：由门店的盐和编号算出，中枢重启后虚拟员工仍然知道 */
  autoCode(key: string): string;
  /** 期初库存（建店时载入一次） */
  openingInventory(at: number): ReturnType<typeof initialInventory>;
}

export function createDemoStore(opts: { id: string; template?: TemplateName; config?: StoreConfig; seed?: number; salt: string; platform: HubPlatform; staff?: number }): DemoStore {
  // 演示门店打开全部扩展模块（模板默认值不变，Phase 1 的仿真不受影响）；建材店没有熟食现做。
  // 给了 config（「你的商店」）时按这份配置建店，模块开关按配置；需求形态按行业选模板
  const config: StoreConfig = opts.config ? (JSON.parse(JSON.stringify(opts.config)) as StoreConfig) : createTemplate(opts.template ?? 'medium');
  const hw = config.industry === 'HARDWARE';
  const template: TemplateName = opts.config ? (hw ? 'hardware' : 'medium') : (opts.template ?? 'medium');
  if (!opts.config) config.modules = { ...config.modules, mto: !hw, parcelHub: true, returns: true, gm: true };
  const model = new StoreModel(config);
  const catalog = generateCatalog(model, { seed: opts.seed ?? 7 });
  const hash = makeHasher(opts.platform, opts.salt);
  const rules = model.config.rules;
  // 区域（决策记录 0013）：暂存格位、库位都带区域编号
  const sa = storeAreas(model.config);
  const rackArea = new Map<string, string>();
  for (const r of sa.racks) {
    const inside = r.areaId ?? sa.areas.find((a) => a.group === 'STAGING' && r.x >= a.x0 && r.x <= a.x1 && r.z >= a.z0 && r.z <= a.z1)?.id;
    if (inside) rackArea.set(r.rackId, inside);
  }
  const explicit = !!model.config.areas;
  const areaIds = (kind: string) => sa.areas.filter((a) => a.kind === kind);
  const statics: StoreStatic = {
    storeId: opts.id,
    name: model.config.name,
    rules: {
      approachingMin: rules.handoff.approachingMin,
      longWaitMin: rules.handoff.longWaitMin,
      codeAttempts: rules.handoff.codeAttempts,
      ...(rules.handoff.driverCancelLockMin !== undefined ? { driverCancelLockMin: rules.handoff.driverCancelLockMin } : {}),
      ...(rules.handoff.driverCancelWaitMin !== undefined ? { driverCancelWaitMin: rules.handoff.driverCancelWaitMin } : {}),
      occupancyAlert: rules.staging.occupancyAlert,
      slotLengthMin: rules.slotLengthMin,
      lockLeadMin: rules.lockLeadMin,
    },
    slots: model.stagingSlots.map((s) => {
      const areaId = rackArea.get(s.rackId);
      return { code: s.code, tempZone: s.tempZone, capacity: s.capacityTotes, area: s.area, purpose: s.purpose, distM: Math.round(s.distanceM * 10) / 10, ...(areaId ? { areaId } : {}) };
    }),
    roster: opts.staff && opts.staff > ROSTER.length ? largeRoster(opts.staff, hw) : hw ? HARDWARE_ROSTER : ROSTER,
    bins: buildBins(model),
    planogram: buildPlanogram(model, catalog.byId),
    replenish: DEFAULT_REPLENISH_RULES,
    modules: { mto: model.config.modules.mto, returns: model.config.modules.returns, oversized: model.config.modules.gm, parcel: model.config.modules.parcelHub },
    ...(model.config.modules.mto
      ? { mtoMenu: DELI_MENU.map((d) => ({ ...d })), hotSlots: explicit && areaIds('HOT_HOLD').length ? hotSlotsFrom(areaIds('HOT_HOLD')) : ['H-01', 'H-02', 'H-03', 'H-04'] }
      : {}),
    parcelSlots: explicit && areaIds('PARCEL').length ? parcelSlotsFrom(areaIds('PARCEL')) : DEFAULT_PARCEL_SLOTS,
    oversizedAreas: explicit && areaIds('STAGING_OVERSIZED').length ? areaIds('STAGING_OVERSIZED').map((a) => a.id) : hw ? ['BULK-1', 'BULK-2', 'BULK-3', 'YARD-1', 'YARD-2'] : ['BULK-1', 'BULK-2', 'BULK-3'],
    areas: sa.areas.map((a) => {
      const out: NonNullable<StoreStatic['areas']>[number] = { id: a.id, kind: a.kind, group: a.group, floorId: a.floorId, x0: a.x0, z0: a.z0, x1: a.x1, z1: a.z1, tempZone: a.tempZone, capacity: a.capacity, unit: a.unit, alertAt: a.alertAt };
      if (a.label) out.label = a.label;
      return out;
    }),
    docks: sa.docks.map((d) => ({ id: d.id, x: d.x, kind: d.kind, reefer: d.reefer })),
    ...(model.config.parking?.pickupBays?.length ? { pickupBays: model.config.parking.pickupBays.map((b) => b.id) } : {}),
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
    makeOrder({ index, type, slotStart, maxLines, oversized, code: given, track }) {
      const list = byType[type].length ? byType[type] : pool;
      const src = list[index % list.length] as Order;
      const id = `D${String(index + 1).padStart(4, '0')}`;
      const base = maxLines ? src.lines.slice(0, maxLines) : src.lines;
      // 演示「大件」：加一行大件商品（2 件）
      const big = oversized && bigItems.length ? (bigItems[index % bigItems.length] as Item) : undefined;
      const lines = big ? [...base, { lineId: 'x', itemId: big.id, qty: 2, allowSubstitution: false }] : base;
      const order: Order = { ...src, id, shortCode: shortCode(`${opts.salt}:${opts.id}:${id}`), type, lines: lines.map((l, i) => ({ ...l, lineId: `${id}-L${i + 1}` })) };
      const info = orderInfoFrom(order, catalog.byId, slotStart, rules.slotLengthMin);
      if (track) info.track = track;
      const code = given ?? randomCode(opts.platform);
      return { info, code, codeHash: hash(codeHashInput(id, code)) };
    },
    hashCode: (key, code) => hash(codeHashInput(key, code)),
    autoCode(key) {
      const h = hash(`auto-code:${key}`);
      let out = '';
      for (let i = 0; i < 4; i++) out += CODE_ALPHABET[parseInt(h.slice(i * 2, i * 2 + 2), 16) % CODE_ALPHABET.length];
      return out;
    },
  };
}

const DEFAULT_PARCEL_SLOTS = [
  ...['P01', 'P02', 'P03', 'P04'].map((code) => ({ code, capacity: 6, size: 'S' as const })),
  ...['P05', 'P06', 'P07', 'P08', 'P09'].map((code) => ({ code, capacity: 4, size: 'M' as const })),
  ...['P10', 'P11', 'P12'].map((code) => ({ code, capacity: 2, size: 'L' as const })),
];

/** 明确给出的熟食保温区：每份一个格位 */
function hotSlotsFrom(areas: ReadonlyArray<{ capacity: number }>): string[] {
  const out: string[] = [];
  for (const a of areas) for (let k = 0; k < Math.max(1, Math.round(a.capacity / 6)); k++) out.push(`H-${String(out.length + 1).padStart(2, '0')}`);
  return out;
}

/** 明确给出的包裹区：按容量切成小、中、大格位（各约三分之一） */
function parcelSlotsFrom(areas: ReadonlyArray<{ capacity: number }>): Array<{ code: string; capacity: number; size: 'S' | 'M' | 'L' }> {
  const out: Array<{ code: string; capacity: number; size: 'S' | 'M' | 'L' }> = [];
  for (const a of areas) {
    const n = Math.max(3, Math.round(a.capacity / 4));
    for (let k = 0; k < n; k++) {
      const size = k < n / 3 ? 'S' : k < (2 * n) / 3 ? 'M' : 'L';
      out.push({ code: `P${String(out.length + 1).padStart(2, '0')}`, capacity: size === 'S' ? 6 : size === 'M' ? 4 : 2, size });
    }
  }
  return out;
}
