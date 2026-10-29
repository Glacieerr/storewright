import { activeAlerts, type AlertImpact, type EquipmentAlert, type OpsState, type StoreStatic } from '@storewright/ops';
import { binsOf, slotsOf, type SensorDef } from './registry';

/**
 * 告警的影响（决策记录 0016 第 4.1 节）：把设备读数和作业状态连起来，这正是孪生比单独的温度监控多出来的部分。
 * - 暂存区的冷藏柜、冷冻柜、熟食保温区：放在里面的框和它们的订单，以及同温区还有空位、可以转移过去的格位；
 * - 后仓冷库：里面的箱数和件数；
 * - 卸货门、入口：没有作业上的影响。
 */
export function alertImpact(s: OpsState, st: StoreStatic, def: SensorDef): AlertImpact {
  const impact: AlertImpact = { orders: [], totes: 0, cases: 0, units: 0, moveTo: [] };
  if (def.kind !== 'TEMP') return impact;
  const slots = new Set(slotsOf(def, st));
  const orders = new Set<string>();
  for (const code of slots) {
    for (const toteId of s.slots[code] ?? []) {
      const t = s.totes[toteId];
      const o = t ? s.orders[t.orderId] : undefined;
      if (!t || !o || o.status === 'COMPLETED' || o.status === 'CANCELLED') continue;
      impact.totes += 1;
      orders.add(o.id);
    }
  }
  impact.orders = [...orders].sort((a, b) => (s.orders[a]?.slotStart ?? 0) - (s.orders[b]?.slotStart ?? 0) || a.localeCompare(b));
  if (slots.size && def.tempZone) {
    impact.moveTo = st.slots
      .filter((x) => x.tempZone === def.tempZone && !slots.has(x.code))
      .map((x) => ({ code: x.code, free: x.capacity - (s.slots[x.code]?.length ?? 0) }))
      .filter((x) => x.free > 0)
      .sort((a, b) => b.free - a.free || a.code.localeCompare(b.code))
      .slice(0, 3)
      .map((x) => x.code);
  }
  for (const bin of binsOf(def, st)) {
    for (const caseId of s.bins[bin] ?? []) {
      const c = s.cases[caseId];
      if (!c) continue;
      impact.cases += 1;
      impact.units += c.units;
    }
  }
  return impact;
}

/**
 * 告警还没解除时，影响按此刻重新算：告警之后才放进这台设备的框也算上；
 * 发出告警时已经受影响、还没完成的订单保留（框可能已经被取走，但经历过超温）。解除后用告警记下的影响。
 */
export function currentImpact(s: OpsState, st: StoreStatic, a: EquipmentAlert, defs: readonly SensorDef[]): AlertImpact {
  if (a.status === 'CLEARED') return a.impact;
  const def = defs.find((d) => d.id === a.sensorId);
  if (!def) return a.impact;
  const now = alertImpact(s, st, def);
  const open = (id: string) => {
    const o = s.orders[id];
    return !!o && o.status !== 'COMPLETED' && o.status !== 'CANCELLED';
  };
  return { ...now, orders: [...new Set([...a.impact.orders.filter(open), ...now.orders])] };
}

/** 影响到这张订单、还没解除的温度告警（交付时提醒员工检查商品温度） */
export function coldAlertOn(s: OpsState, st: StoreStatic, orderId: string, defs: readonly SensorDef[]): EquipmentAlert | undefined {
  return activeAlerts(s).find((a) => (a.kind === 'TEMP_HIGH' || a.kind === 'TEMP_LOW') && currentImpact(s, st, a, defs).orders.includes(orderId));
}
