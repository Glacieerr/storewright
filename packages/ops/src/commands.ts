import type { VehiclePosition } from '@storewright/domain';
import type { InventoryStatus } from '@storewright/algorithms/replenish';
import type { AiMode, AiModule, OverrideReason, RecommendationDraft } from '@storewright/ai';
import type { AiHealth, AlertImpact, AsnLine, IncidentKind, RecallStep, AssociateRole, DemandOutlook, EquipmentAlertKind, LineFlag, MaintenanceFault, NotFoundReason, Nudge, OrderInfo, RecOutcome, ReturnDisposition, ScheduledShift, ShelfFound, WalkEstimate } from './types';

/**
 * 命令：设备或排程器想做的事。服务端用 decide() 校验后产生事件，或者拒绝并给出原因。
 * 时间（at）和操作者（actor）由服务端写入信封，客户端提交的值不可信。
 */
type BaseCommand =
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
  /** gtin：扫到的商品条码（核对是不是这件商品）；labelId：这个框第一次放东西时扫的框标签（顺便绑定，决策记录 0026） */
  | { type: 'PickItem'; walkId: string; toteId: string; lineId: string; qty: number; gtin?: string; labelId?: string }
  | {
      type: 'ReportNotFound';
      walkId: string;
      toteId: string;
      lineId: string;
      qty: number;
      resolution: 'SUBSTITUTED' | 'EXCEPTION' | 'SHORT';
      /** rank / model：选的是 AI 推荐的第几名（采纳率统计用） */
      substitute?: { name: string; gtin: string; rank?: number; model?: string };
      /** 找不到的原因（决策记录 0022 · C1）：货架真相模型的标签 */
      reason?: NotFoundReason;
      /** 替代品放进一个还没绑定的框时扫的框标签 */
      labelId?: string;
    }
  | { type: 'CompleteWalk'; walkId: string }
  // 标签
  | { type: 'ReprintLabel'; toteId: string }
  // 暂存
  | { type: 'StageTote'; labelId: string; slotCode: string }
  /** area：扫到的回收专区标签（门店要求扫码时必须扫，决策记录 0026） */
  | { type: 'RecoverTote'; labelId: string; area?: string }
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
  /** removeRecalled：已经从框里取出召回商品（决策记录 0026） */
  | { type: 'CompleteHandoff'; key: string; removeAgeItems?: boolean; removeRecalled?: boolean }
  /** 退出交付准备（决策记录 0026）：扫错了、顾客没来时结束准备，取出的框放回暂存区 */
  | { type: 'AbandonPrep'; key: string }
  // 后仓补取（决策 X-01～X-04）
  | { type: 'ClaimException'; exceptionId: string }
  /** alsoRestock：箱里剩下的我顺手上架（决策记录 0026：不用别人再跑一趟） */
  | { type: 'ExceptionFound'; exceptionId: string; caseId: string; binEmpty: boolean; alsoRestock?: boolean }
  /** 后仓补取放回队列（决策记录 0026） */
  | { type: 'ReleaseException'; exceptionId: string }
  /** binCode：找过的库位（决策记录 0026：只盘这个库位，别的库位的箱子照样能用） */
  | { type: 'ExceptionMissing'; exceptionId: string; binCode?: string }
  | { type: 'DeliverException'; exceptionId: string; slotCode: string }
  /** 订单已交付或已取消：把后仓取出的商品放回货架（流程梳理发现，决策记录 0025） */
  | { type: 'ReturnExceptionItems'; exceptionId: string }
  // 收货与上架（决策 I-01～I-05）
  | { type: 'CreateAsn'; supplier: string; lines: AsnLine[]; expectedAt?: number }
  /** 供应商更新预计到达时间（决策记录 0022 · A3） */
  | { type: 'UpdateAsnEta'; receiptId: string; expectedAt: number }
  | { type: 'ArriveTruck'; receiptId: string }
  /** lot、expiry：批号和保质期（扫箱上的 GS1 码或手填，决策记录 0024 · C4） */
  | { type: 'ReceiveCases'; receiptId: string; gtin: string; cases: number; damaged?: boolean; lot?: string; expiry?: string }
  | { type: 'CloseReceipt'; receiptId: string }
  | { type: 'PutAwayCase'; caseId: string; binCode: string }
  | { type: 'ChangeCaseStatus'; caseId: string; status: InventoryStatus; binCode?: string }
  // 盘点（决策 I-04）
  | { type: 'CreateCount'; binCode: string; itemId?: string }
  | { type: 'ClaimCount'; countId: string }
  /** 盘点放回队列（决策记录 0026） */
  | { type: 'ReleaseCount'; countId: string }
  /** binCode：开始数之前扫到的库位标签（门店要求扫码时必须扫，决策记录 0026） */
  | { type: 'CompleteCount'; countId: string; results: Array<{ itemId: string; counted: number }>; binCode?: string }
  // 货架存量与补货（决策 R-01～R-05）
  | { type: 'RecordSales'; lines: Array<{ itemId: string; qty: number }> }
  | { type: 'RecordSensor'; locationId: string; sensor: 'tof' | 'weight'; units: number; confidence: number; itemId?: string }
  | { type: 'RequestReplenishment'; itemId: string }
  | { type: 'ClaimReplenishment'; taskIds: string[] }
  | { type: 'ReleaseReplenishment'; taskIds: string[] }
  | { type: 'CompleteReplenishment'; taskId: string; caseId: string; locationId: string; units: number }
  | { type: 'CancelReplenishment'; taskId: string; binCode?: string }
  // 核对货架：数一数货架上实际有几件（可以对应一个核对任务）
  /** found：附近找一找的核对（决策记录 0022 · C1）里，商品在哪里：原货位 / 附近（已放回）/ 都没有 */
  /** locationId：核对时扫到的货位（门店要求扫码时必须扫，决策记录 0026） */
  | { type: 'ConfirmShelf'; itemId: string; units: number; checkId?: string; walkId?: string; found?: ShelfFound; locationId?: string }
  /** 顺路核对不方便做（决策记录 0022 · C3） */
  | { type: 'SkipWalkCheck'; walkId: string; itemId: string }
  /** 效果追踪（决策记录 0022 · F4）：AI 服务记下建议事后的实际效果 */
  | { type: 'RecordOutcome'; recId: string; outcome: Omit<RecOutcome, 'adopted' | 'at'> }
  /** AI 运行监控（决策记录 0022 · H3）：AI 服务发布各模型的健康度 */
  | { type: 'PublishAiHealth'; health: AiHealth }
  // 冷链与分框（决策记录 0023 · B3、B7）：剩下的行转给别人、框装满了加一个框（拣货员）；冷链风险、分框系数（AI）
  | { type: 'HandOverLines'; walkId: string }
  | { type: 'AddTote'; walkId: string; toteId: string }
  | { type: 'FlagColdRisk'; walkId: string; overSec: number; remainingLines: number }
  | { type: 'UpdateToteFactors'; factors: Record<string, number> }
  // 时段产能（决策记录 0023 · B6）：带班负责人或控制台停止 / 重新开放某个取货时段
  | { type: 'CloseSlot'; slotStart: number }
  | { type: 'ReopenSlot'; slotStart: number }
  /** 「下一步」照着做了 / 换一个（决策记录 0024 · D3：只推荐，员工可以选别的，选别的记为反馈） */
  | { type: 'NextTaskFeedback'; kind: string; ref: string; taken: boolean }
  /** 现场操作提示看过了（决策记录 0024 · D4），可以带小测验的成绩 */
  | { type: 'AckSop'; sopId: string; correct?: number; total?: number }
  // 门店助手的问答记录与反馈（决策记录 0024 · F2）
  | { type: 'LogAnswer'; answerId: string; question: string; tools: string[]; source: string; by: string }
  | { type: 'RateAnswer'; answerId: string; helpful: boolean }
  // 现场应对（决策记录 0024 · C5、E4、E5）
  | { type: 'OpenRecall'; title: string; itemIds: string[]; lots?: string[]; reason?: string; from?: string; to?: string }
  | { type: 'MarkRecallStep'; recallId: string; step: RecallStep; done: boolean }
  | { type: 'CloseRecall'; recallId: string }
  | { type: 'StartIncident'; kind: IncidentKind }
  | { type: 'CheckIncidentStep'; incidentId: string; stepId: string }
  | { type: 'EndIncident'; incidentId: string }
  | { type: 'ConfirmFoodSafetyLog'; date: string; note?: string }
  /** 替代品的真实标签（决策记录 0023 · B4）：交付时顾客对替代品满意吗（不改变计费和退货规则） */
  | { type: 'RateSubstitution'; orderId: string; lineId: string; accepted: boolean }
  // AI 建议（决策记录 0010）：由服务端的 AI 服务发出；带班负责人或控制台处理
  | { type: 'IssueRecommendation'; draft: RecommendationDraft }
  /** autoNext：补班邀请被拒后自动问下一个人，不用每次再采纳（决策记录 0026） */
  | { type: 'AcceptRecommendation'; recId: string; autoNext?: boolean }
  | { type: 'OverrideRecommendation'; recId: string; reason: OverrideReason; note?: string }
  | { type: 'DismissRecommendation'; recId: string }
  | { type: 'SetAiMode'; module: AiModule; mode: AiMode; locked?: boolean }
  // 岗位调动与锁定（带班负责人或控制台）
  /** minutes：临时调动多久，到时自动回原岗位（不填就一直在新岗位，直到再调回来） */
  /** whenFree：手上有任务时做完再去（排队，由节拍调过去；决策记录 0026） */
  | { type: 'ChangeRole'; associateId: string; role: AssociateRole; minutes?: number; whenFree?: boolean }
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
  /** 扫错的一件删掉（决策记录 0026） */
  | { type: 'RemoveReturnLine'; returnId: string; index: number }
  | { type: 'SetReturnDisposition'; returnId: string; index: number; disposition: ReturnDisposition; aiSuggested?: ReturnDisposition }
  | { type: 'CompleteReturn'; returnId: string }
  // 大件（Phase 6）：领取时输入这一趟能装载的件数
  | { type: 'ClaimOversized'; orderId: string; maxPieces: number; pieceIds?: string[] }
  | { type: 'ReleaseOversized'; pieceIds: string[] }
  | { type: 'ScanOversized'; pieceId: string; code: string }
  | { type: 'StageOversized'; pieceId: string; area: string }
  /** 打印了这一件的标签（决策记录 0026：放到大件区之前要打印） */
  | { type: 'PrintOversizedLabel'; pieceId: string }
  // 包裹中转（Phase 6）
  | { type: 'CreateParcelAsn'; carrier: string; parcels: Array<{ parcelId: string; tripRef: string; sizeClass: 'S' | 'M' | 'L'; weightKg: number }>; expectedInMin?: number }
  /** extra：确认是到货通知里没有的包裹（决策记录 0026：扫错的编码不再直接变成「多出」） */
  | { type: 'InductParcel'; code: string; extra?: boolean }
  /** 多出、损坏的包裹怎么处理：退回快递 / 放在异常区等人认领（决策记录 0026） */
  | { type: 'ResolveParcel'; parcelId: string; action: 'RETURN' | 'HOLD' }
  | { type: 'StageParcel'; parcelId: string; slotCode: string }
  | { type: 'ReportParcelDamaged'; parcelId: string }
  | { type: 'HandOffParcels'; tripRef: string }
  // 设备告警（数字孪生，决策记录 0016）：门店中枢的孪生服务按规则发出和解除；带班负责人或控制台确认
  | { type: 'RaiseEquipmentAlert'; sensorId: string; kind: EquipmentAlertKind; severity: 'WARN' | 'ALARM'; value: number; limit?: number; since: number; impact: AlertImpact }
  | { type: 'ClearEquipmentAlert'; alertId: string; peak?: number }
  | { type: 'AcknowledgeAlert'; alertId: string }
  // 门店 AI 第二轮（决策记录 0021）：由服务端的 AI 服务（ai / system）发出
  | { type: 'EstimateWalk'; walkId: string; estimate: Omit<WalkEstimate, 'at'> }
  | { type: 'PublishOutlook'; outlook: Omit<DemandOutlook, 'at'> }
  | { type: 'FlagWalkLines'; walkId: string; flags: Record<string, LineFlag> }
  /** 拣货前的缺货预判：后仓有货时先补上（dueAt 是拣货员预计走到这个货位的时刻） */
  | { type: 'RequestPrepick'; itemId: string; dueAt: number; walkId: string }
  // 提醒（建议中枢，决策记录 0021 · G1）：AI 服务发出和关闭；收到提醒的员工标记已读
  | { type: 'SendNudges'; nudges: Array<Omit<Nudge, 'id' | 'createdAt' | 'status'>> }
  | { type: 'CloseNudges'; ids: string[]; status: 'DONE' | 'EXPIRED' }
  | { type: 'ReadNudge'; nudgeId: string }
  // 排班与补位（决策记录 0022）：带班负责人或控制台发布排班、报告缺勤；收到邀请的员工接受或拒绝
  | { type: 'PublishSchedule'; week: string; shifts: Array<Omit<ScheduledShift, 'id'>> }
  | { type: 'ReportAbsence'; associateId: string; date: string; from?: number; to?: number; reason?: string }
  | { type: 'RespondShiftOffer'; offerId: string; accept: boolean }
  /** 带班负责人直接给某人发补班邀请（例如 AI 建议里的其他人选；决策记录 0026） */
  | { type: 'SendShiftOffer'; associateId: string; date: string; from: number; to: number; role?: AssociateRole; replaces?: string; recId?: string; autoNext?: boolean }
  // 设备报修（预测性维护，决策记录 0022 · E1）：带班负责人或控制台报修、修好后关单并记下实际故障
  | { type: 'RequestMaintenance'; sensorId: string; slots?: string[] }
  | { type: 'CloseMaintenance'; ticketId: string; fault: MaintenanceFault }
  // 期初库存（建店时由服务端载入一次）
  | { type: 'LoadInventory'; cases: Array<{ caseId: string; itemId: string; gtin: string; name: string; packQty: number; units: number; binCode: string }> }
  // 门店设置（决策记录 0026）：要不要求扫码、交付准备什么时候能开始；控制台和带班负责人可以改
  | { type: 'SetStoreSettings'; requireScan?: boolean; prepGate?: 'ANY' | 'ARRIVED' };

/** 每条命令都可以带的标记 */
export interface CommandMarks {
  /** 点选代替了扫码（没有扫码枪时）：门店要求扫码时拒绝（决策记录 0026） */
  tap?: boolean;
}

export type OpsCommand = BaseCommand & CommandMarks;

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
  | 'DURATION_INVALID'
  | 'TRIP_PENDING'
  | 'DATE_INVALID'
  | 'SCAN_REQUIRED'
  | 'WRONG_ITEM'
  | 'SETTING_INVALID'
  | 'SLOT_AREA_MISMATCH'
  | 'RECALL_ITEMS_PRESENT'
  | 'MTO_NOT_PULLED'
  | 'MTO_NOT_READY'
  | 'LABEL_NOT_PRINTED'
  | 'RETURN_QTY_EXCEEDED'
  | 'RECALL_STEPS_OPEN'
  | 'OFFER_PENDING'
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
  | 'ALERT_NOT_FOUND'
  | 'ALERT_CLEARED'
  | 'NUDGE_NOT_FOUND'
  | 'NOT_YOURS'
  | 'SCHEDULE_INVALID'
  | 'OFFER_NOT_FOUND'
  | 'OFFER_CLOSED'
  | 'TICKET_EXISTS'
  | 'SLOT_PAUSED'
  | 'ETA_INVALID'
  | 'NOTHING_TO_HAND_OVER'
  | 'SLOT_CLOSED'
  | 'NOT_SUBSTITUTED'
  | 'RECALL_NOT_FOUND'
  | 'RECALL_CLOSED'
  | 'ITEM_RECALLED'
  | 'INCIDENT_NOT_FOUND'
  | 'INCIDENT_ACTIVE'
  | 'ANSWER_NOT_FOUND'

export interface Rejection {
  code: RejectCode;
  params?: Record<string, string | number>;
}
