import { formatClock } from '@storewright/domain';
import type { StoreModel } from '@storewright/store-config';
import type { ExperimentResult, MetricKey, Summary } from '@storewright/sim-engine';

interface KpiDef {
  key: MetricKey;
  label: string;
  unit: string;
  /** 越小越好为 -1，越大越好为 1，中性为 0 */
  better: -1 | 0 | 1;
  digits: number;
  scale?: number;
}

export const KPIS: KpiDef[] = [
  { key: 'uph', label: '拣货效率（件 / 拣货工时）', unit: '', better: 1, digits: 1 },
  { key: 'metersPerUnit', label: '每件行走距离', unit: 'm', better: -1, digits: 2 },
  { key: 'pickDistanceKm', label: '全天拣货行走', unit: 'km', better: -1, digits: 1 },
  { key: 'pickBusyHours', label: '拣货工时', unit: 'h', better: -1, digits: 1 },
  { key: 'walks', label: '推车行程数', unit: '', better: 0, digits: 0 },
  { key: 'totesPerOrder', label: '每单框数', unit: '', better: 0, digits: 2 },
  { key: 'toteVolumeUtil', label: '框体积利用率', unit: '%', better: 0, digits: 1, scale: 100 },
  { key: 'overweightTotePct', label: '超重框比例', unit: '%', better: -1, digits: 1 },
  { key: 'crushRiskTotePct', label: '压坏风险框比例', unit: '%', better: -1, digits: 1 },
  { key: 'chemicalMixTotePct', label: '化学品与食品混装框比例', unit: '%', better: -1, digits: 1 },
  { key: 'coldViolationPct', label: '冷链超时批次比例', unit: '%', better: -1, digits: 1 },
  { key: 'maxColdMinutes', label: '冷链批次最长用时', unit: 'min', better: -1, digits: 1 },
  { key: 'fillRate', label: '订单满足率（含替代）', unit: '%', better: 1, digits: 2, scale: 100 },
  { key: 'shortLines', label: '缺货行数', unit: '', better: -1, digits: 1 },
  { key: 'shortValue', label: '缺货行销售额', unit: '$', better: -1, digits: 0 },
  { key: 'exceptionsRecovered', label: '后仓补取挽回行数', unit: '', better: 1, digits: 1 },
  { key: 'lateOrderPct', label: '未按时就绪订单比例', unit: '%', better: -1, digits: 1 },
  { key: 'avgWaitMin', label: '平均到店等待', unit: 'min', better: -1, digits: 2 },
  { key: 'p80WaitMin', label: '80% 分位等待', unit: 'min', better: -1, digits: 2 },
  { key: 'longWaitPct', label: '等待 ≥ 8 分钟比例', unit: '%', better: -1, digits: 1 },
  { key: 'avgReadyDwellMin', label: '已取出订单门口停留', unit: 'min', better: -1, digits: 1 },
  { key: 'p90ReadyDwellMin', label: '门口停留 90% 分位', unit: 'min', better: -1, digits: 1 },
  { key: 'stageBusyHours', label: '暂存工时', unit: 'h', better: -1, digits: 1 },
  { key: 'handoffBusyHours', label: '交付工时', unit: 'h', better: -1, digits: 1 },
  { key: 'exceptionBusyHours', label: '后仓补取工时', unit: 'h', better: 0, digits: 1 },
  { key: 'busyHoursTotal', label: '作业总工时', unit: 'h', better: -1, digits: 1 },
  { key: 'laborMinutesPerOrder', label: '单均作业工时', unit: 'min', better: -1, digits: 1 },
  { key: 'laborCostPerOrder', label: '单均作业人工成本', unit: '$', better: -1, digits: 2 },
];

const ABLATION_KPIS: MetricKey[] = ['pickBusyHours', 'metersPerUnit', 'overweightTotePct', 'fillRate', 'avgWaitMin', 'avgReadyDwellMin', 'handoffBusyHours', 'busyHoursTotal'];

function fmt(v: number, d: number, scale = 1): string {
  return (v * scale).toFixed(d);
}

function cell(s: Summary, k: KpiDef): string {
  return `${fmt(s.mean, k.digits, k.scale)} ± ${fmt(s.ci95, k.digits, k.scale)}`;
}

function verdict(delta: Summary, k: KpiDef): string {
  const significant = Math.abs(delta.mean) > delta.ci95 && delta.n > 1;
  if (!significant) return '无显著差异';
  if (k.better === 0) return delta.mean > 0 ? '增加' : '减少';
  return delta.mean * k.better > 0 ? '✅ 改善' : '⚠️ 变差';
}

export function renderComparison(result: ExperimentResult, model: StoreModel): string {
  const base = result.policies[0];
  if (!base) return '';
  const lines: string[] = [];
  const cfg = model.config;
  const sc = result.scenario;
  const staffSum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const meanOrders = base.summary.orders.mean;

  lines.push(`# 仿真对比报告 · ${cfg.name}（${result.template}）`, '');
  lines.push('> 证据等级 **B**（仿真实验）：同一门店配置、同一订单流、同一组随机事件（公共随机数），');
  lines.push(`> 每个策略重复 **${result.reps}** 天，报告均值 ± 95% 置信区间。所有门店、商品、订单均为合成数据。`);
  lines.push('> 这些数字只说明「在这些假设下」两种策略的差异，不代表任何真实零售商的数据。', '');
  lines.push('## 1. 实验设置', '');
  lines.push('| 项目 | 值 |', '|---|---|');
  lines.push(`| 门店 | ${cfg.layout.floors.length} 层，${cfg.layout.runs.length} 条货架通道，${model.locations.size} 个货位，${model.stagingSlots.length} 个暂存格位 |`);
  lines.push(`| 营业时间 | ${formatClock(cfg.hours.openMin * 60)}–${formatClock(cfg.hours.closeMin * 60)}，时段 ${cfg.rules.slotLengthMin} 分钟 |`);
  lines.push(`| 日均订单 | ${meanOrders.toFixed(0)} 单，${base.summary.lines.mean.toFixed(0)} 行，${base.summary.units.mean.toFixed(0)} 件 |`);
  lines.push(`| 推车 / 框 | 每车 ${cfg.equipment.cart.totesPerCart} 框；框内径 ${cfg.equipment.tote.innerCm.l}×${cfg.equipment.tote.innerCm.w}×${cfg.equipment.tote.innerCm.h} cm，上限 ${cfg.equipment.tote.maxWeightKg} kg，装填系数 ${cfg.equipment.tote.fillFactor} |`);
  lines.push(`| 排班（人·小时 / 天） | 拣货 ${staffSum(sc.staffing.pick)}，暂存 ${staffSum(sc.staffing.stage)}，交付 ${staffSum(sc.staffing.handoff)}，后仓补取 ${staffSum(sc.staffing.exception)} |`);
  lines.push(`| 种子 | 订单 ${result.baseSeed} 起，每次重复递增 |`, '');

  lines.push('### 主要假设参数', '');
  lines.push('| 参数 | 值 | 说明 |', '|---|---|---|');
  const t = sc.times;
  lines.push(`| 推车速度 | ${t.cartSpeedMps} m/s | 校准后基线拣货效率约 70 件/工时，与公开基准（门店人工拣货 60–70 件/小时）一致 |`);
  lines.push(`| 每个拣货点 / 每件 | ${t.stopSec} s / ${t.unitSec} s | 找位核对 / 扫描放入 |`);
  lines.push(`| 暂存（记录 / 不记录） | ${t.stageRecordedSec} s / ${t.stageUnrecordedSec} s 每框 | 扫描格位多花几秒 |`);
  lines.push(`| 交付取框（记录 / 寻找） | ${t.findRecordedSec} s / ${t.searchBaseSec} s + ${t.searchPerOccupancySec} s × 占用率 | 不记录格位时需要寻找，越满越难找 |`);
  lines.push(`| 后仓补取 | ${t.exceptionBaseSec}–${t.exceptionBaseSec + t.exceptionVarSec} s | 库存记录不准率 ${sc.behavior.phantomRecordRate}，后仓漏找率 ${sc.behavior.backroomMissRate} |`);
  lines.push(`| 顾客行为 | 「我在路上」点击率 ${sc.behavior.onMyWayTapRate}，位置共享率 ${sc.behavior.locationShareRate} | 早到 ${sc.behavior.earlyArrivalShare}，迟到 ${sc.behavior.lateArrivalShare} |`);
  lines.push(`| 时薪 | $${sc.hourlyWage} | 只用于换算成本 |`, '');

  lines.push('### 策略定义', '');
  lines.push('| 环节 | 基线（无专门系统的中型店） | 优化（Storewright） |', '|---|---|---|');
  lines.push('| 分箱 | 凭目测按体积装框，不看重量、不分装化学品 | 体积 + 重量 + 压放顺序 + 化学品分装，单遍完成 |');
  lines.push('| 分批 | 按订单顺序每 8 框一车 | 按通道重叠度全局划分 + 冷链时限约束 |');
  lines.push('| 路线 | 按通道顺序 S 形 | 门店行走网络上的旅行商启发式 |');
  lines.push('| 暂存 | 放好不记录，交付时寻找 | 扫描格位记录 |');
  lines.push('| 准备 | 顾客点击「我在路上」时开始取框（行业常见做法） | 位置估算距离到达 ≤ 5 分钟时取框 |');
  lines.push('| 行程核验 | 逐单核验 | 一个行程一次核验 + 记录车内位置 |');
  lines.push('| 缺货 | 替代或缺货 | 替代 → 库存记录显示后仓有货时异步补取 → 缺货 |', '');
  lines.push('> 基线刻意设得偏强（例如已经在「我在路上」时开始准备），宁可低估本系统的改进。', '');

  const PROFILE_NAMES: Record<string, string> = { optimized: '默认档位（服务与安全优先）', efficiency: '效率优先档位（订单可拆车、装填系数 0.8）' };
  const mains = result.paired.filter((p) => !p.policy.startsWith('+'));
  mains.forEach((pair, mi) => {
    const opt = result.policies.find((p) => p.policy === pair.policy);
    if (!opt) return;
    lines.push(`## 2.${mi + 1} 主要结果：${PROFILE_NAMES[pair.policy] ?? pair.policy} 对比基线`, '');
    lines.push(`| 指标 | 基线 | ${pair.policy} | 差值（配对） | 变化 | 判断 |`, '|---|---|---|---|---|---|');
    for (const k of KPIS) {
      const b = base.summary[k.key];
      const o = opt.summary[k.key];
      const d = pair.delta[k.key];
      const rel = Math.abs(b.mean) > 1e-9 ? `${((100 * d.mean) / Math.abs(b.mean)).toFixed(1)}%` : '—';
      lines.push(`| ${k.label}${k.unit ? `（${k.unit}）` : ''} | ${cell(b, k)} | ${cell(o, k)} | ${fmt(d.mean, k.digits, k.scale)} ± ${fmt(d.ci95, k.digits, k.scale)} | ${rel} | ${verdict(d, k)} |`);
    }
    lines.push('');
    const laborDelta = pair.delta.busyHoursTotal.mean;
    const shortDelta = pair.delta.shortLines.mean;
    const valueDelta = -pair.delta.shortValue.mean;
    const laborYear = laborDelta * sc.hourlyWage * 360;
    const marginYear = valueDelta * sc.grossMargin * 360;
    lines.push('### 换算（示例，非结论）', '');
    lines.push('| 项目 | 每天 | 每年（360 天） |', '|---|---|---|');
    lines.push(`| 作业工时变化 | ${laborDelta >= 0 ? '+' : ''}${laborDelta.toFixed(1)} h（± ${pair.delta.busyHoursTotal.ci95.toFixed(1)}） | 人工成本 ${laborYear >= 0 ? '+' : '−'}$${Math.abs(laborYear).toFixed(0)} |`);
    lines.push(`| 挽回的缺货行 | ${(-shortDelta).toFixed(1)} 行（± ${pair.delta.shortLines.ci95.toFixed(1)}） | 销售额 $${(valueDelta * 360).toFixed(0)}，按 ${(sc.grossMargin * 100).toFixed(0)}% 毛利约 $${marginYear.toFixed(0)} |`);
    lines.push(`| 净额（只计以上两项） | — | ${marginYear - laborYear >= 0 ? '+' : '−'}$${Math.abs(marginYear - laborYear).toFixed(0)} |`, '');
    lines.push('- 安全与质量指标（超重、压坏、化学品混装、冷链停留）以及等待时间对复购的影响没有计入金额，但它们对应的是人身伤害、食品安全和顾客流失风险。', '');
  });

  const ablations = result.paired.filter((p) => p.policy.startsWith('+'));
  if (ablations.length) {
    lines.push('## 3. 消融实验：每项优化单独打开（相对基线的差值）', '');
    const defs = ABLATION_KPIS.map((k) => KPIS.find((x) => x.key === k) as KpiDef);
    lines.push(`| 单项 | ${defs.map((d) => `${d.label}${d.unit ? `（${d.unit}）` : ''}`).join(' | ')} |`);
    lines.push(`|---|${defs.map(() => '---').join('|')}|`);
    for (const a of ablations) {
      lines.push(`| ${a.policy} | ${defs.map((d) => `${fmt(a.delta[d.key].mean, d.digits, d.scale)} ± ${fmt(a.delta[d.key].ci95, d.digits, d.scale)}`).join(' | ')} |`);
    }
    lines.push('', '> 正负号表示相对基线的变化方向；各项之间存在交互作用，单项之和不等于整体效果。', '');
  }

  lines.push('## 4. 如何解读', '');
  lines.push('- 「判断」一栏只在 95% 置信区间不包含 0 时给出改善或变差；');
  lines.push('- 结果依赖上面列出的假设参数，修改参数后重新运行即可得到新的结果；');
  lines.push('- 复现：`npm run compare -- --template ' + result.template + ' --reps ' + result.reps + ' --seed ' + result.baseSeed + (ablations.length ? ' --ablation' : '') + '`。');
  return lines.join('\n') + '\n';
}

export function renderDay(metrics: Record<string, number | string>): string {
  const rows = KPIS.map((k) => {
    const v = metrics[k.key];
    return `  ${k.label.padEnd(22, '　')} ${typeof v === 'number' ? fmt(v, k.digits, k.scale) : String(v)} ${k.unit}`;
  });
  return rows.join('\n');
}

export interface SensitivityRow {
  label: string;
  value: string;
  delta: Record<MetricKey, Summary>;
}

export function renderSensitivity(template: string, reps: number, seed: number, rows: SensitivityRow[]): string {
  const keys: Array<[MetricKey, string, number, number]> = [
    ['busyHoursTotal', 'Δ 作业总工时（h/天）', 1, 1],
    ['laborCostPerOrder', 'Δ 单均人工成本（$）', 2, 1],
    ['avgWaitMin', 'Δ 平均等待（min）', 2, 1],
    ['lateOrderPct', 'Δ 未按时就绪（百分点）', 1, 1],
    ['fillRate', 'Δ 满足率（百分点）', 2, 100],
    ['avgReadyDwellMin', 'Δ 门口停留（min）', 1, 1],
  ];
  const lines: string[] = [];
  lines.push(`# 敏感性分析 · ${template}`, '');
  lines.push(`> 每一行只改变一个假设参数，其余保持基准值；每个设置运行 ${reps} 次公共随机数重复（种子 ${seed} 起），`);
  lines.push('> 表中是「优化 − 基线」的配对差值（均值 ± 95% 置信区间）。用来判断结论对哪些假设最敏感。', '');
  lines.push(`| 设置 | 取值 | ${keys.map((k) => k[1]).join(' | ')} |`);
  lines.push(`|---|---|${keys.map(() => '---').join('|')}|`);
  for (const r of rows) {
    lines.push(`| ${r.label} | ${r.value} | ${keys.map(([k, , d, s]) => `${(r.delta[k].mean * s).toFixed(d)} ± ${(r.delta[k].ci95 * s).toFixed(d)}`).join(' | ')} |`);
  }
  lines.push('', '复现：`npm run sensitivity -- --template ' + template + ' --reps ' + reps + ' --seed ' + seed + '`');
  return lines.join('\n') + '\n';
}
