import type { Reason } from '@storewright/ai';
import { DISRUPTION_LABEL, type Advice, type AdviceArea, type AdviceEffect, type DisruptionKind } from '@storewright/sim-engine';
import { clockText } from './format';
import { t, translate } from '../i18n';

/**
 * AI 建议的文字（决策记录 0020）：建议只带类型代码、因素代码和数值，这里按界面语言拼成「做什么、为什么、预计效果」。
 */

const AREA: Record<AdviceArea, string> = { INBOUND: '到货与卸货场', BACKROOM: '后仓与补货', STAGING: '线上订单暂存', FRONT: '前场', RISK: '异常与风险' };

export const areaLabel = (a: AdviceArea): string => t(AREA[a]);

const hm = (v: string | number | undefined) => clockText(Number(v ?? 0));
const ZONE: Record<string, string> = { AMBIENT: '常温', CHILLED: '冷藏', FROZEN: '冷冻' };
const zone = (v: string | number | undefined) => t(ZONE[String(v)] ?? String(v ?? ''));
const lbl = (v: string | number | undefined) => translate(String(v ?? ''));

/** 做什么（标题） */
export function adviceTitle(a: Advice): string {
  const p = a.params;
  switch (a.code) {
    case 'YARD_QUEUE':
      return t('把「{0}」的预约从 {1} 挪到 {2}', lbl(p.label), hm(p.fromAppt), hm(p.toAppt));
    case 'YARD_QUEUE_NO_MOVE':
      return t('{0}–{1} 卸货门排队', hm(p.from), hm(p.to));
    case 'LATE_ARRIVAL':
      return t('「{0}」预计 {1} 到，比预约晚约 {2} 分钟', lbl(p.label), hm(p.eta), p.lateMin ?? 0);
    case 'RECEIVERS_ADD':
      return t('收货员从 {0} 人加到 {1} 人', p.from ?? 0, p.to ?? 0);
    case 'RECEIVERS_REDUCE':
      return t('收货员可以从 {0} 人减到 {1} 人', p.from ?? 0, p.to ?? 0);
    case 'OVERFLOW':
      return t('今晚后仓放不下 {0} 托：夜班从 {1} 人加到 {2} 人', p.pallets ?? 0, p.crewFrom ?? 0, p.crewTo ?? 0);
    case 'OVERFLOW_NO_FIX':
      return t('今晚后仓放不下 {0} 托', p.pallets ?? 0);
    case 'OVERFLOW_OK':
      return t('今晚 {0} 托放到溢流位：溢流位够用', p.pallets ?? 0);
    case 'NIGHT_CREW_ADD':
      return t('夜班从 {0} 人加到 {1} 人，开门前补齐', p.from ?? 0, p.to ?? 0);
    case 'NIGHT_CREW_SHORT':
      return t('夜班加到 {0} 人也补不完', p.to ?? 0);
    case 'NIGHT_CREW_REDUCE':
      return t('夜班 {0} 人就够（现在 {1} 人）', p.to ?? 0, p.from ?? 0);
    case 'NIGHT_CREW_ENABLE':
      return t('开夜班补货组（{0} 人）', p.to ?? 0);
    case 'SLOTTING':
      return t('按走得快慢分货位：快的放低层、靠主通道');
    case 'LIFT_ORDER':
      return t('二楼的托盘先送二楼走得快的货架的');
    case 'STAGING_PEAK':
      return t('{0}暂存 {1} 前后到 {2}%：{3}:00–{4}:00 多排 1 名交付员', zone(p.zone), hm(p.at), p.peak ?? 0, p.fromHour ?? 0, p.toHour ?? 0);
    case 'STAGING_PEAK_INFO':
      return t('{0}暂存 {1} 前后到 {2}%', zone(p.zone), hm(p.at), p.peak ?? 0);
    case 'CHECKOUT_PLAN':
      return t('按客流开收银通道：高峰 {0}:00 开 {1} 条', p.peakAt ?? 0, p.peakLanes ?? 0);
    case 'CHECKOUT_SHORT':
      return t('{0} {1}:00 收银通道全开也要排 {2} 分钟', floorName(p.floorId), p.hour ?? 0, p.wait ?? 0);
    case 'PARKING_PEAK':
      return t('{0}:00–{1}:00 停车场 {2}% 满：安排人引导', p.fromHour ?? 0, p.toHour ?? 0, p.peak ?? 0);
    case 'LONG_WAIT':
      return a.action ? t('{0}:00 前后顾客等太久：{1}:00–{2}:00 多排 1 名交付员', p.hour ?? 0, p.fromHour ?? 0, p.toHour ?? 0) : t('{0}% 的顾客等得太久，集中在 {1}:00 前后', p.pct ?? 0, p.hour ?? 0);
    case 'LATE_ORDERS':
      return a.action ? t('{0}:00 前后订单没按时备好：{1}:00–{2}:00 多排 1 名拣货员', p.hour ?? 0, p.fromHour ?? 0, p.toHour ?? 0) : t('{0}% 的订单没按时备好，集中在 {1}:00 前后', p.pct ?? 0, p.hour ?? 0);
    case 'FORKLIFT_WAIT':
      return t('叉车在通道口等了 {0} 次、一共 {1} 分钟', p.times ?? 0, p.minutes ?? 0);
    case 'COLD_CHAIN':
      return t('冷链拣货超时 {0} 次', p.times ?? 0);
    case 'AI_SCHEDULE':
      return t('用 AI 排班：线上岗位 {0} 工时 → {1} 工时', p.before ?? 0, p.after ?? 0);
    default:
      if (a.code.startsWith('INCIDENT_')) return t('{0}（{1} 分钟）', incident(p.kind), p.minutes ?? 0);
      return a.code;
  }
}

const incident = (v: string | number | undefined) => translate(DISRUPTION_LABEL[String(v) as DisruptionKind] ?? String(v ?? ''));
const INCIDENT_TIP: Record<string, string> = {
  FIRE_ALARM: '火警时所有人撤到集合点，订单作业全部暂停；恢复后先处理快到时段的订单，主动通知受影响的顾客。',
  POLICE: '停车场有警情时车边交付暂停：请顾客稍等或到店内取货，交付员先备好下一批。',
  POWER_OUTAGE: '停电时拣货和暂存暂停、交付变慢：冷藏冷冻商品先放回冷库，恢复后先补拣快到时段的订单。',
  SYSTEM_OUTAGE: '系统故障时订单暂停下发，暂存和交付变慢：先用纸质单据应急，恢复后核对一遍没同步的订单。',
  PRINTER_JAM: '标签打印机卡纸时拣货标签打不出来：准备一台备用打印机，或先手写标签。',
};

const floorName = (v: string | number | undefined) => (String(v) === 'F1' ? t('一楼') : String(v) === 'F2' ? t('二楼') : String(v ?? ''));

/** 情况说明 */
export function adviceBody(a: Advice): string {
  const p = a.params;
  switch (a.code) {
    case 'YARD_QUEUE':
      return t('{0}–{1} 有 {2} 辆车排队等卸货门（{3} 个门），一共等了 {4} 分钟。挪的预约仍在这家供应商的送货时段里。', hm(p.from), hm(p.to), p.trucks ?? 0, p.docks ?? 0, p.waitMin ?? 0);
    case 'YARD_QUEUE_NO_MOVE':
      return t('有 {0} 辆车排队、一共等了 {1} 分钟；附近的预约都挪不开（配送中心的车或送货时段不允许）。考虑加卸货门，或和配送中心商量到货时刻。', p.trucks ?? 0, p.waitMin ?? 0);
    case 'LATE_ARRIVAL':
      return t('收货员按预计到达时刻准备，在那之前先做别的活；预约是 {0}。', hm(p.appt));
    case 'RECEIVERS_ADD':
      return t('今天到 {0} 辆车、{1} 托货；多一个收货员，托盘从卸下到放进货架更快，收货区不容易堆满。', p.trucks ?? 0, p.pallets ?? 0);
    case 'RECEIVERS_REDUCE':
      return t('少一个收货员，卸货到入库的时间几乎不变，可以把这份工时用到别处。');
    case 'OVERFLOW':
      return t('从 {0} 起货架满了（{1} 个托盘位，今天到 {2} 托），多出来的托盘只能经连通通道放到暂存区的溢流位。夜班多人手边补货边腾出货位。', hm(p.firstAt), p.capacity ?? 0, p.received ?? 0);
    case 'OVERFLOW_NO_FIX':
      return t('从 {0} 起货架满了（{1} 个托盘位，今天到 {2} 托）；多加夜班也腾不出足够的货位。考虑在门店定制里加货架排数，或把部分供应商改为直送上架。', hm(p.firstAt), p.capacity ?? 0, p.received ?? 0);
    case 'OVERFLOW_OK':
      return t('从 {0} 起货架满了（{1} 个托盘位，今天到 {2} 托），{3} 托经连通通道放到暂存区的溢流位。溢流位就是为这种情况准备的，为这几托加夜班不划算；第二天先把它们补上货架。', hm(p.firstAt), p.capacity ?? 0, p.received ?? 0, p.pallets ?? 0);
    case 'NIGHT_CREW_ADD':
      return t('今晚要补 {0} 箱，按现在的人数开门时还有 {1} 箱没上架。', p.cases ?? 0, p.backlog ?? 0);
    case 'NIGHT_CREW_SHORT':
      return t('开门时还有 {0} 箱没上架（占今晚的 {1}%），多加几个人也补不完：瓶颈不在人数，在叉车（{2} 台）放下高层托盘、后到的长途车，或到货太多、后仓货架不够。', p.backlog ?? 0, p.share ?? 0, p.forklifts ?? 0);
    case 'NIGHT_CREW_REDUCE':
      return t('今晚要补 {0} 箱，少几个人也能在开门前补齐。', p.cases ?? 0);
    case 'NIGHT_CREW_ENABLE':
      return t('夜班补货组没开，开门时还有 {0} 箱没上架。', p.backlog ?? 0);
    case 'SLOTTING':
      return t('现在新到的托盘都先占低层、靠主通道的货位，走得快的货常被放到高层，夜班补货要等叉车放下来（今天 {0} 次）。', p.lowerings ?? 0);
    case 'LIFT_ORDER':
      return t('今天有 {0} 个托盘经货梯送上二楼，按到货先后送；先送紧缺的货架，二楼缺货的时间更短。', p.pallets ?? 0);
    case 'STAGING_PEAK':
      return t('{0}–{1} 是取货高峰，{2}暂存一共 {3} 个框位。多一名交付员，顾客到了交付得快，订单在暂存区待得更短。', hm(p.from), hm(p.to), zone(p.zone), p.capacity ?? 0);
    case 'STAGING_PEAK_INFO':
      return t('{0}–{1} 是取货高峰，{2}暂存一共 {3} 个框位；多排交付员作用不大，快满时考虑减少这一时段的取货名额。', hm(p.from), hm(p.to), zone(p.zone), p.capacity ?? 0);
    case 'CHECKOUT_PLAN':
      return t('每小时开几条人工通道才能让顾客平均排队不超过 2 分钟（自助收银一直开着）；全天 {0} 个通道小时，比全天全开（{1}）省下的人可以去补货、交付。采纳后场景里关着的通道号灯变暗，顾客只去开着的通道。', p.laneHours ?? 0, p.allOpen ?? 0);
    case 'CHECKOUT_SHORT':
      return t('这一小时到店的人多，{0} 条人工通道全开也排不过来：引导顾客用自助收银，或临时从别的岗位调人开备用通道。', p.lanes ?? 0);
    case 'PARKING_PEAK':
      return t('停车场 {0} 个车位最多停到 {1}%：安排人在入口引导到远一点的车位和溢流区，线上取货车位不被占用。', p.spots ?? 0, p.peak ?? 0);
    case 'LONG_WAIT':
      return t('今天 {0}% 的顾客到了以后等得太久（超过规定的等待时间），{1}:00 那一小时最多（{2} 人）。', p.pct ?? 0, p.hour ?? 0, p.count ?? 0);
    case 'LATE_ORDERS':
      return t('今天 {0}% 的订单在取货时段开始时还没备好，{1}:00 那一小时最多（{2} 单）；拣货要在取货时段前做完，所以提前两小时加人。', p.pct ?? 0, p.hour ?? 0, p.count ?? 0);
    case 'FORKLIFT_WAIT':
      return t('两台叉车常要进同一条货架通道（窄通道一次只能进一台），最长一次等了 {0} 分钟。可以按走得快慢分货位，把常用的托盘分散到不同通道；或者错开卸货和上架的时间。', p.longest ?? 0);
    case 'COLD_CHAIN':
      return t('冷藏、冷冻商品从拣第一件到放进暂存区超过了时限（最长一单 {0} 分钟，时限 {1} 分钟）。冷藏冷冻的拣货单拆小一点、放到最后拣，或在高峰时多排一名拣货员。', p.worst ?? 0, p.limit ?? 0);
    default:
      if (a.code.startsWith('INCIDENT_')) return t(INCIDENT_TIP[String(p.kind)] ?? '');
      return '';
  }
}

/** 为什么：一个因素 */
export function reasonText(r: Reason): string {
  const v = r.value ?? 0;
  switch (r.factor) {
    case 'QUEUE_TRUCKS':
      return t('同一段时间来了 {0} 辆车', v);
    case 'DOCKS':
      return t('卸货门只有 {0} 个', v);
    case 'WAIT_MIN':
      return t('在场内一共等了 {0} 分钟', v);
    case 'LATE_ARRIVAL':
      return t('有车晚到，和后面的车挤在一起');
    case 'REEFER_WAITING':
      return t('冷藏车也在排队（冷链）');
    case 'LATE_MIN':
      return t('比预约晚 {0} 分钟', v);
    case 'CONGESTION':
      return t('那时路上拥堵（{0}%）', Math.round(v * 100));
    case 'SCHOOL_RUSH':
      return t('赶上学校上学、放学高峰');
    case 'RAILWAY':
      return t('要过铁路道口，可能碰上道口关闭');
    case 'PUNCTUALITY':
      return t('司机准点有起伏');
    case 'DOCK_TO_STOCK':
      return t('卸货到入库平均 {0} 分钟', v);
    case 'PALLETS_TODAY':
      return t('今天到 {0} 托货', v);
    case 'RECEIVERS':
      return t('现在 {0} 个收货员', v);
    case 'RACK_CAPACITY':
      return t('后仓货架 {0} 个托盘位', v);
    case 'OVERFLOW_PALLETS':
      return t('{0} 托只能放到溢流位', v);
    case 'CASES_TONIGHT':
      return t('今晚要补 {0} 箱', v);
    case 'NIGHT_CREW':
      return t('现在夜班 {0} 人', v);
    case 'BACKLOG_CASES':
      return t('开门时还有 {0} 箱没上架', v);
    case 'LOWERINGS':
      return t('叉车放下高层托盘 {0} 次', v);
    case 'FAST_RUNS_HIGH':
      return t('走得快的货常在高层');
    case 'UP_PALLETS':
      return t('{0} 个托盘要送上二楼', v);
    case 'LIFT_FIFO':
      return t('货梯按到货先后送');
    case 'FORKLIFTS':
      return t('叉车 {0} 台', v);
    case 'ZONE_PEAK':
      return t('{0}暂存最满到 {1}%', zone(r.params?.zone), v);
    case 'ZONE_CAPACITY':
      return t('{0}暂存 {1} 个框位', zone(r.params?.zone), v);
    case 'EVENING_PICKUPS':
      return t('傍晚是取货高峰');
    case 'WAIT_NOW':
      return t('顾客现在平均等 {0} 分钟', v);
    case 'PEAK_SHOPPERS':
      return t('{0}:00 前后每小时到店 {1} 人', r.params?.hour ?? 0, v);
    case 'SERVICE_MIN':
      return t('每位顾客结账约 {0} 分钟', v);
    case 'SELF_CHECKOUT':
      return t('自助收银分走约 {0}%', v);
    case 'TARGET_WAIT':
      return t('目标：平均排队不超过 {0} 分钟', v);
    case 'LANES':
      return t('人工通道 {0} 条', v);
    case 'PARKING_PEAK':
      return t('停车场最多 {0}% 满', v);
    case 'PARKING_SPOTS':
      return t('车位 {0} 个', v);
    case 'LONG_WAIT_PCT':
      return t('{0}% 的顾客等得太久', v);
    case 'LONG_WAIT_HOUR':
      return t('{0}:00 那一小时有 {1} 人等得太久', r.params?.hour ?? 0, v);
    case 'LATE_PCT':
      return t('{0}% 的订单没按时备好', v);
    case 'LATE_HOUR':
      return t('{0}:00 那一小时有 {1} 单没按时备好', r.params?.hour ?? 0, v);
    case 'FORKLIFT_WAITS':
      return t('在通道口等了 {0} 次', v);
    case 'FORKLIFT_WAIT_MIN':
      return t('一共等了 {0} 分钟', v);
    case 'COLD_ALERTS':
      return t('冷链超时 {0} 次', v);
    case 'COLD_WORST':
      return t('最长一单 {0} 分钟（时限 {1} 分钟）', v, r.params?.limit ?? 0);
    case 'COLD_PCT':
      return t('冷链拣货单的 {0}% 超时', v);
    case 'INCIDENT':
      return t('突发状况：{0}', incident(r.params?.kind));
    default:
      return r.factor;
  }
}

const METRIC: Record<string, string> = {
  YARD_WAIT: '卸货场排队',
  DOCK_TO_STOCK: '卸货到入库',
  LABOR_HOURS: '工时',
  OVERFLOW: '放到溢流位的托盘',
  BACKLOG: '开门时没上架',
  NIGHT_FINISH: '夜班补完',
  LOWERINGS: '叉车放下高层托盘',
  URGENT_UP: '紧缺货架的托盘送上二楼',
  STAGING_PEAK: '暂存最满',
  WAIT: '顾客平均等待',
  LANE_HOURS: '收银通道小时',
  CHECKOUT_WAIT: '最长平均排队',
  LONG_WAIT: '等太久的顾客',
  LATE_ORDERS: '没按时备好的订单',
};

export const effectLabel = (e: AdviceEffect): string => t(METRIC[e.metric] ?? e.metric);

export function effectValue(e: AdviceEffect, v: number): string {
  switch (e.unit) {
    case 'MIN':
      return t('{0} 分钟', Math.round(v));
    case 'HOURS':
      return t('{0} 工时', Math.round(v * 10) / 10);
    case 'PALLETS':
      return t('{0} 托', Math.round(v));
    case 'CASES':
      return t('{0} 箱', Math.round(v));
    case 'PCT':
      return `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;
    case 'CLOCK':
      return clockText(v);
    case 'COUNT':
      return t('{0} 次', Math.round(v));
  }
}

/** 变化：好转为正 */
export function effectGain(e: AdviceEffect): number {
  const d = e.after - e.before;
  return e.better === 'lower' ? -d : d;
}

/** 忽略的原因（反馈） */
export const DISMISS_REASONS: Array<[string, string]> = [
  ['WRONG_DATA', '数据不准'],
  ['LOCAL_KNOWLEDGE', '现场情况不一样'],
  ['NO_STAFF', '没有人手'],
  ['DISAGREE', '不同意'],
  ['OTHER', '其他'],
];
