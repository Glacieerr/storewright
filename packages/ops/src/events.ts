import type { VehiclePosition } from '@storewright/domain';
import type { InventoryStatus } from '@storewright/algorithms/replenish';
import type { AiMode, AiModule, OverrideReason, Recommendation, Resolution } from '@storewright/ai';
import type { AsnLine, AssociateRole, CountReason, Discrepancy, OrderInfo, ReplReason, ReturnDisposition, ToteInfo, WalkInfo } from './types';

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
  ItemNotFound: { walkId: string; toteId: string; lineId: string; qty: number; resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT'; locationId: string };
  SubstitutionPicked: { walkId: string; toteId: string; lineId: string; qty: number; itemName: string; gtin: string; rank?: number; model?: string };
  ColdChainTimerStarted: { walkId: string };
  ColdChainAlert: { walkId: string; elapsedSec: number; limitSec: number };
  PickWalkCompleted: { walkId: string; durationSec: number };
  // Exception（决策 X-01～X-04）
  ExceptionCreated: { exceptionId: string; orderId: string; lineId: string; walkId: string; itemId?: string; qty?: number };
  ExceptionAssigned: { exceptionId: string };
  ExceptionItemFound: { exceptionId: string; caseId: string; units: number; binEmpty: boolean };
  ExceptionNotFound: { exceptionId: string };
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
  OrderHandedOff: { orderId: string; waitSec: number; ageItemsRemoved: boolean };
  // 行程
  TripProposed: { tripId: string; orderIds: string[]; placements: Record<string, VehiclePosition> };
  TripAccepted: { tripId: string; driverName: string; codeHash: string };
  TripCompleted: { tripId: string };
  // 后仓库存（决策 I-01～I-05）
  InventoryLoaded: { cases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number; units: number; binCode: string }> };
  AsnReceived: { receiptId: string; supplier: string; expected: AsnLine[] };
  TruckArrived: { receiptId: string };
  CasesReceived: { receiptId: string; itemId: string; gtin: string; name: string; packQty: number; caseIds: string[]; damaged: boolean };
  ReceiptClosed: { receiptId: string; discrepancies: Discrepancy[] };
  CasePutAway: { caseId: string; binCode: string };
  CaseStatusChanged: { caseId: string; status: InventoryStatus; binCode?: string };
  CycleCountCreated: { countId: string; binCode: string; itemId?: string; reason: CountReason };
  CycleCountClaimed: { countId: string };
  CycleCountCompleted: { countId: string; binCode: string; results: Array<{ itemId: string; expected: number; counted: number }>; lostCaseIds: string[]; foundCases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number }> };
  // 货架存量与补货（决策 R-01～R-05）
  SalesRecorded: { lines: Array<{ itemId: string; locationId: string; qty: number }> };
  SensorReading: { locationId: string; itemId: string; sensor: 'tof' | 'weight'; units: number; confidence: number; anomaly: boolean };
  ReplenishmentTaskCreated: { taskId: string; locationId: string; itemId: string; area: string; reason: ReplReason; suggestedUnits: number; priority: number };
  ReplenishmentClaimed: { taskIds: string[] };
  ReplenishmentReleased: { taskIds: string[] };
  ReplenishmentCompleted: { taskId: string; locationId: string; itemId: string; caseId: string; units: number };
  ReplenishmentCancelled: { taskId: string; reason: 'NO_STOCK' | 'NOT_FOUND' };
  ShelfCheckRequested: { checkId: string; itemId: string; locationId: string; reason: 'AI' | 'MANUAL'; recId?: string };
  /** 员工在货架上数过的件数（扫描货位后输入），作为新的确认值 */
  ShelfCounted: { itemId: string; locationId: string; units: number; previousEst: number; checkId?: string };
  // AI 建议与运行模式（决策记录 0010）
  RecommendationIssued: { rec: Recommendation };
  RecommendationResolved: { recId: string; resolution: Resolution; reason?: OverrideReason; note?: string };
  AiModeSet: { module: AiModule; mode: AiMode; locked: boolean };
  /** 采纳或自动执行「使用 AI 修正的到达时间」 */
  AiEtaApplied: { orderId: string; etaAt: number; recId: string };
  // 岗位调动与锁定（人员调配）
  AssociateRoleChanged: { associateId: string; role: AssociateRole; from: AssociateRole; recId?: string };
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
  ReturnItemScanned: { returnId: string; itemId: string; gtin: string; name: string; qty: number; condition: 'SEALED' | 'OPENED' | 'DAMAGED'; inOrder: boolean; tempZone: string; unitPrice: number; chemical?: boolean; sealedOnly?: boolean };
  ReturnDispositionSet: { returnId: string; index: number; disposition: ReturnDisposition; aiSuggested?: ReturnDisposition };
  ReturnCompleted: { returnId: string; refundValue: number; restocked: Array<{ itemId: string; qty: number }> };
  // 大件（Phase 6）
  OversizedPiecesCreated: { orderId: string; pieces: Array<{ pieceId: string; lineId: string; itemId: string; name: string; gtin: string; index: number; count: number; weightKg: number; teamLift: boolean }> };
  OversizedClaimed: { orderId: string; pieceIds: string[] };
  OversizedReleased: { pieceIds: string[] };
  OversizedLabeled: { pieceId: string; labelId: string };
  OversizedStaged: { pieceId: string; area: string };
  // 包裹中转（Phase 6）
  ParcelAsnReceived: { asnId: string; carrier: string; expectedBy: number; parcels: Array<{ parcelId: string; tripRef: string; sizeClass: 'S' | 'M' | 'L'; weightKg: number }> };
  ParcelInducted: { parcelId: string };
  ParcelOver: { parcelId: string };
  ParcelStaged: { parcelId: string; slotCode: string };
  ParcelDamaged: { parcelId: string };
  ParcelShort: { parcelId: string };
  ParcelsHandedOff: { tripRef: string; parcelIds: string[] };
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
