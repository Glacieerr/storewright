import type { StoreConfig, TemplateName } from '@storewright/store-config';
import { DEFAULT_COSTS, type CostParams, type DayMetrics, type Disruption, type InboundMetrics, type Role, type Staffing } from '@storewright/sim-engine';
import type { PolicyName, Timeline } from '../sim/protocol';
import type { SiteSettings } from '../scene/site';

/**
 * 保存的方案：一组完整的设置（门店布局、策略、排班、订单量、环境、突发状况、夜班）
 * 加上保存时的全天结果摘要和场景缩略图。保存在本机浏览器里（换浏览器或清除网站数据会丢失），
 * 也可以随报告一起导出。
 */
export interface ScenarioSettings {
  template: TemplateName;
  policy: PolicyName;
  seed: number;
  demandFactor: number;
  staffing: Staffing;
  site: SiteSettings;
  sizing?: { ordersPerDay: number; staffScale: number };
  incidents: { small: boolean; randomLarge: boolean; manual: Disruption[] };
  nightCrew: { enabled: boolean; crew?: number };
  /** 学生兼职工（决策记录 0020；旧方案没有这一项） */
  students?: { enabled: boolean; count?: number; roles: Role[] };
  config: StoreConfig;
}

/** 方案的全天结果摘要（对比、经营账、报告用） */
export interface ScenarioDigest {
  metrics: DayMetrics;
  inbound: InboundMetrics;
  autoRevenue: number;
  autoServed: number;
  pharmacyServed: number;
  forklifts: number;
  palletJacks: number;
  aisles: number;
  floors: number;
  floorAreaM2: number;
  staffTotal: number;
  nightCrew: number;
  hours: string;
}

export interface SavedScenario {
  id: string;
  name: string;
  savedAt: number;
  thumb?: string;
  settings: ScenarioSettings;
  digest: ScenarioDigest;
}

export function digestOf(tl: Timeline, config: StoreConfig): ScenarioDigest {
  const hh = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  // 排班峰值人数（各岗位同一小时的最大在岗人数之和）
  const staffTotal = Object.values(tl.staffing).reduce((n, perHour) => n + Math.max(0, ...perHour), 0);
  return {
    metrics: tl.metrics,
    inbound: tl.inbound.metrics,
    autoRevenue: tl.autoService.reduce((n, a) => n + a.metrics.revenue, 0),
    autoServed: tl.autoService.reduce((n, a) => n + a.metrics.served, 0),
    pharmacyServed: tl.pharmacy?.metrics.served ?? 0,
    forklifts: config.backroom.forklifts,
    palletJacks: config.backroom.palletJacks,
    aisles: config.layout.runs.filter((r) => r.kind === 'AISLE').length,
    floors: config.layout.floors.length,
    floorAreaM2: config.layout.floors.reduce((n, f) => n + f.widthM * f.depthM, 0),
    staffTotal,
    nightCrew: tl.inbound.nightCrew,
    hours: `${hh(config.hours.openMin)}–${hh(config.hours.closeMin)}`,
  };
}

/** 经营账的输入 */
export function economicsInput(d: ScenarioDigest) {
  return {
    metrics: d.metrics,
    receivingHours: d.inbound.receivingHours,
    nightHours: d.inbound.nightHours,
    forklifts: d.forklifts,
    palletJacks: d.palletJacks,
    backlogCases: d.inbound.backlogCases,
    autoRevenue: d.autoRevenue,
  };
}

const KEY = 'storewright.scenarios.v1';
const COST_KEY = 'storewright.costs.v1';

export function loadSavedScenarios(): SavedScenario[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedScenario[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.settings && s.digest) : [];
  } catch {
    return [];
  }
}

/** 保存到本机；空间不够时先去掉缩略图再试 */
export function persistScenarios(list: SavedScenario[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(list.map((s) => ({ ...s, thumb: undefined }))));
      return true;
    } catch {
      return false;
    }
  }
}

export function loadCosts(): CostParams {
  try {
    const raw = window.localStorage.getItem(COST_KEY);
    return raw ? { ...DEFAULT_COSTS, ...(JSON.parse(raw) as Partial<CostParams>) } : { ...DEFAULT_COSTS };
  } catch {
    return { ...DEFAULT_COSTS };
  }
}

export function persistCosts(c: CostParams): void {
  try {
    window.localStorage.setItem(COST_KEY, JSON.stringify(c));
  } catch {
    // 本机存储不可用时只在本次使用
  }
}
