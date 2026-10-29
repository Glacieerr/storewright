import type { VehiclePosition } from '@storewright/domain';
import type { InventoryStatus } from '@storewright/algorithms/replenish';
import type { AiMode, AiModule, OverrideReason, Recommendation, Resolution } from '@storewright/ai';
import type { Absence, AiHealth, AlertImpact, Incident, Recall, RecallStep, AsnLine, AssociateRole, CountReason, DemandOutlook, Discrepancy, EquipmentAlertKind, LineFlag, MaintenanceFault, MaintenanceTicket, NotFoundReason, Nudge, OrderInfo, RecOutcome, ReplReason, ReplWhy, ReturnDisposition, ScheduledShift, ShelfFound, ShiftOffer, ToteInfo, WalkCheck, WalkEstimate, WalkInfo, ShelfCheckReason } from './types';

/**
 * 实时作业事件（名称沿用工作流设计第 6 节的事件清单）。
 * 事件是不可变的事实；状态由事件依次应用得到（见 apply.ts）。
 */
export interface OpsEventPayloads {
  // 订单
  OrderCreated: { order: OrderInfo; codeHash: string };
  OrderLocked: { orderId: string };
  OrderCancelled: { orderId: string; reason: string };
  // 分配
  ToteAssignmentsCreated: { orderId: string; totes: ToteInfo[]; oversized: number };
  PickWalkCreated: { walk: WalkInfo };
  // 标签
  LabelPrinted: { labelId: string; toteId: string; version: number };
  LabelReprinted: { labelId: string };
  LabelVoided: { labelId: string };
  LabelBound: { labelId: string; walkId: string };
  // 拣货
  PickWalkClaimed: { walkId: string };
  PickWalkUnclaimed: { walkId: string };
  ItemPicked: { walkId: string; toteId: string; lineId: string; qty: number; locationId: string };
  ItemNotFound: { walkId: string; toteId: string; lineId: string; qty: number; resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT'; locationId: string; reason?: NotFoundReason };
  SubstitutionPicked: { walkId: string; toteId: string; lineId: string; qty: number; itemName: string; gtin: string; rank?: number; model?: string };
  ColdChainTimerStarted: { walkId: string };
  ColdChainAlert: { walkId: string; elapsedSec: number; limitSec: number };
  PickWalkCompleted: { walkId: string; durationSec: number };
  // Exception（决策 X-01～X-04）
  ExceptionCreated: { exceptionId: string; orderId: string; lineId: string; walkId: string; itemId?: string; qty?: number };
  ExceptionAssigned: { exceptionId: string };
  ExceptionItemFound: { exceptionId: string; caseId: string; units: number; binEmpty: boolean };
  /** binCode：只盘找过的这个库位，不把整个商品标为可疑（决策记录 0026） */
  ExceptionNotFound: { exceptionId: string; binCode?: string };
  /** 订单已交付或已取消：后仓取出的商品放回货架（决策记录 0025） */
  ExceptionItemsReturned: { exceptionId: string; itemId: string; units: number };
  /** 后仓补取放回队列（决策记录 0026） */
  ExceptionReleased: { exceptionId: string };
  ExceptionDeliveredToStaging: { exceptionId: string; toteId: string; slotCode: string };
  ExceptionVoided: { exceptionId: string };
  // 暂存
  ToteStaged: { toteId: string; slotCode: string };
  ToteMoved: { toteId: string; from: string; to: string };
  OrderStaged: { orderId: string };
  CancelledOrderDetected: { toteId: string; orderId: string };
  ToteSentToRecovery: { toteId: string };
  // 交付
  EtaUpdated: { orderId?: string; tripId?: string; etaAt: number };
  CustomerArrived: { orderId?: string; tripId?: string; bay?: string; vehicle?: string };
  PrepStarted: { key: string; kind: 'ORDER' | 'TRIP'; orderIds: string[] };
  PrepJoined: { key: string };
  ToteScannedForPrep: { key: string; toteId: string };
  ReadyToLoad: { key: string };
  CodeVerified: { key: string; method: 'CODE' | 'MANUAL' };
  CodeFailed: { key: string; attempt: number; manualRequired: boolean };
  AgeVerified: { key: string };
  VehiclePlacementRecorded: { tripId: string; orderId: string; position: VehiclePosition };
  OrderHandedOff: { orderId: string; waitSec: number; ageItemsRemoved: boolean; recallRemoved?: boolean };
  /** 退出交付准备（决策记录 0026）：取出的框留在「待暂存」里放回 */
  PrepAbandoned: { key: string; orderIds: string[]; pulled: string[] };
  // 行程
  TripProposed: { tripId: string; orderIds: string[]; placements: Record<string, VehiclePosition> };
  TripAccepted: { tripId: string; driverName: string; codeHash: string };
  TripCompleted: { tripId: string };
  /** 司机取消或门店改派：行程回到待接单；已取出的框放回暂存区；顾客收到延后通知（决策记录 0014） */
  TripDriverCancelled: {
    tripId: string;
    by: 'DRIVER' | 'STORE';
    reason: 'BEFORE_PREP' | 'WAITED_TOO_LONG' | 'NO_SHOW';
    driverName?: string;
    waitedMin?: number;
    sessionOwner?: string;
    returns: Array<{ toteId: string; slotCode: string }>;
    atRisk: boolean;
  };
  // 后仓库存（决策 I-01～I-05）
  InventoryLoaded: { cases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number; units: number; binCode: string }> };
  AsnReceived: { receiptId: string; supplier: string; expected: AsnLine[]; expectedAt?: number };
  AsnEtaUpdated: { receiptId: string; expectedAt: number; previous?: number };
  TruckArrived: { receiptId: string };
  CasesReceived: { receiptId: string; itemId: string; gtin: string; name: string; packQty: number; caseIds: string[]; damaged: boolean; lot?: string; expiry?: string };
  ReceiptClosed: { receiptId: string; discrepancies: Discrepancy[] };
  CasePutAway: { caseId: string; binCode: string };
  CaseStatusChanged: { caseId: string; status: InventoryStatus; binCode?: string };
  CycleCountCreated: { countId: string; binCode: string; itemId?: string; reason: CountReason };
  CycleCountClaimed: { countId: string };
  /** 盘点放回队列（决策记录 0026） */
  CycleCountReleased: { countId: string };
  CycleCountCompleted: { countId: string; binCode: string; results: Array<{ itemId: string; expected: number; counted: number }>; lostCaseIds: string[]; foundCases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number }> };
  // 货架存量与补货（决策 R-01～R-05）
  SalesRecorded: { lines: Array<{ itemId: string; locationId: string; qty: number }> };
  SensorReading: { locationId: string; itemId: string; sensor: 'tof' | 'weight'; units: number; confidence: number; anomaly: boolean };
  /** fromCaseId：补取时已经拿在手上的那一箱（决策记录 0026） */
  ReplenishmentTaskCreated: { taskId: string; locationId: string; itemId: string; area: string; reason: ReplReason; suggestedUnits: number; priority: number; dueAt?: number; risk?: number; why?: ReplWhy; fromCaseId?: string };
  ReplenishmentClaimed: { taskIds: string[] };
  ReplenishmentReleased: { taskIds: string[] };
  ReplenishmentCompleted: { taskId: string; locationId: string; itemId: string; caseId: string; units: number };
  ReplenishmentCancelled: { taskId: string; reason: 'NO_STOCK' | 'NOT_FOUND'; binCode?: string };
  ShelfCheckRequested: { checkId: string; itemId: string; locationId: string; reason: ShelfCheckReason; recId?: string; near?: string[]; lot?: string; pct?: number; expected?: number };
  /** 货架上的批次任务做完了（决策记录 0026）：贴了几件折扣签、下架 / 捐赠了几件、退货放回了几件 */
  LotTaskDone: { checkId: string; itemId: string; kind: 'MARKDOWN' | 'PULL' | 'DONATE' | 'RETURN'; lot?: string; units: number };
  /** 员工在货架上数过的件数（扫描货位后输入），作为新的确认值；walkId：拣货时顺路核对 */
  ShelfCounted: { itemId: string; locationId: string; units: number; previousEst: number; checkId?: string; walkId?: string; found?: ShelfFound };
  // AI 建议与运行模式（决策记录 0010）
  RecommendationIssued: { rec: Recommendation };
  RecommendationResolved: { recId: string; resolution: Resolution; reason?: OverrideReason; note?: string };
  AiModeSet: { module: AiModule; mode: AiMode; locked: boolean; auto?: { hitRate: number; n: number } };
  /** 效果追踪（决策记录 0022 · F4） */
  OutcomeRecorded: { recId: string; module: AiModule; outcome: RecOutcome };
  /** AI 运行监控（决策记录 0022 · H3） */
  AiHealthPublished: { health: AiHealth };
  // 冷链与分框（决策记录 0023 · B3、B7）
  PickWalkSplit: { walkId: string; walks: WalkInfo[]; recId?: string };
  WalkHandedOver: { walkId: string; newWalk: WalkInfo; totes: ToteInfo[]; emptied: string[]; recId?: string };
  TotesAdded: { orderId: string; walkId: string; reason: 'OVERFLOW'; totes: ToteInfo[]; moves: Array<{ lineId: string; from: string; to: string; qty: number }> };
  ColdRiskFlagged: { walkId: string; overSec: number; remainingLines: number };
  ToteFactorsUpdated: { factors: Record<string, number> };
  // 时段产能（决策记录 0023 · B6）
  SlotClosed: { slotStart: number; recId?: string };
  SlotReopened: { slotStart: number };
  SopAcknowledged: { sopId: string; correct?: number; total?: number };
  NextTaskFeedback: { kind: string; ref: string; taken: boolean };
  // 门店助手的问答（决策记录 0024 · F2）
  AnswerLogged: { answerId: string; question: string; tools: string[]; source: string; by: string };
  AnswerRated: { answerId: string; helpful: boolean };
  // 现场应对（决策记录 0024 · C5、E4、E5）
  RecallOpened: { recall: Recall };
  RecallStepMarked: { recallId: string; step: RecallStep; done: boolean };
  RecallClosed: { recallId: string };
  IncidentStarted: { incident: Incident };
  IncidentStepChecked: { incidentId: string; stepId: string };
  IncidentEnded: { incidentId: string };
  FoodSafetyLogConfirmed: { date: string; note?: string };
  // 临期与损耗（决策记录 0024 · C4）
  MarkdownApplied: { itemId: string; lot: string; pct: number; recId?: string };
  LotDonated: { itemId: string; lot: string; units: number; recId?: string };
  /** 替代品的真实标签（决策记录 0023 · B4） */
  SubstitutionRated: { orderId: string; lineId: string; accepted: boolean; rank?: number; model?: string; gtin?: string };
  /** 采纳或自动执行「使用 AI 修正的到达时间」 */
  AiEtaApplied: { orderId: string; etaAt: number; recId: string };
  // 岗位调动与锁定（人员调配）
  /** minutes：临时调动多久（到时自动调回）；revert：临时调动到时自动回原岗位 */
  /** 门店设置改了（决策记录 0026） */
  StoreSettingsChanged: { requireScan?: boolean; prepGate?: 'ANY' | 'ARRIVED' };
  AssociateRoleChanged: { associateId: string; role: AssociateRole; from: AssociateRole; recId?: string; minutes?: number; revert?: boolean };
  /** 手上有任务：做完再调过去（决策记录 0026） */
  AssociateMoveQueued: { associateId: string; role: AssociateRole; minutes?: number; recId?: string };
  AssociateMoveCancelled: { associateId: string };
  AssociateLockChanged: { associateId: string; locked: boolean };
  // 门店经验库
  NoteAdded: { noteId: string; text: string; tags: string[]; itemId?: string; locationId?: string };
  NoteRemoved: { noteId: string };
  // 熟食现做（Phase 6）
  MtoTicketCreated: { ticketId: string; orderId: string; menuId: string; name: string; qty: number; hot: boolean; holdMin: number; startAt: number; dueAt: number };
  MtoStartAdjusted: { ticketId: string; startAt: number; recId: string };
  MtoStarted: { ticketId: string };
  MtoCompleted: { ticketId: string; slotCode?: string; discardAt: number };
  MtoPulled: { ticketId: string };
  MtoDiscarded: { ticketId: string; reason: 'HOLD_EXPIRED' | 'MANUAL' | 'ORDER_CANCELLED' };
  // 退货（Phase 6）
  ReturnStarted: { returnId: string; orderId?: string; kind: 'CUSTOMER' | 'DELIVERY' };
  ReturnLineRemoved: { returnId: string; index: number };
  ReturnItemScanned: { returnId: string; itemId: string; gtin: string; name: string; qty: number; condition: 'SEALED' | 'OPENED' | 'DAMAGED'; inOrder: boolean; tempZone: string; unitPrice: number; chemical?: boolean; sealedOnly?: boolean };
  ReturnDispositionSet: { returnId: string; index: number; disposition: ReturnDisposition; aiSuggested?: ReturnDisposition };
  ReturnCompleted: { returnId: string; refundValue: number; restocked: Array<{ itemId: string; qty: number }> };
  // 大件（Phase 6）
  OversizedPiecesCreated: { orderId: string; pieces: Array<{ pieceId: string; lineId: string; itemId: string; name: string; gtin: string; index: number; count: number; weightKg: number; teamLift: boolean }> };
  OversizedClaimed: { orderId: string; pieceIds: string[] };
  OversizedReleased: { pieceIds: string[] };
  OversizedLabeled: { pieceId: string; labelId: string };
  OversizedLabelPrinted: { pieceId: string };
  OversizedStaged: { pieceId: string; area: string };
  // 包裹中转（Phase 6）
  ParcelAsnReceived: { asnId: string; carrier: string; expectedBy: number; parcels: Array<{ parcelId: string; tripRef: string; sizeClass: 'S' | 'M' | 'L'; weightKg: number }> };
  ParcelInducted: { parcelId: string };
  ParcelOver: { parcelId: string };
  ParcelResolved: { parcelId: string; action: 'RETURN' | 'HOLD' };
  ParcelStaged: { parcelId: string; slotCode: string };
  ParcelDamaged: { parcelId: string };
  ParcelShort: { parcelId: string };
  ParcelsHandedOff: { tripRef: string; parcelIds: string[] };
  // 设备告警（数字孪生，决策记录 0016）
  EquipmentAlertRaised: { alertId: string; sensorId: string; kind: EquipmentAlertKind; severity: 'WARN' | 'ALARM'; value: number; limit?: number; since: number; impact: AlertImpact };
  EquipmentAlertAcknowledged: { alertId: string };
  EquipmentAlertCleared: { alertId: string; durationSec: number; peak?: number };
  // 门店 AI 第二轮（决策记录 0021）
  PickWalkEstimated: { walkId: string; estimate: WalkEstimate };
  DemandOutlookPublished: { outlook: DemandOutlook };
  WalkLinesFlagged: { walkId: string; flags: Record<string, LineFlag> };
  /** 拣货前的缺货预判：已有的补货任务提前（截止时间、排到最前） */
  ReplenishmentExpedited: { taskId: string; dueAt: number };
  /** 运营预警采纳后执行的动作 */
  OrdersExpedited: { orderIds: string[]; recId: string };
  FrozenDeferred: { orderIds: string[]; until: number; recId: string };
  DelayNoticeSent: { orderIds: string[]; minutes: number; recId: string };
  NudgesSent: { nudges: Nudge[] };
  NudgesClosed: { ids: string[]; status: 'DONE' | 'EXPIRED' };
  NudgeRead: { nudgeId: string };
  // 第二批（决策记录 0022）
  SchedulePublished: { week: string; shifts: ScheduledShift[] };
  AbsenceReported: { absence: Absence };
  /** AI 的补位建议被采纳后发出邀请；员工接受后排班随之改变 */
  ShiftOffered: { offer: Omit<ShiftOffer, 'status' | 'createdAt' | 'answeredAt'> };
  ShiftOfferAnswered: { offerId: string; accept: boolean };
  MaintenanceRequested: { ticket: Omit<MaintenanceTicket, 'status' | 'openedAt' | 'by'> };
  MaintenanceClosed: { ticketId: string; fault: MaintenanceFault };
  /** 顺路核对（决策记录 0022 · C3） */
  WalkCheckAdded: { walkId: string; check: Omit<WalkCheck, 'status' | 'units'>; recId?: string };
  WalkCheckSkipped: { walkId: string; itemId: string };
}

export type OpsEventType = keyof OpsEventPayloads;

export interface OpsEvent<K extends OpsEventType = OpsEventType> {
  /** 门店内单调递增的序号，从 1 开始 */
  seq: number;
  /** 服务端时间（毫秒） */
  at: number;
  type: K;
  payload: OpsEventPayloads[K];
  /** 操作者：员工 ID，或 system / console / customer / driver */
  actor: string;
}

export type AnyOpsEvent = { [K in OpsEventType]: OpsEvent<K> }[OpsEventType];

/** 还没有分配序号的事件（decide 的输出） */
export type PendingEvent = { [K in OpsEventType]: { type: K; payload: OpsEventPayloads[K] } }[OpsEventType];

export function ev<K extends OpsEventType>(type: K, payload: OpsEventPayloads[K]): PendingEvent {
  return { type, payload } as PendingEvent;
}
