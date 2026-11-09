import type { DayResult } from '../ops/day';

/** 对比用的指标：名称、单位、取值方法、越大越好还是越小越好、属于哪个环节 */
export interface Kpi {
  key: string;
  label: string;
  unit: string;
  group: '线上订单' | '到店顾客' | '货架' | '人工' | '机器人' | '生鲜' | '能耗' | '收货' | '每天的钱';
  better: 'lower' | 'higher' | 'none';
  get: (r: DayResult) => number;
  digits?: number;
  /** 只在 StoreX 的扫描实验里用（上一代没有这些设备），不进两代对比表 */
  storexOnly?: boolean;
}

export const KPIS: readonly Kpi[] = [
  { key: 'onTime', label: '按时备好的订单', unit: '%', group: '线上订单', better: 'higher', get: (r) => r.online.onTimePct },
  { key: 'wait', label: '自提顾客平均等待', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.waitAvg, digits: 2 },
  { key: 'waitP95', label: '自提等待 95% 分位', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.waitP95, digits: 2 },
  { key: 'waitOver5', label: '等待超过 5 分钟的比例', unit: '%', group: '线上订单', better: 'lower', get: (r) => r.online.waitOver5Pct },
  { key: 'dwell', label: '交付前离开温控的时间', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.dwellAvg, digits: 2 },
  { key: 'fill', label: '订单满足率（含替代）', unit: '%', group: '线上订单', better: 'higher', get: (r) => r.online.fillPct, digits: 2 },
  { key: 'laborMinPerOrder', label: '线上作业有效工时 / 单', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.laborMinPerOrder },
  { key: 'laborCostPerOrder', label: '线上作业人工成本 / 单（带薪）', unit: '美元', group: '线上订单', better: 'lower', get: (r) => r.online.laborCostPerOrder, digits: 2 },
  { key: 'walkKm', label: '卖场拣货行走', unit: '公里 / 天', group: '线上订单', better: 'lower', get: (r) => r.online.walkKm },
  { key: 'done', label: '当天完成的订单', unit: '%', group: '线上订单', better: 'higher', get: (r) => (r.online.done / Math.max(1, r.demand.orders)) * 100 },
  { key: 'lockerWait', label: '自提柜顾客平均等待', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.byMode.locker?.waitAvg ?? 0, digits: 2, storexOnly: true },
  { key: 'driveWait', label: '免下车取货顾客平均等待', unit: '分钟', group: '线上订单', better: 'lower', get: (r) => r.online.byMode.drive?.waitAvg ?? 0, digits: 2, storexOnly: true },
  { key: 'lockerQ', label: '等空格口的订单（当天最多）', unit: '单', group: '线上订单', better: 'lower', get: (r) => r.online.lockerQueuedMax, digits: 0, storexOnly: true },
  { key: 'botUtil', label: '货格机器人利用率（5–21 点）', unit: '%', group: '机器人', better: 'none', get: (r) => r.online.mfcBotUtil * 100, digits: 0, storexOnly: true },
  { key: 'portUtil', label: '站台拣货员的站台利用率', unit: '%', group: '机器人', better: 'none', get: (r) => r.online.mfcPortUtil * 100, digits: 0, storexOnly: true },
  { key: 'checkoutWait', label: '到店顾客结账平均等待', unit: '分钟', group: '到店顾客', better: 'lower', get: (r) => r.instore.waitAvg, digits: 2 },
  { key: 'checkoutP95', label: '结账等待 95% 分位', unit: '分钟', group: '到店顾客', better: 'lower', get: (r) => r.instore.waitP95, digits: 2 },
  { key: 'oos', label: '货架缺货率（营业时间平均）', unit: '%', group: '货架', better: 'lower', get: (r) => r.shelf.outOfShelfPct, digits: 2 },
  { key: 'outages', label: '缺货次数', unit: '次 / 天', group: '货架', better: 'lower', get: (r) => r.shelf.outages, digits: 0 },
  { key: 'recover', label: '缺货到补回的平均时长', unit: '分钟', group: '货架', better: 'lower', get: (r) => r.shelf.recoverAvgMin, digits: 0 },
  { key: 'lostSales', label: '因缺货流失的销售额', unit: '美元 / 天', group: '货架', better: 'lower', get: (r) => r.shelf.lostSales, digits: 0 },
  { key: 'paid', label: '全店带薪工时', unit: '小时 / 天', group: '人工', better: 'lower', get: (r) => r.labor.paidTotal },
  { key: 'fte', label: '折合全职员工（8 小时）', unit: '人', group: '人工', better: 'lower', get: (r) => r.labor.fte },
  { key: 'night', label: '夜班上架工时', unit: '小时 / 天', group: '人工', better: 'lower', get: (r) => r.labor.night },
  { key: 'util', label: '员工利用率（事件仿真内的岗位）', unit: '%', group: '人工', better: 'none', get: (r) => r.labor.utilization * 100 },
  { key: 'robots', label: '机器人数量', unit: '台', group: '机器人', better: 'none', get: (r) => r.robots.total, digits: 0 },
  { key: 'robotHours', label: '机器人忙碌时长', unit: '小时 / 天', group: '机器人', better: 'none', get: (r) => Object.values(r.robots.busyHours).reduce((a, b) => a + b, 0) },
  { key: 'robotFailures', label: '机器人故障', unit: '次 / 天', group: '机器人', better: 'lower', get: (r) => r.robots.failures, digits: 2 },
  { key: 'freshWaste', label: '生鲜损耗（报废 / 进货）', unit: '%', group: '生鲜', better: 'lower', get: (r) => r.fresh.wastePct, digits: 2 },
  { key: 'markdown', label: '生鲜打折损失 / 生鲜销售额', unit: '%', group: '生鲜', better: 'lower', get: (r) => r.fresh.markdownPct, digits: 2 },
  { key: 'kwh', label: '用电量', unit: '千瓦时 / 天', group: '能耗', better: 'lower', get: (r) => r.energy.kwh, digits: 0 },
  { key: 'gridKwh', label: '电网购电', unit: '千瓦时 / 天', group: '能耗', better: 'lower', get: (r) => r.energy.gridKwh, digits: 0 },
  { key: 'peakKw', label: '峰时最大购电功率', unit: '千瓦', group: '能耗', better: 'lower', get: (r) => r.energy.peakGridKw, digits: 0 },
  { key: 'co2', label: '购电碳排放', unit: '千克 / 天', group: '能耗', better: 'lower', get: (r) => r.energy.co2Kg, digits: 0 },
  { key: 'dock', label: '货车卸货停留', unit: '分钟 / 车', group: '收货', better: 'lower', get: (r) => r.inbound.dockAvgMin },
  { key: 'labor$', label: '人工成本', unit: '美元 / 天', group: '每天的钱', better: 'lower', get: (r) => r.money.labor, digits: 0 },
  { key: 'energy$', label: '电费（含需量电费）', unit: '美元 / 天', group: '每天的钱', better: 'lower', get: (r) => r.money.energy, digits: 0 },
  { key: 'fresh$', label: '生鲜报废 + 打折损失', unit: '美元 / 天', group: '每天的钱', better: 'lower', get: (r) => r.money.freshLoss, digits: 0 },
  { key: 'lost$', label: '缺货流失的毛利', unit: '美元 / 天', group: '每天的钱', better: 'lower', get: (r) => r.money.lostMargin, digits: 0 },
  { key: 'total$', label: '以上合计', unit: '美元 / 天', group: '每天的钱', better: 'lower', get: (r) => r.money.total, digits: 0 },
];

export function kpi(key: string): Kpi {
  const k = KPIS.find((x) => x.key === key);
  if (!k) throw new Error(`unknown kpi ${key}`);
  return k;
}
