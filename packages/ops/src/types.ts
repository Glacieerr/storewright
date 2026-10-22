import type { FulfillmentType, OrderType, TempZone, VehiclePosition } from '@storewright/domain';
import type { AbcClass, InventoryStatus, ReplenishRules } from '@storewright/algorithms/replenish';
import type { AiMode, OverrideReason, Recommendation, Resolution } from '@storewright/ai';

/**
 * 实时作业的状态类型。
 *
 * 约定：
 * - 时间一律是毫秒时间戳（服务端时钟），调用规划算法时再换算为秒；
 * - 状态是普通的 JSON 对象（Record 而不是 Map），可以直接作为快照发送；
 * - 事件自带显示所需的信息（商品名称、货位），客户端不需要商品目录。
 */

export interface LineInfo {
  lineId: string;
  itemId: string;
  gtin: string;
  name: string;
  qty: number;
  tempZone: TempZone;
  /** 主陈列货位 */
  locationId: string;
  allowSubstitution: boolean;
  ageRestricted: boolean;
  unitPrice: number;
}

export interface OrderInfo {
  id: string;
  shortCode: string;
  firstName: string;
  lastName: string;
  type: OrderType;
  fulfillmentType: FulfillmentType;
  express: boolean;
  slotStart: number;
  slotLengthMin: number;
  lines: LineInfo[];
  /** 配送目的地相对门店的坐标（千米） */
  destinationKm?: { x: number; y: number };
}

export type OrderStatus = 'CREATED' | 'LOCKED' | 'PICKING' | 'STAGED' | 'PREPPING' | 'READY' | 'HANDING_OFF' | 'COMPLETED' | 'CANCELLED';

export interface LineResult {
  picked: number;
  short: number;
  substituted: number;
  substituteName?: string;
  /** 已转后仓补取 */
  exception?: boolean;
  /** 后仓补取送到暂存区的件数（已从缺货中扣除） */
  recovered?: number;
}

export interface LiveOrder extends OrderInfo {
  status: OrderStatus;
  createdAt: number;
  /** 验证码哈希；明文只交给顾客 */
  codeHash: string;
  toteIds: string[];
  /** 不进框的大件数（Phase 3 不处理先扫后打） */
  oversized: number;
  lockedAt?: number;
  stagedAt?: number;
  etaAt?: number;
  /** 顾客上报预计到达的时间（用来算导航给出的用时） */
  etaReportedAt?: number;
  /** AI 修正后的预计到达（采纳或自动执行后才有） */
  aiEtaAt?: number;
  arrivedAt?: number;
  bay?: string;
  vehicle?: string;
  tripId?: string;
  completedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
  ageItemsRemoved?: boolean;
  lineResults: Record<string, LineResult>;
}

export interface ToteInfo {
  id: string;
  orderId: string;
  tempZone: TempZone;
  index: number;
  count: number;
  chemical: boolean;
  lines: Array<{ lineId: string; qty: number }>;
  dueAt: number;
}

export type ToteStatus = 'PLANNED' | 'IN_WALK' | 'BOUND' | 'PICKED' | 'STAGED' | 'PULLED' | 'HANDED_OFF' | 'RECOVERY';

export interface LiveTote extends ToteInfo {
  status: ToteStatus;
  walkId?: string;
  labelId?: string;
  labelVersion: number;
  slotCode?: string;
}

export interface LiveLabel {
  labelId: string;
  toteId: string;
  version: number;
  voided: boolean;
  printedAt: number;
  reprints: number;
}

export interface WalkPick {
  toteId: string;
  lineId: string;
  qty: number;
}

export interface WalkStop {
  locationId: string;
  picks: WalkPick[];
}

export interface WalkInfo {
  id: string;
  tempZone: TempZone;
  toteIds: string[];
  /** 已按路线排序：拣货顺序就是路线顺序（工程约束 EC-5） */
  stops: WalkStop[];
  distanceM: number;
  estimatedSec: number;
  coldLimitSec?: number;
  dueAt: number;
}

export type WalkStatus = 'OPEN' | 'CLAIMED' | 'PICKING' | 'COMPLETED';

export interface LiveWalk extends WalkInfo {
  status: WalkStatus;
  createdAt: number;
  associateId?: string;
  claimedAt?: number;
  startedAt?: number;
  completedAt?: number;
  coldStartedAt?: number;
  coldAlerted?: boolean;
  /** 已扫描绑定的框 */
  bound: string[];
  /** `${toteId}|${lineId}` → 已处理件数（拣到 + 缺货） */
  done: Record<string, number>;
}

export type SessionStatus = 'PREPPING' | 'READY' | 'HANDING_OFF' | 'COMPLETED';

/** 交付会话：一个自取订单，或一个配送行程（一次核验） */
export interface HandoffSession {
  key: string;
  kind: 'ORDER' | 'TRIP';
  orderIds: string[];
  status: SessionStatus;
  owner: string;
  helpers: string[];
  startedAt: number;
  /** 已从暂存区取出并扫描的框 */
  scanned: string[];
  verified?: 'CODE' | 'MANUAL';
  codeFailures: number;
  manualRequired: boolean;
  ageVerified: boolean;
  completedAt?: number;
}

export interface LiveTrip {
  id: string;
  orderIds: string[];
  placements: Record<string, VehiclePosition>;
  proposedAt: number;
  driverName?: string;
  codeHash?: string;
  acceptedAt?: number;
  etaAt?: number;
  arrivedAt?: number;
  bay?: string;
  vehicle?: string;
  completedAt?: number;
}

export type ExceptionStatus = 'OPEN' | 'ASSIGNED' | 'FOUND' | 'NOT_FOUND' | 'DELIVERED' | 'VOID';

/** 后仓补取（决策 X-01～X-04）：拣货员报告缺货后，授权员工从后仓取货送到暂存区 */
export interface LiveException {
  id: string;
  orderId: string;
  lineId: string;
  walkId: string;
  createdAt: number;
  itemId: string;
  qty: number;
  status: ExceptionStatus;
  associateId?: string;
  assignedAt?: number;
  caseId?: string;
  foundAt?: number;
  deliveredAt?: number;
  slotCode?: string;
}

/** 后仓的一箱货（每箱一个内部箱号，决策 I-02） */
export type CaseState = 'RECEIVED' | 'STORED' | 'EMPTY' | 'LOST';

export interface LiveCase {
  id: string;
  itemId: string;
  gtin: string;
  name: string;
  packQty: number;
  /** 箱里剩余件数 */
  units: number;
  status: InventoryStatus;
  state: CaseState;
  binCode?: string;
  receiptId?: string;
  receivedAt: number;
  damaged?: boolean;
}

export interface AsnLine {
  itemId: string;
  gtin: string;
  name: string;
  cases: number;
  packQty: number;
}

export interface Discrepancy {
  itemId: string;
  expected: number;
  received: number;
  damaged: number;
  kind: 'SHORT' | 'OVER' | 'DAMAGED';
}

/** 收货单：先收到 ASN，卡车到店后逐箱收货，关闭时与 ASN 比较（决策 I-01） */
export interface LiveReceipt {
  id: string;
  supplier: string;
  expected: AsnLine[];
  createdAt: number;
  arrivedAt?: number;
  closedAt?: number;
  /** 商品 → 已收箱数 / 损坏箱数 */
  received: Record<string, { cases: number; damaged: number }>;
  discrepancies?: Discrepancy[];
}

/** 货架货位的存量估算（决策 R-01、P-06） */
export interface ShelfState {
  est: number;
  /** 0–1；员工扫描 > 传感器 > 销售推算 */
  conf: number;
  source: 'INIT' | 'POS' | 'SENSOR' | 'SCAN';
  /** 最后一次变化 */
  at: number;
  confirmedAt?: number;
  /** 销售速度（件 / 小时，指数平滑） */
  velocity: number;
  lastSaleAt?: number;
  sensorAt?: number;
  sensorAnomaly?: boolean;
}

export type ReplReason = 'EXCEPTION' | 'EMPTY' | 'LOW' | 'MANUAL' | 'SENSOR';
export type ReplStatus = 'OPEN' | 'CLAIMED' | 'DONE' | 'CANCELLED';

export interface ReplTask {
  id: string;
  locationId: string;
  itemId: string;
  area: string;
  reason: ReplReason;
  suggestedUnits: number;
  priority: number;
  createdAt: number;
  status: ReplStatus;
  associateId?: string;
  claimedAt?: number;
  caseId?: string;
  doneAt?: number;
  units?: number;
}

export type CountReason = 'SCHEDULED' | 'MANUAL' | 'EXCEPTION_NOT_FOUND' | 'DISCREPANCY' | 'REPLENISH_NOT_FOUND' | 'AI_RISK';

/** 核对货架（Phase 5b）：AI 判断「系统显示有货、但货架上可能找不到」时，请员工到货架数一数 */
export interface ShelfCheck {
  id: string;
  itemId: string;
  locationId: string;
  reason: 'AI' | 'MANUAL';
  recId?: string;
  createdAt: number;
  status: 'OPEN' | 'DONE';
  associateId?: string;
  doneAt?: number;
  units?: number;
  /** 核对前系统的估算（与实际数的差就是没有经过收银的损耗或放错位置） */
  previousEst?: number;
}

/** 盘点任务（决策 I-04） */
export interface CountTask {
  id: string;
  binCode: string;
  itemId?: string;
  reason: CountReason;
  createdAt: number;
  status: 'OPEN' | 'CLAIMED' | 'DONE';
  associateId?: string;
  doneAt?: number;
  results?: Array<{ itemId: string; expected: number; counted: number }>;
}

/** AI 建议（决策记录 0010）：发出后等待处理，处理结果也记在这里 */
export interface LiveRec extends Recommendation {
  status: 'OPEN' | Resolution;
  resolvedAt?: number;
  resolvedBy?: string;
  reason?: OverrideReason;
  note?: string;
}

export interface AiModeState {
  mode: AiMode;
  /** 锁定后只有控制台（门店管理员）可以修改 */
  locked: boolean;
  at: number;
  by: string;
}

/** 每个模块的建议处理统计（不随旧建议的清理而减少） */
export interface AiModuleStats {
  issued: number;
  ACCEPTED: number;
  OVERRIDDEN: number;
  DISMISSED: number;
  EXPIRED: number;
  SUPERSEDED: number;
  AUTO_APPLIED: number;
  /** 否决原因 → 次数 */
  reasons: Record<string, number>;
}

// —— 扩展模块（Phase 6）——

export type MtoStatus = 'QUEUED' | 'COOKING' | 'HELD' | 'PULLED' | 'DISCARDED';

/** 熟食现做单（工作流设计 4.8） */
export interface MtoTicket {
  id: string;
  orderId: string;
  menuId: string;
  name: string;
  qty: number;
  hot: boolean;
  holdMin: number;
  status: MtoStatus;
  createdAt: number;
  /** 建议开始时间（AI 可以调整）、标准建议开始时间、应完成时间 */
  startAt: number;
  standardStartAt: number;
  dueAt: number;
  aiAdjusted?: boolean;
  associateId?: string;
  startedAt?: number;
  completedAt?: number;
  discardAt?: number;
  slotCode?: string;
  pulledAt?: number;
  discardedAt?: number;
  discardReason?: 'HOLD_EXPIRED' | 'MANUAL' | 'ORDER_CANCELLED';
}

export type ReturnDisposition = 'RESTOCK' | 'DISPOSE' | 'HAZMAT' | 'VENDOR';

export interface ReturnLine {
  itemId: string;
  gtin: string;
  name: string;
  qty: number;
  condition: 'SEALED' | 'OPENED' | 'DAMAGED';
  inOrder: boolean;
  tempZone: string;
  unitPrice: number;
  /** 化学品（危险品回收规则）；只有未开封才能回架的散件（超市的食品、日用品、个护）。旧事件没有这两项时按 false 处理 */
  chemical?: boolean;
  sealedOnly?: boolean;
  disposition?: ReturnDisposition;
  aiSuggested?: ReturnDisposition;
}

/** 退货单（工作流设计 4.10）：顾客退货逐件处理，配送退回整单处理 */
export interface ReturnCase {
  id: string;
  orderId?: string;
  kind: 'CUSTOMER' | 'DELIVERY';
  status: 'OPEN' | 'COMPLETED';
  createdAt: number;
  associateId: string;
  lines: ReturnLine[];
  completedAt?: number;
  refundValue?: number;
}

export type OversizedStatus = 'OPEN' | 'CLAIMED' | 'LABELED' | 'STAGED';

/** 大件（工作流设计 4.3）：先扫后打、一件一签 */
export interface OversizedTask {
  id: string;
  orderId: string;
  lineId: string;
  itemId: string;
  name: string;
  gtin: string;
  index: number;
  count: number;
  weightKg: number;
  teamLift: boolean;
  status: OversizedStatus;
  associateId?: string;
  labelId?: string;
  area?: string;
  stagedAt?: number;
}

export type ParcelStatus = 'EXPECTED' | 'INDUCTED' | 'STAGED' | 'HANDED_OFF' | 'SHORT' | 'DAMAGED' | 'OVER';

/** 包裹中转（工作流设计 4.9） */
export interface Parcel {
  id: string;
  asnId?: string;
  carrier: string;
  tripRef?: string;
  sizeClass: 'S' | 'M' | 'L';
  weightKg: number;
  status: ParcelStatus;
  expectedBy?: number;
  inductedAt?: number;
  slotCode?: string;
  handedOffAt?: number;
}

/** 门店经验记录（Phase 5d）：员工记下的现场经验，本地助手可以检索 */
export interface StoreNote {
  id: string;
  text: string;
  tags: string[];
  itemId?: string;
  locationId?: string;
  author: string;
  at: number;
}

/** 员工最近一次扫描的位置：模拟器用它近似员工所在位置（不做室内定位，工程约束 EC-8） */
export interface AssociateActivity {
  lastScanAt?: number;
  lastLocationId?: string;
  lastSlotCode?: string;
}

export interface OpsState {
  /** 最后一条已应用事件的序号 */
  seq: number;
  at: number;
  orders: Record<string, LiveOrder>;
  totes: Record<string, LiveTote>;
  labels: Record<string, LiveLabel>;
  walks: Record<string, LiveWalk>;
  sessions: Record<string, HandoffSession>;
  trips: Record<string, LiveTrip>;
  exceptions: Record<string, LiveException>;
  /** 暂存格位 → 放在里面的框 */
  slots: Record<string, string[]>;
  activity: Record<string, AssociateActivity>;
  /** 编号计数器 */
  counters: { walks: number; trips: number; exceptions: number; cases: number; receipts: number; repl: number; counts: number; recs: number; checks: number; notes: number; mto: number; returns: number; asns: number };
  // —— 后仓库存与补货（Phase 4）——
  cases: Record<string, LiveCase>;
  receipts: Record<string, LiveReceipt>;
  /** 库位 → 放在里面的箱子 */
  bins: Record<string, string[]>;
  /** 商品 → 后仓可售且有剩余的箱子 */
  itemCases: Record<string, string[]>;
  /** 后仓记录可疑的商品（Exception 或补货没找到，等待盘点，决策 X-02） */
  suspect: Record<string, number>;
  /** 货架上每个商品（在它的主货位）的存量估算；没有记录时视为开门时补满 */
  shelf: Record<string, ShelfState>;
  repl: Record<string, ReplTask>;
  counts: Record<string, CountTask>;
  /** 核对货架任务 */
  checks: Record<string, ShelfCheck>;
  /** 库位最后一次盘点的时间 */
  countedAt: Record<string, number>;
  // —— AI（Phase 5）——
  /** 最近的建议（最多保留 MAX_RECS 条，最早的已处理建议先清理） */
  recs: Record<string, LiveRec>;
  /** 模块 → 运行模式；没有记录时用默认模式 */
  aiModes: Record<string, AiModeState>;
  aiStats: Record<string, AiModuleStats>;
  /** 员工的临时岗位（调动后；回到名单岗位时删除） */
  roles: Record<string, AssociateRole>;
  /** 被管理员锁定、不参与 AI 调动的员工 */
  staffLocks: Record<string, boolean>;
  /** 门店经验库 */
  notes: Record<string, StoreNote>;
  // —— 扩展模块（Phase 6）——
  mto: Record<string, MtoTicket>;
  returns: Record<string, ReturnCase>;
  oversized: Record<string, OversizedTask>;
  parcels: Record<string, Parcel>;
}

export type { BinInfo, DisplayMethod, PlanogramEntry } from '@storewright/algorithms/planogram';
import type { BinInfo, PlanogramEntry } from '@storewright/algorithms/planogram';

export interface SlotInfo {
  code: string;
  tempZone: TempZone;
  capacity: number;
  area: 'PICKUP' | 'DELIVERY' | 'ANY';
  purpose: string;
}

export type AssociateRole = 'PICK' | 'STAGE' | 'HANDOFF' | 'LEAD' | 'BACKROOM' | 'RESTOCK' | 'DELI';

export interface AssociateInfo {
  id: string;
  name: string;
  role: AssociateRole;
  /** 永久授权：可以执行 Exception（决策 X-01） */
  exceptionAuthorized: boolean;
}

/** 门店的静态信息：随快照一起发给客户端 */
export interface StoreStatic {
  storeId: string;
  name: string;
  rules: {
    approachingMin: number;
    longWaitMin: number;
    codeAttempts: number;
    occupancyAlert: number;
    slotLengthMin: number;
    lockLeadMin: number;
  };
  slots: SlotInfo[];
  roster: AssociateInfo[];
  bins: BinInfo[];
  planogram: PlanogramEntry[];
  replenish: ReplenishRules;
  /** 扩展模块（Phase 6）：来自门店配置的开关；没有时全部关闭 */
  modules?: { mto: boolean; returns: boolean; oversized: boolean; parcel: boolean };
  /** 熟食现做的菜单 */
  mtoMenu?: MtoMenuItem[];
  /** 熟食保温区的格位 */
  hotSlots?: string[];
  /** 包裹中转的暂存格位（按离门口由近到远排列） */
  parcelSlots?: ParcelSlot[];
  /** 大件暂存区（区域级位置） */
  oversizedAreas?: string[];
}

export interface MtoMenuItem {
  id: string;
  name: string;
  /** 标准制作时长与保温时限（分钟） */
  prepMin: number;
  holdMin: number;
  hot: boolean;
}

export interface ParcelSlot {
  code: string;
  capacity: number;
  size: 'S' | 'M' | 'L';
}

export function emptyState(): OpsState {
  return {
    seq: 0,
    at: 0,
    orders: {},
    totes: {},
    labels: {},
    walks: {},
    sessions: {},
    trips: {},
    exceptions: {},
    slots: {},
    activity: {},
    counters: { walks: 0, trips: 0, exceptions: 0, cases: 0, receipts: 0, repl: 0, counts: 0, recs: 0, checks: 0, notes: 0, mto: 0, returns: 0, asns: 0 },
    cases: {},
    receipts: {},
    bins: {},
    itemCases: {},
    suspect: {},
    shelf: {},
    repl: {},
    counts: {},
    checks: {},
    countedAt: {},
    recs: {},
    aiModes: {},
    aiStats: {},
    roles: {},
    staffLocks: {},
    notes: {},
    mto: {},
    returns: {},
    oversized: {},
    parcels: {},
  };
}
