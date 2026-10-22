import type { StoreConfig, TemplateName } from '@storewright/store-config';
import type { AssociateTrace, AutoServiceMetrics, DayMetrics, Disruption, EquipmentTrace, InboundMetrics, PalletRecord, PharmacyResult, Role, ServiceJob, Staffing, StagingChange, Truck, WorkerTrace } from '@storewright/sim-engine';

export type PolicyName = 'baseline' | 'optimized' | 'efficiency';

export interface SimRequest {
  type: 'simulate';
  reqId: number;
  config: StoreConfig;
  /** 需求场景用哪个模板的默认值（编辑过的布局仍沿用原模板的需求） */
  demandTemplate: TemplateName;
  /** 自定义门店的日订单量（按规模插值）；不给时用模板默认值 */
  ordersPerDay?: number;
  policy: PolicyName;
  seed: number;
  demandFactor: number;
  staffing?: Staffing;
  /** 道路拥堵强度：0 关闭，1 一般，2 严重 */
  traffic: number;
  /** 夜班补货组：是否启用、人数 */
  nightCrew?: { enabled: boolean; crew: number };
  /** 天气：雨、雪、雾会加重路况，雨雪让车边交付变慢、线上订单增加 */
  weather?: 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog' | 'dynamic';
  /** 「多变」天气：按季节和周边环境的随机种子生成一天的天气 */
  season?: string;
  weatherSeed?: number;
  /** 事件提醒等文字的语言 */
  lang?: 'zh' | 'en';
  /** 突发状况：随机小状况、随机大事件、手动触发的大事件 */
  incidents?: { small: boolean; randomLarge: boolean; manual: Disruption[] };
  /** 货架存量模型（Phase 4）：货架空 → Exception → 补货任务 → 货架恢复 */
  shelfStock?: boolean;
  /** 手动请求的补货（点击货架）：商品与仿真时刻 */
  restockRequests?: Array<{ itemId: string; t: number }>;
  /** AI 模块（Phase 5c）：按预测排班（总工时不变）、修正到店时间、替代推荐 */
  ai?: boolean;
}

export interface ShelfEventInfo {
  t: number;
  kind: 'EMPTY' | 'TASK' | 'DONE';
  itemId: string;
  name: string;
  locationId: string;
  /** `${runId}|${bay}` */
  bay: string;
  units?: number;
  reason?: string;
}

/** 货架存量模块的结果：每个货架段的填充率随时间变化（场景着色）、事件与指标 */
export interface ShelfTimeline {
  lostSalesUnits: number;
  soldUnits: number;
  itemsEmptied: number;
  restocks: number;
  restockedUnits: number;
  avgEmptyMin: number;
  emptyAtClose: number;
  emptyCurve: Array<[number, number]>;
  /** 货架段 → [t, 填充率, 空商品数, t, …]（第一组为开门时） */
  bays: Record<string, number[]>;
  /** 货架段 → 商品数 */
  bayItems: Record<string, number>;
  /** 开门时后仓有货的商品（件数） */
  backroom: Record<string, number>;
  events: ShelfEventInfo[];
}

export type NotificationLevel = 'info' | 'warn' | 'alert';

export interface Notification {
  t: number;
  level: NotificationLevel;
  text: string;
  target?: { type: 'car' | 'associate' | 'staging' | 'run'; id: string };
}

export interface CarInfo {
  id: string;
  kind: 'PICKUP' | 'TRIP';
  orderIds: string[];
  label: string;
  approachAt?: number;
  arriveAt: number;
  doneAt: number;
  /** 停车位序号 */
  spot: number;
  /** 堵车造成的到店延误（秒） */
  delaySec?: number;
}

export interface OrderInfo {
  id: string;
  shortCode: string;
  name: string;
  type: 'PICKUP' | 'DELIVERY';
  fulfillment: string;
  lines: number;
  units: number;
  totes: number;
  slotStart: number;
  stagedAt?: number;
  lateMin?: number;
}

/** 按分钟采样的时间序列，下标 i 对应时刻 t0 + i × step */
export interface Series {
  t0: number;
  step: number;
  handedOff: number[];
  waiting: number[];
  avgWaitMin: number[];
  late: number[];
  picked: number[];
  busy: Record<Role, number[]>;
  onShift: Record<Role, number[]>;
  stagingOcc: Record<'AMBIENT' | 'CHILLED' | 'FROZEN', number[]>;
  /** 夜班累计上架箱数 */
  nightStocked: number[];
  /** 后仓货架上的托盘数 */
  rackUsed: number[];
}

/** 汽车快修中心的全天结果 */
export interface AutoServiceTimeline {
  facilityId: string;
  name: string;
  oilBays: number;
  tireBays: number;
  jobs: ServiceJob[];
  metrics: AutoServiceMetrics;
  /** 与主时间序列对齐：排队车辆数、正在作业的工位数 */
  queue: number[];
  inService: number[];
}

export interface Timeline {
  start: number;
  end: number;
  policy: PolicyName;
  seed: number;
  orderCount: number;
  metrics: DayMetrics;
  staffing: Staffing;
  associates: AssociateTrace[];
  homeNodes: Record<Role, number>;
  cars: CarInfo[];
  orders: Record<string, OrderInfo>;
  staging: StagingChange[];
  series: Series;
  notifications: Notification[];
  /** `${runId}|${bay}` → 当天拣货件数 */
  pickHeat: Record<string, number>;
  /** 货架存量模块（开启时） */
  shelf?: ShelfTimeline;
  /** 本次仿真使用的道路拥堵设置 */
  traffic: { level: number; profile: number[] };
  autoService: AutoServiceTimeline[];
  /** 店内药房（没有药房时为空） */
  pharmacy?: { counters: number; visits: PharmacyResult['visits']; metrics: PharmacyResult['metrics'] };
  /** 本次仿真中的大事件窗口和小状况记录 */
  incidents: { disruptions: Disruption[]; small: Array<{ t: number; kind: string; ref?: string }> };
  /** 到货车辆、托盘、收货员与夜班、叉车与搬运车 */
  inbound: { trucks: Truck[]; pallets: PalletRecord[]; workers: WorkerTrace[]; equipment: EquipmentTrace[]; metrics: InboundMetrics; nightCrew: number };
  simMs: number;
}

/** 同一门店、同一订单流下三种策略的全天结果（策略对比用） */
export interface CompareRequest {
  type: 'compare';
  reqId: number;
  base: Omit<SimRequest, 'type' | 'reqId' | 'policy'>;
}

export interface PolicyDigest {
  policy: PolicyName;
  metrics: DayMetrics;
  series: Series;
}

/** 连续模拟多天（每天换随机种子，订单量按星期几浮动），只返回每天的汇总 */
export interface MultiDayRequest {
  type: 'multiDay';
  reqId: number;
  base: Omit<SimRequest, 'type' | 'reqId'>;
  days: number;
}

export interface DayDigest {
  day: number;
  /** 0 = 周一 */
  weekday: number;
  seed: number;
  demandFactor: number;
  metrics: DayMetrics;
  inbound: InboundMetrics;
  autoRevenue: number;
  pharmacyServed: number;
}

export type WorkerRequest = SimRequest | CompareRequest | MultiDayRequest;

export type SimResponse =
  | { type: 'result'; reqId: number; timeline: Timeline }
  | { type: 'compare'; reqId: number; results: PolicyDigest[] }
  | { type: 'multiDay'; reqId: number; days: DayDigest[] }
  | { type: 'progress'; reqId: number; done: number; total: number }
  | { type: 'error'; reqId: number; message: string };
