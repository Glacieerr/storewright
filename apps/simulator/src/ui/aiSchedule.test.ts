import { describe, expect, it } from 'vitest';
import { aiStaffPlan } from './aiSchedule';

describe('用 AI 排班仿真一天（决策记录 0022 · D1）', () => {
  it('按取货时段的订单算出每小时要几个人：高峰多排、营业时间外不排，拣货比取货提前', () => {
    const orders: Record<string, { slotStart: number }> = {};
    let k = 0;
    // 10 点到 20 点每小时 6 单，17–18 点高峰 90 单
    for (let h = 10; h < 20; h++) for (let i = 0; i < (h === 17 ? 90 : 6); i++) orders[`O${k++}`] = { slotStart: h * 3600 + (i % 60) * 60 };
    const p = aiStaffPlan({ orders }, 8, 21);
    expect(p.shifts).toBeGreaterThan(0);
    expect(p.staffing.handoff[17]).toBeGreaterThan(p.staffing.handoff[12] as number);
    // 拣货在取货时段之前做完：高峰前一两个小时拣货的人最多
    const peakPick = p.staffing.pick.indexOf(Math.max(...p.staffing.pick));
    expect(peakPick).toBeGreaterThanOrEqual(14);
    expect(peakPick).toBeLessThan(17);
    for (const h of [0, 3, 23]) expect(p.staffing.pick[h] ?? 0).toBe(0);
  });
});
