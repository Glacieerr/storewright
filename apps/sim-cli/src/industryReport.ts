import { buildBins } from '@storewright/algorithms';
import { backtest, evaluatePrepTime, evaluateReturns, FORECASTERS, hourlySeries, wape } from '@storewright/ai';
import { createTemplate, StoreModel, type TemplateName } from '@storewright/store-config';
import { aiAblationPolicies, BASELINE, defaultScenario, OPTIMIZED, runExperiment } from '@storewright/sim-engine';
import { DEFAULT_DEMAND, generateCatalog, generateDeliHistory, generateDemandHistory, generateOrders, generateReturns, historyDailyHours, isPerishableCategory } from '@storewright/synth';

/**
 * 行业迁移报告（Phase 6，决策记录 0011 第 4 节）：同一套核心分别跑中型超市和家居建材店，
 * 比较门店配置、商品与订单形态、运营仿真（基线 / 默认档位、AI 开 / 关）和订单量预测。
 * 全部为合成数据与仿真（证据等级 B），同一个命令可以重新生成。
 */

export interface IndustryReportOptions {
  reps: number;
  seeds: number;
  onProgress?: (msg: string) => void;
}

const TEMPLATES: Array<{ id: TemplateName; label: string }> = [
  { id: 'medium', label: '中型超市' },
  { id: 'hardware', label: '家居建材店' },
];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function table(head: string[], rows: Array<Array<string | number>>): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const OPS_METRICS: Array<[string, string, number]> = [
  ['uph', '拣货效率（件 / 拣货工时）', 1],
  ['metersPerUnit', '每件行走距离（m）', 2],
  ['totesPerOrder', '每单框数', 2],
  ['overweightTotePct', '超重框比例（%）', 1],
  ['crushRiskTotePct', '压坏风险框比例（%）', 1],
  ['fillRate', '订单满足率', 4],
  ['avgWaitMin', '平均到店等待（分钟）', 2],
  ['avgReadyDwellMin', '门口停留（分钟）', 2],
  ['busyHoursTotal', '作业总工时（h）', 1],
];

export function industryReport(o: IndustryReportOptions): string {
  const log = o.onProgress ?? (() => undefined);
  const out: string[] = [];
  out.push('# 行业迁移报告（自动生成）', '', `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 运营仿真每组 ${o.reps} 天 · 预测回测种子 ${o.seeds} 个 · 全部为合成数据与仿真（证据等级 B）`, '');

  // 1. 门店配置
  log('门店配置…');
  const cfg = TEMPLATES.map((t) => {
    const config = createTemplate(t.id);
    const model = new StoreModel(config);
    const cats = config.catalog.categories;
    const zones = new Map<string, number>();
    for (const s of model.stagingSlots) zones.set(s.tempZone, (zones.get(s.tempZone) ?? 0) + 1);
    const areas = [...new Set(buildBins(model).filter((b) => b.status === 'SELLABLE').map((b) => b.area))];
    const walls = config.layout.runs.filter((r) => r.kind === 'WALL').map((r) => r.label ?? r.id);
    const mods = Object.entries(config.modules)
      .filter(([, on]) => on)
      .map(([k]) => k);
    return {
      label: t.label,
      rows: [
        config.industry ?? 'GROCERY',
        `${hhmm(config.hours.openMin)}–${hhmm(config.hours.closeMin)}`,
        `${cats.length}（散件 ${cats.filter((c) => c.fulfillmentType === 'GROCERY').length} / 大件为主 ${cats.filter((c) => c.fulfillmentType === 'GM').length} / 现做 ${cats.filter((c) => c.fulfillmentType === 'MTO').length}）`,
        cats.filter((c) => c.tempZone === 'CHILLED' || c.tempZone === 'FROZEN').length,
        cats.filter((c) => c.handling.includes('CHEMICAL')).length,
        config.layout.runs.filter((r) => r.kind === 'AISLE').length,
        walls.join('、'),
        [...zones.entries()].map(([z, n]) => `${z} ${n}`).join('，'),
        areas.join(' / '),
        mods.join(', '),
      ],
    };
  });
  const cfgHead = ['行业', '营业时间', '品类数', '冷链品类', '化学品品类', '货架通道', '沿墙货架', '暂存格位（按温区）', '后仓可售分区', '默认打开的模块'];
  out.push('## 1. 门店配置', '', '两个模板用同一个 schema 和同一个生成器；行业参数决定品类字典、通道顺序、沿墙货架、暂存区和默认模块。', '');
  out.push(table(['项目', ...cfg.map((c) => c.label)], cfgHead.map((h, i) => [h, ...cfg.map((c) => String(c.rows[i]))])), '');

  // 2. 商品与订单形态
  log('商品与订单形态…');
  const shape = TEMPLATES.map((t) => {
    const model = new StoreModel(createTemplate(t.id));
    const catalog = generateCatalog(model, { seed: 7 });
    const scenario = defaultScenario(t.id);
    let orders = 0;
    let lines = 0;
    let units = 0;
    let gm = 0;
    let pickup = 0;
    const days = 10;
    for (let d = 1; d <= days; d++) {
      const os = generateOrders(model, catalog, scenario.demand, { seed: 1000 + d, day: d });
      orders += os.length;
      for (const x of os) {
        lines += x.lines.length;
        units += x.lines.reduce((a, l) => a + l.qty, 0);
        if (x.fulfillmentType === 'GM') gm++;
        if (x.type === 'PICKUP') pickup++;
      }
    }
    const items = catalog.items;
    return [
      t.label,
      items.length,
      `${(mean(items.map((i) => i.weightKg))).toFixed(2)} kg`,
      pct(items.filter((i) => i.weightKg > 13.6).length / items.length),
      Math.round(orders / days),
      (lines / orders).toFixed(1),
      (units / lines).toFixed(2),
      pct(gm / orders),
      pct(pickup / orders),
    ];
  });
  out.push('## 2. 商品与订单形态', '', '合成目录（种子 7）与 10 天合成订单。', '');
  out.push(table(['门店', 'SKU', '平均单件重量', '单件超过 30 lb 的 SKU', '日均订单', '每单行数', '每行件数', '大件为主（GM）订单', '自取比例'], shape), '');

  // 3. 运营仿真：基线 vs 默认档位
  log('运营仿真：基线 / 默认档位…');
  const ops = TEMPLATES.map((t) => ({ t, r: runExperiment({ template: t.id, reps: o.reps, baseSeed: 1, policies: [BASELINE, OPTIMIZED] }) }));
  out.push('## 3. 运营仿真：基线与默认档位', '', `每个门店 ${o.reps} 天，公共随机数。表中为「默认档位 − 基线」的配对差值（括号里是 95% 置信区间的半宽）和基线值。`, '');
  out.push(
    table(
      ['指标', ...ops.flatMap(({ t }) => [`${t.label} 基线`, `${t.label} 差值`])],
      OPS_METRICS.map(([k, label, d]) => [
        label,
        ...ops.flatMap(({ r }) => {
          const base = (r.policies[0]?.summary as Record<string, { mean: number }>)[k]?.mean ?? NaN;
          const x = (r.paired[0]?.delta as Record<string, { mean: number; ci95: number }> | undefined)?.[k];
          return [base.toFixed(d), x ? `${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(d)}（±${x.ci95.toFixed(d)}）` : '—'];
        }),
      ]),
    ),
    '',
  );
  const opp = ops.map(({ t, r }) => {
    const s = r.policies[0]?.summary as Record<string, { mean: number }>;
    return `${t.label}每天约 ${Math.round(s.oversizedPieces?.mean ?? 0)} 件大件`;
  });
  out.push(`- ${opp.join('；')}。`, '');

  // 4. AI 开 / 关（家居建材）
  log('运营仿真：家居建材 AI 开 / 关…');
  const aiRun = runExperiment({ template: 'hardware', reps: o.reps, baseSeed: 2026, policies: [OPTIMIZED, ...aiAblationPolicies(OPTIMIZED)] });
  const aiMetrics: Array<[string, string, number]> = [
    ['avgWaitMin', '平均等待（分钟）', 2],
    ['p90WaitMin', '90 分位等待（分钟）', 2],
    ['lateOrderPct', '迟到订单（%）', 2],
    ['avgReadyDwellMin', '门口停留（分钟）', 2],
    ['fillRate', '满足率', 4],
    ['staffedHoursTotal', '排班工时', 1],
  ];
  out.push('## 4. 家居建材店的 AI 开 / 关', '', `默认档位为基础，${o.reps} 天，公共随机数。AI 的误差大小沿用超市的设定（决策记录 0010 第 9 节）；AI 排班按本店的小时需求形态重新分配同样的总工时（早上施工队高峰）。`, '');
  out.push(
    table(
      ['指标', '不打开 AI', ...aiRun.paired.map((p) => p.policy.replace(`${OPTIMIZED.name}+`, ''))],
      aiMetrics.map(([k, label, d]) => [
        label,
        ((aiRun.policies[0]?.summary as Record<string, { mean: number }>)[k]?.mean ?? NaN).toFixed(d),
        ...aiRun.paired.map((p) => {
          const x = (p.delta as Record<string, { mean: number; ci95: number }>)[k];
          return x ? `${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(d)}（±${x.ci95.toFixed(d)}）` : '—';
        }),
      ]),
    ),
    '',
  );

  // 5. 订单量预测
  log('订单量预测…');
  const seeds = Array.from({ length: o.seeds }, (_, i) => [107, 1, 2, 3, 4, 5, 6, 7][i] ?? 100 + i);
  const days = 730;
  const testDays = 365;
  const fc = TEMPLATES.map((t) => {
    const model = new StoreModel(createTemplate(t.id));
    const res: Record<string, number[]> = {};
    const oracle: number[] = [];
    for (const seed of seeds) {
      const h = generateDemandHistory(model, { seed, days, startDate: '2024-10-01', scenario: DEFAULT_DEMAND[t.id], factors: { regimeShift: { day: Math.floor(days * 0.82), multiplier: 0.9 } } });
      const s = hourlySeries(historyDailyHours(h), h.hours);
      const act: number[] = [];
      const exp: number[] = [];
      for (const d of h.days.slice(days - testDays))
        for (const hr of h.hours) {
          act.push(d.actual.hourly[hr] ?? 0);
          exp.push(d.expected.hourly[hr] ?? 0);
        }
      oracle.push(wape(act, exp));
      for (const f of Object.values(FORECASTERS)) (res[f.kind] ??= []).push(backtest(s, f, { initialDays: days - testDays, horizonDays: 7, stepDays: 7 }).metrics.wape as number);
    }
    return { t, res, oracle: mean(oracle) };
  });
  const kinds = Object.keys(fc[0]?.res ?? {});
  out.push('## 5. 订单量预测', '', `${days} 天合成历史（含隐藏因素与一次需求下降；建材店另有季节性），最后 ${testDays} 天按周滚动回测，按小时 WAPE（越低越好）。同一套预测器、同样的特征，只换数据。`, '');
  out.push(table(['预测器', ...fc.map((x) => x.t.label)], [...kinds.map((k) => [k, ...fc.map((x) => pct(mean(x.res[k] ?? [])))]), ['理论下限（真实期望值）', ...fc.map((x) => pct(x.oracle))]]), '');
  out.push('- 建材店订单量小（每小时几单），泊松噪声占比更大，所以理论下限本身更高；比较时看各预测器与下限的差距。', '');

  // 6. 扩展模块的模型
  log('扩展模块的模型…');
  const prep = seeds.map((seed) => evaluatePrepTime(generateDeliHistory({ seed }).map((r) => ({ dishId: r.dishId, standardMin: r.standardMin, load: r.load, actualMin: r.actualMin }))).metrics);
  out.push('## 6. 扩展模块的模型', '', '### 熟食制作时长（只在超市）', '', `合成制作记录（每道菜的本店系数和厨房负荷影响模型看不到），前 70% 训练，${seeds.length} 个种子。`, '');
  out.push(table(['种子', '按标准时长的平均绝对误差', '菜品系数 + 负荷模型'], prep.map((m, i) => [seeds[i] as number, `${(m.maeStandard as number).toFixed(1)} 分钟`, `${(m.maeModel as number).toFixed(1)} 分钟`])), '');
  out.push('### 退货去向（两个行业各用本店目录训练）', '', '合成退货记录（3000 条），前 70% 训练；比较「回架」判断与商品实际能否再售。误判回架 = 不能再售却放回货架（顾客风险），可售却报废 = 浪费。', '');
  const rows: Array<Array<string | number>> = [];
  for (const t of TEMPLATES) {
    const items = generateCatalog(new StoreModel(createTemplate(t.id)), { seed: 7 }).items;
    const acc: Record<string, number[]> = {};
    for (const seed of seeds) {
      const ev = evaluateReturns(generateReturns(items, { seed }).map((r) => ({ ...r, perishable: isPerishableCategory(r.categoryId) })));
      for (const [k, m] of Object.entries(ev.metrics)) for (const mk of ['accuracy', 'falseRestock', 'missedResale']) (acc[`${k}.${mk}`] ??= []).push(m[mk] as number);
    }
    for (const k of ['rule', 'model']) rows.push([t.label, k === 'rule' ? '固定规则' : '再售概率 + 规则', pct(mean(acc[`${k}.accuracy`] ?? [])), pct(mean(acc[`${k}.falseRestock`] ?? [])), pct(mean(acc[`${k}.missedResale`] ?? []))]);
  }
  out.push(table(['门店', '方法', '判断正确率', '误判回架', '可售却报废'], rows), '');
  out.push('- 复现：`npm run industry-report -- --reps ' + o.reps + ' --seeds ' + o.seeds + '`。', '');
  return out.join('\n');
}
