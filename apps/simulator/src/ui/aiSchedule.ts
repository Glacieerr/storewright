import { DEFAULT_WORKLOAD, generateSchedule, headsFromWorkload, workloadByHour, type ScheduleAssociate, type ScheduleDemand } from '@storewright/ai';

/**
 * 用 AI 排班仿真一天（决策记录 0022 · D1 的规划孪生版）：按这一天仿真里的订单（按取货时段）算出每半小时要几个人
 * （与门店的排班草稿同一套换算），用排班生成器排班（班次 3–9 小时、休息和工时上限），再换算成每小时在岗人数。
 */
export function aiStaffPlan(tl: { orders: Record<string, { slotStart: number }> }, openH: number, closeH: number): { staffing: { pick: number[]; stage: number[]; handoff: number[] }; shifts: number; underHours: number; overHours: number } {
  const byHour = new Array<number>(24).fill(0);
  for (const o of Object.values(tl.orders)) {
    const h = Math.floor(o.slotStart / 3600) % 24;
    byHour[h] = (byHour[h] as number) + 1;
  }
  const w = workloadByHour(byHour, DEFAULT_WORKLOAD);
  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  const demand: ScheduleDemand[] = [
    { day: 0, role: 'PICK', slots: headsFromWorkload(w.pick, { minHeads: 1, hours: range(openH - 2, closeH - 1) }) },
    { day: 0, role: 'STAGE', slots: headsFromWorkload(w.stage, { minHeads: 0, hours: range(openH, closeH) }) },
    { day: 0, role: 'HANDOFF', slots: headsFromWorkload(w.handoff, { minHeads: 1, hours: range(openH, closeH) }) },
  ];
  // 只排一天：每个岗位准备「最多同时要几个人 × 2」位候选人（够排早晚两班），由排班生成器决定排谁、几点到几点
  const associates: ScheduleAssociate[] = demand.flatMap((d) => Array.from({ length: Math.max(1, Math.max(0, ...d.slots) * 2) }, (_, i) => ({ id: `${d.role}-${i + 1}`, role: d.role, employment: 'FULL' as const })));
  const res = generateSchedule({ associates, demand, rules: { open: { from: Math.max(5, openH - 3), to: Math.min(24, closeH + 1) } } });
  const staffing = { pick: new Array<number>(24).fill(0), stage: new Array<number>(24).fill(0), handoff: new Array<number>(24).fill(0) };
  for (const sh of res.shifts) {
    const key = sh.role === 'PICK' ? 'pick' : sh.role === 'STAGE' ? 'stage' : 'handoff';
    for (let h = 0; h < 24; h++) if (h * 60 + 30 >= sh.from && h * 60 + 30 < sh.to) staffing[key][h] = (staffing[key][h] as number) + 1;
  }
  return { staffing, shifts: res.shifts.length, underHours: res.metrics.underHours, overHours: res.metrics.overHours };
}
