import type { Rejection } from '@storewright/ops';
import { t } from './i18n';
import { RETURN_BLOCK_TEXT } from './screens/AiScreen';

/** 服务端拒绝原因 → 界面文字 */
const RECALL_STEP_SHORT: Record<string, string> = { SHELF: '货架下架', BACKROOM: '后仓的箱子', STAGED: '暂存和推车上的框', ORDERS: '未完成的订单', CUSTOMERS: '通知顾客' };

export function rejectText(r: Rejection, nameOf: (id: string) => string): string {
  const p = r.params ?? {};
  const by = nameOf(String(p.by ?? ''));
  switch (r.code) {
    case 'WALK_CLAIMED':
      return t('这个批次已被 {0} 领取', by);
    case 'WALK_NOT_YOURS':
      return t('这不是你的批次');
    case 'WALK_COMPLETED':
      return t('这个批次已经完成');
    case 'WALK_UNFINISHED':
      return t('还有 {0} 行没有处理', p.remaining ?? 0);
    case 'WALK_STARTED':
      return t('已经开始拣货，不能放弃');
    case 'ASSOCIATE_BUSY':
      return t('你还有一个进行中的批次（{0}）', p.walkId ?? '');
    case 'LABEL_NOT_FOUND':
      return t('找不到这个标签');
    case 'LABEL_VOIDED':
      return t('这个标签已作废，请用新标签');
    case 'LABEL_NOT_IN_WALK':
      return t('这个框不在当前批次里');
    case 'TOTE_NOT_BOUND':
      return t('请先扫描框上的标签');
    case 'TOTE_NOT_PICKED':
      return t('这个框还没有拣完');
    case 'TOTE_NOT_STAGED':
      return t('这个框不在暂存区');
    case 'QTY_INVALID':
      return t('数量不对，还需要 {0} 件', p.remaining ?? 0);
    case 'SUBSTITUTION_NOT_ALLOWED':
      return t('顾客不允许替代这件商品');
    case 'SUBSTITUTE_REQUIRED':
      return t('请选择替代商品');
    case 'SLOT_NOT_FOUND':
      return t('找不到这个格位');
    case 'SLOT_ZONE_MISMATCH':
      return t('温区不对：格位是 {0}，框是 {1}', zone(String(p.slot)), zone(String(p.tote)));
    case 'SLOT_FULL':
      return t('格位已满（最多 {0} 个框）', p.capacity ?? 0);
    case 'SAME_SLOT':
      return t('已经在这个格位里');
    case 'BAY_NOT_FOUND':
      return t('没有这个取货车位：{0}', String(p.bay ?? ''));
    case 'NOT_STAGED':
      return t('订单还没有全部暂存，请告诉顾客预计等待时间');
    case 'PREP_LOCKED':
      return t('{0} 正在准备这个订单，可以加入协助', by);
    case 'NOT_IN_SESSION':
      return by ? t('这个订单由 {0} 负责', by) : t('没有权限');
    case 'TOTE_NOT_IN_SESSION':
      return t('这个框不属于这个订单');
    case 'TOTE_ALREADY_SCANNED':
      return t('这个框已经扫过了');
    case 'NOT_READY':
      return t('还有框没有取出');
    case 'NOT_ARRIVED':
      return t('顾客还没有到达');
    case 'ALREADY_VERIFIED':
      return t('已经核验过了');
    case 'NO_CODE':
      return t('没有验证码，请人工核验');
    case 'MANUAL_NOT_ALLOWED':
      return t('请先输入验证码');
    case 'NOT_VERIFIED':
      return t('请先核验验证码');
    case 'AGE_CHECK_REQUIRED':
      return t('含年龄限制商品，请核验证件');
    case 'ORDER_IN_TRIP':
      return t('这个订单在行程 {0} 中，请按行程交付', p.tripId ?? '');
    case 'ORDER_CANCELLED':
      return t('订单已取消');
    case 'ORDER_COMPLETED':
      return t('订单已完成');
    case 'NOTHING_TO_RELEASE':
      return t('没有需要生成批次的订单');
    case 'TRIP_NOT_ACCEPTED':
      return t('这个行程还没有司机接单');
    case 'CANCEL_LOCKED':
      return t('已进入预计到店前的准备期，不能取消');
    case 'CANCEL_WAIT': {
      const left = Math.max(1, Math.ceil((Number(p.opensAt ?? 0) - Date.now()) / 60_000));
      return t('到店后要再等一会儿才能取消（已等 {0} 分钟，还差约 {1} 分钟）', p.waitedMin ?? 0, left);
    }
    case 'NOT_NO_SHOW':
      return t('司机还没有超过预计到店时间足够久，暂时不能改派');
    case 'TRIP_ACCEPTED':
      return t('司机已经接单');
    case 'ORDER_NOT_CREATED':
      return t('订单已经锁单');
    case 'NO_BACKROOM_STOCK':
      return t('库存记录显示后仓没有这个商品');
    case 'NOT_AUTHORIZED':
      return t('你没有这个操作的权限（需要带班负责人，或后仓补取的永久授权）');
    case 'EXCEPTION_TAKEN':
      return t('已被 {0} 领取', by);
    case 'EXCEPTION_NOT_YOURS':
    case 'TASK_NOT_YOURS':
      return t('这不是你的任务');
    case 'EXCEPTION_STATE':
      return t('任务状态已经变化，请刷新');
    case 'CASE_NOT_FOUND':
      return t('找不到这个箱子');
    case 'CASE_WRONG_ITEM':
      return t('不是这个商品的箱子');
    case 'CASE_EMPTY':
      return t('这个箱子已经空了');
    case 'RECEIPT_NOT_ARRIVED':
      return t('卡车还没到');
    case 'RECEIPT_CLOSED':
      return t('收货单已关闭');
    case 'ITEM_NOT_FOUND':
      return t('商品目录里没有这个商品');
    case 'BIN_NOT_FOUND':
      return t('找不到这个库位');
    case 'BIN_ZONE':
      return t('温区不对：这个库位是 {0}', zone(String(p.bin)));
    case 'BIN_ISOLATION':
      return t('隔离规则：化学品和食品不能放在一起');
    case 'BIN_STATUS':
      return t('库存状态不符（可售 / 待检 / 退供应商 / 报废分区存放）');
    case 'BIN_FULL':
      return t('库位已满');
    case 'LOCATION_NOT_FOUND':
      return t('找不到这个货位');
    case 'LOCATION_MISMATCH':
      return t('位置不对：应该是 {0}', String(p.expected ?? ''));
    case 'TASK_NOT_FOUND':
    case 'COUNT_NOT_FOUND':
      return t('任务不存在');
    case 'TASK_TAKEN':
    case 'COUNT_TAKEN':
      return t('已被 {0} 领取', by);
    case 'TASK_DONE':
    case 'COUNT_DONE':
      return t('任务已经完成');
    case 'TASK_EXISTS':
      return t('已经有进行中的任务');
    case 'REC_NOT_FOUND':
      return t('找不到这条建议');
    case 'REC_CLOSED':
      return t('这条建议已经处理过了');
    case 'MODE_LOCKED':
      return t('这个模块已被门店管理员锁定');
    case 'REASON_UNKNOWN':
      return t('请选择原因');
    case 'ACTION_STALE':
      return t('情况已经变了，这条建议不能再执行，可以忽略');
    case 'CHECK_NOT_FOUND':
      return t('找不到这个核对任务');
    case 'CHECK_DONE':
      return t('这个核对任务已经完成');
    case 'MODULE_DISABLED':
      return t('门店没有启用这个模块');
    case 'MENU_NOT_FOUND':
      return t('菜单里没有这道菜');
    case 'TICKET_NOT_FOUND':
      return t('找不到这张现做单');
    case 'TICKET_STATE':
      return t('这张现做单的状态已经变了（{0}）', String(p.status ?? ''));
    case 'RETURN_NOT_FOUND':
      return t('找不到这张退货单');
    case 'RETURN_CLOSED':
      return t('这张退货单已经完成');
    case 'RETURN_INCOMPLETE':
      return t('每件都要先选好去向');
    case 'DISPOSITION_NOT_ALLOWED':
      return t('门店规则不允许这个去向：{0}', t(RETURN_BLOCK_TEXT[String(p.reason ?? '')] ?? String(p.reason ?? '')));
    case 'PIECE_NOT_FOUND':
      return t('找不到这件大件');
    case 'PIECE_STATE':
      return t('这件大件的状态已经变了');
    case 'PIECE_NOT_YOURS':
      return t('这件大件不是你领取的');
    case 'NOTHING_TO_CLAIM':
      return t('没有可以领取的大件了');
    case 'PARCEL_NOT_FOUND':
      return t('找不到这个包裹');
    case 'PARCEL_STATE':
      return t('这个包裹已经处理过了');
    case 'TRIP_NOT_READY':
      return t('这个行程还有包裹没暂存，或者没有可交接的包裹');
    case 'ALERT_NOT_FOUND':
      return t('找不到这条设备告警');
    case 'ALERT_CLEARED':
      return t('这条设备告警已经解除了');
    // 门店 AI 第二轮（决策记录 0021、0022）
    case 'NUDGE_NOT_FOUND':
      return t('找不到这条提醒');
    case 'NOT_YOURS':
      return t('这不是发给你的');
    case 'SCHEDULE_INVALID':
      return t('排班不对：有人不在名单上、日期不在这一周，或者同一天排了两个班');
    case 'OFFER_NOT_FOUND':
      return t('找不到这个邀请');
    case 'OFFER_CLOSED':
      return t('这个邀请已经答复过了');
    case 'TICKET_EXISTS':
      return t('这台设备已经有一张没关的报修单');
    case 'SLOT_PAUSED':
      return t('这个格位所在的冷柜在报修，请放到同温区的其他格位');
    case 'ETA_INVALID':
      return t('预计到达时间不对');
    case 'NOTHING_TO_HAND_OVER':
      return t('没有剩下要转的行');
    case 'SLOT_CLOSED':
      return t('这个取货时段已经停止接新单，请选别的时段');
    case 'NOT_SUBSTITUTED':
      return t('这一行没有替代品');
    case 'RECALL_NOT_FOUND':
      return t('找不到这个召回');
    case 'RECALL_CLOSED':
      return t('这个召回已经结束');
    case 'ITEM_RECALLED':
      return t('这件商品正在召回：不能拣、也不能放回可售，按「找不到」处理（替代或缺货）');
    case 'INCIDENT_NOT_FOUND':
      return t('找不到这个突发状况或这一步，可能已经结束');
    case 'INCIDENT_ACTIVE':
      return t('已经有一个突发状况在处理，请先结束它');
    case 'ANSWER_NOT_FOUND':
      return t('找不到这条回答');
    // 调配在岗员工（决策记录 0025）
    case 'ASSOCIATE_NOT_FOUND':
      return t('名单里没有这个人');
    case 'ROLE_NOT_ALLOWED':
      return t('只能在拣货、暂存、交付、补货、后仓、熟食之间调动，带班负责人不调动');
    case 'SAME_ROLE':
      return t('已经在这个岗位了');
    case 'DURATION_INVALID':
      return t('调动时长要在 5 分钟到 12 小时之间');
    // 修复全部卡点（决策记录 0026）
    case 'SCAN_REQUIRED':
      return t('门店要求扫码：请扫描标签或条码，不能点选代替');
    case 'WRONG_ITEM':
      return t('扫到的不是这件商品');
    case 'RECALL_ITEMS_PRESENT':
      return t('这单里有召回商品：从框里取出后勾选，再完成交付');
    case 'MTO_NOT_PULLED':
      return t('熟食做好了还在保温位：先取出再交付');
    case 'MTO_NOT_READY':
      return t('熟食还在做：等做好，或者顾客不要了再交付');
    case 'LABEL_NOT_PRINTED':
      return t('这一件还没打印标签');
    case 'RETURN_QTY_EXCEEDED':
      return t('比订单里交出去的多：这件商品最多还能退 {0} 件', p.remaining ?? 0);
    case 'RECALL_STEPS_OPEN':
      return t('召回还有步骤没做完（{0}）：做完才能关闭', String(p.steps ?? '').split(',').filter(Boolean).map((x) => t(RECALL_STEP_SHORT[x] ?? x)).join('、'));
    case 'OFFER_PENDING':
      return t('这个人当天还有没答复的邀请');
    case 'SLOT_AREA_MISMATCH':
      return p.order === 'DELIVERY' ? t('这是自取区的格位：配送订单请放到配送区') : t('这是配送区的格位：自取订单请放到自取区');
    case 'SETTING_INVALID':
      return t('设置的值不对');
    case 'TRIP_PENDING':
      return t('配送订单要等行程成行后一起准备');
    case 'DATE_INVALID':
      return t('保质期的写法不对，要写成 年-月-日（例如 2026-11-01）');
    default:
      return t('操作没有成功（{0}）', r.code);
  }
}

export function zone(z: string): string {
  switch (z) {
    case 'AMBIENT':
      return t('常温');
    case 'CHILLED':
      return t('冷藏');
    case 'FROZEN':
      return t('冷冻');
    case 'HOT':
      return t('热食');
    default:
      return z;
  }
}
