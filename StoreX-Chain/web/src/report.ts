import { barChart, changeChart, lineChart, SERIES, tornadoChart } from '../../../StoreX/src/analysis/svg';
import raw from './data/results.json';
import { mountDrills } from './drillLab';
import { mountForecast } from './forecastPanel';
import { t as tr, tx, isEn } from './i18n';

/** 指标名（单位）：英文界面用半角括号 */
const lu = (label: string, unit: string) => (isEn() ? `${tx(label)} (${tx(unit)})` : `${label}（${unit}）`);
/** 「标题：内容」：英文界面两段分别翻、用半角冒号 */
const pair = (a: string, b: string) => (isEn() ? `${tx(a)}: ${tx(b)}` : `${a}：${b}`);
/** 英文的说明句首字母大写（由几段短语拼成的说明，第一段是小写） */
const cap = (s: string) => (isEn() ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** StoreX 画图函数自带的几个中文词（选用、改善 / 变差、超出刻度、基准、取低值 / 取高值、全角冒号）：英文界面换掉 */
const chartEn = (svg: string) =>
  isEn()
    ? svg
        .replace(/>选用</g, `>${tr('选用')}<`)
        .replace(/ (改善|变差)(?=[<（])/g, (_m, v: string) => ` ${tx(v)}`)
        .replace(/（超出刻度）/g, ` ${tr('（超出刻度）')}`)
        .replace(/>基准 /g, `>${tx('基准')} `)
        .replace(/>取低值</g, `>${tr('取低值')}<`)
        .replace(/>取高值</g, `>${tr('取高值')}<`)
        .replace(/：/g, ': ')
    : svg;

/** 「对比与报告」页：读 npm run reports 生成的结果（docs/results/data.json 的副本），图在浏览器里现画 */
type Gen = 'g1' | 'g2' | 'g3';
interface KpiMeta {
  key: string;
  label: string;
  unit: string;
  group: string;
  better: 'lower' | 'higher' | 'none';
  digits: number;
}
type Means = Record<string, number>;
interface Econ {
  capex: number;
  npv: number;
  irr: number;
  payback: number;
  workingCapital: number;
  steady: { gross: number; opex: number; net: number };
  rows: { year: number; gross: number; opex: number; capex: number; wc: number; net: number; cumulative: number }[];
  scenarios: { key: string; label: string; detail: string; npv: number; irr: number; payback: number; cumulative: number[] }[];
}
interface Data {
  seeds: { compare: number; sweep: number };
  kpis: KpiMeta[];
  gens: { gen: Gen; label: string; mean: Means; ci: Means; cost: number[] }[];
  costCats: string[];
  pairs: { g3g1: { key: string; pct: number; verdict: string }[]; g3g2: { key: string; pct: number; verdict: string }[] };
  sweeps: { key: string; title: string; question: string; chart: string; chosen: number | string; kpis: string[]; points: { value: number | string; label: string; mean: Means }[]; note?: string }[];
  flows?: { key: string; label: string; via: 'direct' | 'dc'; palletsPerDay: number; loads: number; interval: number; costDc: number; costDirect: number; reason: string }[];
  twin?: { seeds: number; arms: { key: string; label: string; short: string }[]; levels: { key: string; label: string; arms: Record<string, Record<string, number>>; fidelity: { eta30: number; eta60: number; eta120: number; temp: number } }[] };
  capacity: { scales: number[]; gens: Record<Gen, Means[]> };
  levers?: { key: string; title: string; from: string; to: string; cost: number; co2: number; service: number; inventory: number }[];
  automation?: { label: string; npv: number; irr: number; payback: number; withoutNpv: number; hours: number }[];
  stress: { key: string; label: string; detail: string; gens: Record<Gen, { window: number; windowDrop: number; worstDrop: number; airDrop: number; onTimeDrop: number; response: number; extraCost: number; lostUnits: number }> }[];
  economics: { upstream: Econ; system: Econ; sensitivity: { label: string; low: { label: string; npv: number }; high: { label: string; npv: number } }[] };
  runs: number;
  runtime: number;
}
const data = raw as unknown as Data;
const GENS: Gen[] = ['g1', 'g2', 'g3'];
const GL: Record<Gen, string> = { g1: tr('上一代'), g2: 'StoreX', g3: tr('StoreX 全链路') };
const GC: Record<Gen, string> = { g1: SERIES.gen1, g2: SERIES.storex, g3: SERIES.noMfc };
const REPO = 'https://github.com/Glacieerr/storewright/blob/main/StoreX-Chain/docs';
const meta = (key: string) => data.kpis.find((k) => k.key === key) as KpiMeta;
const mean = (g: Gen, key: string) => data.gens.find((x) => x.gen === g)?.mean[key] ?? NaN;
const ci = (g: Gen, key: string) => data.gens.find((x) => x.gen === g)?.ci[key] ?? 0;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, '−') : '—');
const usd = (x: number) => (x < 0 ? `−$${fmt(-x, 0)}` : `$${fmt(x, 0)}`);
const musd = (x: number) => tr('{x} 百万美元', { x: fmt(x / 1e6, 1) });
const img = (svg: string, alt: string) => `<img alt="${alt}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(chartEn(svg))}">`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** 结果页里的 Markdown 链接在网页上只留文字 */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

function hero(key: string): string {
  const k = meta(key);
  const a = mean('g1', key);
  const b = mean('g3', key);
  const pct = a ? ((b - a) / Math.abs(a)) * 100 : 0;
  return `<div class="hero"><div class="k">${lu(k.label, k.unit)}</div><div class="v">${fmt(b, k.digits)}</div><div class="from">${tr('上一代 {a} · {v2}{pct}%', { a: fmt(a, k.digits), v2: pct > 0 ? '+' : '', pct: fmt(pct, 0) })}</div></div>`;
}

function kpiTable(): string {
  const groups = [...new Set(data.kpis.map((k) => k.group))];
  const verdict = (list: Data['pairs']['g3g1'], key: string) => {
    const r = list.find((x) => x.key === key);
    if (!r) return '<td class="na">—</td>';
    const cls = r.verdict === '改善' ? 'verdict-good' : r.verdict === '变差' ? 'verdict-bad' : 'na';
    const pct = Number.isFinite(r.pct) && r.pct !== 0 ? `${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}% ` : '';
    return `<td class="${cls}">${pct}${tx(r.verdict)}</td>`;
  };
  const rows = groups.flatMap((g) => [
    `<tr class="group"><td colspan="6">${tx(g)}</td></tr>`,
    ...data.kpis
      .filter((k) => k.group === g)
      .map((k) => {
        const cell = (gen: Gen) => {
          const h = ci(gen, k.key);
          return `<td>${fmt(mean(gen, k.key), k.digits)}${h > 0 ? ` <small>± ${fmt(h, k.digits)}</small>` : ''}</td>`;
        };
        return `<tr><td>${lu(k.label, k.unit)}</td>${cell('g1')}${cell('g2')}${cell('g3')}${verdict(data.pairs.g3g1, k.key)}${verdict(data.pairs.g3g2, k.key)}</tr>`;
      }),
  ]);
  return `<div class="table-wrap"><table><thead><tr><th>${tr('指标')}</th><th>${tr('上一代')}</th><th>StoreX</th><th>${tr('StoreX 全链路')}</th><th>${tr('全链路 vs 上一代')}</th><th>${tr('全链路 vs StoreX')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function changeCharts(): string {
  const keys = ['service', 'storeInv', 'waste', 'freshRemain', 'arrivals', 'dcInv', 'dcLabor', 'outKm', 'fill', 'fleet', 'inboundKm', 'dwell', 'co2Local', 'costTransport', 'costTotal', 'workingCapital', 'systemTotal'];
  const chart = (list: Data['pairs']['g3g1'], label: string) => {
    const vs = /^[A-Za-z]/.test(label) ? ` ${label} ` : label;
    return changeChart({
      title: tr('StoreX 全链路相对{vs}的变化', { vs }),
      subtitle: tr('{compare} 个种子的配对差值 ÷ {vs}的均值；灰色 = 差异不显著', { compare: data.seeds.compare, vs }),
      items: keys.map((key) => {
        const r = list.find((x) => x.key === key);
        return { label: tx(meta(key).label), pct: r?.pct ?? 0, good: r?.verdict === '改善' ? true : r?.verdict === '变差' ? false : null };
      }),
    });
  };
  return `<div class="grid2">${img(chart(data.pairs.g3g1, tr('上一代')), tr('StoreX 全链路相对上一代的变化'))}${img(chart(data.pairs.g3g2, 'StoreX'), tr('StoreX 全链路相对 StoreX 的变化'))}</div>`;
}

function levers(): string {
  if (!data.levers?.length) return '';
  const rows = data.levers.map((l) => `<tr><td>${esc(tx(l.title))}</td><td>${esc(tx(l.from))} → ${esc(tx(l.to))}</td><td class="${l.cost < 0 ? 'verdict-good' : l.cost > 0 ? 'verdict-bad' : ''}">${usd(l.cost)}</td><td>${fmt(l.co2, 2)}</td><td>${fmt(l.service, 2)}</td></tr>`);
  return `<div class="table-wrap"><table><thead><tr><th>${tr('举措')}</th><th>${tr('不做 → 选用')}</th><th>${tr('供应链成本（美元 / 天）')}</th><th>${tr('本地运输排放（吨 / 天）')}</th><th>${tr('门店服务水平（个百分点）')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="note">${tr('其余保持全链路的选用值，只换这一项；各项之间有交互，加起来不等于总差。')}</p>`;
}

function sweeps(): string {
  return data.sweeps
    .map((sw) => {
      const k = meta(sw.chart);
      const idx = sw.points.findIndex((p) => p.value === sw.chosen);
      // 横轴标签太长时截断（英文按字母数，放宽一倍）
      const cut = isEn() ? 24 : 12;
      const title = tx(sw.title);
      const chart = lineChart({ title, subtitle: tr('{label}（{unit}）· 其余保持 StoreX 全链路的选用值', { label: tx(k.label), unit: tx(k.unit) }), x: sw.points.map((p) => tx(p.label)).map((s) => (s.length > cut ? `${s.slice(0, cut)}…` : s)), digits: k.digits, ...(idx >= 0 ? { highlight: idx } : {}), series: [{ name: tx(k.label), color: GC.g3, values: sw.points.map((p) => p.mean[sw.chart] ?? NaN) }] });
      const head = `<tr><th>${esc(title)}</th>${sw.kpis.map((key) => `<th>${lu(meta(key).label, meta(key).unit)}</th>`).join('')}</tr>`;
      const rows = sw.points.map((p) => `<tr${p.value === sw.chosen ? ' class="chosen"' : ''}><td>${esc(tx(p.label))}${p.value === sw.chosen ? `${isEn() ? ' ' : ''}${tr('（选用）')}` : ''}</td>${sw.kpis.map((key) => `<td>${fmt(p.mean[key] ?? NaN, meta(key).digits)}</td>`).join('')}</tr>`);
      return `<div><p class="lead"><b>${esc(title)}${isEn() ? ': ' : '：'}</b>${esc(tx(sw.question))}</p>${img(chart, title)}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>${sw.note ? `<p class="note">${esc(tx(plain(sw.note)))}</p>` : ''}</div>`;
    })
    .join('');
}

function flows(): string {
  if (!data.flows?.length) return '';
  const rows = data.flows.map((d) => `<tr${d.via === 'direct' ? ' class="chosen"' : ''}><td>${esc(tx(d.label))}</td><td>${fmt(d.palletsPerDay, 1)}</td><td>${fmt(d.interval, 1)}</td><td>${usd(d.costDc)}</td><td>${usd(d.costDirect)}</td><td>${d.via === 'direct' ? tr('直送门店') : tr('进配送中心')}</td><td>${esc(tx(d.reason))}</td></tr>`);
  return `<div class="table-wrap"><table><thead><tr><th>${tr('商品族')}</th><th>${tr('每天（托）')}</th><th>${tr('一车是几天的量')}</th><th>${tr('进配送中心（美元 / 天）')}</th><th>${tr('直送（美元 / 天）')}</th><th>${tr('决定')}</th><th>${tr('原因')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function twin(): string {
  const t = data.twin;
  if (!t) return '';
  const colors = [SERIES.gen1, SERIES.s4, SERIES.storex, SERIES.noMfc];
  const charts = t.levels.map((lv) => img(barChart({ title: tr('{label}：现场出了多少问题', { label: tx(lv.label) }), subtitle: tr('分钟 / 天，{seeds} 个种子平均', { seeds: t.seeds }), categories: [tr('门店收货迟到'), tr('冷链超温'), tr('门店缺货')], digits: 0, series: t.arms.map((a, i) => ({ name: tx(a.short), color: colors[i] as string, values: ['late', 'hot', 'short'].map((k) => lv.arms[a.key]?.[k] ?? NaN) })) }), tx(lv.label))).join('');
  const rows = t.levels.flatMap((lv) =>
    t.arms.map((a) => {
      const m = lv.arms[a.key] ?? {};
      return `<tr><td>${tx(lv.label)} · ${esc(tx(a.short))}</td><td>${fmt(m.late ?? NaN, 0)}</td><td>${fmt(m.hot ?? NaN, 0)}</td><td>${fmt(m.short ?? NaN, 0)}</td><td>${fmt(m.lost ?? NaN, 0)}</td><td>${usd(m.cost ?? NaN)}</td><td>${fmt(m.cards ?? NaN, 1)}</td></tr>`;
    }),
  );
  const fid = t.levels.map((lv) => tr('{label}提前 45–90 分钟预测到店时间平均差 {eta60} 分钟、货温差 {temp} °C', { label: tx(lv.label), eta60: fmt(lv.fidelity.eta60, 1), temp: fmt(lv.fidelity.temp, 2) })).join(isEn() ? '; ' : '；');
  return `<div class="grid2">${charts}</div><div class="table-wrap"><table><thead><tr><th>${tr('现场 · 做法')}</th><th>${tr('收货迟到（分钟）')}</th><th>${tr('冷链超温（分钟）')}</th><th>${tr('门店缺货（分钟）')}</th><th>${tr('少卖（件）')}</th><th>${tr('措施花的钱')}</th><th>${tr('建议卡（张）')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="note">${t.arms.map((a) => pair(a.short, a.label)).join(isEn() ? '; ' : '；')}${tr('。孪生的保真度：{fid}。', { fid })}</p>`;
}

function capacity(): string {
  const x = data.capacity.scales.map((s) => `${Math.round(s * 100)}%`);
  const series = (key: string) => GENS.map((g) => ({ name: GL[g], color: GC[g], values: data.capacity.gens[g].map((m) => m[key] ?? NaN) }));
  return `<div class="grid2">${img(lineChart({ title: tr('每箱的供应链成本随需求增长'), subtitle: tr('美元 / 箱；100% = 现在，124% ≈ 2030 年'), x, digits: 2, series: series('costPerCase') }), tr('每箱的供应链成本'))}${img(lineChart({ title: tr('配送中心工时随需求增长'), subtitle: tr('小时 / 天'), x, digits: 0, series: series('dcLabor') }), tr('配送中心工时'))}${img(lineChart({ title: tr('配送车队随需求增长'), subtitle: tr('辆（最多同时用车）'), x, digits: 0, series: series('fleet') }), tr('配送车队'))}${img(lineChart({ title: tr('每箱的本地运输排放随需求增长'), subtitle: tr('克 / 箱'), x, digits: 0, series: series('co2PerCase') }), tr('每箱的本地运输排放'))}</div>`;
}

function stress(): string {
  const rows = data.stress.flatMap((c) =>
    GENS.map((g) => {
      const m = c.gens[g];
      return `<tr><td>${tx(c.label)} · ${GL[g]}</td><td>${fmt(m.window, 2)}</td><td>${fmt(m.worstDrop, 1)}</td><td>${fmt(m.airDrop, 1)}</td><td>${fmt(m.onTimeDrop, 1)}</td><td>${fmt(m.lostUnits / 1000, 1)}</td><td>${usd(m.response)}</td><td>${usd(m.extraCost)}</td></tr>`;
    }),
  );
  const chart = barChart({ title: tr('压力演练：最差一天的服务水平比平常低多少'), subtitle: tr('个百分点（和同一种子、没有扰动的那次逐日比），{sweep} 个种子平均；越低越好', { sweep: data.seeds.sweep }), categories: data.stress.map((c) => tx(c.label)), digits: 1, series: GENS.map((g) => ({ name: GL[g], color: GC[g], values: data.stress.map((c) => c.gens[g].worstDrop) })) });
  return `${img(chart, tr('压力演练'))}<div class="table-wrap"><table><thead><tr><th>${tr('情况 · 方案')}</th><th>${tr('之后 3 周的服务水平（%）')}</th><th>${tr('最差一天比平常低（个百分点）')}</th><th>${tr('空运生鲜最差一天比平常低')}</th><th>${tr('准时送达最差一天比平常低')}</th><th>${tr('多出的缺货（千件）')}</th><th>${tr('应对花的钱')}</th><th>${tr('多花的钱合计')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="note">${data.stress.map((c) => pair(c.label, c.detail)).join(isEn() ? '; ' : '；')}${isEn() ? '.' : '。'}</p>`;
}

function economics(): string {
  const e = data.economics;
  const tiles = (x: Econ, title: string) => `<div class="hero"><div class="k">${title}</div><div class="v">${musd(x.npv)}</div><div class="from">${tr('10 年净现值 · 投资 {musd} · 内部收益率 {irr}% · 回收期 {payback} 年', { musd: musd(x.capex), irr: fmt(x.irr, 1), payback: fmt(x.payback, 1) })}</div></div>`;
  const years = e.upstream.rows.map((r) => String(r.year));
  const cum = (x: Econ, title: string) => lineChart({ title, subtitle: tr('百万美元（2026 年不变价格，未折现）'), x: years, digits: 0, yMin: Math.min(...x.scenarios.flatMap((s) => s.cumulative.map((v) => v / 1e6))), series: x.scenarios.map((s, i) => ({ name: tx(s.label), color: [SERIES.s4, SERIES.storex, SERIES.noMfc][i] as string, values: s.cumulative.map((v) => v / 1e6) })) });
  const tornado = tornadoChart({ title: tr('敏感性：上游这一步的 10 年净现值'), subtitle: tr('每次只改一个假设，其余保持基准'), base: e.upstream.npv, scale: 1e6, unit: ` ${tr('百万')}`, items: e.sensitivity.map((s) => ({ label: tx(s.label), low: { label: tx(s.low.label), value: s.low.npv }, high: { label: tx(s.high.label), value: s.high.npv } })) });
  const scen = (x: Econ, title: string) => `<div class="table-wrap"><table><thead><tr><th>${title}</th><th>${tr('10 年净现值')}</th><th>${tr('内部收益率')}</th><th>${tr('回收期')}</th></tr></thead><tbody>${x.scenarios.map((s) => `<tr><td>${tx(s.label)}<br><small>${esc(cap(tx(s.detail)))}</small></td><td>${musd(s.npv)}</td><td>${Number.isFinite(s.irr) ? `${fmt(s.irr, 1)}%` : '—'}</td><td>${Number.isFinite(s.payback) ? tr('{payback} 年', { payback: fmt(s.payback, 1) }) : tr('不回本')}</td></tr>`).join('')}</tbody></table></div>`;
  const auto = data.automation?.length
    ? `<p class="lead"><b>${tr('配送中心自动化单独的账：')}</b>${tr('只比较上和不上自动化（不上时配送中心每天多约 {hours} 工时）。', { hours: fmt(data.automation[0]?.hours ?? 0, 0) })}</p><div class="table-wrap"><table><thead><tr><th>${tr('情况')}</th><th>${tr('上自动化的增量净现值')}</th><th>${tr('增量内部收益率')}</th><th>${tr('增量回收期')}</th><th>${tr('不上自动化时上游这一步的净现值')}</th></tr></thead><tbody>${data.automation.map((x) => `<tr><td>${esc(cap(tx(x.label)))}</td><td>${musd(x.npv)}</td><td>${Number.isFinite(x.irr) ? `${fmt(x.irr, 1)}%` : '—'}</td><td>${Number.isFinite(x.payback) && x.payback < 50 ? tr('{payback} 年', { payback: fmt(x.payback, 1) }) : tr('分析期内不回本')}</td><td>${musd(x.withoutNpv)}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  return `<div class="heroes">${tiles(e.upstream, tr('上游这一步（门店已是 StoreX）'))}${tiles(e.system, tr('全系统（上一代 → 全链路，含综合店改造）'))}</div><div class="grid2">${img(cum(e.upstream, tr('累计现金流：上游这一步')), tr('累计现金流：上游这一步'))}${img(cum(e.system, tr('累计现金流：全系统')), tr('累计现金流：全系统'))}</div>${img(tornado, tr('敏感性'))}<div class="grid2">${scen(e.upstream, tr('情景：上游这一步'))}${scen(e.system, tr('情景：全系统'))}</div>${auto}`;
}

export function renderReport(el: HTMLElement): void {
  const cost = barChart({ title: tr('每天的供应链成本，按项目分'), subtitle: tr('美元 / 天，{compare} 个种子平均', { compare: data.seeds.compare }), categories: data.costCats.map((c) => tx(c)), series: data.gens.map((g) => ({ name: tx(g.label), color: GC[g.gen], values: g.cost })) });
  el.innerHTML = `
  <div class="report">
    <section>
      <h2>${tr('三代全链路对比')}</h2>
      <p class="lead">${tr('同一个湾区、同样的需求、促销和船期（{compare} 个种子，每个 18 周），比较三代方案：', { compare: data.seeds.compare })}<b>${tr('上一代')}</b> ${tr('= Storewright 的门店 + 传统供应链；')}<b>StoreX</b> ${tr('= 门店升级成 StoreX，上游不变；')}<b>${tr('StoreX 全链路')}</b> ${tr('= 门店和上游（供应商、港口、机场、铁路、配送中心、车队）一起由全链路数字孪生协同。下面的大数字是全链路，小字是上一代。')}</p>
      <div class="heroes">${['costTotal', 'costPerCase', 'workingCapital', 'waste', 'dcLabor', 'outKm', 'co2Local', 'systemTotal'].map(hero).join('')}</div>
    </section>
    <section>
      <h2>${tr('哪些变好了、变好多少')}</h2>
      ${changeCharts()}
    </section>
    <section>
      <h2>${tr('全部指标')}</h2>
      <p class="lead">${tr('「±」后面是 95% 置信区间的半宽；判断「改善 / 变差」看配对差值的置信区间是否包含 0。')}</p>
      ${kpiTable()}
    </section>
    <section>
      <h2>${tr('钱花在哪里')}</h2>
      ${img(cost, tr('每天的供应链成本，按项目分'))}
    </section>
    <section>
      <h2>${tr('全链路方案的决策扫描')}</h2>
      <p class="lead">${tr('每次只改一项，其余保持全链路的选用值（每个配置 {sweep} 个种子）。先看每一项单独值多少，再看每一项怎么定。表里加粗的是选用的方案。', { sweep: data.seeds.sweep })}</p>
      ${levers()}
      <div class="grid2">${sweeps()}</div>
    </section>
    <section>
      <h2>${tr('货流规划：长途整车直送门店还是进配送中心')}</h2>
      <p class="lead">${tr('海运、铁路班列和空运的货都要先进配送中心（拆箱、分拣、按温区配车），再用卡车送店；长途公路的整车（北边国内、东边跨境）可以直送门店，也可以进配送中心。规划按每个商品族算账，再排除易腐、长尾、一车的量门店放不下的。表里加粗的是直送门店的。')}</p>
      ${flows()}
    </section>
    <section>
      <h2>${tr('需求增长')}</h2>
      <p class="lead">${tr('综合店的需求从现在的 80% 到 160%；三代都按需求自动排班、派车、订货。')}</p>
      ${capacity()}
    </section>
    <section>
      <h2>${tr('压力演练')}</h2>
      <p class="lead">${tr('五种扰动，每种都和同一种子、没有扰动的那次比。全链路有孪生的应对手段（按缺口过桥采购、备降机场、预先认证的备用供应商、提前改道），上一代和 StoreX 的上游没有。')}</p>
      ${stress()}
    </section>
    <section id="rp-drills"></section>
    <section>
      <h2>${tr('闭环孪生：同一天的现场，用不用孪生')}</h2>
      <p class="lead">${tr('全链路方案第 86 天的计划在「现场」里跑一整天：现场会出计划不知道的状况（装车晚、事故、抛锚、冷机故障、门店突然卖得快、长途直送车发车晚），孪生只通过感知数据知道发生了什么，给出建议卡。同一个种子下四种做法面对完全一样的状况。')}</p>
      ${twin()}
    </section>
    <section id="rp-forecast"></section>
    <section>
      <h2>${tr('商业分析')}</h2>
      <p class="lead">${tr('2026 年建设，2027–2036 年运营，2026 年不变价格，折现率 7%；设备价格是公开资料里的常见区间。')}</p>
      ${economics()}
    </section>
    <section>
      <h2>${tr('完整报告')}</h2>
      <p class="lead">${tr('规划、三代对比（含 Storewright 和 StoreX）、商业分析和系统设计的完整报告，以及每个数字的来源（共 {runs} 次仿真，用时 {runtime} 秒）。', { runs: data.runs, runtime: fmt(data.runtime, 0) })}</p>
      <div class="links">
        <a href="${REPO}/01-planning-report.md">${tr('规划报告')}</a>
        <a href="${REPO}/02-generation-comparison.md">${tr('三代对比')}</a>
        <a href="${REPO}/03-business-analysis.md">${tr('商业分析')}</a>
        <a href="${REPO}/04-system-design.md">${tr('系统设计')}</a>
        <a href="${REPO}/results/README.md">${tr('实验结果')}</a>
      </div>
    </section>
  </div>`;
  // 演练和预测要在浏览器里现跑（后台线程）
  mountDrills(el.querySelector('#rp-drills') as HTMLElement);
  mountForecast(el.querySelector('#rp-forecast') as HTMLElement);
}
