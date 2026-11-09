/**
 * 仓储中心一天的作业（港口物流中心、机场货站、物流园的转运仓和配送中心收发货场、门店的停车场和收货场）。
 *
 * 每个设施的作业模型（src/hub/port.ts、airport.ts、park.ts，门店是 src/site/）按当天的仿真轨迹、设施配置和负荷档位
 * 排出这一份计划；三维按它摆车、箱、板，值班助手按它回答（两边用同一份，画面和回答对得上）。
 * 纯数据，不依赖 three.js；时刻都是当天 0 点起的秒。
 */
export type HubKey = 'port' | 'airport' | 'park' | 'store';

/** 一个区：堆场、拆装箱库、保税库、查验场、冷库、月台、排队车道、停车场…… */
export interface HubZone {
  /** 区的键（同一个设施里唯一），例如 cy、cfs、bonded、inspect、holding、etv、cold、bulk、docks、queue、pickup、lot */
  key: string;
  label: string;
  kind: 'storage' | 'cold' | 'bonded' | 'inspection' | 'dock' | 'queue' | 'parking' | 'staging' | 'work';
  /** 容量（按 unit 计：箱位、板位、ULD 位、车位、门数） */
  capacity: number;
  unit: string;
}

/** 一件货（一个箱、一块板、一批托盘）或一辆车在设施里走过的区：按先后排，每段是占用这个区的时段 */
export interface HubFlow {
  id: string;
  label: string;
  /** 本店的货或车 */
  own: boolean;
  units: number;
  unit: string;
  steps: { zone: string; t0: number; t1: number; act: string }[];
  /** 从什么载具卸下来、装上什么载具走（船名、航班号、车次、作业编号）；仿真里的车写调度台的作业编号，值班助手按它把排队时间接到那一趟车上 */
  carrierIn?: string;
  carrierOut?: string;
  /** 冷链（冷藏、冷冻）的货或车 */
  cold?: boolean;
  /** 一辆车的一次到访，还是一件货（箱、板、托盘） */
  kind?: 'vehicle' | 'cargo';
}

export interface HubKpi {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** 越大越好还是越小越好（看板、异常检测用） */
  better?: 'higher' | 'lower';
}

export interface HubDay {
  key: HubKey;
  label: string;
  zones: HubZone[];
  flows: HubFlow[];
  /** 每个区的占用：5 分钟一格、26 小时（312 格），按区的 unit 计 */
  occupancy: Record<string, Float32Array>;
  kpi: HubKpi[];
  /** 这一天值得说的几句话（高峰、瓶颈、本店的货在哪） */
  notes: string[];
}

/** 5 分钟一格、到 26 小时 */
export const HUB_SLOT = 300;
export const HUB_SLOTS = 312;

/** 按 flows 的 steps 数出每个区每 5 分钟的平均占用（模型可以直接用） */
export function tallyOccupancy(zones: readonly HubZone[], flows: readonly HubFlow[]): Record<string, Float32Array> {
  const occ: Record<string, Float32Array> = {};
  for (const z of zones) occ[z.key] = new Float32Array(HUB_SLOTS);
  for (const f of flows)
    for (const s of f.steps) {
      const a = occ[s.zone];
      if (!a || !(s.t1 > s.t0)) continue;
      const k0 = Math.max(0, Math.floor(s.t0 / HUB_SLOT));
      const k1 = Math.min(HUB_SLOTS - 1, Math.floor((s.t1 - 1e-6) / HUB_SLOT));
      for (let k = k0; k <= k1; k++) {
        const lo = Math.max(s.t0, k * HUB_SLOT);
        const hi = Math.min(s.t1, (k + 1) * HUB_SLOT);
        if (hi > lo) a[k] = (a[k] as number) + (f.units * (hi - lo)) / HUB_SLOT;
      }
    }
  return occ;
}

/** 时刻 t 一个区的占用（取所在的 5 分钟格） */
export function occupancyAt(day: HubDay, zone: string, t: number): number {
  const a = day.occupancy[zone];
  if (!a) return 0;
  return a[Math.max(0, Math.min(HUB_SLOTS - 1, Math.floor(t / HUB_SLOT)))] ?? 0;
}
