import type { FulfillmentType, OrderType, TempZone, VehiclePosition } from '@storewright/domain';
import type { AbcClass, InventoryStatus, ReplenishRules } from '@storewright/algorithms/replenish';
import type { AiMode, OverrideReason, Reason, Recommendation, Resolution } from '@storewright/ai';

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
  /**
   * 自动运营的订单（演示门店的虚拟员工和虚拟顾客处理）。与员工手里的订单分开生成拣货批次和配送行程，
   * 员工手机上不显示；不设置时是普通订单。
   */
  track?: 'AUTO';
}

export type OrderStatus = 'CREATED' | 'LOCKED' | 'PICKING' | 'STAGED' | 'PREPPING' | 'READY' | 'HANDING_OFF' | 'COMPLETED' | 'CANCELLED';

export interface LineResult {
  picked: number;
  short: number;
  substituted: number;
  substituteName?: string;
  /** 替代品的条码、AI 推荐里的名次与模型（决策记录 0023 · B4：交付时记下顾客的反应，作为真实标签） */
  substituteGtin?: string;
  subRank?: number;
  subModel?: string;
  /** 交付时顾客对替代品满意吗 */
  subAccepted?: boolean;
  /** 已转后仓补取 */
  exception?: boolean;
  /** 后仓补取送到暂存区的件数（已从缺货中扣除） */
  recovered?: number;
  /** 最后一次拣到的时间（只召回部分批号时，货架下架之前拣的才可能是召回的批次；决策记录 0026） */
  pickedAt?: number;
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
  /** 配送司机取消后（或运营预警采纳「通知顾客延后」后），系统通知顾客会延后的时间 */
  delayNoticeAt?: number;
  /** 通知顾客延后的分钟数（运营预警，决策记录 0021） */
  delayMin?: number;
  /** 加急：不等锁单时间，下一次排程就锁单、生成批次（运营预警「提前开始」） */
  expedite?: boolean;
  /** 冷冻商品在这个时间之后才进入拣货批次（运营预警「冷冻商品晚点拣」） */
  frozenAfter?: number;
  /** 设备快照里精简过：完成超过一小时的订单，商品明细只在服务端（决策记录 0014） */
  trimmed?: boolean;
  lineResults: Record<string, LineResult>;
  /** 交付时取出了召回商品（决策记录 0026） */
  recallRemoved?: boolean;
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
  /** 自动运营的批次（只含自动运营的订单） */
  track?: 'AUTO';
  /** 优先拣：含加急订单（运营预警「提前开始」，决策记录 0021）的批次排在可领取列表最前面 */
  priority?: boolean;
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
  /** AI 预计用时（决策记录 0021 · 拣货时长预测）：批次生成时估一次，领取时按领取人的熟练度组再估一次 */
  ai?: WalkEstimate;
  /** 缺货预判（决策记录 0021 · B2）：`${toteId}|${lineId}` → AI 的标记 */
  flags?: Record<string, LineFlag>;
  /** 顺路核对（决策记录 0022 · C3）：拣到第 afterStop 站之后，顺手数一下附近某件商品还剩几件 */
  checks?: WalkCheck[];
  /** 冷链风险（决策记录 0023 · B3）：按现在的速度预计会超时多少秒、还剩几行 */
  coldRisk?: { overSec: number; remainingLines: number; at: number };
}

export interface WalkCheck {
  itemId: string;
  locationId: string;
  name: string;
  afterStop: number;
  status: 'OPEN' | 'DONE' | 'SKIPPED';
  units?: number;
}

export interface WalkEstimate {
  sec: number;
  low: number;
  high: number;
  /** 模型族与版本，例如 pick-time v3 */
  model: string;
  at: number;
  /** 估计时按哪个熟练度组（领取前按中等） */
  tenure?: string;
  reasons?: Reason[];
}

/** 拣货清单上一行的缺货预判：找得到的概率、已安排的后仓补取、首选替代 */
export interface LineFlag {
  p: number;
  /** 已安排的补货任务（后仓有货时） */
  pullTaskId?: string;
  /** 补货预计完成的时间（拣货员预计走到这个货位之前） */
  readyAt?: number;
  /** 后仓也没有时，提前排好的替代候选（预计顾客接受的概率） */
  subs?: Array<{ name: string; gtin: string; p?: number }>;
  /** 货架上最早的一批快到期（决策记录 0024 · C4）：拣的时候避开这个日期之前到期的 */
  shortDated?: string;
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
  /** 验证码错误达到次数后提供人工核验入口；验证码仍可继续输入（决策记录 0014，字段名沿用） */
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
  /** 司机取消（或门店因司机没来而改派）的记录；有记录时行程重新派单（决策记录 0014） */
  cancellations?: TripCancellation[];
  /** 最近一次重新派单的时间 */
  redispatchedAt?: number;
}

export interface TripCancellation {
  at: number;
  by: 'DRIVER' | 'STORE';
  reason: 'BEFORE_PREP' | 'WAITED_TOO_LONG' | 'NO_SHOW';
  driverName?: string;
  /** 到店后等了多少分钟（等待过久时） */
  waitedMin?: number;
  /** 取消时正在交付准备的员工 */
  sessionOwner?: string;
  /** 已经从暂存区取出、需要放回的框和放回的格位 */
  returns: Array<{ toteId: string; slotCode: string }>;
  /** 订单可能赶不上承诺的时间 */
  atRisk: boolean;
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
  /** 实际取出的件数（箱子里不够时比要的少；送到暂存时按这个记） */
  units?: number;
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
  /** 批号、保质期（YYYY-MM-DD）：收货时扫箱上的 GS1 码或手填（决策记录 0024 · C4） */
  lot?: string;
  expiry?: string;
}

/** 召回（决策记录 0024 · C5） */
export type RecallStep = 'SHELF' | 'BACKROOM' | 'STAGED' | 'ORDERS' | 'CUSTOMERS';
export interface Recall {
  id: string;
  title: string;
  reason?: string;
  itemIds: string[];
  /** 批号或批号开头（没有时整个商品都算） */
  lots: string[];
  from?: string;
  to?: string;
  openedAt: number;
  by: string;
  status: 'OPEN' | 'CLOSED';
  closedAt?: number;
  /** auto：开启时已经做了或者没有要做的（后仓的箱子开启时就转待检；没有框、订单、顾客的那一步） */
  steps: Partial<Record<RecallStep, { at: number; by: string; auto?: boolean }>>;
  /** 开启时找到的：货架估算件数、后仓箱、暂存和推车上的框、未完成的订单、30 天内已交付的订单 */
  affected: { shelf: Record<string, number>; cases: string[]; totes: string[]; openOrders: string[]; doneOrders: string[] };
}

/** 突发状况（决策记录 0024 · E4） */
export type IncidentKind = 'POWER' | 'FIRE' | 'SYSTEM' | 'STORM';
export interface Incident {
  id: string;
  kind: IncidentKind;
  startedAt: number;
  by: string;
  endedAt?: number;
  checked: Record<string, { at: number; by: string }>;
  /** 开启时的影响：暂存里的冷藏、冷冻框，后仓冷链箱，接下来两小时要取的订单 */
  impact: { coldTotes: number; frozenTotes: number; coldCases: number; ordersSoon: string[] };
}

/** 货架上的一个批次（决策记录 0024 · C4）：补货上架时来自那一箱，卖出、拣货按到期先后扣 */
export interface ShelfLot {
  lot: string;
  expiry?: string;
  units: number;
  at: number;
  caseId?: string;
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
  /** 供应商通知的预计到达（决策记录 0022 · A3）；更新过时 firstExpectedAt 是第一次通知的时间 */
  expectedAt?: number;
  firstExpectedAt?: number;
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

/** PREPICK：拣货前的缺货预判（拣货员走到之前先补上）；RISK：接下来几小时可能断货（含已下单的线上需求） */
export type ReplReason = 'EXCEPTION' | 'EMPTY' | 'LOW' | 'MANUAL' | 'SENSOR' | 'PREPICK' | 'RISK';
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
  /** 应在这个时间前补上（拣货前的缺货预判：拣货员预计走到这个货位的时刻） */
  dueAt?: number;
  /** 接下来 horizonH 小时断货的概率与依据（决策记录 0021 · C2） */
  risk?: number;
  why?: ReplWhy;
  /** 补取时已经拿在手上的那一箱（决策记录 0026） */
  fromCaseId?: string;
}

export interface ReplWhy {
  /** 接下来几小时线上订单要的件数（已下单未拣 + 预测） */
  online: number;
  /** 其中已下单的件数、涉及的订单数 */
  ordered: number;
  orders: number;
  /** 货架估算件数、找得到的概率 */
  est: number;
  pFind?: number;
  /** 店内预计卖出的件数 */
  instore: number;
  horizonH: number;
}

export type CountReason = 'SCHEDULED' | 'MANUAL' | 'EXCEPTION_NOT_FOUND' | 'DISCREPANCY' | 'REPLENISH_NOT_FOUND' | 'AI_RISK';

/** 拣货员报告找不到时选的原因（决策记录 0022 · C1）：空架、货位上是别的东西或空位（可能放错了地方）、损坏、价签不对、其他 */
export type NotFoundReason = 'EMPTY' | 'NOT_AT_LOCATION' | 'DAMAGED' | 'PRICE_TAG' | 'OTHER';
/** 附近找一找的结果：就在原货位 / 在附近找到（已放回）/ 都没有 */
export type ShelfFound = 'HOME' | 'NEARBY' | 'NONE';

/** 核对货架（Phase 5b）：AI 判断「系统显示有货、但货架上可能找不到」时，请员工到货架数一数；SEARCH：可能放错了地方，到附近货架段找一找（决策记录 0022） */
/**
 * 核对货架任务的种类：AI / 手动 / 附近找一找是数货架上有几件；
 * 贴折扣签、下架过期的批次、拿下来捐赠、退货放回货架是要到货架上做的事（决策记录 0026），做完数一下做了几件
 */
/** RECALL：只召回部分批号、货架上又没有批次记录时，下架后数一下剩下的（别的批号，决策记录 0026） */
export type ShelfCheckReason = 'AI' | 'MANUAL' | 'SEARCH' | 'MARKDOWN' | 'PULL' | 'DONATE' | 'RETURN' | 'RECALL';
export const LOT_TASKS: readonly ShelfCheckReason[] = ['MARKDOWN', 'PULL', 'DONATE', 'RETURN'];

export interface ShelfCheck {
  id: string;
  itemId: string;
  locationId: string;
  reason: ShelfCheckReason;
  /** 批次任务（决策记录 0026）：哪一批、打几折、大约几件 */
  lot?: string;
  pct?: number;
  expected?: number;
  /** 附近找一找的货位（同一通道前后几个货架段） */
  near?: string[];
  recId?: string;
  createdAt: number;
  status: 'OPEN' | 'DONE';
  associateId?: string;
  doneAt?: number;
  units?: number;
  /** 附近找一找：商品在哪里找到的 */
  found?: ShelfFound;
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
  /** 事后测到的实际效果（决策记录 0022 · F4） */
  outcome?: RecOutcome;
}

/**
 * 效果追踪（决策记录 0022 · F4）：建议的时间段过去、或者对应的任务做完之后，从事件流算出的实际值。
 * - EFFECT：预计的改善（采纳后的值 vs 不处理时的推演值），例如迟到单数、平均等待；
 * - EVENT：建议所依据的事情有没有发生，例如货架上真的没有、设备真的有故障、AI 的到店时间比导航准；
 * - CALIBRATION：只用来校准概率（例如顺路核对：AI 本来就说不准）。
 */
export interface RecOutcome {
  kind: 'EFFECT' | 'EVENT' | 'CALIBRATION';
  /** 指标代码：LATE、WAIT、COLD_FULL、BACKLOG、SHELF_EMPTY、MISPLACED、ON_SHELF、FAULT、AI_CLOSER、RECORD_WRONG */
  metric: string;
  unit: string;
  predicted: number;
  /** 不处理时的推演值（EFFECT） */
  baseline?: number;
  actual: number;
  /** 采纳 / 自动执行的建议：说到做到；没采纳的同类建议（对照）：预警的问题真的发生了 */
  hit: boolean;
  adopted: boolean;
  /** 实现的改善占预计改善的比例（EFFECT，可能为负） */
  realized?: number;
  at: number;
}

/** 每个模块的效果统计（不随旧建议的清理而减少） */
export interface OutcomeStats {
  /** 采纳 / 自动执行后测到实际值的次数、说到做到的次数 */
  n: number;
  hits: number;
  /** 实现比例之和与次数（EFFECT） */
  realizedSum: number;
  realizedN: number;
  /** 没采纳的同类建议：测到的次数、问题真的发生的次数 */
  ctrlN: number;
  ctrlHits: number;
  /** 概率预测的 Brier 分数之和与次数 */
  brierSum: number;
  brierN: number;
  /** 最近几次采纳后的结果（1 说到做到，0 没做到），用来判断要不要自动降成只显示 */
  recent: number[];
  /** 按指标累计的预计改善与实际改善（EFFECT，采纳的） */
  gains: Record<string, { n: number; predicted: number; actual: number }>;
}

/** AI 运行监控（决策记录 0022 · H3）：一个模型族的健康度 */
export interface AiModelHealth {
  /** 模型族：orders-hourly、eta、shelf-availability、pick-time、shelf-truth、ops-foresight…… */
  id: string;
  /** 正常 / 误差明显变大 / 数据中断已暂停 / 数据不够还没法判断 */
  status: 'OK' | 'DRIFT' | 'PAUSED' | 'NO_DATA';
  /** 比较用的指标、最近的值、回测时的值、最近的样本数 */
  metric?: string;
  recent?: number;
  backtest?: number;
  n?: number;
  /** 暂停的原因：POS_STALE（收银流水中断）、SENSORS_OFFLINE（传感器离线） */
  cause?: string;
  /** 进入这个状态的时间 */
  since: number;
}

export interface AiHealth {
  at: number;
  models: AiModelHealth[];
}

export interface AiModeState {
  mode: AiMode;
  /** 锁定后只有控制台（门店管理员）可以修改 */
  locked: boolean;
  at: number;
  by: string;
  /** 效果追踪发现连续不准、自动降成只显示时的记录（决策记录 0022 · F4） */
  auto?: { hitRate: number; n: number };
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
  /** 效果追踪（决策记录 0022 · F4） */
  outcomes?: OutcomeStats;
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
  /** 标签打印的时间（决策记录 0026） */
  printedAt?: number;
  area?: string;
  stagedAt?: number;
}

/** RETURNED：退回快递；HELD：放在异常区等人认领（决策记录 0026） */
export type ParcelStatus = 'EXPECTED' | 'INDUCTED' | 'STAGED' | 'HANDED_OFF' | 'SHORT' | 'DAMAGED' | 'OVER' | 'RETURNED' | 'HELD';

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

/** 门店设置（决策记录 0026）：控制台和带班负责人可以改 */
export interface StoreSettings {
  /** 要求扫码：点选代替扫码的操作被拒绝，演示和培训时关掉 */
  requireScan?: boolean;
  /** 交付准备什么时候能开始：ANY 顾客到店前也可以（先取常温、最后取冷藏冷冻）；ARRIVED 顾客到了才能开始 */
  prepGate?: 'ANY' | 'ARRIVED';
}

export interface RoleChange {
  from: AssociateRole;
  at: number;
  by: string;
  /** 到这个时刻自动回原岗位 */
  until?: number;
}

/** 排队中的调动：手上的任务做完后由节拍调过去（决策记录 0026） */
export interface PendingMove {
  role: AssociateRole;
  minutes?: number;
  at: number;
  by: string;
  recId?: string;
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
  counters: { walks: number; trips: number; exceptions: number; cases: number; receipts: number; repl: number; counts: number; recs: number; checks: number; notes: number; mto: number; returns: number; asns: number; alerts: number; nudges?: number };
  // —— 后仓库存与补货（Phase 4）——
  cases: Record<string, LiveCase>;
  receipts: Record<string, LiveReceipt>;
  /** 库位 → 放在里面的箱子 */
  bins: Record<string, string[]>;
  /** 商品 → 后仓可售且有剩余的箱子 */
  itemCases: Record<string, string[]>;
  /** 后仓记录可疑的商品（Exception 或补货没找到，等待盘点，决策 X-02） */
  /** AI 运行监控（决策记录 0022 · H3）：AI 服务发布的各模型健康度 */
  aiHealth?: AiHealth;
  /** 分框系数（决策记录 0023 · B7）：商品类别 → 实际占用体积 ÷ 体积数据；锁单分框时用 */
  toteFactors?: Record<string, number>;
  /** 拣货中加框的次数（框装不下） */
  overflows?: number;
  /** 替代品的真实标签（决策记录 0023 · B4）：交付时记下的顾客反应；其中 AI 推荐第一名的 */
  subLabels?: { n: number; accepted: number; top1: number; top1Accepted: number };
  /** 「下一步」的采用情况（决策记录 0024 · D3）：照着做了几次、换了几次（按任务种类） */
  nextTaskStats?: Record<string, { taken: number; skipped: number }>;
  /** 现场操作提示（决策记录 0024 · D4）：员工 → 看过的操作规范（时间、小测验答对几题） */
  sopAcks?: Record<string, Record<string, { at: number; correct?: number; total?: number }>>;
  /** 门店助手的问答（决策记录 0024 · F2）：最近的问答（最多 200 条）和「有用 / 没用」的统计 */
  answers?: Record<string, { q: string; tools: string[]; source: string; at: number; by: string; helpful?: boolean }>;
  answerStats?: { answered: number; helpful: number; unhelpful: number };
  /** 现场应对（决策记录 0024 · C5、E4、E5）：召回、突发状况、食品安全记录的确认（日期 → 谁、什么时候） */
  recalls?: Record<string, Recall>;
  incidents?: Record<string, Incident>;
  foodSafety?: Record<string, { at: number; by: string; note?: string }>;
  /** 临期与损耗（决策记录 0024 · C4）：货架上每件商品的批次；降价记录（商品|批号 → 幅度）；捐赠的件数 */
  shelfLots?: Record<string, ShelfLot[]>;
  markdowns?: Record<string, { pct: number; at: number }>;
  donated?: number;
  /** 停止接新单的取货时段（决策记录 0023 · B6）：时段开始（毫秒，字符串）→ 谁、什么时候、哪条建议 */
  closedSlots?: Record<string, { at: number; by: string; recId?: string }>;
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
  /** 临时调动的来龙去脉：从哪个岗位、几点、谁调的、到几点自动调回（在岗人员页显示） */
  roleChanges?: Record<string, RoleChange>;
  /** 排队中的调动（做完手上的任务再去） */
  pendingMoves?: Record<string, PendingMove>;
  /** 门店设置（决策记录 0026） */
  settings?: StoreSettings;
  /** 被管理员锁定、不参与 AI 调动的员工 */
  staffLocks: Record<string, boolean>;
  /** 门店经验库 */
  notes: Record<string, StoreNote>;
  // —— 扩展模块（Phase 6）——
  mto: Record<string, MtoTicket>;
  returns: Record<string, ReturnCase>;
  oversized: Record<string, OversizedTask>;
  parcels: Record<string, Parcel>;
  // —— 数字孪生（Phase 9）——
  /** 设备告警（最近的，最多保留 MAX_ALERTS 条，最早的已解除告警先清理） */
  alerts: Record<string, EquipmentAlert>;
  // —— 门店 AI 第二轮（决策记录 0021）——
  /** 订单量展望：AI 每小时（以及今天的实际偏离预测较多时）发布，推演和补货优先级都用它 */
  outlook?: DemandOutlook;
  /** 提醒（建议中枢）：发给谁、关于什么、是否紧急；最多保留 MAX_NUDGES 条 */
  nudges: Record<string, Nudge>;
  // —— 第二批（决策记录 0022）——
  /** 周 → 发布的排班；没有时按名单（学生按 shift，其他人整天在岗） */
  schedules?: Record<string, PublishedSchedule>;
  absences?: Record<string, Absence>;
  offers?: Record<string, ShiftOffer>;
  /** 设备报修单（预测性维护，决策记录 0022 · E1）；报修期间这台设备的暂存格位暂停放新框 */
  tickets?: Record<string, MaintenanceTicket>;
  pausedSlots?: Record<string, string>;
}

export type MaintenanceFault = 'COMPRESSOR' | 'DOOR_SEAL' | 'SENSOR' | 'DEFROST' | 'OTHER' | 'NONE';

export interface MaintenanceTicket {
  id: string;
  sensorId: string;
  /** 为什么报修：预测风险、读数卡住、开门回温变慢、人工 */
  reason: 'RISK' | 'STUCK' | 'WATCH' | 'MANUAL';
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  by: string;
  recId?: string;
  /** 报修期间暂停放新框的暂存格位 */
  slots: string[];
  /** 修好时记下的实际故障（预测性维护的训练标签；NONE 表示没发现问题） */
  fault?: MaintenanceFault;
  closedAt?: number;
}

/** 订单量展望：按取货时段开始的小时，每小时的预计订单数（已按今天的实际修正）与 80% 区间 */
export interface DemandOutlook {
  at: number;
  /** 模型族与版本 */
  model: string;
  /** 今天的修正系数：已经结束的时段里实际 ÷ 预测（向 1 收缩） */
  correction: number;
  observed: number;
  expected: number;
  hours: Array<{ t: number; mean: number; low: number; high: number }>;
  /** 每单的预计拣货用时（秒，按拣货时长模型；没有时推演用默认值） */
  perOrderSec?: number;
  /** 每单平均件数（补货优先级换算线上需求用） */
  unitsPerOrder?: number;
}

export type NudgeKind = 'REC' | 'ALERT' | 'TASK' | 'ESCALATION' | 'COLD' | 'OFFER' | 'NOTICE' | 'SAFETY' | 'ARRIVAL';

/** 一条提醒（决策记录 0021 · G1） */
export interface Nudge {
  id: string;
  /** 员工编号，或 console（门店管理员） */
  to: string;
  kind: NudgeKind;
  /** 关于什么：建议、告警、任务的编号（合并的提醒有多个） */
  refs: string[];
  /** 合并用的分组（同一货架段、同一台设备、同一个模块） */
  topic: string;
  params?: Record<string, string | number>;
  priority: number;
  urgent: boolean;
  createdAt: number;
  status: 'SENT' | 'READ' | 'DONE' | 'EXPIRED';
  readAt?: number;
  closedAt?: number;
}

/** 设备告警的种类（决策记录 0016）：温度过高、温度过低（热保温）、卸货门长时间打开、传感器离线 */
export type EquipmentAlertKind = 'TEMP_HIGH' | 'TEMP_LOW' | 'DOOR_OPEN' | 'SENSOR_OFFLINE';

/** 告警的影响：受影响的订单、框、后仓箱数和件数，以及同温区还有空位、可以转移过去的格位 */
export interface AlertImpact {
  orders: string[];
  totes: number;
  cases: number;
  units: number;
  moveTo: string[];
}

export interface EquipmentAlert {
  id: string;
  sensorId: string;
  kind: EquipmentAlertKind;
  severity: 'WARN' | 'ALARM';
  value: number;
  limit?: number;
  /** 越线（或门开着、离线）开始的时间，可能早于告警时间 */
  since: number;
  raisedAt: number;
  status: 'ACTIVE' | 'ACKED' | 'CLEARED';
  ackAt?: number;
  ackBy?: string;
  clearedAt?: number;
  /** 越线期间的极值（温度） */
  peak?: number;
  impact: AlertImpact;
}

export type { BinInfo, DisplayMethod, PlanogramEntry } from '@storewright/algorithms/planogram';
import type { BinInfo, PlanogramEntry } from '@storewright/algorithms/planogram';

export interface SlotInfo {
  code: string;
  tempZone: TempZone;
  capacity: number;
  area: 'PICKUP' | 'DELIVERY' | 'ANY';
  purpose: string;
  /** 所在的暂存区域（决策记录 0013） */
  areaId?: string;
  /** 从交付点（暂存点）走到这个格位的距离（米）；按到店时间放格位时用（决策记录 0023 · B5） */
  distM?: number;
}

/** 区域（决策记录 0013）：收货、后仓存储、暂存的每一块地面；种类和单位见 store-config 的 AREA_KINDS */
export interface AreaInfo {
  id: string;
  kind: string;
  group: 'RECEIVING' | 'STORAGE' | 'STAGING';
  floorId: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  tempZone: TempZone;
  capacity: number;
  unit: 'PALLET' | 'CASE' | 'TOTE' | 'ITEM' | 'PARCEL';
  alertAt: number;
  label?: string;
}

export type AssociateRole = 'PICK' | 'STAGE' | 'HANDOFF' | 'LEAD' | 'BACKROOM' | 'RESTOCK' | 'DELI';

export interface AssociateInfo {
  id: string;
  name: string;
  role: AssociateRole;
  /** 永久授权：可以执行 Exception（决策 X-01） */
  exceptionAuthorized: boolean;
  /** 学生兼职工（决策记录 0020）：不能按全职的时长工作，只在 shift 的时段里在岗；兼职（PART_TIME）每周工时上限较低；没有这一项的是全职 */
  employment?: 'STUDENT' | 'PART_TIME';
  /** 在岗时段（当地时间，当天的分钟数）；没有时整天都在岗 */
  shift?: { from: number; to: number };
  /** 入职日期（YYYY-MM-DD）：AI 只用它分熟练度组（新人 / 中等 / 熟手），不对个人建模（决策记录 0021） */
  hiredAt?: string;
  /** 还会做的岗位和技能（排班、补位、交叉培训用；决策记录 0022） */
  skills?: string[];
  /** 可上班时间（星期几：0 = 周一；当天的分钟数）；没有时按营业时间 */
  availability?: Array<{ day: number; from: number; to: number }>;
  /** 每周工时上限（低于雇佣类型的上限时） */
  maxWeeklyHours?: number;
}

/** 发布的周排班（决策记录 0022 · D1） */
export interface PublishedSchedule {
  /** 这一周的周一（YYYY-MM-DD） */
  week: string;
  shifts: ScheduledShift[];
  publishedAt: number;
  by: string;
}

export interface ScheduledShift {
  id: string;
  associateId: string;
  /** YYYY-MM-DD */
  date: string;
  /** 当天的分钟数 */
  from: number;
  to: number;
  role: AssociateRole;
}

/** 缺勤（带班负责人或控制台报告） */
export interface Absence {
  id: string;
  associateId: string;
  date: string;
  from?: number;
  to?: number;
  reason?: string;
  at: number;
  by: string;
}

/** 补班 / 延长 / 提前下班的邀请（决策记录 0022 · D2）：员工自己接受或拒绝 */
export interface ShiftOffer {
  id: string;
  associateId: string;
  kind: 'EXTRA' | 'EARLY_LEAVE';
  date: string;
  from: number;
  to: number;
  role: AssociateRole;
  /** 顶替谁（缺勤的人） */
  replaces?: string;
  recId?: string;
  /** 被拒后自动问下一个人（带班负责人同意过一次，决策记录 0026） */
  autoNext?: boolean;
  createdAt: number;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
  answeredAt?: number;
}

/** 门店的静态信息：随快照一起发给客户端 */
export interface StoreStatic {
  storeId: string;
  name: string;
  rules: {
    approachingMin: number;
    longWaitMin: number;
    /** 验证码连续错几次后提供人工核验（不锁定） */
    codeAttempts: number;
    /** 配送司机取消的准备期和等待阈值（分钟，没有时都是 10；决策记录 0014） */
    driverCancelLockMin?: number;
    driverCancelWaitMin?: number;
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
  /** 区域（决策记录 0013）；旧快照没有时界面不显示区域管理 */
  areas?: AreaInfo[];
  /** 卸货门 */
  docks?: Array<{ id: string; x: number; kind: 'DOCK' | 'GRADE'; reefer: boolean }>;
  /** 线上取货车位编号（配置里明确给出时）；顾客到店时只能用这些编号 */
  pickupBays?: string[];
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
    counters: { walks: 0, trips: 0, exceptions: 0, cases: 0, receipts: 0, repl: 0, counts: 0, recs: 0, checks: 0, notes: 0, mto: 0, returns: 0, asns: 0, alerts: 0, nudges: 0 },
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
    alerts: {},
    nudges: {},
  };
}
