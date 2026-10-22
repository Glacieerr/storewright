/**
 * 领域核心类型。
 *
 * 约定：
 * - 长度单位为厘米（商品尺寸）或米（门店坐标、行走距离）；重量单位为千克；容积单位为升。
 *   界面显示时再按门店配置换算为英制单位。
 * - 仿真时间单位为秒，0 表示仿真当天 00:00。
 */

export type TempZone = 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'HOT';
export const TEMP_ZONES: readonly TempZone[] = ['AMBIENT', 'CHILLED', 'FROZEN', 'HOT'];

/** 处理方式。一个商品可以同时具有多种处理方式。 */
export type Handling =
  | 'STANDARD'
  | 'FRAGILE'
  | 'CHEMICAL'
  | 'HAZMAT'
  | 'AGE_RESTRICTED'
  | 'SECURED'
  | 'OVERSIZED'
  | 'TEAM_LIFT';

export type FulfillmentType = 'GROCERY' | 'GM' | 'MTO' | 'PARCEL';
export type OrderType = 'PICKUP' | 'DELIVERY';
export type PricingMode = 'EACH' | 'WEIGHT';

/** 压放等级：0 = 底层（重、耐压），3 = 顶层（易碎）。装框时按等级从低到高放入。 */
export type CrushClass = 0 | 1 | 2 | 3;

export interface Dimensions {
  /** 厘米 */
  l: number;
  w: number;
  h: number;
}

export interface Item {
  id: string;
  gtin: string;
  name: string;
  categoryId: string;
  tempZone: TempZone;
  handling: readonly Handling[];
  fulfillmentType: FulfillmentType;
  dims: Dimensions;
  /** 单件重量（千克）；按重量计价的商品为典型单件重量 */
  weightKg: number;
  crushClass: CrushClass;
  pricing: PricingMode;
  /** 每件价格，或按重量计价时的每千克价格 */
  unitPrice: number;
  attributes: Readonly<Record<string, string | number | boolean>>;
  /** 陈列位置，第一个为主位置 */
  locationIds: readonly string[];
  /** 相对需求权重（合成数据使用） */
  popularity: number;
  /** 拣货时在货架上找到的概率（合成数据使用） */
  shelfAvailability: number;
  /** 货架缺货时后仓仍有库存的概率（合成数据使用） */
  backroomAvailability: number;
  /** 非食品行业的商品（例如家居建材，决策记录 0011）：没有「化学品与食品分开装框」的要求 */
  nonFood?: true;
}

export interface Customer {
  id: string;
  firstName: string;
  lastName: string;
}

export interface OrderLine {
  lineId: string;
  itemId: string;
  qty: number;
  allowSubstitution: boolean;
}

export interface Point2 {
  x: number;
  y: number;
}

export interface Order {
  id: string;
  /** 订单短号，便于口头核对 */
  shortCode: string;
  customer: Customer;
  type: OrderType;
  fulfillmentType: FulfillmentType;
  express: boolean;
  /** 仿真秒 */
  createdAt: number;
  slotStart: number;
  slotLengthSec: number;
  lines: readonly OrderLine[];
  /** 配送目的地相对门店的坐标（千米），仅配送订单 */
  destinationKm?: Point2;
}

export interface ToteLine {
  lineId: string;
  itemId: string;
  qty: number;
}

/** 框任务：履约段按容量拆分后的单位，只属于一个订单。 */
export interface ToteAssignment {
  id: string;
  orderId: string;
  tempZone: TempZone;
  fulfillmentType: FulfillmentType;
  /** 化学品单独装框 */
  chemical: boolean;
  /** 在订单全部框中的序号（从 1 开始）与总数，用于标签上的 x/n */
  index: number;
  count: number;
  lines: ToteLine[];
  volumeL: number;
  weightKg: number;
  slotStart: number;
  /** 拣货截止时间（自取为时段起点，配送需提前） */
  dueAt: number;
}

/** 不进框的大件（先扫后打，一件一签） */
export interface OversizedPiece {
  id: string;
  orderId: string;
  lineId: string;
  itemId: string;
  index: number;
  count: number;
  teamLift: boolean;
  weightKg: number;
}

export interface PickInstruction {
  toteAssignmentId: string;
  lineId: string;
  itemId: string;
  qty: number;
}

export interface PickStop {
  locationId: string;
  nodeId: number;
  picks: PickInstruction[];
}

/** 拣货批次：一辆推车的一次行程，单一温区。 */
export interface PickWalk {
  id: string;
  tempZone: TempZone;
  fulfillmentType: FulfillmentType;
  toteAssignmentIds: string[];
  /** 已按路线顺序排列；拣货顺序就是路线顺序 */
  stops: PickStop[];
  distanceM: number;
  /** 按标准工时估算的用时（秒） */
  estimatedSec: number;
  /** 冷链时限（秒），仅冷藏 / 冷冻批次 */
  coldLimitSec?: number;
  dueAt: number;
}

export type VehiclePosition = 'FRONT_PASSENGER' | 'REAR_LEFT' | 'REAR_RIGHT' | 'TRUNK';
export const VEHICLE_POSITIONS: readonly VehiclePosition[] = ['FRONT_PASSENGER', 'REAR_LEFT', 'REAR_RIGHT', 'TRUNK'];

/** 配送行程：多个配送订单，一次核验。 */
export interface Trip {
  id: string;
  orderIds: string[];
  placements: Record<string, VehiclePosition>;
  totes: number;
  weightKg: number;
}
