import { HUB_SLOT, HUB_SLOTS, tallyOccupancy, type HubDay, type HubFlow, type HubKpi, type HubZone } from '../hub/types';
import type { Stall, StoreLot } from './lot';
import type { StayPlan } from './stays';
import type { TruckTurn } from './trucks';
import { isLong, isPickup, KIND_LABEL } from './visits';

/**
 * 门店的停车场、即时取货和收货场一天的作业（值班助手的仓储中心数据，src/hub/types.ts）：
 * 区——即时取货车位、自提柜车位、免下车取货道、普通车位、员工车位、长车位、收货场待命车位、收货口；
 * 每辆车一条流水（停在哪个区、从几点到几点），指标——取货平均 / 95% 等待、5 分钟内交付的比例、停车场高峰占用、
 * 收货场最多几辆排队、货车平均周转、收货口利用率。三维（web/src/three/store）按同一份车位安排和收货场排程画。
 */
export interface SiteOpsInput {
  lot: StoreLot;
  plan: StayPlan;
  turns: readonly TruckTurn[];
  docks: number;
  /** 收货场的待命车位数（yard 引擎排的） */
  queueSlots: number;
  generation: 'gen1' | 'storex';
  label?: string;
}

const pct = (xs: readonly number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
};
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const hm = (t: number) => `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;

export function siteOps(i: SiteOpsInput): HubDay {
  const { lot, plan } = i;
  const sx = i.generation === 'storex';
  // 即时取货车位：StoreX 用 2–7 号对着墙上的自提柜（自提柜车位），1、8 号留作车边交付；上一代全是车边交付
  const lockerStalls = new Set(sx ? lot.pickup.slice(1, -1) : []);
  const front = lot.frontStalls.filter((s) => !plan.staffStalls.has(s));
  const zones: HubZone[] = [
    { key: 'pickup', label: '即时取货车位', kind: 'parking', capacity: lot.pickup.length - lockerStalls.size, unit: '车位' },
    ...(sx ? [{ key: 'locker', label: '自提柜车位', kind: 'parking' as const, capacity: lockerStalls.size, unit: '车位' }, { key: 'drive', label: '免下车取货道', kind: 'queue' as const, capacity: lot.drive.length, unit: '个取货位' }] : []),
    { key: 'front', label: '普通车位', kind: 'parking', capacity: front.length, unit: '车位' },
    { key: 'staff', label: '员工车位', kind: 'parking', capacity: plan.staffStalls.size, unit: '车位' },
    { key: 'long', label: '长车位', kind: 'parking', capacity: lot.long.length, unit: '个' },
    { key: 'queue', label: '收货场待命车位', kind: 'queue', capacity: i.queueSlots, unit: '车' },
    { key: 'docks', label: '收货口', kind: 'dock', capacity: i.docks, unit: '樘' },
  ];
  const zoneOf = (stall: Stall | undefined, kind: string): string => {
    if (kind === 'drive') return 'drive';
    if (!stall) return 'front';
    if (stall.zone === 'pickup') return lockerStalls.has(stall.i) ? 'locker' : 'pickup';
    if (plan.staffStalls.has(stall.i)) return 'staff';
    return 'front';
  };
  const flows: HubFlow[] = [];
  const waits: number[] = [];
  for (const st of plan.stays) {
    const v = st.visit;
    const stall = st.mode === 'long' || st.mode === 'drive' ? undefined : lot.stalls[st.stall];
    const zone = st.mode === 'long' ? 'long' : zoneOf(stall, v.kind);
    const act = isPickup(v.kind) ? `${KIND_LABEL[v.kind]}：等交付` : v.kind === 'staff' ? '上班' : isLong(v.kind) ? `${KIND_LABEL[v.kind]}停车` : '停车购物';
    const steps: HubFlow['steps'] = [];
    // 免下车取货：车道满了在车道口等的那一段算排队
    if (st.mode === 'drive' && st.enter !== undefined && st.arrive - st.enter > 20) steps.push({ zone: 'drive', t0: Math.max(0, st.enter), t1: st.arrive, act: '在免下车车道口排队' });
    steps.push({ zone, t0: Math.max(0, st.arrive), t1: Math.min(HUB_SLOTS * HUB_SLOT, st.leave), act });
    flows.push({ id: v.id, label: v.label, own: true, units: 1, unit: '车', steps, carrierIn: '社会车辆', kind: 'vehicle', cold: false });
    // 取货等待：车到了（免下车是开进车道）到交付完
    if (isPickup(v.kind) && v.handoff !== undefined) waits.push(Math.max(0, v.handoff - (st.enter ?? st.arrive)) / 60);
  }
  const turnSec: number[] = [];
  let maxQueue = 0;
  const queueEv: Array<[number, number]> = [];
  for (const tt of i.turns) {
    const v = tt.visit;
    const steps = [] as HubFlow['steps'];
    if (tt.queue[1] - tt.queue[0] > 30) steps.push({ zone: 'queue', t0: tt.queue[0], t1: tt.queue[1], act: '待命车位排队' });
    steps.push({ zone: 'docks', t0: tt.door[0], t1: tt.door[1], act: `${v.dock + 1} 号收货口卸货（${v.pallets} 板）` });
    flows.push({ id: `T${v.vid}-${Math.round(v.arrive)}`, label: v.label, own: true, units: 1, unit: '车', steps, carrierIn: v.job ?? v.label, carrierOut: v.job ?? v.label, kind: 'vehicle', cold: v.type === 'reefer' });
    turnSec.push(tt.gone - tt.queue[0]);
    if (tt.queue[1] - tt.queue[0] > 30) queueEv.push([tt.queue[0], 1], [tt.queue[1], -1]);
  }
  queueEv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let q = 0;
  let maxQueueAt = 0;
  for (const [t, d] of queueEv) {
    q += d;
    if (q > maxQueue) {
      maxQueue = q;
      maxQueueAt = t;
    }
  }
  const occupancy = tallyOccupancy(zones, flows);
  const frontOcc = occupancy.front as Float32Array;
  let peak = 0;
  let peakK = 0;
  frontOcc.forEach((x, k) => {
    if (x > peak) {
      peak = x;
      peakK = k;
    }
  });
  const docksOcc = occupancy.docks as Float32Array;
  // 收货口利用率：营业前后各两小时（5:00–24:00）里平均占用的门数 / 门数
  let used = 0;
  for (let k = Math.floor((5 * 3600) / HUB_SLOT); k < Math.floor((24 * 3600) / HUB_SLOT); k++) used += docksOcc[k] as number;
  const util = (used / ((19 * 3600) / HUB_SLOT) / Math.max(1, i.docks)) * 100;
  const pick = plan.stays.filter((s) => isPickup(s.visit.kind)).length;
  const shop = plan.stays.filter((s) => s.visit.kind === 'shopper' || s.visit.kind === 'dept').length;
  const kpi: HubKpi[] = [
    { key: 'pickupMean', label: '取货平均等待', value: mean(waits), unit: '分钟', better: 'lower' },
    { key: 'pickupP95', label: '取货 95% 等待', value: pct(waits, 0.95), unit: '分钟', better: 'lower' },
    { key: 'pickup5', label: '5 分钟内交付', value: waits.length ? (waits.filter((w) => w <= 5).length / waits.length) * 100 : 100, unit: '%', better: 'higher' },
    { key: 'lotPeak', label: '停车场高峰占用', value: front.length ? (peak / front.length) * 100 : 0, unit: '%', better: 'lower' },
    { key: 'yardQueue', label: '收货场最多排队', value: maxQueue, unit: '辆', better: 'lower' },
    { key: 'truckTurn', label: '货车平均周转', value: mean(turnSec) / 60, unit: '分钟', better: 'lower' },
    { key: 'doorUtil', label: '收货口利用率', value: util, unit: '%', better: 'higher' },
    { key: 'pickupCars', label: '取货车辆', value: pick, unit: '辆' },
    { key: 'shopperCars', label: '购物车辆', value: shop, unit: '辆' },
    { key: 'trucks', label: '到店货车', value: i.turns.length, unit: '辆' },
    { key: 'turnedAway', label: '没找到车位开走的车', value: plan.turnedAway.length, unit: '辆', better: 'lower' },
  ];
  const notes: string[] = [];
  notes.push(`停车场高峰在 ${hm(peakK * HUB_SLOT)} 前后：普通车位平均停着 ${Math.round(peak)} 辆（共 ${front.length} 个，${Math.round((peak / Math.max(1, front.length)) * 100)}%）。`);
  if (waits.length) notes.push(`到店取货 ${pick} 辆：平均等 ${mean(waits).toFixed(1)} 分钟，95% 在 ${pct(waits, 0.95).toFixed(1)} 分钟内拿到货。`);
  if (i.turns.length) notes.push(`到店货车 ${i.turns.length} 辆，平均周转 ${(mean(turnSec) / 60).toFixed(0)} 分钟${maxQueue ? `；${hm(maxQueueAt)} 前后收货场最多 ${maxQueue} 辆在待命车位排队` : '，没有排队'}。`);
  if (plan.turnedAway.length) notes.push(`${plan.turnedAway.length} 辆车没找到车位开走了（长车位被占或车位全满）。`);
  return { key: 'store', label: i.label ?? '综合店停车场与收货场', zones, flows, occupancy, kpi, notes };
}
