import { COST_LABEL, distribution, PNL_GROUP_LABEL, WEEKDAY_LABEL, type CostParams, type DayPnL, type Distribution, type PnLGroup } from '@storewright/sim-engine';
import type { DayDigest } from '../sim/protocol';
import type { ScenarioDigest } from '../state/scenarios';
import { rowsFor } from './metricRows';
import { getLang, t, translate } from '../i18n';

const locale = () => (getLang() === 'en' ? 'en-US' : 'zh-CN');
import { POLICY_SHORT, TEMPLATE_LABEL } from './format';
import type { PolicyName } from '../sim/protocol';
import type { TemplateName } from '@storewright/store-config';

/**
 * 方案报告：当前方案和选中的对比方案的指标、经营账，以及连续多天模拟的分布。
 * 导出为独立的 HTML（内联样式和图片，离线打开）或 Markdown。
 */

export interface ReportColumn {
  name: string;
  template: TemplateName;
  policy: PolicyName;
  thumb?: string;
  digest: ScenarioDigest;
  pnl: DayPnL;
  /** 门店的行业（建材店不显示和食品有关的指标） */
  industry?: string;
}

export interface MultiDayKey {
  label: string;
  fmt: (v: number) => string;
  pick: (d: DayDigest, net: number) => number;
}

export const MULTI_KEYS: MultiDayKey[] = [
  { label: '线上订单', fmt: (v) => v.toFixed(0), pick: (d) => d.metrics.orders },
  { label: '平均到店等待（分钟）', fmt: (v) => v.toFixed(2), pick: (d) => d.metrics.avgWaitMin },
  { label: '等待 P90（分钟）', fmt: (v) => v.toFixed(1), pick: (d) => d.metrics.p90WaitMin },
  { label: '未按时就绪（%）', fmt: (v) => v.toFixed(1), pick: (d) => d.metrics.lateOrderPct },
  { label: '长等待占比（%）', fmt: (v) => v.toFixed(1), pick: (d) => d.metrics.longWaitPct },
  { label: '订单满足率（%）', fmt: (v) => v.toFixed(2), pick: (d) => d.metrics.fillRate * 100 },
  { label: '单均作业工时（分钟）', fmt: (v) => v.toFixed(1), pick: (d) => d.metrics.laborMinutesPerOrder },
  { label: '开门未上架（箱）', fmt: (v) => v.toFixed(0), pick: (d) => d.inbound.backlogCases },
  { label: '线上业务日净额（$）', fmt: (v) => v.toFixed(0), pick: (_, net) => net },
];

export interface ReportData {
  title: string;
  generatedAt: Date;
  columns: ReportColumn[];
  costs: CostParams;
  multi?: { days: DayDigest[]; nets: number[] };
  screenshot?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const money = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(0)}`;

const disclaimer = () => t('本项目与任何零售商、企业无隶属关系。报告中的数据来自对通用作业流程的合理推测和模拟，单价为可调的假设值，只用于比较方案之间的相对差异。');

function summaryRows(c: ReportColumn): Array<[string, string]> {
  const d = c.digest;
  return [
    [t('门店'), TEMPLATE_LABEL[c.template] ?? c.template],
    [t('楼层 / 货架通道'), t('{0} 层 / {1} 条', d.floors, d.aisles)],
    [t('面积'), `${Math.round(d.floorAreaM2).toLocaleString()} ㎡`],
    [t('营业时间'), d.hours],
    [t('策略'), POLICY_SHORT[c.policy] ?? c.policy],
    [t('排班峰值 / 夜班'), t('{0} 人 / {1} 人', d.staffTotal, d.nightCrew)],
    [t('叉车 / 搬运车'), `${d.forklifts} / ${d.palletJacks}`],
  ];
}

function metricTable(columns: ReportColumn[]): { head: string[]; rows: Array<{ group?: string; cells: string[] }> } {
  const head = [t('指标'), ...columns.map((c) => c.name)];
  const rows: Array<{ group?: string; cells: string[] }> = [];
  const industry = columns.length && columns.every((c) => c.industry === 'HARDWARE') ? 'HARDWARE' : undefined;
  for (const g of rowsFor(industry)) {
    rows.push({ group: t(g.group), cells: [] });
    for (const r of g.rows) rows.push({ cells: [t(r.label), ...columns.map((c) => r.fmt(c.digest.metrics[r.key] as number))] });
  }
  rows.push({ group: t('后仓与到货'), cells: [] });
  rows.push({ cells: [t('到货托盘'), ...columns.map((c) => String(c.digest.inbound.palletsReceived))] });
  rows.push({ cells: [t('卸货到入库（分钟）'), ...columns.map((c) => c.digest.inbound.dockToStockMin.toFixed(0))] });
  rows.push({ cells: [t('开门补齐率'), ...columns.map((c) => `${Math.round(c.digest.inbound.readyAtOpen * 100)}%`)] });
  rows.push({ cells: [t('货架托盘位'), ...columns.map((c) => String(c.digest.inbound.rackCapacity))] });
  return { head, rows };
}

function pnlTable(columns: ReportColumn[]): { head: string[]; rows: Array<{ cells: string[]; kind?: 'sub' | 'total' }> } {
  const head = [t('经营账（每天）'), ...columns.map((c) => c.name)];
  const first = columns[0]?.pnl;
  const rows: Array<{ cells: string[]; kind?: 'sub' | 'total' }> = [];
  if (!first) return { head, rows };
  for (const g of ['online', 'service', 'backroom'] as PnLGroup[]) {
    if (g === 'service' && columns.every((c) => Math.abs(c.pnl.groups.service) < 0.5)) continue;
    for (const l of first.lines.filter((x) => x.group === g)) rows.push({ cells: [translate(l.label), ...columns.map((c) => money(c.pnl.lines.find((x) => x.key === l.key)?.value ?? 0))] });
    rows.push({ cells: [t('{0}小计', translate(PNL_GROUP_LABEL[g])), ...columns.map((c) => money(c.pnl.groups[g]))], kind: 'sub' });
  }
  rows.push({ cells: [t('合计（不含店内销售）'), ...columns.map((c) => money(c.pnl.net))], kind: 'total' });
  rows.push({ cells: [t('线上业务每单净额'), ...columns.map((c) => `$${c.pnl.onlinePerOrder.toFixed(2)}`)] });
  return { head, rows };
}

function multiStats(multi: NonNullable<ReportData['multi']>): Array<{ key: MultiDayKey; d: Distribution }> {
  return MULTI_KEYS.map((key) => ({ key, d: distribution(multi.days.map((day, i) => key.pick(day, multi.nets[i] ?? 0))) }));
}

/** 每日净额柱状图（内联 SVG） */
function netBars(nets: number[]): string {
  const w = 640;
  const h = 160;
  const max = Math.max(1, ...nets.map(Math.abs));
  const bw = w / Math.max(1, nets.length);
  const mid = h / 2;
  const bars = nets
    .map((v, i) => {
      const bh = (Math.abs(v) / max) * (mid - 12);
      const y = v >= 0 ? mid - bh : mid;
      return `<rect x="${(i * bw + 2).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" fill="${v >= 0 ? '#2f9a5f' : '#c8433a'}"><title>${esc(t('第 {0} 天：{1}', i + 1, money(v)))}</title></rect>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(t('每天的线上业务净额'))}"><line x1="0" y1="${mid}" x2="${w}" y2="${mid}" stroke="#9aa3ab" stroke-width="1"/>${bars}</svg>`;
}

export function reportHTML(d: ReportData): string {
  const mt = metricTable(d.columns);
  const pt = pnlTable(d.columns);
  const table = (head: string[], body: string) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const cards = d.columns
    .map(
      (c) => `<section class="card">${c.thumb ? `<img src="${c.thumb}" alt="${esc(t('{0} 场景缩略图', c.name))}">` : ''}<h3>${esc(c.name)}</h3><dl>${summaryRows(c)
        .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
        .join('')}<dt>${esc(t('线上业务日净额'))}</dt><dd><strong>${money(c.pnl.groups.online)}</strong></dd><dt>${esc(t('合计（不含店内销售）'))}</dt><dd>${money(c.pnl.net)}</dd></dl></section>`,
    )
    .join('');
  let multi = '';
  if (d.multi?.days.length) {
    const stats = multiStats(d.multi);
    multi = `<h2>${esc(t('连续 {0} 天模拟（当前方案）', d.multi.days.length))}</h2>
<p class="muted">${esc(t('每天换一组随机订单，订单量按星期几浮动（周末偏高）。P10–P90 表示十天里有八天落在这个范围内。'))}</p>
${table([t('指标'), t('平均'), 'P10', t('中位数'), 'P90', t('最差 / 最好')], stats.map(({ key, d: s }) => `<tr><td>${esc(t(key.label))}</td><td>${key.fmt(s.mean)}</td><td>${key.fmt(s.p10)}</td><td>${key.fmt(s.p50)}</td><td>${key.fmt(s.p90)}</td><td>${key.fmt(s.min)} / ${key.fmt(s.max)}</td></tr>`).join(''))}
<h3>${esc(t('每天的线上业务净额'))}</h3>${netBars(d.multi.nets)}
${table([t('天'), t('星期'), t('订单'), t('平均等待'), t('未按时'), t('线上净额')], d.multi.days.map((day, i) => `<tr><td>${day.day}</td><td>${translate(WEEKDAY_LABEL[day.weekday] ?? '')}</td><td>${day.metrics.orders}</td><td>${esc(t('{0} 分钟', day.metrics.avgWaitMin.toFixed(2)))}</td><td>${day.metrics.lateOrderPct.toFixed(1)}%</td><td>${money(d.multi?.nets[i] ?? 0)}</td></tr>`).join(''))}`;
  }
  const costs = (Object.keys(COST_LABEL) as Array<keyof CostParams>).map((k) => `<tr><td>${esc(translate(COST_LABEL[k]))}</td><td>${d.costs[k]}</td></tr>`).join('');
  return `<!doctype html>
<html lang="${getLang() === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>
:root { --ink: #1f2a30; --muted: #66727b; --line: #dde3e7; --bg: #fafbfc; --card: #fff; --accent: #2f9a5f; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6ebee; --muted: #9aa6ae; --line: #33404a; --bg: #161c20; --card: #1f272c; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 2px solid var(--accent); padding-bottom: 4px; }
h3 { font-size: 15px; margin: 8px 0; }
.muted { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.card img { width: 100%; border-radius: 6px; display: block; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--card); margin: 8px 0; }
th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
tr.group td { background: rgba(47, 154, 95, 0.08); font-weight: 600; text-align: left; }
tr.sub td { font-weight: 600; background: rgba(127, 140, 150, 0.08); }
tr.total td { font-weight: 700; border-top: 2px solid var(--ink); }
.shot { width: 100%; border-radius: 10px; border: 1px solid var(--line); }
footer { margin-top: 32px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${esc(d.title)}</h1>
<p class="muted">${esc(t('生成时间：{0} · Storewright 门店数字孪生', d.generatedAt.toLocaleString(locale())))}</p>
${d.screenshot ? `<img class="shot" src="${d.screenshot}" alt="${esc(t('当前场景截图'))}">` : ''}
<h2>${esc(t('方案概览'))}</h2>
<div class="cards">${cards}</div>
<h2>${esc(t('全天指标'))}</h2>
<div class="table">${table(mt.head, mt.rows.map((r) => (r.group ? `<tr class="group"><td colspan="${mt.head.length}">${esc(r.group)}</td></tr>` : `<tr>${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)).join(''))}</div>
<h2>${esc(t('经营账（估算）'))}</h2>
<div class="table">${table(pt.head, pt.rows.map((r) => `<tr class="${r.kind ?? ''}">${r.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join(''))}</div>
<p class="muted">${esc(t('后仓收货与夜班补货服务的是整个门店，而模拟器不计算店内销售收入，所以合计通常为负；比较方案时看差值。'))}</p>
<details><summary>${esc(t('单价假设'))}</summary>${table([t('假设'), t('取值')], costs)}</details>
${multi}
<footer>${esc(disclaimer())}</footer>
</main>
</body>
</html>`;
}

export function reportMarkdown(d: ReportData): string {
  const lines: string[] = [];
  const row = (cells: string[]) => `| ${cells.map(md).join(' | ')} |`;
  const sep = (n: number) => `|${' --- |'.repeat(n)}`;
  lines.push(`# ${d.title}`, '', t('生成时间：{0} · Storewright 门店数字孪生', d.generatedAt.toLocaleString(locale())), '');
  lines.push(`## ${t('方案概览')}`, '');
  for (const c of d.columns) {
    lines.push(`### ${md(c.name)}`, '');
    for (const [k, v] of summaryRows(c)) lines.push(`- ${k}${t('：')}${v}`);
    lines.push(`- ${t('线上业务日净额')}${t('：')}**${money(c.pnl.groups.online)}**${t('；')}${t('合计（不含店内销售）')}${t('：')}${money(c.pnl.net)}`, '');
  }
  const mt = metricTable(d.columns);
  lines.push(`## ${t('全天指标')}`, '', row(mt.head), sep(mt.head.length));
  for (const r of mt.rows) lines.push(r.group ? row([`**${r.group}**`, ...mt.head.slice(1).map(() => '')]) : row(r.cells));
  const pt = pnlTable(d.columns);
  lines.push('', `## ${t('经营账（估算）')}`, '', row(pt.head), sep(pt.head.length), ...pt.rows.map((r) => row(r.kind ? r.cells.map((c, i) => (i === 0 ? `**${c}**` : c)) : r.cells)));
  lines.push('', t('后仓收货与夜班补货服务的是整个门店，而模拟器不计算店内销售收入，所以合计通常为负；比较方案时看差值。'));
  lines.push('', t('单价假设') + t('：') + (Object.keys(COST_LABEL) as Array<keyof CostParams>).map((k) => `${translate(COST_LABEL[k])} ${d.costs[k]}`).join(t('；')), '');
  if (d.multi?.days.length) {
    lines.push(`## ${t('连续 {0} 天模拟（当前方案）', d.multi.days.length)}`, '', row([t('指标'), t('平均'), 'P10', t('中位数'), 'P90', t('最差 / 最好')]), sep(6));
    for (const { key, d: s } of multiStats(d.multi)) lines.push(row([t(key.label), key.fmt(s.mean), key.fmt(s.p10), key.fmt(s.p50), key.fmt(s.p90), `${key.fmt(s.min)} / ${key.fmt(s.max)}`]));
    lines.push('', row([t('天'), t('星期'), t('订单'), t('平均等待'), t('未按时'), t('线上净额')]), sep(6));
    d.multi.days.forEach((day, i) => lines.push(row([String(day.day), translate(WEEKDAY_LABEL[day.weekday] ?? ''), String(day.metrics.orders), t('{0} 分钟', day.metrics.avgWaitMin.toFixed(2)), `${day.metrics.lateOrderPct.toFixed(1)}%`, money(d.multi?.nets[i] ?? 0)])));
    lines.push('');
  }
  lines.push('---', '', `_${disclaimer()}_`, '');
  return lines.join('\n');
}

export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(name: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}
