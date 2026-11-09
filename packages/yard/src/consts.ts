/**
 * 场地的常数（米、秒）。半挂车的最小转弯半径约 12.5 米，所以场里的转弯都不小于 12 米；从主路拐进、拐出按 15 米的圆弧（喇叭口）。
 */
/** 车尾靠台时离墙（防撞块的厚度） */
export const DOCK_GAP = 0.6;
/** 进待命车道、下进场道路的转弯半径 */
export const R_IN = 13;
export const R_OUT = 13;
/** 车道之间掉头的最小半径 */
export const R_U = 12;
/** 拉出后转上驶离车道的半径 */
export const R_PULL = 12.8;
/** 从主路拐进、拐出：右转 15 米、左转 17 米 */
export const R_ROAD = 15;
/** 驶离车道和待命车道的间距 */
export const LANE_GAP = 6.3;
/** 靠台车道从最靠 −x 的门往 −x 至少要有的直线（驶近、倒车起点前） */
export const DOOR_LEAD = 30;
/** 甩挂车位：宽 3.8 米，深按挂车长加 1.5 米 */
export const STALL_W = 3.8;
/** 场内车速、倒车车速、进场道路车速、主路车速 */
export const YARD_SPEED = 4.2;
export const BACK_SPEED = 0.9;
export const BACK_SPEED_BODY = 1.2;
/** 停在倒车起点：司机下车打开后门、看清两边（打双闪）；半挂车 45 秒，单体车 15 秒 */
export const SWING_WAIT = { rig: 45, body: 15 };
/** 先到先进的窗口：最晚该进场的时刻比到达晚这么多以上的车（门一时空不出来），先到场外等候区等，不堵待命车道 */
export const HOLD_WINDOW = 900;
export const DRIVE_SPEED = 6;
export const ROAD_SPEED = 11;
/** 半挂车、单体货车、面包车的动力学 */
export const TRUCK_DYN = { accel: 0.8, decel: 1.6, lat: 1.1, wheelbase: 3.3 };
export const BOX_DYN = { accel: 1.2, decel: 2, lat: 1.5, wheelbase: 6.2 };
export const VAN_DYN = { accel: 1.8, decel: 2.6, lat: 1.8, wheelbase: 3.7 };
/** 靠台后的准备（放轮挡、车辆锁、调平板、开门）：半挂车 3 分钟、单体货车 2 分钟、面包车 1 分钟；压缩时最少到一半 */
export const PREP = { rig: 180, truck: 120, van: 60 };
/** 靠稳、准备完以后至少要留的装卸时间（停留放不下进场、倒车、准备和它，才算 tight） */
export const MIN_WORK = { rig: 300, truck: 240, van: 120 };
/** 驶出时在路口停车让行（专用通道）的秒数；经支路时按信号灯的平均红灯等待 */
export const YIELD_RIG = 5;
export const YIELD_BODY = 3.5;
export const SIGNAL_WAIT = 28;
