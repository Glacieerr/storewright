/**
 * 闭环孪生的数据：现场发出来的感知数据（Msg）、孪生发回现场的控制指令（Cmd）、孪生给出的判断和建议（Issue、Rec）。
 *
 * 时间都是动画那一天 0 点起的秒，位置是沙盘坐标（米，x 向东、z 向南）。
 */

/** 现场 → 孪生：感知数据 */
export type Msg =
  /** 车辆定位（每分钟一条，有几米的误差） */
  | { kind: 'gps'; t: number; vid: number; x: number; z: number }
  /**
   * 车载终端事件：出发、到达、离开、故障、修好、收到指令（追加补货车出发时带上装的商品族和件数）；
   * 长途车（直送门店、进配送中心）进区域之前每小时报一次预计进区域的时刻（eta，当天的秒）
   */
  | { kind: 'event'; t: number; vid: number; ev: 'depart' | 'arrive' | 'leave' | 'fault' | 'fixed' | 'ack' | 'done' | 'eta'; place?: string; code?: string; note?: string; fam?: string; units?: number; eta?: number }
  /** 冷机：车厢空气温度、货物温度（探针）、设定温度、车门、压缩机（每 5 分钟） */
  | { kind: 'temp'; t: number; vid: number; air: number; product: number; set: number; door: boolean; cool: boolean }
  /** 月台装车进度（仓库系统扫描托盘，每 5 分钟） */
  | { kind: 'load'; t: number; vid: number; door: string; done: number; total: number }
  /** 配送中心月台门、门店收货口（S01-1…S01-4）的开关（门磁 + 车牌识别） */
  | { kind: 'door'; t: number; door: string; open: boolean; vid: number }
  /** 门店收银：过去 15 分钟某个商品族卖出的件数 */
  | { kind: 'pos'; t: number; store: string; fam: string; units: number }
  /** 门店盘点：某个商品族货架 + 后仓的件数（电子价签 + 货架摄像头 + 后仓扫码，每小时） */
  | { kind: 'stock'; t: number; store: string; fam: string; units: number }
  /** 路况：交通事故 / 施工（导航数据），开始和结束各一条 */
  | { kind: 'traffic'; t: number; id: string; x: number; z: number; r: number; factor: number; until: number; text: string; end?: boolean }
  /** 电动车电量（每 10 分钟） */
  | { kind: 'soc'; t: number; vid: number; soc: number };

/** 孪生 → 现场：控制指令 */
export type Cmd =
  /** 通知门店把收货截止顺延到 until（当天的秒） */
  | { kind: 'notifyStore'; t: number; store: string; until: number }
  /** 车上剩下的门店按新顺序送 */
  | { kind: 'resequence'; t: number; vid: number; order: string[] }
  /** 派一辆备用车去接走抛锚车上剩下的站 */
  | { kind: 'rescue'; t: number; vid: number }
  /** 提醒司机就近停车检查车门密封 */
  | { kind: 'driverCheck'; t: number; vid: number }
  /** 远程调低冷机的设定温度 */
  | { kind: 'setpoint'; t: number; vid: number; delta: number }
  /** 把要等门的车改到空闲的月台门 */
  | { kind: 'reassignDoor'; t: number; vid: number; door: string }
  /** 配送中心追加一趟小车，给门店补某个商品族 */
  | { kind: 'restock'; t: number; fam: string; units: number }
  /** 改去处：长途进配送中心的车改直送门店（store），直送门店的车改送配送中心（DC） */
  | { kind: 'divert'; t: number; vid: number; to: 'store' | 'DC' }
  /** 让车晚点到（门店收货口排不开时，在路边等到 until） */
  | { kind: 'hold'; t: number; vid: number; until: number };

export type IssueKind = 'late' | 'temp' | 'breakdown' | 'door' | 'dock' | 'stockout';
export const ISSUE_LABEL: Record<IssueKind, string> = { late: '预计迟到', temp: '温度将超标', breakdown: '车辆抛锚', door: '月台门要等', dock: '门店收货口排不开', stockout: '门店将缺货' };

/** 一个可选的做法，以及孪生推演出来的结果 */
export interface Option {
  key: string;
  label: string;
  /** 推演的结果：迟到分钟、超温分钟、缺货分钟、多花的钱（美元） */
  late: number;
  hot: number;
  short: number;
  cost: number;
  note: string;
  cmds: Cmd[];
  /** 低风险、可以自动执行 */
  auto: boolean;
}

/** 孪生的一条判断（附带几个做法和推荐的那个） */
export interface Rec {
  key: string;
  kind: IssueKind;
  t: number;
  title: string;
  text: string;
  vid?: number;
  store?: string;
  options: Option[];
  best: number;
  /** proposed 待处理；done 已执行；rejected 调度员否了；resolved 问题自己没了；expired 没处理，问题真的发生了 */
  status: 'proposed' | 'done' | 'rejected' | 'resolved' | 'expired';
  by?: 'auto' | 'user';
  chosen?: string;
  doneAt?: number;
  /** 「低风险的自动执行」时，推荐的做法要人批准，先自动做了的低风险措施（卡片仍等调度员） */
  interim?: { key: string; t: number };
}

/** 调度员在某个时刻的决定（重新推演时在那个时刻生效） */
export interface UserDecision {
  t: number;
  key: string;
  action: 'approve' | 'reject';
  option?: string;
}

/** 自动执行的范围 */
export type Policy = 'manual' | 'safe' | 'auto';
export const POLICY_LABEL: Record<Policy, string> = { manual: '全部人工确认', safe: '低风险的自动执行', auto: '全部自动执行' };
