import { z } from 'zod';
import type { Rule } from '@storewright/domain';

/**
 * 门店配置 schema（决策 C-01、C-02）。
 *
 * 一份门店配置是纯 JSON：可以由模板生成、由可视化编辑器修改、导入导出，并带版本号。
 * 布局用「可行走线段」描述：货架通道（run，两侧或单侧有货架）和走廊（corridor）。
 * 行走网络由这些线段自动推导，编辑器只需要编辑线段。
 */

const TempZone = z.enum(['AMBIENT', 'CHILLED', 'FROZEN', 'HOT']);
const FulfillmentType = z.enum(['GROCERY', 'GM', 'MTO', 'PARCEL']);
const Handling = z.enum(['STANDARD', 'FRAGILE', 'CHEMICAL', 'HAZMAT', 'AGE_RESTRICTED', 'SECURED', 'OVERSIZED', 'TEAM_LIFT']);

const Vec2 = z.object({ x: z.number(), y: z.number() });
const PointOnFloor = z.object({ floorId: z.string(), x: z.number(), y: z.number() });

export const FloorSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  level: z.number().int(),
  widthM: z.number().positive(),
  depthM: z.number().positive(),
});

export const RunSchema = z.object({
  id: z.string().min(1),
  floorId: z.string(),
  kind: z.enum(['AISLE', 'WALL', 'TABLE', 'BACKROOM_RACK']),
  label: z.string().optional(),
  /** 拣货员行走的中线 */
  start: Vec2,
  end: Vec2,
  /** 两侧有货架为 2，靠墙单侧为 1 */
  sides: z.union([z.literal(1), z.literal(2)]),
  bays: z.number().int().positive(),
  levels: z.number().int().positive(),
  /** 线段两端留给转弯的长度（米），货架段均匀分布在中间 */
  endMarginM: z.number().nonnegative().default(1.5),
  tempZone: TempZone,
  categoryIds: z.array(z.string()),
  /** 蛇形顺序，用于分区重叠度和基线路线；越小越靠前 */
  sequence: z.number().int().nonnegative(),
});

export const CorridorSchema = z.object({
  id: z.string().min(1),
  floorId: z.string(),
  start: Vec2,
  end: Vec2,
});

export const ConnectorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['ELEVATOR', 'STAIRS', 'ESCALATOR']),
  a: PointOnFloor,
  b: PointOnFloor,
  /** 单程耗时（秒），含等待 */
  traversalSec: z.number().positive(),
});

export const StagingRackSchema = z.object({
  id: z.string().min(1),
  /** 编码中的区域段，例如 AMB / CHL / FRZ / HOT / OVS / GM / RCV */
  zoneCode: z.string().min(1),
  tempZone: TempZone,
  purpose: z.enum(['ORDERS', 'GM', 'OVERSIZED', 'RECOVERY']),
  area: z.enum(['PICKUP', 'DELIVERY', 'ANY']),
  rackNo: z.number().int().positive(),
  levels: z.number().int().positive(),
  slotsPerLevel: z.number().int().positive(),
  totesPerSlot: z.number().int().positive(),
  /** 货架中心相对暂存点的步行距离（米） */
  distanceFromStagingM: z.number().nonnegative(),
  /** 所在的暂存区域（决策记录 0013）；不给时按原来的规则从暂存点排开 */
  areaId: z.string().optional(),
  /** 货架中心位置（米）；给了就按这个位置摆放 */
  x: z.number().optional(),
  z: z.number().optional(),
});

const AREA_KIND = z.enum(['UNLOAD', 'RECEIVING_HOLD', 'QA', 'RTV', 'RETURNS', 'PALLETS', 'BALER', 'RACKS', 'COOLER', 'FREEZER', 'OVERSTOCK', 'BULK', 'CAGE', 'CHEM', 'CHARGING', 'STAGING', 'STAGING_DELIVERY', 'STAGING_OVERSIZED', 'HOT_HOLD', 'PARCEL', 'RECOVERY']);

/** 区域（决策记录 0013）：收货、后仓存储、暂存的每一块地面，矩形，单位米 */
export const AreaSchema = z.object({
  id: z.string().min(1),
  kind: AREA_KIND,
  floorId: z.string(),
  x0: z.number(),
  z0: z.number(),
  x1: z.number(),
  z1: z.number(),
  tempZone: TempZone.optional(),
  /** 容量（单位按区域类型：托盘位 / 箱 / 框 / 件 / 包裹）；不给时按面积和货架推算 */
  capacity: z.number().int().positive().optional(),
  /** 占用超过这个比例时提醒，默认 0.85 */
  alertAt: z.number().gt(0).max(1).optional(),
  label: z.string().optional(),
});

/** 卸货门：一楼后墙上的位置（米） */
export const DockSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  kind: z.enum(['DOCK', 'GRADE']).optional(),
  reefer: z.boolean().optional(),
});

/** 线上取货车位：编号、车位中心（米，门店坐标，店外 y 为负）和车头朝向（度） */
export const PickupBaySchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  z: z.number(),
  heading: z.number(),
});

export const CategorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  nameZh: z.string(),
  tempZone: TempZone,
  fulfillmentType: FulfillmentType,
  handling: z.array(Handling),
  crushClass: z.number().int().min(0).max(3),
  seasonal: z.boolean().default(false),
});

const ConditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }),
    z.object({ any: z.array(ConditionSchema) }),
    z.object({ not: ConditionSchema }),
    z.object({
      field: z.string(),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'includes']),
      value: z.unknown(),
    }),
  ]),
);

export type SizeClass = 'STANDARD' | 'OVERSIZED' | 'TEAM_LIFT';
const SizeClassSchema = z.enum(['STANDARD', 'OVERSIZED', 'TEAM_LIFT']);

const RuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  when: ConditionSchema,
  then: SizeClassSchema,
});

export const RulesSchema = z.object({
  /** 时段长度（决策 O-01） */
  slotLengthMin: z.union([z.literal(60), z.literal(120)]),
  /** 锁单提前量（决策 O-03） */
  lockLeadMin: z.number().int().positive(),
  /** 冷链时限 = clamp(base + perItem × 件数, min, max)（决策 P-12） */
  coldChain: z.object({
    baseMin: z.number().nonnegative(),
    perItemMin: z.number().nonnegative(),
    minMin: z.number().positive(),
    maxMin: z.number().positive(),
  }),
  /** 大件分类规则，按顺序求值，第一条命中为准（决策 GM-01） */
  sizeRules: z.array(RuleSchema),
  /** 不得进入 GM 的温区 */
  gmExcludedTempZones: z.array(TempZone),
  handoff: z.object({
    /** 「即将到达」阈值，门店级固定常量（工程约束 EC-7） */
    approachingMin: z.number().positive(),
    longWaitMin: z.number().positive(),
    maxOrdersPerTrip: z.number().int().min(1).max(4),
    /** 验证码连续错几次后提供「人工核验」入口（不锁定，验证码仍可继续输入；决策记录 0014） */
    codeAttempts: z.number().int().positive(),
    /** 配送司机取消：预计到店前多少分钟起进入准备期、不能取消（默认 10；决策记录 0014） */
    driverCancelLockMin: z.number().positive().optional(),
    /** 配送司机取消：到店后等待多少分钟起可以取消（默认 10） */
    driverCancelWaitMin: z.number().positive().optional(),
    /** 配送订单需要在时段起点之前多久就绪 */
    deliveryReadyLeadMin: z.number().nonnegative(),
    /** 位置上报固定间隔（秒） */
    locationIntervalSec: z.number().positive(),
  }),
  staging: z.object({
    mode: z.enum(['SELF_SELECT', 'SUGGEST']),
    occupancyAlert: z.number().min(0).max(1),
  }),
  substitution: z.object({
    pricing: z.enum(['ACTUAL', 'ORIGINAL', 'LOWER']),
    priceBand: z.number().min(0),
    curbsideReject: z.boolean(),
  }),
  labels: z.object({
    nameMaxLength: z.number().int().min(6),
  }),
});

/**
 * 门店附属设施。目前支持汽车快修中心（换机油、换轮胎），独立于店内拣货网络，
 * 建在门店一侧，车辆从停车场驶入维修工位。
 */
export const AutoServiceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('AUTO_SERVICE'),
  name: z.string(),
  side: z.enum(['LEFT', 'RIGHT']),
  oilBays: z.number().int().min(0).max(8),
  tireBays: z.number().int().min(0).max(8),
  /** 每天到店车辆数；0 表示按工位数估算 */
  carsPerDay: z.number().int().min(0).max(500).default(0),
  hours: z.object({ openMin: z.number().int().min(0), closeMin: z.number().int().max(24 * 60) }),
  /** 每小时在岗技师人数（长度 24）；不给时每个工位配一名技师 */
  techs: z.array(z.number().int().min(0)).length(24).optional(),
});

/** 园艺中心：门店一侧带围栏的露天卖场（花卉、园艺用品），只用于画面和面积规划 */
export const GardenCenterSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('GARDEN_CENTER'),
  name: z.string(),
  side: z.enum(['LEFT', 'RIGHT']),
  widthM: z.number().min(10).max(40).default(18),
  depthM: z.number().min(12).max(40).default(22),
});

/** 药房：店内正面一角的柜台，顾客取药、咨询；按柜台数排队 */
export const PharmacySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('PHARMACY'),
  name: z.string(),
  counters: z.number().int().min(1).max(4),
  /** 每天来取药 / 咨询的顾客数；0 表示按门店规模估算 */
  patientsPerDay: z.number().int().min(0).max(800).default(0),
  hours: z.object({ openMin: z.number().int().min(0), closeMin: z.number().int().max(24 * 60) }),
});

export const FacilitySchema = z.discriminatedUnion('kind', [AutoServiceSchema, GardenCenterSchema, PharmacySchema]);

export const StoreConfigSchema = z.object({
  schemaVersion: z.literal(1),
  configVersion: z.number().int().nonnegative(),
  id: z.string().min(1),
  name: z.string(),
  template: z.enum(['small', 'medium', 'large', 'hardware', 'custom']),
  /** 行业（决策记录 0011）：决定默认品类、布局、需求形态；旧配置没有这一项时视为超市 */
  industry: z.enum(['GROCERY', 'HARDWARE']).optional(),
  units: z.object({ weight: z.enum(['lb', 'kg']) }),
  hours: z.object({ openMin: z.number().int().min(0), closeMin: z.number().int().max(24 * 60) }),
  layout: z.object({
    floors: z.array(FloorSchema).min(1),
    runs: z.array(RunSchema).min(1),
    corridors: z.array(CorridorSchema),
    connectors: z.array(ConnectorSchema),
    points: z.object({
      cartDepot: PointOnFloor,
      staging: PointOnFloor,
      handoff: PointOnFloor,
      backroom: PointOnFloor,
    }),
  }),
  staging: z.object({
    /** 例如 "{zone}-{rack}-{level}-{slot}"，管理员可自定义（决策 S-01） */
    codePattern: z.string().min(1),
    pad: z.number().int().min(1).max(4),
    racks: z.array(StagingRackSchema).min(1),
  }),
  catalog: z.object({
    categories: z.array(CategorySchema).min(1),
  }),
  equipment: z.object({
    cart: z.object({ totesPerCart: z.number().int().min(1).max(12) }),
    tote: z.object({
      innerCm: z.object({ l: z.number().positive(), w: z.number().positive(), h: z.number().positive() }),
      maxWeightKg: z.number().positive(),
      fillFactor: z.number().gt(0).max(1),
    }),
  }),
  rules: RulesSchema,
  /** 附属设施；旧版配置没有这一项时视为空 */
  facilities: z.array(FacilitySchema).default([]),
  /** 店外：停车场双排车位排数、线上取货专用车位数（0 表示按门店宽度自动确定） */
  outdoor: z
    .object({
      parkingRows: z.number().int().min(0).max(5).default(0),
      pickupBays: z.number().int().min(0).max(30).default(0),
      /** 顾客入口在门店正面的位置（米）；不给时放在正面约 42% 处 */
      entranceX: z.number().optional(),
    })
    .default({ parkingRows: 0, pickupBays: 0 }),
  /**
   * 后仓（库存仓库）：在售货区后墙之后再加深的米数、托盘货架排数（0 = 按深度自动）与层数、
   * 卸货门数量、叉车与手动液压搬运车数量
   */
  backroom: z
    .object({
      extraDepthM: z.number().min(0).max(40).default(0),
      rackRows: z.number().int().min(0).max(10).default(0),
      rackLevels: z.number().int().min(2).max(5).default(3),
      docks: z.number().int().min(1).max(4).default(3),
      forklifts: z.number().int().min(0).max(4).default(1),
      palletJacks: z.number().int().min(0).max(6).default(2),
    })
    .default({ extraDepthM: 0, rackRows: 0, rackLevels: 3, docks: 3, forklifts: 1, palletJacks: 2 }),
  /** 区域（决策记录 0013）；不给时按门店尺寸自动生成 */
  areas: z.array(AreaSchema).optional(),
  /** 卸货门；不给时按 backroom.docks 自动排在后墙右侧 */
  docks: z.array(DockSchema).optional(),
  /** 停车：线上取货车位的明确位置；不给时按门店宽度自动生成 */
  parking: z.object({ pickupBays: z.array(PickupBaySchema).optional() }).optional(),
  modules: z.object({
    gm: z.boolean(),
    mto: z.boolean(),
    parcelHub: z.boolean(),
    /** 退货（Phase 6）：旧配置没有这个字段时默认打开 */
    returns: z.boolean().default(true),
    exceptions: z.boolean(),
    trips: z.boolean(),
    sensors: z.boolean(),
    staffingAi: z.boolean(),
  }),
});

export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type FloorConfig = z.infer<typeof FloorSchema>;
export type RunConfig = z.infer<typeof RunSchema>;
export type CorridorConfig = z.infer<typeof CorridorSchema>;
export type ConnectorConfig = z.infer<typeof ConnectorSchema>;
export type StagingRackConfig = z.infer<typeof StagingRackSchema>;
export type AreaConfig = z.infer<typeof AreaSchema>;
export type DockConfig = z.infer<typeof DockSchema>;
export type PickupBayConfig = z.infer<typeof PickupBaySchema>;
export type CategoryConfig = z.infer<typeof CategorySchema>;
export type RulesConfig = z.infer<typeof RulesSchema>;
export type SizeRule = Rule<SizeClass>;
export type AutoServiceConfig = z.infer<typeof AutoServiceSchema>;
export type FacilityConfig = z.infer<typeof FacilitySchema>;
export type GardenCenterConfig = z.infer<typeof GardenCenterSchema>;
export type PharmacyConfig = z.infer<typeof PharmacySchema>;
