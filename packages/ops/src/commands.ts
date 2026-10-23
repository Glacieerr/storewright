import type { VehiclePosition } from '@storewright/domain';
import type { InventoryStatus } from '@storewright/algorithms/replenish';
import type { AiMode, AiModule, OverrideReason, RecommendationDraft } from '@storewright/ai';
import type { AsnLine, AssociateRole, OrderInfo, ReturnDisposition } from './types';

/**
 * 命令：设备或排程器想做的事。服务端用 decide() 校验后产生事件，或者拒绝并给出原因。
 * 时间（at）和操作者（actor）由服务端写入信封，客户端提交的值不可信。
 */
export type OpsCommand =
  // 订单接入（订单平台或演示控制台）
  | { type: 'CreateOrder'; order: OrderInfo; codeHash: string }
  | { type: 'CancelOrder'; orderId: string; reason: string }
  // 排程：锁单、生成拣货批次、冷链提醒、组合行程
  | { type: 'Tick'; release: boolean }
  | { type: 'LockOrder'; orderId: string }
  | { type: 'ReleaseWalks' }
  // 拣货
  | { type: 'ClaimWalk'; walkId: string }
  | { type: 'UnclaimWalk'; walkId: string }
  | { type: 'BindLabel'; walkId: string; labelId: string }
  | { type: 'PickItem'; walkId: string; toteId: string; lineId: string; qty: number }
  | {
      type: 'ReportNotFound';
      walkId: string;
      toteId: string;
      lineId: string;
      qty: number;
      resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT';
      /** rank / model：选的是 AI 推荐的第几名（采纳率统计用） */
      substitute?: { name: string; gtin: string; rank?: number; model?: string };
    }
  | { type: 'CompleteWalk'; walkId: string }
  // 标签
  | { type: 'ReprintLabel'; toteId: string }
  // 暂存
  | { type: 'StageTote'; labelId: string; slotCode: string }
  | { type: 'RecoverTote'; labelId: string }
  // 顾客与司机
  | { type: 'UpdateEta'; orderId?: string; tripId?: string; etaAt: number }
  | { type: 'CheckIn'; orderId?: string; tripId?: string; bay?: string; vehicle?: string }
  | { type: 'AcceptTrip'; tripId: string; driverName: string; codeHash: string }
  /** 司机取消接单（只在允许的时间窗口内，决策记录 0014） */
  | { type: 'CancelTripDriver'; tripId: string }
  /** 司机没来：带班负责人或控制台改派，行程重新派单 */
  | { type: 'RedispatchTrip'; tripId: string }
  // 交付
  | { type: 'StartPrep'; key: string }
  | { type: 'JoinPrep'; key: string }
  | { type: 'ScanPrepTote'; key: string; labelId: string }
  | { type: 'VerifyCode'; key: string; code: string }
  | { type: 'VerifyManually'; key: string }
  | { type: 'VerifyAge'; key: string }
  | { type: 'RecordPlacement'; tripId: string; orderId: string; position: VehiclePosition }
  | { type: 'CompleteHandoff'; key: string; removeAgeItems?: boolean }
  // 后仓补取（决策 X-01～X-04）
  | { type: 'ClaimException'; exceptionId: string }
  | { type: 'ExceptionFound'; exceptionId: string; caseId: string; binEmpty: boolean }
  | { type: 'ExceptionMissing'; exceptionId: string }
  | { type: 'DeliverException'; exceptionId: string; slotCode: string }
  // 收货与上架（决策 I-01～I-05）
  | { type: 'CreateAsn'; supplier: string; lines: AsnLine[] }
  | { type: 'ArriveTruck'; receiptId: string }
  | { type: 'ReceiveCases'; receiptId: string; gtin: string; cases: number; damaged?: boolean }
  | { type: 'CloseReceipt'; receiptId: string }
  | { type: 'PutAwayCase'; caseId: string; binCode: string }
  | { type: 'ChangeCaseStatus'; caseId: string; status: InventoryStatus; binCode?: string }
  // 盘点（决策 I-04）
  | { type: 'CreateCount'; binCode: string; itemId?: string }
  | { type: 'ClaimCount'; countId: string }
  | { type: 'CompleteCount'; countId: string; results: Array<{ itemId: string; counted: number }> }
  // 货架存量与补货（决策 R-01～R-05）
  | { type: 'RecordSales'; lines: Array<{ itemId: string; qty: number }> }
  | { type: 'RecordSensor'; locationId: string; sensor: 'tof' | 'weight'; units: number; confidence: number; itemId?: string }
  | { type: 'RequestReplenishment'; itemId: string }
  | { type: 'ClaimReplenishment'; taskIds: string[] }
  | { type: 'ReleaseReplenishment'; taskIds: string[] }
  | { type: 'CompleteReplenishment'; taskId: string; caseId: string; locationId: string; units: number }
  | { type: 'CancelReplenishment'; taskId: string }
  // 核对货架：数一数货架上实际有几件（可以对应一个核对任务）
  | { type: 'ConfirmShelf'; itemId: string; units: number; checkId?: string }
  // AI 建议（决策记录 0010）：由服务端的 AI 服务发出；带班负责人或控制台处理
  | { type: 'IssueRecommendation'; draft: RecommendationDraft }
  | { type: 'AcceptRecommendation'; recId: string }
  | { type: 'OverrideRecommendation'; recId: string; reason: OverrideReason; note?: string }
  | { type: 'DismissRecommendation'; recId: string }
  | { type: 'SetAiMode'; module: AiModule; mode: AiMode; locked?: boolean }
  // 岗位调动与锁定（带班负责人或控制台）
  | { type: 'ChangeRole'; associateId: string; role: AssociateRole }
  | { type: 'LockAssociate'; associateId: string; locked: boolean }
  // 门店经验库：任何员工可以添加；作者、带班负责人或控制台可以删除
  | { type: 'AddNote'; text: string; itemId?: string; locationId?: string; tags?: string[] }
  | { type: 'RemoveNote'; noteId: string }
  // 熟食现做（Phase 6）
  | { type: 'CreateMtoTicket'; orderId: string; menuId: string; qty: number }
  | { type: 'StartMto'; ticketId: string }
  | { type: 'CompleteMto'; ticketId: string; slotCode?: string }
  | { type: 'PullMto'; ticketId: string }
  | { type: 'DiscardMto'; ticketId: string }
  // 退货（Phase 6）
  | { type: 'StartReturn'; orderId?: string; kind: 'CUSTOMER' | 'DELIVERY' }
  | { type: 'ScanReturnItem'; returnId: string; code: string; qty: number; condition: 'SEALED' | 'OPENED' | 'DAMAGED' }
  | { type: 'SetReturnDisposition'; returnId: string; index: number; disposition: ReturnDisposition; aiSuggested?: ReturnDisposition }
  | { type: 'CompleteReturn'; returnId: string }
  // 大件（Phase 6）：领取时输入这一趟能装载的件数
  | { type: 'ClaimOversized'; orderId: string; maxPieces: number; pieceIds?: string[] }
  | { type: 'ReleaseOversized'; pieceIds: string[] }
  | { type: 'ScanOversized'; pieceId: string; code: string }
  | { type: 'StageOversized'; pieceId: string; area: string }
  // 包裹中转（Phase 6）
  | { type: 'CreateParcelAsn'; carrier: string; parcels: Array<{ parcelId: string; tripRef: string; sizeClass: 'S' | 'M' | 'L'; weightKg: number }>; expectedInMin?: number }
  | { type: 'InductParcel'; code: string }
  | { type: 'StageParcel'; parcelId: string; slotCode: string }
  | { type: 'ReportParcelDamaged'; parcelId: string }
  | { type: 'HandOffParcels'; tripRef: string }
  // 期初库存（建店时由服务端载入一次）
  | { type: 'LoadInventory'; cases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number; units: number; binCode: string }> };

export type OpsCommandType = OpsCommand['type'];

export interface CommandEnvelope {
  cmd: OpsCommand;
  actor: string;
  at: number;
}

/** 拒绝原因：代码 + 参数，界面按语言显示文字 */
export type RejectCode =
  | 'ORDER_EXISTS'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'ORDER_COMPLETED'
  | 'ORDER_NOT_CREATED'
  | 'INVALID_ORDER'
  | 'NOTHING_TO_RELEASE'
  | 'WALK_NOT_FOUND'
  | 'WALK_CLAIMED'
  | 'WALK_NOT_YOURS'
  | 'WALK_COMPLETED'
  | 'WALK_UNFINISHED'
  | 'WALK_STARTED'
  | 'ASSOCIATE_BUSY'
  | 'LABEL_NOT_FOUND'
  | 'LABEL_VOIDED'
  | 'LABEL_NOT_IN_WALK'
  | 'TOTE_NOT_FOUND'
  | 'TOTE_NOT_BOUND'
  | 'TOTE_NOT_PICKED'
  | 'TOTE_NOT_STAGED'
  | 'LINE_NOT_IN_TOTE'
  | 'QTY_INVALID'
  | 'SUBSTITUTION_NOT_ALLOWED'
  | 'SUBSTITUTE_REQUIRED'
  | 'SLOT_NOT_FOUND'
  | 'SLOT_ZONE_MISMATCH'
  | 'SLOT_FULL'
  | 'SAME_SLOT'
  | 'BAY_NOT_FOUND'
  | 'NOT_CANCELLED'
  | 'TRIP_NOT_FOUND'
  | 'TRIP_ACCEPTED'
  | 'TRIP_NOT_ACCEPTED'
  | 'CANCEL_LOCKED'
  | 'CANCEL_WAIT'
  | 'NOT_NO_SHOW'
  | 'ORDER_IN_TRIP'
  | 'NOT_STAGED'
  | 'PREP_LOCKED'
  | 'NOT_IN_SESSION'
  | 'SESSION_NOT_FOUND'
  | 'TOTE_NOT_IN_SESSION'
  | 'TOTE_ALREADY_SCANNED'
  | 'NOT_READY'
  | 'NOT_ARRIVED'
  | 'ALREADY_VERIFIED'
  | 'NO_CODE'
  | 'MANUAL_NOT_ALLOWED'
  | 'CODE_WRONG'
  | 'NOT_VERIFIED'
  | 'AGE_CHECK_REQUIRED'
  | 'ALREADY_DONE'
  | 'NOT_AUTHORIZED'
  | 'EXCEPTION_NOT_FOUND'
  | 'EXCEPTION_TAKEN'
  | 'EXCEPTION_NOT_YOURS'
  | 'EXCEPTION_STATE'
  | 'CASE_NOT_FOUND'
  | 'CASE_WRONG_ITEM'
  | 'CASE_EMPTY'
  | 'CASE_NOT_STORED'
  | 'CASE_STATUS'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_CLOSED'
  | 'RECEIPT_NOT_ARRIVED'
  | 'ITEM_NOT_FOUND'
  | 'BIN_NOT_FOUND'
  | 'BIN_ZONE'
  | 'BIN_ISOLATION'
  | 'BIN_STATUS'
  | 'BIN_FULL'
  | 'LOCATION_NOT_FOUND'
  | 'LOCATION_MISMATCH'
  | 'TASK_NOT_FOUND'
  | 'TASK_TAKEN'
  | 'TASK_NOT_YOURS'
  | 'TASK_DONE'
  | 'TASK_EXISTS'
  | 'NO_BACKROOM_STOCK'
  | 'COUNT_NOT_FOUND'
  | 'COUNT_TAKEN'
  | 'COUNT_DONE'
  | 'CHECK_NOT_FOUND'
  | 'CHECK_DONE'
  | 'REC_NOT_FOUND'
  | 'REC_CLOSED'
  | 'MODULE_UNKNOWN'
  | 'MODE_UNKNOWN'
  | 'MODE_LOCKED'
  | 'REASON_UNKNOWN'
  | 'ACTION_UNKNOWN'
  | 'ACTION_STALE'
  | 'INVALID_RECOMMENDATION'
  | 'ASSOCIATE_NOT_FOUND'
  | 'ROLE_NOT_ALLOWED'
  | 'SAME_ROLE'
  | 'NOTE_EMPTY'
  | 'NOTE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MENU_NOT_FOUND'
  | 'TICKET_NOT_FOUND'
  | 'TICKET_STATE'
  | 'RETURN_NOT_FOUND'
  | 'RETURN_CLOSED'
  | 'RETURN_INCOMPLETE'
  | 'DISPOSITION_NOT_ALLOWED'
  | 'PIECE_NOT_FOUND'
  | 'PIECE_STATE'
  | 'PIECE_NOT_YOURS'
  | 'NOTHING_TO_CLAIM'
  | 'PARCEL_NOT_FOUND'
  | 'PARCEL_STATE'
  | 'TRIP_NOT_READY'

export interface Rejection {
  code: RejectCode;
  params?: Record<string, string | number>;
}
