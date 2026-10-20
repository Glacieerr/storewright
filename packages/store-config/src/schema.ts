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
    codeAttempts: z.number().int().positive(),
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

export const StoreConfigSchema = z.object({
  schemaVersion: z.literal(1),
  configVersion: z.number().int().nonnegative(),
  id: z.string().min(1),
  name: z.string(),
  template: z.enum(['small', 'medium', 'large', 'custom']),
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
  modules: z.object({
    gm: z.boolean(),
    mto: z.boolean(),
    parcelHub: z.boolean(),
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
export type CategoryConfig = z.infer<typeof CategorySchema>;
export type RulesConfig = z.infer<typeof RulesSchema>;
export type SizeRule = Rule<SizeClass>;
