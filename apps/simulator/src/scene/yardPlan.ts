import { VEHICLE_LENGTH } from './vehicleTypes';

/**
 * 卸货场的布置（决策记录 0018、0019）：车道位置、待命车位数、两头掉头的位置、甩挂车位。纯函数，不依赖 three.js，
 * 周边环境（site.ts）用它划出卸货场的范围，车辆动线（yard.ts）按它生成路线。
 *
 * 车道从后墙往外：靠台车道（向 +X）、驶离车道（向 −X）、待命车道（向 −X，先到的车在西头）、顶部车道（向 +X）；
 * 半挂车总是沿靠台车道向 +X 驶过卸货门、从司机一侧（左侧）倒车靠台。进场道路可以在门店右侧（东）或左侧（西）：
 * - 右侧：后勤通道（或支路）上行 → 右转进待命车道排队 → 西头右转掉头下到靠台车道；驶离：拉出 → 右转上驶离车道 →
 *   西头左转掉头上到顶部车道 → 东头左转下后勤通道；
 * - 左侧：后勤通道（或支路）上行 → 左转上顶部车道 → 东头左转掉头下到待命车道排队 → 西头右转掉头下到靠台车道；
 *   驶离：拉出 → 右转上驶离车道 → 一直向西到后勤通道右转下行。
 * 后勤通道可以接主路（专用通道，路口是喇叭口），也可以是门店侧面的支路（经信号灯路口进出）。
 */

export type YardSide = 'RIGHT' | 'LEFT';
export type YardVia = 'DRIVE' | 'STREET';

export interface YardPlan {
  side: YardSide;
  via: YardVia;
  /** 后墙（卸货门所在的墙）z */
  wall: number;
  /** 场地范围：x0 … x1，后墙 … z1 */
  x0: number;
  x1: number;
  z1: number;
  /** 进场道路（后勤通道或支路）：中心线、半宽（不含人行道）；上行（进场）与下行（驶离）车道中心 x */
  driveX: number;
  driveHalf: number;
  xIn: number;
  xOut: number;
  /** 靠台车道、驶离车道、待命车道、顶部车道 */
  zCourt: number;
  zExit: number;
  zQueue: number;
  zTop: number;
  /** 待命车道：排在最前的车的车头 x、车位数、车位间距 */
  xHead: number;
  slots: number;
  pitch: number;
  /** 西头的掉头：靠台（右转下行）的起点 x；驶离（右侧进场时左转上行）的起点 x */
  xTurnDock: number;
  xTurnExit: number;
  /** 左侧进场：东头从顶部车道掉头下到待命车道的位置 */
  xEast: number;
  /** 进场点（进场车道上，后墙的延长线处）z */
  gateZ: number;
  /** 甩挂车位：车位中心、挂车朝向（车头朝顶部车道） */
  stalls: Array<{ x: number; z: number; heading: number }>;
}

export interface YardInput {
  side: YardSide;
  via: YardVia;
  driveX: number;
  driveHalf: number;
  xIn: number;
  xOut: number;
  /** 后墙 z */
  wall: number;
  /** 场地另一头能用到哪里：右侧进场时是西边界，左侧进场时是东边界 */
  farLimit: number;
  /** 卸货门的位置：靠台车道要从最西边的门往西留出驶近的距离 */
  doorXs: number[];
  /** 待命车位数（0 = 自动：按卸货门数 3–4 个；指定时最多 6 个，放不下时按放得下的） */
  slots: number;
  /** 甩挂车位数 */
  trailerStalls: number;
}

/** 进待命车道（右侧进场）和下后勤通道（驶离）的转弯半径（米）：洲际半挂车的最小转弯半径约 12.5 米 */
export const R_IN = 13;
export const R_OUT = 13;
/** 车道之间的掉头半径不小于 12 米 */
const SEMI_LEN = VEHICLE_LENGTH.semi;
/** 甩挂车位：宽 3.8 米、深 17 米（53 英尺挂车） */
export const STALL_W = 3.8;
export const STALL_D = 17;
/** 靠台车道从最西边的卸货门往西至少要有的长度（驶近、倒车起点前的直线） */
const DOOR_LEAD = 30;

export function planYard(input: YardInput): YardPlan {
  const { side, wall, xIn, xOut } = input;
  const pitch = SEMI_LEN + 3;
  // 靠台车道离墙 31 米：倒车时挂车要在离墙 24 米以外摆正（两边停着的车头到 22 米）；
  // 驶离车道在拉出后右转（半径约 12.8 米）的位置；待命车道在倒车摆车头的范围之外；
  // 顶部车道与待命车道之间能掉头（半径 12 米）
  const zCourt = wall + 31;
  const zExit = wall + 51.5;
  const zQueue = wall + 57.8;
  const zTop = wall + 81.8;
  const minDoor = input.doorXs.length ? Math.min(...input.doorXs) : xIn;
  const maxDoor = input.doorXs.length ? Math.max(...input.doorXs) : xIn;
  const want = input.slots > 0 ? Math.min(6, input.slots) : 0;
  // 自动：按卸货门数（3 个门以下 3 个待命车位，4–6 个门 4 个），放不下时按放得下的
  const auto = Math.min(4, Math.max(2, 2 + Math.ceil(input.doorXs.length / 3)));
  let xHead: number;
  let slots: number;
  let xTurnDock: number;
  let xEast: number;
  let x0: number;
  let x1: number;
  if (side === 'RIGHT') {
    // 待命车道上能排几辆半挂车：队尾的挂车尾部离进口转弯留 3 米，西头留出两个掉头的地方
    const tailRear = xIn - R_IN - 3;
    const westRoom = 21.3;
    const fit = Math.max(1, Math.floor((tailRear - SEMI_LEN - westRoom - input.farLimit) / pitch) + 1);
    slots = want ? Math.min(want, fit) : Math.min(auto, fit);
    xHead = tailRear - SEMI_LEN - (slots - 1) * pitch;
    // 卸货门在西边时，靠台车道的起点（掉头处）还要再往西
    xTurnDock = Math.min(xHead - 2, minDoor - DOOR_LEAD);
    xEast = xIn;
    x0 = xTurnDock - 19.3;
    x1 = input.driveX + input.driveHalf;
  } else {
    // 西头：进场道路东边留出靠台掉头（半径 12 米）的地方；待命车道从这里往东排，东头再掉头
    const west = input.driveX + input.driveHalf;
    xTurnDock = Math.max(west + 16, Math.min(minDoor - DOOR_LEAD, west + 40));
    xHead = xTurnDock + 2;
    const room = input.farLimit - 15 - 3 - xHead;
    const fit = Math.max(1, Math.floor((room - SEMI_LEN) / pitch) + 1);
    slots = want ? Math.min(want, fit) : Math.min(auto, fit);
    xEast = Math.max(xHead + (slots - 1) * pitch + SEMI_LEN + 3, maxDoor + 12);
    x0 = input.driveX - input.driveHalf;
    x1 = Math.max(xEast + 15, maxDoor + 22);
  }
  // 甩挂车位：顶部车道外侧一排，挂车车头朝顶部车道；避开两头的掉头和进场道路的转弯
  const stalls: YardPlan['stalls'] = [];
  const sx0 = side === 'RIGHT' ? x0 + 26 : x0 + input.driveHalf * 2 + 22;
  const sx1 = side === 'RIGHT' ? xIn - R_IN - 6 : xEast - 4;
  const nStall = Math.max(0, Math.min(input.trailerStalls, Math.floor((sx1 - sx0) / STALL_W)));
  const zStall = zTop + 5 + STALL_D / 2;
  for (let k = 0; k < nStall; k++) stalls.push({ x: sx0 + (k + 0.5) * STALL_W, z: zStall, heading: Math.PI });
  const z1 = nStall ? zTop + 6 + STALL_D : zTop + 4;
  return {
    side,
    via: input.via,
    wall,
    x0,
    x1,
    z1,
    driveX: input.driveX,
    driveHalf: input.driveHalf,
    xIn,
    xOut,
    zCourt,
    zExit,
    zQueue,
    zTop,
    xHead,
    slots,
    pitch,
    xTurnDock,
    xTurnExit: xTurnDock - 2,
    xEast,
    gateZ: wall,
    stalls,
  };
}
