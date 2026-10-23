import { describe, expect, it } from 'vitest';
import { dayPnL, DEFAULT_COSTS, type DayMetrics, type InboundMetrics } from '@storewright/sim-engine';
import { economicsInput, type ScenarioDigest } from '../state/scenarios';
import { reportHTML, reportMarkdown, type ReportColumn } from './report';
import type { DayDigest } from '../sim/protocol';

const metrics = {
  orders: 240, fillRate: 0.98, staffedHoursTotal: 200, lateOrderPct: 3, longWaitPct: 8, handoffSessions: 220, shortValue: 300,
  avgWaitMin: 4.5, p90WaitMin: 8, p50WaitMin: 3, p80WaitMin: 6, overweightTotePct: 0, crushRiskTotePct: 0, chemicalMixTotePct: 0, avgReadyDwellMin: 2,
  laborMinutesPerOrder: 30, uph: 70, pickDistanceKm: 50, totesPerOrder: 5, avgTrafficDelayMin: 1,
} as unknown as DayMetrics;
const inbound = { trucks: 6, palletsReceived: 45, avgTurnaroundMin: 20, dockToStockMin: 35, totalCases: 2500, stockedCases: 2480, backlogCases: 20, readyAtOpen: 0.99, rackCapacity: 51, rackUsedStart: 28, rackUsedEnd: 24, receivingHours: 17, nightHours: 54 } as InboundMetrics;
const digest: ScenarioDigest = { metrics, inbound, autoRevenue: 0, autoServed: 0, pharmacyServed: 0, forklifts: 1, palletJacks: 2, aisles: 16, floors: 1, floorAreaM2: 2850, staffTotal: 21, nightCrew: 6, hours: '07:00–22:00' };
const col = (name: string): ReportColumn => ({ name, template: 'medium', policy: 'optimized', digest, pnl: dayPnL(economicsInput(digest), DEFAULT_COSTS) });

describe('方案报告', () => {
  it('HTML 报告是完整的单个文件，方案名被转义，含声明、经营账和多天分布', () => {
    const days: DayDigest[] = [0, 1, 2].map((i) => ({ day: i + 1, weekday: i, seed: i, demandFactor: 1, metrics, inbound, autoRevenue: 0, pharmacyServed: 0 }));
    const html = reportHTML({ title: '报告', generatedAt: new Date(2026, 9, 20), columns: [col('当前方案'), col('<b>方案|A</b>')], costs: DEFAULT_COSTS, multi: { days, nets: [100, -50, 20] } });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('&lt;b&gt;方案|A&lt;/b&gt;');
    expect(html).not.toContain('<b>方案');
    expect(html).toContain('本项目与任何零售商、企业无隶属关系');
    expect(html).toContain('线上订单业务小计');
    expect(html).toContain('连续 3 天模拟');
    expect(html).toContain('<svg');
  });

  it('Markdown 报告的表格列数一致，竖线被转义', () => {
    const text = reportMarkdown({ title: '报告', generatedAt: new Date(2026, 9, 20), columns: [col('当前方案'), col('方案|B')], costs: DEFAULT_COSTS });
    expect(text).toContain('方案\\|B');
    const table = text.split('\n').filter((l) => l.startsWith('| 平均到店等待'));
    expect(table).toHaveLength(1);
    const cells = (table[0] as string).split(/(?<!\\)\|/).length;
    const head = text.split('\n').find((l) => l.startsWith('| 指标')) as string;
    expect(head.split(/(?<!\\)\|/).length).toBe(cells);
  });
});

describe('metric rows by industry (decision 0015)', () => {
  it('hardware stores do not show the food/chemical mixing row and drop the cold-chain wording', async () => {
    const { rowsFor, ROWS } = await import('./metricRows');
    const keys = (rs: typeof ROWS) => rs.flatMap((g) => g.rows.map((r) => r.key));
    expect(keys(rowsFor())).toContain('chemicalMixTotePct');
    expect(keys(rowsFor('HARDWARE'))).not.toContain('chemicalMixTotePct');
    expect(rowsFor('HARDWARE').flatMap((g) => g.rows).find((r) => r.key === 'avgReadyDwellMin')?.label).toBe('门口停留');
    expect(rowsFor()).toBe(ROWS);
  });
});
