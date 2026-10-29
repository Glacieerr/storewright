import type { TempZone } from '@storewright/domain';
import type { StoreStatic } from '@storewright/ops';

/**
 * 孪生的设备层（决策记录 0016 第 4.1 节）：传感器清单从门店的静态数据推导，服务端和查看端各自算出同一份，
 * 所以推送里只需要传读数。名称不在这里写，界面按种类和所在位置翻译。
 *
 * - 温度：后仓的冷藏库、冷冻库各一个；暂存区里每个有冷藏或冷冻格位的区域，每个温区一个；熟食保温区一个；
 * - 门磁：每个卸货门一个（1 = 打开）；
 * - 客流：入口一个（店内人数）。
 * 货架上的测距、称重传感器仍然走原来的接入（RecordSensor），不在这份清单里。
 */

export type SensorKind = 'TEMP' | 'DOOR' | 'COUNT';

/** 传感器装在哪里：区域（后仓冷库、暂存区、保温区）、卸货门、入口 */
export type SensorAnchor = { type: 'AREA'; areaId: string; areaKind: string } | { type: 'DOCK'; dockId: string; index: number } | { type: 'ENTRANCE' };

/** 温度阈值：冷的设备不能高于 limit（MAX），热保温不能低于 limit（MIN）；越过 critical 立即告警 */
export interface TempLimits {
  direction: 'MAX' | 'MIN';
  nominal: number;
  limit: number;
  critical: number;
}

export interface SensorDef {
  id: string;
  kind: SensorKind;
  anchor: SensorAnchor;
  /** 温度传感器监控的温区 */
  tempZone?: TempZone;
  floorId?: string;
  /** 区域中心（场景坐标，米）；卸货门和入口由场景按自己的几何放置 */
  x?: number;
  z?: number;
  /** 上报周期（秒） */
  intervalSec: number;
  limits?: TempLimits;
}

/**
 * 常用的食品安全数值：冷藏不高于 5 °C、冷冻 −18 °C 左右（高于 −15 °C 告警）、热保温不低于 57 °C。
 * 严重线：冷藏 8 °C、冷冻 −12 °C、热保温 50 °C，越过立即告警。
 */
export const TEMP_LIMITS: Record<'CHILLED' | 'FROZEN' | 'HOT', TempLimits> = {
  CHILLED: { direction: 'MAX', nominal: 3, limit: 5, critical: 8 },
  FROZEN: { direction: 'MAX', nominal: -20, limit: -15, critical: -12 },
  HOT: { direction: 'MIN', nominal: 66, limit: 57, critical: 50 },
};

const ZONE_SUFFIX: Record<string, string> = { CHILLED: 'C', FROZEN: 'F', HOT: 'H' };

export function sensorsFor(st: StoreStatic): SensorDef[] {
  const out: SensorDef[] = [];
  const areas = st.areas ?? [];
  const center = (id: string) => {
    const a = areas.find((x) => x.id === id);
    return a ? { floorId: a.floorId, x: (a.x0 + a.x1) / 2, z: (a.z0 + a.z1) / 2 } : {};
  };
  // 后仓冷库与熟食保温区：整个区域一个温区
  for (const a of areas) {
    const zone = a.kind === 'COOLER' ? 'CHILLED' : a.kind === 'FREEZER' ? 'FROZEN' : a.kind === 'HOT_HOLD' ? 'HOT' : undefined;
    if (!zone) continue;
    out.push({ id: `T-${a.id}`, kind: 'TEMP', anchor: { type: 'AREA', areaId: a.id, areaKind: a.kind }, tempZone: zone, ...center(a.id), intervalSec: 10, limits: TEMP_LIMITS[zone] });
  }
  // 暂存区：冷藏柜、冷冻柜（同一区域里同一温区的格位共用一台设备）
  const seen = new Set<string>();
  for (const sl of st.slots) {
    if (sl.tempZone !== 'CHILLED' && sl.tempZone !== 'FROZEN') continue;
    const areaId = sl.areaId ?? 'STAGING';
    const key = `${areaId}|${sl.tempZone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = areas.find((a) => a.id === areaId)?.kind ?? 'STAGING';
    out.push({ id: `T-${areaId}-${ZONE_SUFFIX[sl.tempZone]}`, kind: 'TEMP', anchor: { type: 'AREA', areaId, areaKind: kind }, tempZone: sl.tempZone, ...center(areaId), intervalSec: 10, limits: TEMP_LIMITS[sl.tempZone] });
  }
  (st.docks ?? []).forEach((d, i) => out.push({ id: `D-${d.id}`, kind: 'DOOR', anchor: { type: 'DOCK', dockId: d.id, index: i }, intervalSec: 10 }));
  out.push({ id: 'C-ENTRANCE', kind: 'COUNT', anchor: { type: 'ENTRANCE' }, intervalSec: 10 });
  return out;
}

/** 一台温度设备管着哪些暂存格位（冷库和保温区按区域，暂存柜按区域 + 温区） */
export function slotsOf(def: SensorDef, st: StoreStatic): string[] {
  if (def.anchor.type !== 'AREA' || !def.tempZone) return [];
  const { areaId, areaKind } = def.anchor;
  if (areaKind === 'HOT_HOLD') return st.hotSlots ?? st.slots.filter((s) => s.tempZone === 'HOT').map((s) => s.code);
  return st.slots.filter((s) => (s.areaId ?? 'STAGING') === areaId && s.tempZone === def.tempZone).map((s) => s.code);
}

/** 一台冷库设备管着哪些后仓库位 */
export function binsOf(def: SensorDef, st: StoreStatic): string[] {
  if (def.anchor.type !== 'AREA') return [];
  const { areaId } = def.anchor;
  return st.bins.filter((b) => b.areaId === areaId).map((b) => b.code);
}
