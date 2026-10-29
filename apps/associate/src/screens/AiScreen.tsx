import { useEffect, useState } from 'react';
import { AI_MODES, AI_MODULES, OVERRIDE_REASONS, type AiMode, type AiModule, type OverrideReason, type Reason } from '@storewright/ai';
import { adoptionRate, aiModeOf, canManageAi, CONFIRM_ALWAYS, maintenanceStats, nudgeStats, openRecs, planogramByItem, recentRecs, recsByUrgency, recStale, type AssociateRole, type LiveRec, type OpsState, type StoreStatic } from '@storewright/ops';
import { ai, type AiModelInfo, type AiSummary } from '../api';
import { clock, t } from '../i18n';
import { useIntent } from '../nav';
import { useLive, useNow } from '../live';
import { locationText, nearText } from '../format';
import { toast } from '../ui/Toasts';
import { AiHealthCard, BriefCard, CapacityCard, OutcomeLine, outcomeText, ReviewCard, SubstitutionLive, WeeklyCard } from './AiBrief';
import { AskPanel } from './AskPanel';
import { FieldScreen } from './FieldScreen';
import { hm, ScheduleView } from './ScheduleScreen';
import { sensorName } from './TwinCard';
import { sensorsFor } from '@storewright/twin';

/**
 * AI（决策记录 0010）：带班负责人和控制台查看并处理 AI 建议、设置各模块的运行模式、查看模型版本与回测指标。
 * 每条建议都显示预测区间、置信度、主要理由和其他模型的预测；否决时必须选原因。
 */

export const MODULE_TEXT: Record<AiModule, string> = {
  FORECAST: '订单量预测',
  ETA: '到店时间',
  AVAILABILITY: '可售概率',
  SUBSTITUTION: '替代推荐',
  STAFFING: '人员调配',
  REPLENISH: '补货优先级',
  COUNT: '按风险盘点',
  MTO: '熟食开始时间',
  RETURNS: '退货去向',
  FORESIGHT: '运营预警',
  PICKING: '拣货',
  EQUIPMENT: '设备健康',
  INBOUND: '到货与卸货场',
  FRONT: '前场收银',
  CAPACITY: '时段产能',
  STAGING: '暂存与冷冻拣货',
  EXPIRY: '临期与损耗',
};
/** 退货去向的硬性规则（决策 RT-02） */
export const RETURN_BLOCK_TEXT: Record<string, string> = {
  COLD_CHAIN: '冷藏、冷冻、热食退回后一律不能回架',
  NOT_SEALED: '食品、日用品和个护只有未开封才能回架',
  DAMAGED: '损坏的商品不能回架',
  CHEMICAL_OPENED: '开封或损坏的化学品只能走危险品回收',
  CHEMICAL_TRASH: '化学品不能按普通垃圾报废',
};
export const ROLE_TEXT: Record<string, string> = { PICK: '拣货', STAGE: '暂存', HANDOFF: '交付', LEAD: '带班负责人', BACKROOM: '后仓', RESTOCK: '补货', DELI: '熟食', pick: '拣货', stage: '暂存', handoff: '交付' };
const DISPOSITION_TEXT: Record<string, string> = { RESTOCK: '可售回架', DISPOSE: '报废', HAZMAT: '危险品回收', VENDOR: '退供应商' };
const MODE_TEXT: Record<AiMode, string> = { SHOW: '只显示', CONFIRM: '需确认', AUTO: '自动执行' };
const STATUS_TEXT: Record<LiveRec['status'], string> = {
  OPEN: '待处理',
  ACCEPTED: '已采纳',
  OVERRIDDEN: '已否决',
  DISMISSED: '已忽略',
  EXPIRED: '已过期',
  SUPERSEDED: '已被取代',
  AUTO_APPLIED: '已自动执行',
};
const REASON_TEXT: Record<OverrideReason, string> = {
  WRONG_DATA: '数据不对',
  LOCAL_KNOWLEDGE: '我知道系统不知道的情况',
  NO_STAFF: '人手不够',
  CUSTOMER_REQUEST: '顾客要求',
  DISAGREE: '不同意',
  OTHER: '其他',
};
const KIND_TEXT: Record<string, string> = {
  'feature-glm': '已知因素回归',
  'eta-reported': '只信导航',
  'eta-fixed': '导航 + 高峰与天气',
  'eta-hierarchical': '导航 + 高峰与天气 + 顾客习惯',
  'availability-bayes': '只看沉默（朴素贝叶斯）',
  'availability-logistic': '逻辑回归（沉默 + 估算 + 确认时间）',
  'count-abc': 'ABC 周期 + 事件触发',
  'count-risk': '按风险排序',
  'queue-sim': '短时排队估算',
  'sub-rule': '名称规则',
  'sub-similarity': '属性相似度',
  'sub-learned': '学习排序',
  'seasonal-naive': '同时段上周值',
  'hour-of-week-mean-4': '近 4 周同时段平均',
  'seasonal-es': '季节性指数平滑',
  'prep-standard': '标准制作时长',
  'prep-model': '菜品系数 + 厨房负载',
  'returns-rule': '固定规则',
  'returns-model': '再售概率（逻辑回归）+ 规则',
  'pick-standard': '标准工时',
  'pick-standard-ratio': '标准工时 × 实测比例',
  'pick-model': '货位 + 商品类型 + 时段 + 熟练度组',
  'queue-forecast': 'AI 驱动的排队推演',
  'noshow-rule': '规则（取货前 30 分钟还没报预计到达）',
  'noshow-logistic': '逻辑回归（提前量、时段、天气、以前爽约、报没报预计到达）',
};
const MODEL_STATUS_TEXT: Record<AiModelInfo['status'], string> = { CHAMPION: '当前版本', CANDIDATE: '候选', RETIRED: '已退役', REJECTED: '未通过' };
const NOTE_TEXT: Record<string, string> = { NOT_BEST: '同一批中不是最好的', ROLLED_BACK: '已回滚', FORCED: '人工上线' };
const HOLIDAY_TEXT: Record<string, string> = {
  NEW_YEAR: '元旦',
  MEMORIAL_DAY: '阵亡将士纪念日',
  INDEPENDENCE_DAY: '独立日',
  LABOR_DAY: '劳动节',
  THANKSGIVING: '感恩节',
  CHRISTMAS: '圣诞节',
};
const ZONE_TEXT: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻', HOT: '热食' };
const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const METRIC_TEXT: Record<string, string> = {
  wape: '加权误差 WAPE',
  mae: '平均绝对误差',
  bias: '偏差',
  coverage80: '80% 区间覆盖率',
  absBias: '偏差绝对值',
  coverageGap: '覆盖率偏离 80%',
  maeRepeat: '老顾客的平均绝对误差',
  brier: 'Brier 分数',
  auc: 'AUC',
  ece: '校准误差',
  precision: '提醒的精确率',
  recall: '提醒的召回率',
  avgInaccurate: '平均不准的记录数',
  meanDetectDays: '发现错误的平均天数',
  hitRate: '盘点命中率',
  acceptTop1: '推荐第一名的期望接受率',
  ndcg3: '前三名排序质量（NDCG@3）',
  accuracy: '判断正确率',
  falseRestock: '误判回架的比例',
  missedResale: '可售却报废的比例',
  captureTop10: '风险最高的一成订单抓到的爽约',
  rate: '爽约率',
};
const EVAL_TEXT: Record<string, string> = {
  'orders-hourly': '回测：每次只用当时已有的数据训练，预测之后 7 天，滚动多次后汇总。',
  'eta-arrival': '评估：按时间先后，前 70% 训练，之后逐条预测，预测完再把这次到店计入顾客习惯。',
  'shelf-availability': '评估：按天切分，前 70% 的天数训练，之后的每个商品-小时预测「货架上找不找得到」。',
  'count-risk': '评估：同样的每日盘点数量下，两种策略面对完全相同的出错事件（公共随机数）。',
  substitution: '评估：前 70% 的替代记录训练，之后每条记录比较各方法选出的第一名，用顾客真实的接受概率计算。',
  'mto-prep': '评估：前 70% 的制作记录训练，之后逐条预测实际制作时长（模拟数据中有菜品差异与厨房繁忙的影响）。',
  'returns-disposition': '评估：前 70% 的退货记录训练，之后比较「回架」判断与这件商品实际能否再售。',
  'pick-time': '评估：按时间先后，前 70% 的拣货批次训练，之后逐批预测用时（模拟数据里每个货位有看不到的难度，高峰更挤、新人更慢，偶尔被打断）。',
  'no-show': '评估：按时间先后，前 70% 的自取订单训练，之后逐单预测顾客会不会不来（模拟数据里每位顾客有看不到的爽约倾向）。用途：风险高的订单冷冻商品晚点拣，营业结束前提醒联系顾客。',
};
/** 模型族：标题、显示的指标、主指标 */
const FAMILIES: Array<{ id: string; title: string; metrics: string[]; primary: string; minutes: boolean }> = [
  { id: 'orders-hourly', title: '订单量预测模型', metrics: ['wape', 'mae', 'bias', 'coverage80'], primary: 'wape', minutes: false },
  { id: 'eta-arrival', title: '到店时间修正模型', metrics: ['mae', 'maeRepeat', 'bias', 'coverage80'], primary: 'mae', minutes: true },
  { id: 'shelf-availability', title: '可售概率模型', metrics: ['brier', 'auc', 'ece', 'precision', 'recall'], primary: 'brier', minutes: false },
  { id: 'count-risk', title: '按风险盘点模型', metrics: ['avgInaccurate', 'meanDetectDays', 'hitRate'], primary: 'avgInaccurate', minutes: false },
  { id: 'substitution', title: '替代推荐模型', metrics: ['acceptTop1', 'ndcg3'], primary: 'acceptTop1', minutes: false },
  { id: 'mto-prep', title: '熟食制作时长模型', metrics: ['mae'], primary: 'mae', minutes: true },
  { id: 'returns-disposition', title: '退货去向模型', metrics: ['accuracy', 'falseRestock', 'missedResale'], primary: 'accuracy', minutes: false },
  { id: 'pick-time', title: '拣货时长模型', metrics: ['wape', 'mae', 'bias', 'coverage80'], primary: 'wape', minutes: false },
  { id: 'no-show', title: '未取订单风险模型', metrics: ['brier', 'auc', 'ece', 'captureTop10', 'rate'], primary: 'brier', minutes: false },
];
const PERCENT_METRICS = new Set(['wape', 'coverage80', 'ece', 'precision', 'recall', 'hitRate', 'acceptTop1', 'accuracy', 'falseRestock', 'missedResale', 'captureTop10', 'rate']);

const kindText = (k: string) => (KIND_TEXT[k] ? t(KIND_TEXT[k]) : k);
const noteText = (n: string) => (NOTE_TEXT[n] ? t(NOTE_TEXT[n]) : n);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** 倍数 → ±百分比 */
function effectText(r: Reason): string {
  if (!r.effect) return '';
  if (r.effect.kind === 'ADD') return `${r.effect.amount >= 0 ? '+' : '−'}${Math.abs(Math.round(r.effect.amount * 10) / 10)}`;
  const d = Math.round((r.effect.amount - 1) * 100);
  return d === 0 ? '±0%' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;
}

export function reasonText(r: Reason): string {
  const v = r.value ?? 0;
  switch (r.factor) {
    case 'WEEKDAY_FACTOR':
      return t('{0}的订单比一周平均 {1}', t(WEEKDAY[Number(r.params?.dow ?? 0)] ?? ''), effectText(r));
    case 'HOUR_SHARE':
      return t('这段时间占全天订单的 {0}%', Math.round(v));
    case 'TREND':
      return t('近期趋势 {0}', effectText(r));
    case 'BASE_LEVEL':
      return t('基础水平：每天约 {0} 单', Math.round(v));
    case 'SAME_HOUR_LAST_WEEK':
      return t('上周同一时段 {0} 单', Math.round(v));
    case 'RECENT_WEEKS_MEAN':
      return t('近几周同一时段平均 {0} 单', Math.round(v));
    case 'HOLIDAY':
      return t('{0}当天 {1}', holidayName(r), effectText(r));
    case 'HOLIDAY_EVE':
      return t('{0}前一天 {1}', holidayName(r), effectText(r));
    case 'DAY_AFTER_HOLIDAY':
      return t('节后第一天 {0}', effectText(r));
    case 'PROMO':
      return t('本周促销（覆盖 {0}% 的需求）{1}', Math.round(v), effectText(r));
    case 'STORM_WARNING_TOMORROW':
      return t('明天有风暴预警，顾客提前囤货 {0}', effectText(r));
    case 'STORM_WARNING':
      return t('今天有风暴预警 {0}', effectText(r));
    case 'HEAVY_RAIN_FORECAST':
      return t('预报大雨（{0} 毫米）{1}', Math.round(v), effectText(r));
    case 'HEAT_FORECAST':
      return t('预报高温（{0}°C）{1}', Math.round(v), effectText(r));
    case 'COLD_FORECAST':
      return t('预报严寒（{0}°C）{1}', Math.round(v), effectText(r));
    case 'REPORTED_ETA':
      return t('导航预计 {0} 分钟', Math.round(v));
    case 'TYPICAL_DELAY':
      return t('一般会比导航多用 {0} 分钟', minutesText(r));
    case 'RUSH_HOUR':
      return t('高峰时段 {0} 分钟', minutesText(r));
    case 'WEEKEND':
      return t('周末 {0} 分钟', minutesText(r));
    case 'CUSTOMER_HABIT':
      return t('这位顾客以往 {0} 次到店的习惯 {1} 分钟', Number(r.params?.visits ?? 0), minutesText(r));
    case 'NO_SALES':
      return t('已经 {0} 没有卖出（按平时应卖出约 {1} 件）', hoursText(v), Number(r.params?.expected ?? 0));
    case 'SHELF_ESTIMATE':
      return t('系统估算 {0} 件', Math.round(v));
    case 'ALMOST_EMPTY':
      return t('系统估算只剩 {0} 件', Math.round(v));
    case 'SINCE_CONFIRMED':
      return r.params?.never ? t('开门以来还没有员工到货架确认过') : t('{0}前员工确认过', hoursText(v));
    case 'VELOCITY':
      return t('平均每小时卖 {0} 件', Math.round(v * 10) / 10);
    case 'DAYS_SINCE_COUNT':
      return t('距上次盘点 {0} 天', Math.round(v));
    case 'MOVES_SINCE_COUNT':
      return t('盘点后进出 {0} 次', Math.round(v));
    case 'RECEIPT_DISCREPANCY':
      return t('最近收货有差异');
    case 'SUSPECT':
      return t('后仓补取或补货时按记录没找到');
    case 'DAMAGED':
      return r.effect ? t('包装损坏 {0}', effectText(r)) : t('有 {0} 箱损坏', Math.round(v));
    case 'HANDOFF_QUEUE':
      return t('交付区 {0} 位顾客在等，{1} 分钟内还会到 {2} 位', Math.round(v), Number(r.params?.horizon ?? 15), Number(r.params?.arriving ?? 0));
    case 'PICK_BACKLOG':
      return t('待拣约 {0} 分钟的工作量，最早 {1} 分钟后截止', Math.round(v), Number(r.params?.due ?? 0));
    case 'STAGE_BACKLOG':
      return t('{0} 框等待暂存', Math.round(v));
    case 'IDLE_IN_SOURCE':
      return t('{0}岗位有 {1} 人手上没有任务', t(ROLE_TEXT[String(r.params?.role ?? '')] ?? ''), Math.round(v));
    case 'PEAK_HOUR':
      return t('高峰在 {0} 点，预计 {1} 单', Number(r.params?.hour ?? 0), Math.round(v));
    case 'SAME_TOTAL_HOURS':
      return t('各岗位总工时与现在相同，只调整时间分布');
    case 'RECENT_LEVEL':
      return t('近期需求水平比训练期平均 {0}', effectText(r));
    case 'STANDARD_TIME':
      return t('标准制作时长 {0} 分钟', Math.round(v));
    case 'DISH_FACTOR':
      return t('这道菜实际制作通常 {0} 分钟', minutesText(r));
    case 'KITCHEN_LOAD':
      return t('厨房同时在做 {0} 单，{1} 分钟', Math.round(v), minutesText(r));
    case 'INTERCEPT':
      return t('基础再售率');
    case 'OPENED':
      return t('已开封 {0}', effectText(r));
    case 'COLD_HOURS':
      return t('冷藏冷冻商品离开冷链约 {0} 小时 {1}', Math.round(v * 10) / 10, effectText(r)) + (r.params?.assumed ? t('（没有订单，按 24 小时估计）') : '');
    case 'PERISHABLE':
      return t('易腐商品 {0}', effectText(r));
    case 'PERISHABLE_HOURS':
      return t('易腐商品交付后 {0} 小时 {1}', Math.round(v * 10) / 10, effectText(r)) + (r.params?.assumed ? t('（没有订单，按 24 小时估计）') : '');
    case 'CHEMICAL':
      return t('化学品 {0}', effectText(r));
    case 'RULE':
      return t('门店规则：{0}（模型原本建议{1}）', t(RETURN_BLOCK_TEXT[String(r.params?.reason ?? '')] ?? ''), t(DISPOSITION_TEXT[String(r.params?.original ?? '')] ?? ''));
    // 运营预警（决策记录 0021）
    case 'PROBLEM_LATE':
      return t('推演：{0} 起有 {1} 单赶不上取货时段（{2} 单起提醒）', clock(Number(r.params?.at ?? 0)), Math.round(v), Number(r.params?.limit ?? 0));
    case 'PROBLEM_WAIT':
      return t('推演：顾客等待会到 {0} 分钟（超过 {1} 分钟提醒）', Math.round(v * 10) / 10, Number(r.params?.limit ?? 0));
    case 'PROBLEM_COLD_FULL':
      return t('推演：冷区暂存最高会到 {0}%（超过 {1}% 提醒）', Math.round(v * 100), Math.round(Number(r.params?.limit ?? 0) * 100));
    case 'PROBLEM_BACKLOG':
      return t('推演：拣货积压最高会到 {0} 分钟', Math.round(v));
    case 'DEMAND_VS_FORECAST':
      return v >= 0 ? t('今天的单量比预测多 {0}%', Math.round(v)) : t('今天的单量比预测少 {0}%', Math.abs(Math.round(v)));
    case 'PICK_PACE':
      return v >= 0 ? t('今天拣货比计划慢 {0}%', Math.round(v)) : t('今天拣货比计划快 {0}%', Math.abs(Math.round(v)));
    case 'STAFF_ON_DUTY':
      return t('在岗：拣货 {0} · 暂存 {1} · 交付 {2}', Number(r.params?.pick ?? 0), Number(r.params?.stage ?? 0), Number(r.params?.handoff ?? 0));
    case 'MORE_ORDERS':
      return t('接下来 {0} 小时还会来约 {1} 单', Number(r.params?.hours ?? 2), Math.round(v));
    // 补位（决策记录 0022）
    case 'ABSENCE':
      return t('{0} {1} {2}–{3} 的{4}班缺勤', String(r.params?.who ?? ''), String(r.params?.date ?? ''), String(r.params?.from ?? ''), String(r.params?.to ?? ''), t(ROLE_TEXT[String(r.params?.role ?? '')] ?? ''));
    case 'CAN_COVER':
      return t('{0} 这段时间可以上班、会这个岗位', String(r.params?.who ?? ''));
    case 'CAN_EXTEND':
      return t('{0} 当天有班，可以接着延长', String(r.params?.who ?? ''));
    case 'HOURS_LEFT':
      return t('这周还能排 {0} 小时', Math.round(v * 10) / 10);
    case 'NO_OVERTIME':
      return t('不用加班');
    case 'OVERTIME':
      return t('会超过每周 40 小时（加班）');
    case 'NO_CANDIDATE':
      return t('没有会这个岗位、这段时间能上班、这周还有工时的人');
    // 预测性维护（决策记录 0022）
    case 'TEMP_TREND':
      return t('底线温度每小时 +{0} °C（去掉开门和除霜的短暂升温）', Math.round(v * 100) / 100);
    case 'TEMP_LEVEL':
      return t('现在的底线温度 {0} °C（平时 {1} °C，告警线 {2} °C）', Math.round(v * 10) / 10, Number(r.params?.nominal ?? 0), Number(r.params?.limit ?? 0));
    case 'ETA_LIMIT':
      return t('照这样约 {0} 分钟后越过告警线（{1}–{2} 分钟）', Math.round(v), Number(r.params?.low ?? 0), Number(r.params?.high ?? 0));
    case 'DOOR_RECOVERY':
      return t('开门后回温是之前的 {0} 倍：可能门封漏气', Math.round(v * 10) / 10);
    case 'STUCK':
      return t('读数 {0} 分钟一点没变（正常时有小幅波动）', Math.round(v));
    // 多源货架真相、顺路核对（决策记录 0022）
    case 'PICKER_REPORTS':
      return t('拣货员报告找不到 {0} 次（最近一次 {1} 分钟前：{2}）', Math.round(v), Number(r.params?.ago ?? 0), t(SIGNAL_TEXT[String(r.params?.kind ?? '')] ?? ''));
    case 'MISPLACED_LIKELY':
      return t('多半是放错了地方（{0}%），不像是卖完或损坏', Math.round(v));
    case 'REPORT_RELIABILITY':
      return t('这类报告的可靠度 {0}%（从之前的核对结果学）', Math.round(v));
    case 'SHELF_UNCERTAIN':
      return t('说不准还在不在架上（找得到的概率 {0}%）', Math.round(v));
    case 'ON_THE_WAY':
      return t('拣完第 {0} 站就路过附近', Math.round(v));
    // 冷链拆批、未取订单、时段产能（决策记录 0023）
    case 'COLD_EXPOSURE':
      return t('AI 估计从第一件到送回暂存要 {0} 分钟（冷链时限 {1} 分钟）', Math.round(v), Number(r.params?.limit ?? 0));
    case 'SPLIT_INTO':
      return t('拆成 {0} 个批次，最长的约 {1} 分钟', Math.round(v), Number(r.params?.worst ?? 0));
    case 'NO_SHOW_RISK':
      return t('顾客不来的可能 {0}%', Math.round(v));
    case 'NO_ETA':
      return t('还没报预计到达');
    case 'PAST_NO_SHOWS':
      return t('以前 {0} 单里有 {1} 单没来取', Number(r.params?.orders ?? 0) + Math.round(v), Math.round(v));
    case 'ORDERED_AHEAD':
      return t('提前 {0} 小时下的单', Math.round(v));
    case 'EVENING_SLOT':
      return t('晚上最后几个时段');
    case 'RAIN':
      return t('预报下雨');
    case 'WEEKEND':
      return t('周末');
    case 'SAME_DAY':
      return t('当天临时下的单');
    case 'LOYAL':
      return t('老顾客');
    case 'NOT_PICKED_UP':
      return t('{0} 单备好了、过了取货时段 30 分钟还没来（{1} 关门）', Math.round(v), clock(Number(r.params?.close ?? 0)));
    case 'SLOT_BOOKED':
      return t('已经接了 {0} 单，估计能做 {1} 单', Math.round(v), Number(r.params?.capacity ?? 0));
    case 'PICK_CAPACITY':
      return t('拣货能做约 {0} 单（每单约 {1} 分钟）', Math.round(v), Number(r.params?.perOrder ?? 0));
    case 'HANDOFF_CAPACITY':
      return t('交付能做约 {0} 单', Math.round(v));
    // 提前下班（决策记录 0022 · D2）
    case 'NO_WORSE':
      return t('推演：少一名{0}，迟到 {1} 单、平均等待 {2} 分钟，都不变差', t(ROLE_TEXT[String(r.params?.role ?? '')] ?? ''), Math.round(v), Number(r.params?.wait ?? 0));
    case 'HOURS_THIS_WEEK':
      return t('这周已排 {0} 小时', v);
    // 到货、开门前补货、收银通道（决策记录 0022 · A3）
    case 'TRUCKS_WAITING':
      return t('{0} 辆车在排队，接下来两小时还会到 {1} 辆', Math.round(v), Number(r.params?.upcoming ?? 0));
    case 'LONGEST_WAIT':
      return t('最长要等 {0} 分钟（{1}）', Math.round(v), String(r.params?.receiptId ?? ''));
    case 'RECEIVERS':
      return t('在岗收货员 {0} 人，卸货门 {1} 个', Math.round(v), Number(r.params?.docks ?? 0));
    case 'COLD_FIRST':
      return t('{0} 车有冷藏冷冻商品：先卸', Math.round(v));
    case 'SUPPLIER_ETA':
      return t('供应商通知晚 {0} 分钟（{1} → {2}）', Math.round(v), clock(Number(r.params?.from ?? 0)), clock(Number(r.params?.to ?? 0)));
    case 'TRUCKS_AROUND':
      return t('前后 30 分钟还有 {0} 车（同时能卸 {1} 车）', Math.round(v), Number(r.params?.docks ?? 0));
    case 'CASES_TONIGHT':
      return t('开门前要上架 {0} 箱', Math.round(v));
    case 'NIGHT_CREW':
      return t('排了 {0} 人（需要 {1} 人）', Math.round(v), Number(r.params?.need ?? 0));
    case 'FINISH_AT':
      return Number(r.params?.finish ?? -1) < 0 ? t('没有排人补货') : t('照现在的人数 {0} 补完，比开门晚 {1} 分钟', hm(Number(r.params?.finish ?? 0)), Math.round(v));
    case 'ENTRANCE_RATE':
      return t('入口客流每小时约 {0} 人', Math.round(v));
    case 'FLOW_TREND':
      return v >= 0 ? t('最近 10 分钟比之前多 {0}%', Math.round(v)) : t('最近 10 分钟比之前少 {0}%', Math.abs(Math.round(v)));
    case 'SERVICE_MIN':
      return t('人工通道每位顾客约 {0} 分钟', v);
    case 'TARGET_WAIT':
      return t('目标：平均排队不超过 {0} 分钟', v);
    // 临期与损耗（决策记录 0024 · C4）
    case 'EXPIRES_IN':
      return v <= 0 ? t('{0} 到期，已经过期', String(r.params?.expiry ?? '')) : t('{0} 到期（还有 {1}）', String(r.params?.expiry ?? ''), hoursText(v));
    case 'LEFT_AT_EXPIRY':
      return t('照现在的卖法，到期时还会剩约 {0} 件（这一批 {1} 件）', Math.round(v), Number(r.params?.units ?? 0));
    default:
      return r.factor;
  }
}

/** 时长：不到 1 小时显示分钟 */
function hoursText(h: number): string {
  return h < 1 ? t('{0} 分钟', Math.max(1, Math.round(h * 60))) : t('{0} 小时', Math.round(h * 10) / 10);
}

function minutesText(r: Reason): string {
  const a = Math.round((r.effect?.amount ?? 0) * 10) / 10;
  return `${a >= 0 ? '+' : '−'}${Math.abs(a)}`;
}

function holidayName(r: Reason): string {
  const c = String(r.params?.code ?? '');
  return HOLIDAY_TEXT[c] ? t(HOLIDAY_TEXT[c]) : t('节假日');
}

function recTitle(r: LiveRec, s?: OpsState, st?: StoreStatic): string {
  if (r.module === 'FORECAST' && r.prediction?.unit === 'ORDERS') return t('接下来 {0} 小时的订单量', Number(r.action.params?.window ?? 0));
  if (r.module === 'ETA') {
    const o = s?.orders[r.target];
    return t('{0} 的到店时间', o ? `${o.firstName} ${o.lastName.slice(0, 1)}.` : r.target);
  }
  if (r.module === 'AVAILABILITY' && r.action.kind === 'SEARCH_NEARBY') return t('{0} 可能放错了地方', st ? (planogramByItem(st).get(r.target)?.name ?? r.target) : r.target);
  if (r.module === 'AVAILABILITY') return t('{0} 可能不在货架上', st ? (planogramByItem(st).get(r.target)?.name ?? r.target) : r.target);
  if (r.module === 'PICKING' && r.action.kind === 'ADD_WALK_CHECK') return t('批次 {0} 顺路数一下 {1}', String(r.action.params?.walkId ?? ''), String(r.action.params?.name ?? ''));
  if (r.module === 'COUNT') return t('建议盘点库位 {0}', r.target);
  if (r.module === 'STAFFING' && r.action.kind === 'MOVE_ASSOCIATE') {
    const name = st?.roster.find((a) => a.id === r.target)?.name ?? r.target;
    return t('建议把 {0} 从{1}调到{2}', name, t(ROLE_TEXT[String(r.action.params?.from ?? '')] ?? ''), t(ROLE_TEXT[String(r.action.params?.to ?? '')] ?? ''));
  }
  if (r.module === 'STAFFING' && r.action.params?.plan) return t('今天的排班建议');
  if (r.module === 'STAFFING' && r.target.startsWith('absence:')) {
    const p = r.action.params ?? {};
    const who = st?.roster.find((a) => a.id === p.replaces)?.name ?? String(p.replaces ?? '');
    return r.action.kind === 'OFFER_SHIFT' ? t('{0} 缺勤：找人补 {1} 的班', who, String(p.date ?? '')) : t('{0} 缺勤：{1} 的班找不到人补', who, String(p.date ?? ''));
  }
  if (r.module === 'STAFFING' && r.action.kind === 'OFFER_EARLY_LEAVE') return t('单量比预测少：可以请人自愿提前下班');
  if (r.module === 'MTO') return t('{0} 的开始时间', s?.mto[r.target]?.name ?? r.target);
  if (r.module === 'INBOUND') {
    const p = r.action.params ?? {};
    if (r.target === 'DOCK') return t('卸货门排队：最长要等 {0} 分钟', Math.round(r.prediction?.baseline ?? 0));
    if (r.target === 'NIGHT') return t('明早开门前补不完：要上架 {0} 箱', Number(p.cases ?? r.reasons.find((x) => x.factor === 'CASES_TONIGHT')?.value ?? 0));
    if (r.target.startsWith('ETA:')) return t('{0} 的到货晚 {1} 分钟', String(p.supplier ?? ''), Number(p.delayMin ?? 0));
  }
  if (r.module === 'FRONT' && r.target === 'LANES') return t('收银通道：现在开 {0} 条', Number(r.action.params?.lanes ?? 0));
  if (r.module === 'PICKING' && r.action.kind === 'SPLIT_WALK') return t('冷链批次 {0} 拆成两个', String(r.action.params?.walkId ?? ''));
  if (r.module === 'STAGING' && r.target.startsWith('noshow:')) {
    const o = s?.orders[r.target.slice(7)];
    return t('{0} 可能不来取：冷冻商品晚点拣', o ? `${o.firstName} ${o.lastName.slice(0, 1)}. · ${o.shortCode}` : r.target.slice(7));
  }
  if (r.module === 'STAGING' && r.target === 'CONTACT') return t('快关门了：{0} 单还没来取', Number(r.action.params?.count ?? 0));
  if (r.module === 'CAPACITY' && r.action.kind === 'CLOSE_SLOT') return t('{0} 的取货时段快接满了', clock(Number(r.action.params?.slotStart ?? 0)));
  if (r.module === 'EXPIRY') {
    const p = r.action.params ?? {};
    const name = st ? (planogramByItem(st).get(String(p.itemId ?? ''))?.name ?? String(p.itemId ?? '')) : String(p.itemId ?? '');
    const lot = String(p.lot ?? '');
    if (p.expired) return t('{0}（批号 {1}）已经过期', name, lot);
    if (r.action.kind === 'MARKDOWN') return t('{0}（批号 {1}）快到期：建议降价 {2}%', name, lot, Math.round(Number(p.pct ?? 0) * 100));
    if (r.action.kind === 'DONATE') return t('{0}（批号 {1}）到期前卖不完：建议捐赠', name, lot);
    return t('{0}（批号 {1}）快到期：建议放到显眼位置', name, lot);
  }
  if (r.module === 'EQUIPMENT') {
    const name = st ? sensorName(sensorsFor(st).find((d) => d.id === r.target), r.target) : r.target;
    return r.action.params?.reason === 'STUCK' ? t('{0} 读数卡住：建议报修传感器', name) : t('{0} 在慢慢变坏：建议报修', name);
  }
  if (r.module === 'FORESIGHT') {
    const at = Number(r.action.params?.at ?? r.prediction?.from ?? 0);
    const b = r.prediction?.baseline ?? 0;
    if (r.target === 'LATE') return t('预计 {0} 起有 {1} 单赶不上取货时段', clock(at), Math.round(b));
    if (r.target === 'WAIT') return t('预计 {0} 前后顾客平均要等 {1} 分钟', clock(at), Math.round(b * 10) / 10);
    if (r.target === 'COLD_FULL') return t('冷区暂存会到 {0}%', Math.round(b * 100));
    if (r.target === 'BACKLOG') return t('拣货积压会到 {0} 分钟', Math.round(b));
  }
  return t(MODULE_TEXT[r.module]);
}

/** 建议要做的事（运营预警的各种办法，决策记录 0021） */
export function actionText(a: { kind: string; params?: Record<string, string | number | boolean> | undefined }, st?: StoreStatic): string {
  const p = a.params ?? {};
  const n = Number(p.count ?? String(p.orderIds ?? '').split(',').filter(Boolean).length);
  switch (a.kind) {
    case 'MOVE_ASSOCIATE':
      return (
        t('现在把 {0} 从{1}调到{2}（约 {3} 小时）', st?.roster.find((x) => x.id === p.associateId)?.name ?? String(p.associateId ?? ''), t(ROLE_TEXT[String(p.from ?? '')] ?? ''), t(ROLE_TEXT[String(p.to ?? '')] ?? ''), Number(p.hours ?? 1)) +
        (p.order ? t('；收货顺序 {0}', String(p.order).split(',').join(' → ')) : '')
      );
    case 'EXPEDITE_ORDERS':
      return t('提前开始 {0} 单（不等锁单时间，批次排在最前）', n);
    case 'DEFER_FROZEN':
      return p.noShow ? t('这单的冷冻商品 {0}（取货前 20 分钟）再拣，顾客来了再拣也来得及', clock(Number(p.until ?? 0))) : t('{0} 单的冷冻商品 {1} 之后再拣', n, clock(Number(p.until ?? 0)));
    case 'NOTIFY_DELAY':
      return t('通知 {0} 位顾客会晚 {1} 分钟', n, Number(p.minutes ?? 0));
    case 'REQUEST_REPAIR': {
      const n = String(p.slots ?? '').split(',').filter(Boolean).length;
      return n ? t('开报修单，这台设备的 {0} 个暂存格位暂停放新框（已经在里面的框照常取出）', n) : t('开报修单');
    }
    case 'OFFER_SHIFT':
      return t('请 {0} {1} {2}–{3} 上{4}（发邀请，本人接受后生效）', st?.roster.find((x) => x.id === p.associateId)?.name ?? String(p.associateId ?? ''), String(p.date ?? ''), hm(Number(p.from ?? 0)), hm(Number(p.to ?? 0)), t(ROLE_TEXT[String(p.role ?? '')] ?? ''));
    case 'OFFER_EARLY_LEAVE':
      return t('问 {0} 愿不愿意 {1} 下班（自愿）', st?.roster.find((x) => x.id === p.associateId)?.name ?? String(p.associateId ?? ''), hm(Number(p.from ?? 0)));
    case 'SEARCH_NEARBY': {
      const near = String(p.near ?? '').split(',').filter(Boolean);
      return near.length ? t('请一位同事先看原货位 {0}，再看同一通道的 {1}', locationText(String(p.locationId ?? '')), nearText(near)) : t('请一位同事到货位 {0} 附近找一找', locationText(String(p.locationId ?? '')));
    }
    case 'SPLIT_WALK':
      return t('拆成两个批次（按订单在路线上的先后），各自不超过冷链时限');
    case 'HAND_OVER':
      return t('剩下没拣的行转给别人（补新框），先把已经拣好的框送回暂存');
    case 'CLOSE_SLOT':
      return t('{0}–{1} 的时段停止接新单（已经接的单照常做）{2}', clock(Number(p.slotStart ?? 0)), clock(Number(p.slotEnd ?? 0)), p.later ? t('；{0} 的时段还能接约 {1} 单', clock(Number(p.later)), Number(p.laterLeft ?? 0)) : '');
    case 'ADD_WALK_CHECK':
      return t('拣货员拣完第 {0} 站后顺手数一下货位 {1}', Number(p.afterStop ?? 0) + 1, locationText(String(p.locationId ?? '')));
    // 临期与损耗（决策记录 0024 · C4）
    case 'MARKDOWN':
      return t('这一批 {0} 件（{1} 到期）降价 {2}%，贴上临期价签', Number(p.units ?? 0), String(p.expiry ?? ''), Math.round(Number(p.pct ?? 0) * 100));
    case 'DONATE':
      return t('到期前把这一批 {0} 件（{1} 到期）下架，交给合作的捐赠机构', Number(p.units ?? 0), String(p.expiry ?? ''));
    case 'INFO':
      if (p.callIn) return t('请一名{0}提前来或延长到 {1}（需要店长安排）', t(ROLE_TEXT[String(p.role ?? '')] ?? ''), clock(Number(p.until ?? 0)));
      // 到货、开门前补货、收银通道（决策记录 0022 · A3）
      if (p.receiptId && p.delayMin !== undefined) return t('{0} → {1}；前后 30 分钟还有 {2} 车，同时能卸 {3} 车', clock(Number(p.from ?? 0)), clock(Number(p.to ?? 0)), Number(p.overlap ?? 0), Number(p.docks ?? 0));
      if (p.order) return t('按这个顺序收货（冷藏冷冻优先）：{0}', String(p.order).split(',').join(' → '));
      if (p.need !== undefined) return t('需要 {0} 人（现在排了 {1} 人{2}）：请店长安排', Number(p.need), Number(p.crew ?? 0), p.finish !== undefined ? t('，预计 {0} 补完，开门 {1}', hm(Number(p.finish)), hm(Number(p.open ?? 0))) : '');
      if (p.orderIds && p.close) return t('打电话或发消息问问这 {0} 位顾客还来不来；确认不来的由门店管理员取消（记为未取）', String(p.orderIds).split(',').filter(Boolean).length);
      if (p.lanes !== undefined)
        return Number(p.next) > Number(p.lanes)
          ? t('{0} 起需要 {1} 条人工收银通道（每小时约 {2} 位顾客）：{3} 前叫人', clock(Number(p.at ?? 0)), Number(p.next), Number(p.nextPerHour ?? 0), clock(Number(p.callAt ?? p.at ?? 0)))
          : t('每小时约 {0} 位顾客结账：开 {1} 条人工通道，平均排队约 {2} 分钟（一共 {3} 条）', Number(p.perHour ?? 0), Number(p.lanes), Number(p.wait ?? 0), Number(p.manual ?? 0));
      if (p.nobody) return t('{0}–{1} 的{2}班找不到能补的人：考虑调整其他人的班或少接单', hm(Number(p.from ?? 0)), hm(Number(p.to ?? 0)), t(ROLE_TEXT[String(p.role ?? '')] ?? ''));
      if (p.expired) return t('这一批 {0} 件已经过了保质期（{1}）：马上下架，不能再卖', Number(p.units ?? 0), String(p.expiry ?? ''));
      if (p.visible) return t('把这一批 {0} 件（{1} 到期）挪到货架最前面，先卖它', Number(p.units ?? 0), String(p.expiry ?? ''));
      return '';
    default:
      return a.kind;
  }
}

/** 运营预警的预计效果：采纳前后推演里的迟到订单、平均等待、冷区占用 */
function ForesightEffect({ rec }: { rec: LiveRec }) {
  const p = rec.action.params ?? {};
  const rows: Array<[string, number, number, (v: number) => string]> = [
    ['赶不上取货时段', Number(p.lateBefore ?? 0), Number(p.lateAfter ?? 0), (v) => t('{0} 单', Math.round(v))],
    ['顾客平均等待', Number(p.waitBefore ?? 0), Number(p.waitAfter ?? 0), (v) => t('{0} 分钟', Math.round(v * 10) / 10)],
    ['冷区暂存峰值', Number(p.coldBefore ?? 0), Number(p.coldAfter ?? 0), (v) => `${Math.round(v * 100)}%`],
  ];
  return (
    <table className="ai-effect">
      <thead>
        <tr>
          <th>{t('预计效果（推演）')}</th>
          <th>{t('不处理')}</th>
          <th>{t('采纳后')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b, fmt]) => (
          <tr key={label}>
            <td>{t(label)}</td>
            <td className="mono">{fmt(a)}</td>
            <td className={`mono ${b < a - 1e-9 ? 'good-text' : b > a + 1e-9 ? 'warn-text' : ''}`}>{fmt(b)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 订单量展望（决策记录 0021 · A1）：接下来几个小时的预计单数（已按今天的实际修正） */
function OutlookCard() {
  const { client } = useLive();
  const now = useNow(60_000);
  const ol = client.state.outlook;
  if (!ol) return null;
  const hours = ol.hours.filter((h) => h.t + 3_600_000 > now).slice(0, 4);
  if (!hours.length) return null;
  const max = Math.max(1, ...hours.map((h) => h.high));
  return (
    <section className="card outlook">
      <div className="card-head">
        <span className="tag">{t('订单量展望')}</span>
        <span className="strong">{t('接下来 {0} 小时约 {1} 单', hours.length, Math.round(hours.reduce((a, h) => a + h.mean, 0)))}</span>
        <span className="due">{clock(ol.at)}</span>
      </div>
      <div className="outlook-bars">
        {hours.map((h) => (
          <div key={h.t} title={t('80% 区间 {0}–{1}', Math.round(h.low), Math.round(h.high))}>
            <i style={{ height: `${(h.mean / max) * 100}%` }} />
            <b className="mono">{Math.round(h.mean)}</b>
            <small>{new Date(h.t).getHours()}:00</small>
          </div>
        ))}
      </div>
      <p className="note">{Math.abs(ol.correction - 1) >= 0.02 ? t('按今天的实际修正 ×{0}（最近观察到 {1} 单，原来预测 {2} 单）。推演、补货优先级都用这条线。', ol.correction, ol.observed, Math.round(ol.expected)) : t('今天的实际和预测差不多。推演、补货优先级都用这条线。')}</p>
    </section>
  );
}

function unitText(unit: string): string {
  return unit === 'ORDERS' ? t('单') : unit === 'MINUTES' || unit === 'SECONDS' ? t('分钟') : unit === 'LANES' ? t('条通道') : '';
}

/** 预测值的显示：概率显示为百分比，秒换成分钟 */
function valueText(unit: string, v: number): string {
  if (unit === 'SECONDS') return String(Math.round(v / 60));
  return unit === 'PROBABILITY' ? pct(v) : String(Math.round(v));
}

export function AiScreen() {
  const [tab, setTab] = useState<'recs' | 'schedule' | 'field' | 'ask' | 'modes' | 'models'>('recs');
  // 提醒直接打开某个子页、滚到那条建议（决策记录 0026）
  useIntent('aiTab', setTab);
  useIntent('recId', (id) => {
    setTab('recs');
    window.setTimeout(() => document.getElementById(`rec-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
  });
  const { client } = useLive();
  const open = openRecs(client.state).length;
  const tabs: [typeof tab, string][] = [
    ['recs', '建议'],
    ['schedule', '排班'],
    ['field', '现场'],
    ['ask', '问答'],
    ['modes', '模式与统计'],
    ['models', '模型'],
  ];
  return (
    <div className="ai">
      <div className="segmented wide" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(label)}
            {k === 'recs' && open > 0 && <em>{open}</em>}
          </button>
        ))}
      </div>
      {tab === 'recs' ? <RecsView /> : tab === 'schedule' ? <ScheduleView /> : tab === 'field' ? <FieldScreen /> : tab === 'ask' ? <AskPanel /> : tab === 'modes' ? <ModesView /> : <ModelsView />}
    </div>
  );
}

function RecsView() {
  const { client, auth } = useLive();
  // 按紧急程度排（决策记录 0026）：标了紧急的、要执行的、设备和运营预警在前
  const open = recsByUrgency(client.state);
  const recent = recentRecs(client.state, 10);
  const lead = canManageAi(client.statics as StoreStatic, auth.actor);
  return (
    <div className="list">
      {canManageAi(client.statics as StoreStatic, auth.actor) && (
        <>
          <BriefCard />
          <ReviewCard />
          <WeeklyCard />
        </>
      )}
      <OutlookCard />
      {open.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{t('暂时没有待处理的建议')}</p>
          <p>{t('AI 每小时会发出一次订单量预测；带班负责人可以在「模型」里立即预测。')}</p>
        </div>
      ) : (
        open.map((r) => <RecCard key={r.id} rec={r} />)
      )}
      {/* 停止接单不用再去「模型」页找（决策记录 0026） */}
      {lead && <CapacityCard compact />}
      {recent.length > 0 && (
        <>
          <h2 className="section-title">{t('最近处理')}</h2>
          <section className="card">
            <ul className="plain ai-history">
              {recent.map((r) => (
                <li key={r.id}>
                  <span className="mono">{clock(r.issuedAt)}</span> {recTitle(r, client.state, client.statics)}
                  {r.prediction && (
                    <b>
                      {' '}
                      · {valueText(r.prediction.unit, r.prediction.value)} {unitText(r.prediction.unit)}
                    </b>
                  )}
                  <span className={`tag ${r.status === 'ACCEPTED' || r.status === 'AUTO_APPLIED' ? 'ok' : ''}`}>{t(STATUS_TEXT[r.status])}</span>
                  {r.reason && <span className="muted">{t(REASON_TEXT[r.reason])}</span>}
                  {r.outcome && <span className={`tag ${r.outcome.hit ? 'ok' : 'warn-tag'}`} title={t('效果追踪：事后从事件记录算出的实际值')}>{outcomeText(r)}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/** 这些模块的建议在卡片上写出要做的事（运营预警、设备、排班另有专门的显示） */
const GENERIC_ACTION = new Set<string>(['INBOUND', 'FRONT', 'PICKING', 'STAGING', 'CAPACITY', 'EXPIRY']);

/** 快关门了还没来取的订单（决策记录 0023 · B5）：门店管理员确认顾客不来时取消，记为未取（之后的风险会算上） */
function ContactList({ rec }: { rec: LiveRec }) {
  const { client, auth, run } = useLive();
  const ids = String(rec.action.params?.orderIds ?? '').split(',').filter(Boolean);
  return (
    <ul className="plain contact-list">
      {ids.map((id) => {
        const o = client.state.orders[id];
        if (!o) return null;
        return (
          <li key={id}>
            <span className="grow">
              {o.firstName} {o.lastName.slice(0, 1)}. · <span className="mono">{o.shortCode}</span> · {t('取货时段 {0}', clock(o.slotStart))}
            </span>
            {o.status === 'CANCELLED' ? (
              <span className="tag">{t('已取消')}</span>
            ) : o.status === 'COMPLETED' ? (
              <span className="tag ok">{t('已取走')}</span>
            ) : auth.role === 'console' ? (
              <button className="link danger" onClick={() => void run({ type: 'CancelOrder', orderId: id, reason: 'NO_SHOW' })}>
                {t('顾客不来了：取消（记为未取）')}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RecCard({ rec }: { rec: LiveRec }) {
  const { client, auth, run } = useLive();
  const st = client.statics as StoreStatic;
  const can = canManageAi(st, auth.actor);
  const now = useNow(30_000);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState<OverrideReason | undefined>();
  const [note, setNote] = useState('');
  // 决策记录 0026：涉及人、钱、顾客的动作点两下（先看清要做什么）；补班邀请默认被拒后自动问下一个人
  const [confirming, setConfirming] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const p = rec.prediction;
  const info = rec.action.kind === 'INFO';
  // 只显示的建议：「有用」不执行动作
  const show = rec.mode === 'SHOW';
  // 情况已经变了、动作做不了的建议：只留「收起」（节拍也会自动收起）
  const stale = !show && !!st && recStale(client.state, rec, st, now);
  const careful = !show && CONFIRM_ALWAYS.has(rec.action.kind);
  const offer = rec.action.kind === 'OFFER_SHIFT';
  const accept = () => void run({ type: 'AcceptRecommendation', recId: rec.id, ...(offer && autoNext ? { autoNext: true } : {}) });
  const vsUsual = p?.baseline ? (p.value - p.baseline) / p.baseline : undefined;
  return (
    <article className="card ai-rec" id={`rec-${rec.id}`}>
      <div className="card-head">
        <span className="tag">{t(MODULE_TEXT[rec.module])}</span>
        <span className="strong">{recTitle(rec, client.state, client.statics)}</span>
        <span className="due">{p?.from !== undefined && p.to !== undefined ? `${clock(p.from)}–${clock(p.to)}` : ''}</span>
      </div>
      {p && rec.module !== 'FORESIGHT' && (
        <div className="ai-big">
          <b>{valueText(p.unit, p.value)}</b>
          <span>
            {p.unit === 'PROBABILITY' ? (rec.module === 'COUNT' ? t('记录不准的概率') : rec.module === 'STAGING' ? t('顾客不来的概率') : rec.action.kind === 'SEARCH_NEARBY' ? t('放错了地方的概率') : t('货架上找得到的概率')) : unitText(p.unit)}
            {rec.module === 'EQUIPMENT' && <small>{t('后预计越过告警线')}</small>}
            {rec.module === 'STAFFING' && p.unit === 'MINUTES' && <small>{t('调动后预计的平均等待')}</small>}
            {p.low !== undefined && p.high !== undefined && <small>{t('80% 区间 {0}–{1}', Math.round(p.low), Math.round(p.high))}</small>}
          </span>
          {vsUsual !== undefined && p.unit === 'ORDERS' && rec.module === 'FORECAST' && (
            <em className={vsUsual >= 0 ? 'up' : 'down'}>{t('比近 4 周同时段 {0}', `${vsUsual >= 0 ? '+' : '−'}${Math.abs(Math.round(vsUsual * 100))}%`)}</em>
          )}
          {p.unit === 'MINUTES' && p.baseline !== undefined && rec.module === 'ETA' && <em className={p.value >= p.baseline ? 'up' : 'down'}>{t('顾客报 {0} 分钟', Math.round(p.baseline))}</em>}
          {p.unit === 'MINUTES' && p.baseline !== undefined && rec.module === 'STAFFING' && <em className="down">{t('调动前 {0} 分钟', Math.round(p.baseline * 10) / 10)}</em>}
        </div>
      )}
      {rec.module === 'FORESIGHT' && (
        <>
          <p className="ai-action">
            <b>{t('建议：')}</b>
            {actionText(rec.action, client.statics)}
          </p>
          <ForesightEffect rec={rec} />
        </>
      )}
      {rec.module === 'EQUIPMENT' && (
        <p className="ai-action">
          <b>{t('建议：')}</b>
          {actionText(rec.action, client.statics)}
        </p>
      )}
      {rec.module === 'STAFFING' && (rec.action.kind === 'OFFER_SHIFT' || rec.action.kind === 'OFFER_EARLY_LEAVE' || rec.action.params?.nobody) && (
        <p className="ai-action">
          <b>{t('建议：')}</b>
          {actionText(rec.action, client.statics)}
          {rec.alternatives.length > 0 && !(can && offer) && <small className="block-note">{t('其他人选：{0}', rec.alternatives.map((a) => client.statics?.roster.find((x) => x.id === a.action.params?.associateId)?.name ?? '').filter(Boolean).join('、'))}</small>}
        </p>
      )}
      {can && offer && !stale && (
        <div className="offer-options">
          <label className="toggle">
            <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} />
            <span>{t('被拒后自动问下一个人（不用每次再采纳）')}</span>
          </label>
          {rec.alternatives.length > 0 && (
            <div className="chips">
              {rec.alternatives.map((a) => {
                const ap = a.action.params ?? {};
                const id = String(ap.associateId ?? '');
                return (
                  <button
                    key={id}
                    className="chip"
                    onClick={() =>
                      void run({ type: 'SendShiftOffer', associateId: id, date: String(ap.date ?? ''), from: Number(ap.from), to: Number(ap.to), ...(ap.role ? { role: String(ap.role) as AssociateRole } : {}), ...(ap.replaces ? { replaces: String(ap.replaces) } : {}), recId: rec.id, ...(autoNext ? { autoNext: true } : {}) })
                    }
                  >
                    {t('改发给 {0}', client.statics?.roster.find((x) => x.id === id)?.name ?? id)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {rec.module === 'STAFFING' && rec.action.params?.plan && <StaffPlanTable rec={rec} />}
      {(GENERIC_ACTION.has(rec.module) || rec.action.kind === 'SEARCH_NEARBY') &&
        (() => {
          const a = actionText(rec.action, client.statics);
          return a && a !== rec.action.kind ? (
            <p className="ai-action">
              <b>{t('建议：')}</b>
              {a}
            </p>
          ) : null;
        })()}
      {rec.module === 'STAGING' && rec.target === 'CONTACT' && <ContactList rec={rec} />}
      {p?.breakdown && p.breakdown.unit === 'LINES' && (
        <p className="note">
          {t(
            '预计商品行：{0}',
            Object.entries(p.breakdown.values)
              .map(([z, n]) => `${ZONE_TEXT[z] ? t(ZONE_TEXT[z]) : z} ${n}`)
              .join(' · '),
          )}
        </p>
      )}
      <div className="ai-conf" title={t('置信度')}>
        <span>{t('置信度 {0}', pct(rec.confidence))}</span>
        <i style={{ width: pct(rec.confidence) }} />
      </div>
      <h3 className="ai-sub">{t('主要理由')}</h3>
      <ul className="plain ai-reasons">
        {rec.reasons.map((r) => (
          <li key={r.factor}>
            <span>{reasonText(r)}</span>
            <i style={{ width: pct(Math.max(0.04, r.weight)) }} />
          </li>
        ))}
      </ul>
      {rec.module === 'FORESIGHT' && rec.alternatives.length > 0 && (
        <p className="note">
          {t(
            '其他办法：{0}',
            rec.alternatives.map((a) => `${actionText(a.action, client.statics)}（${rec.target === 'COLD_FULL' ? `${Math.round(Number(a.action.params?.after ?? 0) * 100)}%` : Math.round(Number(a.action.params?.after ?? 0) * 10) / 10}）`).join(' · '),
          )}
        </p>
      )}
      {rec.module !== 'FORESIGHT' && rec.alternatives.length > 0 && (
        <p className="note">
          {t(
            '其他模型：{0}',
            rec.alternatives.map((a) => `${kindText(String(a.action.params?.model ?? ''))} ${valueText(p?.unit ?? '', Number(a.action.params?.value ?? 0))}`).join(' · '),
          )}
        </p>
      )}
      <p className="note">
        {t('模型 {0} v{1} · {2} · {3}', rec.model.id, rec.model.version, kindText(rec.model.kind), t(MODE_TEXT[rec.mode]))}
      </p>
      {can && show && !info && <p className="note">{t('只显示：点「有用」不会执行；要执行，请到「模式与统计」把这个模块改成需确认')}</p>}
      {can &&
        (stale ? (
          <div className="actions">
            <span className="tag warn-tag">{t('已过时')}</span>
            <span className="muted">{t('情况已经变了，这条建议做不了')}</span>
            <button className="link" onClick={() => void run({ type: 'DismissRecommendation', recId: rec.id }, { quiet: true })}>
              {t('收起')}
            </button>
          </div>
        ) : confirming ? (
          <div className="ai-confirm" role="alertdialog" aria-label={t('确认执行')}>
            <p className="strong">{t('确认执行：{0}', actionText(rec.action, client.statics))}</p>
            <p className="note">{t('涉及人、钱或顾客的动作，执行后撤不回')}</p>
            <div className="actions">
              <button onClick={() => setConfirming(false)}>{t('取消')}</button>
              <button className="primary" onClick={accept}>
                {t('确认执行')}
              </button>
            </div>
          </div>
        ) : overriding ? (
          <div className="ai-override">
            <p className="strong">{info || show ? t('哪里不准？') : t('为什么不采纳？')}</p>
            <div className="chips">
              {OVERRIDE_REASONS.map((r) => (
                <button key={r} className={`chip${reason === r ? ' on' : ''}`} onClick={() => setReason(r)}>
                  {t(REASON_TEXT[r])}
                </button>
              ))}
            </div>
            <input className="ai-note" value={note} maxLength={200} placeholder={t('补充说明（可选）')} onChange={(e) => setNote(e.target.value)} />
            <div className="actions">
              <button onClick={() => setOverriding(false)}>{t('取消')}</button>
              <button
                className="primary"
                disabled={!reason}
                onClick={() => reason && void run({ type: 'OverrideRecommendation', recId: rec.id, reason, ...(note.trim() ? { note: note.trim() } : {}) })}
              >
                {t('提交')}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button className="primary" onClick={careful ? () => setConfirming(true) : accept}>
              {info || show ? t('有用') : t('采纳')}
            </button>
            <button onClick={() => setOverriding(true)}>{info || show ? t('不准') : t('否决')}</button>
            <button className="link" onClick={() => void run({ type: 'DismissRecommendation', recId: rec.id }, { quiet: true })}>
              {t('忽略')}
            </button>
          </div>
        ))}
    </article>
  );
}

function ModesView() {
  const { client, auth, run } = useLive();
  const s = client.state;
  const isConsole = auth.role === 'console';
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  return (
    <div className="list">
      <NudgeStatsView />
      <p className="note">{t('调配人员、把人放进固定名单（AI 不建议调动）：点顶栏的「在岗」按钮（👥）。')}</p>
      <h2 className="section-title">{t('运行模式')}</h2>
      <p className="note">{t('只显示：AI 给出信息；需确认：员工采纳后才执行；自动执行：AI 直接执行并记录。锁定的模块只有门店管理员可以修改。')}</p>
      <p className="note">{t('涉及人、钱、顾客的动作（调人、补班和提前下班的邀请、通知顾客晚到、降价、捐赠、停止接单）即使设成自动执行，也要人确认。')}</p>
      <p className="note">{t('效果追踪：建议的时间段过去、或者对应的任务做完后，AI 从事件记录算出同一个指标的实际值。连续不准时自动降成只显示。这是观察数据：带班负责人更愿意采纳有把握的建议，采纳的和没采纳的不能直接比较。')}</p>
      {AI_MODULES.map((m) => {
        const cur = aiModeOf(s, m);
        const st = s.aiModes[m];
        const locked = !!st?.locked;
        const stats = s.aiStats[m];
        const rate = adoptionRate(stats);
        return (
          <section key={m} className="card ai-mode">
            <div className="card-head">
              <span className="strong">{t(MODULE_TEXT[m])}</span>
              {locked && <span className="tag">{t('已锁定')}</span>}
              <span className="due">{stats ? t('发出 {0} 条 · 采纳率 {1}', stats.issued, rate === undefined ? '—' : pct(rate)) : t('还没有建议')}</span>
            </div>
            <div className="segmented">
              {AI_MODES.map((mode) => (
                <button key={mode} className={cur === mode ? 'on' : ''} disabled={!can || (locked && !isConsole)} onClick={() => void run({ type: 'SetAiMode', module: m, mode }, { quiet: true })}>
                  {t(MODE_TEXT[mode])}
                </button>
              ))}
            </div>
            {isConsole && (
              <button className="link" onClick={() => void run({ type: 'SetAiMode', module: m, mode: cur, locked: !locked }, { quiet: true })}>
                {locked ? t('解锁') : t('锁定')}
              </button>
            )}
            {st?.auto && cur === 'SHOW' && <p className="banner warn">{t('效果追踪：最近 {0} 次只有 {1} 达到预计效果，已自动改为只显示。确认原因后可以改回来。', st.auto.n, pct(st.auto.hitRate))}</p>}
            <OutcomeLine stats={stats} />
            {stats && stats.OVERRIDDEN > 0 && (
              <p className="note">
                {t(
                  '否决原因：{0}',
                  Object.entries(stats.reasons)
                    .sort((a, b) => b[1] - a[1])
                    .map(([r, n]) => `${t(REASON_TEXT[r as OverrideReason] ?? r)} ×${n}`)
                    .join(' · '),
                )}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** 建议中枢的统计（决策记录 0021 · G1）：最近一小时发了多少提醒、平均每人几条、多久处理、过期没处理的比例 */
function NudgeStatsView() {
  const { client, auth } = useLive();
  const now = useNow(30_000);
  const [deferred, setDeferred] = useState<Record<string, number> | undefined>();
  useEffect(() => {
    void ai
      .nudges(auth)
      .then((r) => setDeferred(r.deferred))
      .catch(() => undefined);
  }, [now]);
  const st = nudgeStats(client.state, now);
  const nameOf = (id: string) => (id === 'console' ? t('门店管理员') : (client.statics?.roster.find((a) => a.id === id)?.name ?? id));
  return (
    <>
      <h2 className="section-title">{t('提醒')}</h2>
      <section className="card">
        <div className="facts">
          <span>
            {t('最近一小时')} <b>{st.lastHour}</b>
          </span>
          <span>
            {t('紧急')} <b>{st.urgentLastHour}</b>
          </span>
          <span>
            {t('平均每人')} <b>{st.perPerson}</b>
          </span>
          <span>
            {t('读的中位数')} <b>{st.medianReadSec !== undefined ? t('{0} 秒', st.medianReadSec) : '—'}</b>
          </span>
          <span>
            {t('处理完的中位数')} <b>{st.medianCloseSec !== undefined ? t('{0} 秒', st.medianCloseSec) : '—'}</b>
          </span>
          <span>
            {t('过期没处理')} <b>{st.expiredShare !== undefined ? pct(st.expiredShare) : '—'}</b>
          </span>
        </div>
        {st.byPerson.length > 0 && <p className="note">{st.byPerson.map((x) => `${nameOf(x.to)} ${x.count}`).join(' · ')}</p>}
        {deferred && (
          <p className="note">{t('先不发的（累计）：正在交付 {0} · 超出每小时预算 {1} · 营业时间外 {2}', deferred.BUSY ?? 0, deferred.BUDGET ?? 0, deferred.NIGHT ?? 0)}</p>
        )}
        <p className="note">{t('紧急的马上发；正在交付、核验取货码、冷链计时快到的人先不打扰；每人每小时最多 3 条非紧急提醒；同一通道、同一台设备、同一个模块的合成一条。')}</p>
      </section>
    </>
  );
}

/** 人员：当前岗位、临时调动、固定名单（锁定后 AI 不会建议调动这个人） */
function ModelsView() {
  const { client, auth } = useLive();
  const can = canManageAi(client.statics as StoreStatic, auth.actor);
  const [data, setData] = useState<AiSummary | undefined>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    ai
      .models(auth)
      .then(setData)
      .catch((e: unknown) => toast(String(e), 'error'));
  useEffect(() => {
    void load();
  }, []);
  const act = async (fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(ok(r as never), 'ok');
      await load();
    } catch (e) {
      toast(String(e).includes('nothing_to_roll_back') ? t('没有可以回滚的版本') : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <p className="muted center">{t('正在载入模型…')}</p>;
  const trained = (r: { promoted: boolean; best: number }) => (r.promoted ? t('v{0} 已上线', r.best) : t('v{0} 没有通过上线检查，保留当前版本', r.best));
  return (
    <div className="list">
      <AiHealthCard />
      {FAMILIES.map((f) => (
        <FamilySection key={f.id} family={f} models={data.models.filter((m) => m.id === f.id)} />
      ))}
      <MaintenanceStats />
      {data.shelfTruth && <ShelfTruthStats data={data.shelfTruth} />}
      {data.substitution && <SubstitutionLive data={data.substitution} />}
      <CapacityCard />
      {can && (
        <div className="actions ai-actions">
          <button className="primary" disabled={busy} onClick={() => void act(() => ai.forecast(auth), () => t('已发出预测'))}>
            {t('立即预测')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.scan(auth), (r: { shelves: number; counts: number }) => t('发出 {0} 条核对货架、{1} 条盘点建议', r.shelves, r.counts))}>
            {t('立即检查货架与盘点风险')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.foresight(auth), (r: { problems: unknown[] }) => (r.problems.length ? t('推演发现 {0} 个问题，已发出运营预警', r.problems.length) : t('推演：接下来两小时没有问题')))}>
            {t('立即用推演看一次')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.retrain(auth), trained)}>
            {t('重新训练')}
          </button>
          <button disabled={busy} onClick={() => void act(() => ai.retrain(auth, ['seasonal-naive']), trained)}>
            {t('用较弱的模型测试上线检查')}
          </button>
          <button className="link danger" disabled={busy} onClick={() => void act(() => ai.rollback(auth), (r: { champion?: number }) => t('已回滚到 v{0}', r.champion ?? 0))}>
            {t('回滚订单量模型')}
          </button>
        </div>
      )}
    </div>
  );
}

/** 预测性维护的命中情况（决策记录 0022）：AI 发起的报修里，修好时确认有故障的比例 */
function MaintenanceStats() {
  const { client } = useLive();
  const m = maintenanceStats(client.state);
  return (
    <>
      <h2 className="section-title">{t('设备健康（预测性维护）')}</h2>
      <section className="card">
        <p>{m.predicted ? t('AI 发起的报修关单 {0} 次，修好时确认有故障 {1} 次（命中率 {2}）；未关单 {3} 张。', m.predicted, m.confirmed, pct(m.confirmed / m.predicted), m.open) : t('还没有关单的 AI 报修；未关单 {0} 张。', m.open)}</p>
        <p className="note">{t('做法：每台设备和自己的平时比，看底线温度的趋势（稳健回归）、开门后的回温、读数是否卡住，估计多久越过告警线。关单时选的实际故障就是评估和改进的标签。')}</p>
      </section>
    </>
  );
}

/** 拣货员报告的种类（决策记录 0022 · C1） */
const SIGNAL_TEXT: Record<string, string> = {
  NOT_FOUND_EMPTY: '找不到 · 空架',
  NOT_FOUND_ELSEWHERE: '找不到 · 不在原位',
  NOT_FOUND_DAMAGED: '找不到 · 损坏',
  NOT_FOUND_TAG: '找不到 · 价签不对',
  NOT_FOUND_OTHER: '找不到 · 其他',
  PICKED_OK: '拣到了',
};

/** 多源货架真相：各种拣货员报告的可靠度（从「报告之后员工去数的结果」学） */
function ShelfTruthStats({ data }: { data: NonNullable<AiSummary['shelfTruth']> }) {
  return (
    <>
      <h2 className="section-title">{t('货架真相（拣货员报告）')}</h2>
      <section className="card">
        <p>{t('正在跟踪 {0} 件商品的最近报告。可靠度：报告之后员工去数，结果和报告一致的比例（起点相当于看过 10 次）。', data.tracked)}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('报告')}</th>
                <th>{t('对 / 错')}</th>
                <th>{t('可靠度')}</th>
              </tr>
            </thead>
            <tbody>
              {data.reliability.map((r) => (
                <tr key={r.kind}>
                  <td>{t(SIGNAL_TEXT[r.kind] ?? r.kind)}</td>
                  <td className="mono">
                    {r.hit} / {r.miss}
                  </td>
                  <td className="mono">{pct(r.r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t('做法：收银沉默给出起点，每条「找不到」按它的可靠度降低「货架上有」的把握，「拣到了」提高；越旧的报告分量越轻。多半放错了地方时发「附近找一找」，说不准时请路过的拣货员顺手数一下。')}</p>
      </section>
    </>
  );
}

function metricText(k: string, v: number | undefined, minutes: boolean): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  if (k === 'ece') return `${(v * 100).toFixed(1)}%`;
  if (PERCENT_METRICS.has(k)) return pct(v);
  if (k === 'meanDetectDays') return t('{0} 天', v.toFixed(1));
  if (k === 'brier' || k === 'auc' || k === 'ndcg3') return v.toFixed(3);
  if (k === 'avgInaccurate') return v.toFixed(1);
  return minutes && (k === 'mae' || k === 'maeRepeat' || k === 'bias') ? t('{0} 分钟', v.toFixed(1)) : v.toFixed(2);
}

function FamilySection({ family, models }: { family: (typeof FAMILIES)[number]; models: AiModelInfo[] }) {
  const champ = models.find((m) => m.status === 'CHAMPION');
  const latest = [...models].sort((a, b) => b.trainedAt - a.trainedAt || b.version - a.version);
  const lastGate = latest.find((m) => m.gate && m.gate.checks.length > 0);
  return (
    <>
      <h2 className="section-title">{t(family.title)}</h2>
      {champ && (
        <section className="card">
          <div className="card-head">
            <span className="strong">{t('当前版本 v{0}', champ.version)}</span>
            <span className="tag ok">{kindText(champ.kind)}</span>
            <span className="due">{new Date(champ.trainedAt).toLocaleDateString()}</span>
          </div>
          <p className="note">
            {family.id === 'substitution'
              ? t('仿真预训练：合成替代记录（顾客有忠于品牌、对价格敏感、坚持有机等模型看不到的偏好）')
              : family.id === 'no-show'
              ? t('仿真预训练：{0} 天的合成自取订单（顾客有模型看不到的爽约倾向）', champ.data.days)
              : family.id === 'shelf-availability'
              ? t('仿真预训练：{0} 天的合成货架真实存量（含模型看不到的整批丢失、放错位置和零星损耗）', champ.data.days)
              : family.id === 'count-risk'
                ? t('仿真预训练：{0} 天的后仓记录（前一半用 ABC 周期盘点积累训练数据，后一半两种策略对比）', champ.data.days)
                : family.minutes
              ? t('仿真预训练：最近 {0} 天的合成到店记录（顾客习惯、高峰、天气，以及模型看不到的顺路办事）', champ.data.days)
              : champ.data.source === 'SIM'
                ? t('仿真预训练：用本店配置生成 {0} 天合成历史（含模型看不到的本地活动和一次需求变化）', champ.data.days)
                : t('合成历史 {0} 天，其中真实营业日 {1} 天（合成数据权重 {2}）', champ.data.days, champ.data.liveDays ?? 0, champ.data.simWeight ?? 1)}
          </p>
          <div className="facts">
            {family.metrics.map((k) => (
              <span key={k}>
                {t(METRIC_TEXT[k] ?? k)} <b>{metricText(k, champ.metrics[k], family.minutes)}</b>
              </span>
            ))}
          </div>
          <p className="note">{t(EVAL_TEXT[family.id] ?? '')}</p>
          {family.id === 'substitution' && champ.metrics.personalLift !== undefined && (
            <p className="note">
              {t('个性化（按顾客自己以前的反应调整，决策记录 0023）：第一名的期望接受率变化 {0} 个百分点（下限 {1}，知道真实偏好时的上限 {2}）。{3}', (Math.round((champ.metrics.personalLift as number) * 1000) / 10).toFixed(1), (Math.round((champ.metrics.personalLiftLow ?? 0) * 1000) / 10).toFixed(1), pct(champ.metrics.personalOracle ?? 0), (champ.metrics.personalLift as number) >= 0.01 && (champ.metrics.personalLiftLow ?? 0) > 0 ? t('值得做。') : t('提升不到 1 个百分点，暂时不做；先攒真实标签再看。'))}
            </p>
          )}
        </section>
      )}
      {lastGate?.gate && (
        <section className="card">
          <div className="card-head">
            <span className="strong">{t('最近一次上线检查：v{0}', lastGate.version)}</span>
            <span className={`tag ${lastGate.gate.passed ? 'ok' : ''}`}>{lastGate.gate.passed ? t('通过') : t('未通过')}</span>
          </div>
          <ul className="plain">
            {lastGate.gate.checks.map((c) => (
              <li key={c.metric}>
                {t(
                  '{0} · {1}：候选 {2}，当前版本 {3}（{4}）',
                  c.rule === 'PRIMARY' ? t('主指标') : t('护栏'),
                  t(METRIC_TEXT[c.metric] ?? c.metric),
                  fmt(c.candidate),
                  fmt(c.champion),
                  `${c.change >= 0 ? '+' : ''}${pct(c.change)}`,
                )}
                <span className={`tag ${c.ok ? 'ok' : ''}`}>{c.ok ? '✓' : '✗'}</span>
              </li>
            ))}
          </ul>
          <p className="note">{t('新版本必须让主指标至少改善 1%，且护栏指标不明显变差，才会替换当前版本。对比时，当前版本在同一份数据上重新回测。')}</p>
        </section>
      )}
      <section className="card">
        <ul className="plain ai-versions">
          {latest.slice(0, 8).map((m) => (
            <li key={m.version}>
              <span className="mono">v{m.version}</span> {kindText(m.kind)} · {t(METRIC_TEXT[family.primary] ?? family.primary)} {metricText(family.primary, m.metrics[family.primary], family.minutes)}
              <span className={`tag ${m.status === 'CHAMPION' ? 'ok' : ''}`}>{t(MODEL_STATUS_TEXT[m.status])}</span>
              {m.note && <span className="muted">{noteText(m.note)}</span>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function fmt(v: number): string {
  return Number.isFinite(v) ? (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2)) : '—';
}

/** 排班建议：各岗位每小时的建议人数（与当前的差别标出颜色） */
function StaffPlanTable({ rec }: { rec: LiveRec }) {
  const prm = rec.action.params ?? {};
  const first = Number(prm.first ?? 0);
  const rows = (['pick', 'stage', 'handoff'] as const).map((r) => ({ r, values: String(prm[r] ?? '').split(',').map(Number), current: Number(prm[`current${r[0]!.toUpperCase()}${r.slice(1)}`] ?? 0) }));
  const n = rows[0]?.values.length ?? 0;
  return (
    <div className="plan-wrap">
      <table className="plan">
        <thead>
          <tr>
            <th />
            {Array.from({ length: n }, (_, i) => (
              <th key={i}>{first + i}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, values, current }) => (
            <tr key={r}>
              <th>{t(ROLE_TEXT[r] ?? r)}</th>
              {values.map((v, i) => (
                <td key={i} className={v > current ? 'more' : v < current ? 'less' : ''}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">{t('数字是建议的在岗人数；比现在多的标绿色，比现在少的标灰色。')}</p>
    </div>
  );
}
