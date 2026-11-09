import raw from './data/results.json';
import { barChart, lineChart, SERIES, tornadoChart } from '../../src/analysis/svg';

/** 「对比与报告」页：读 npm run reports 生成的结果（docs/results/data.json 的副本） */
interface KpiMeta {
  key: string;
  label: string;
  unit: string;
  group: string;
  better: 'lower' | 'higher' | 'none';
  digits: number;
}
type Means = Record<string, number>;
interface Data {
  seeds: { compare: number; sweep: number };
  kpis: KpiMeta[];
  headline: { key: string; title: string; a: { label: string; mean: Means; ci: Means }; b: { label: string; mean: Means; ci: Means }; rows: { key: string; diff: number; half: number; pct: number; verdict: string }[] }[];
  alternatives: { title: string; arms: { label: string; mean: Means }[] }[];
  hoursByGroup: { labels: string[]; gen1: number[]; storex: number[]; gen1y2030: number[]; storex2030: number[] };
  sweeps: { key: string; title: string; question: string; chart: string; chosen: number | string; kpis: string[]; points: { value: number | string; label: string; mean: Means; half: Means }[] }[];
  capacity: { volumes: number[]; gen1: Means[]; noMfc: Means[]; storex: Means[] };
  stress: { key: string; label: string; detail: string; mean: Means }[];
  economics: {
    npv: number;
    irr: number;
    payback: number;
    discountedPayback: number;
    capexTotal: number;
    capexOpening: number;
    capexByGroup: Record<string, number>;
    steady: { gross: number; opex: number; net: number };
    rows: { year: number; orders: number; gross: number; opex: number; capex: number; residual: number; net: number; cumulative: number }[];
    mfc: { npv: number; irr: number; payback: number; breakEven: number; annualCost: number };
    scenarios: { key: string; label: string; detail: string; npv: number; irr: number; payback: number; cumulative: number[] }[];
    sensitivity: { label: string; low: { label: string; npv: number }; high: { label: string; npv: number } }[];
  };
  days: number;
  runtime: number;
}
const data = raw as unknown as Data;
const meta = (key: string) => data.kpis.find((k) => k.key === key) as KpiMeta;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, '−') : '—');
const usdM = (x: number) => `${fmt(x / 1e6, 2)} 百万美元`;
const img = (svg: string, alt: string) => `<img alt="${alt}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
const REPO = 'https://github.com/Glacieerr/storewright/blob/main/StoreX/docs';

function hero(label: string, value: string, from: string): string {
  return `<div class="hero"><div class="k">${label}</div><div class="v">${value}</div><div class="from">${from}</div></div>`;
}

export function renderReport(el: HTMLElement): void {
  const [today, y2030] = data.headline;
  if (!today || !y2030) return;
  const a = today.a.mean;
  const b = today.b.mean;
  const pct = (k: string) => {
    const r = today.rows.find((x) => x.key === k);
    return r ? `${r.pct > 0 ? '+' : ''}${fmt(r.pct, 0)}%` : '';
  };
  const e = data.economics;
  const ratio = (m: Means) => fmt((m.fte ?? 0) / Math.max(1, m.robots ?? 1), 1);

  el.innerHTML = `
  <div class="report">
    <section>
      <h2>结论</h2>
      <p class="lead">同一家店、同样的订单和顾客（${data.seeds.compare} 个不同的日子取平均），StoreX 与上一代（Storewright 优化后的手机作业流程）相比，现在的订单量（266 单 / 天）下：</p>
      <div class="heroes">
        ${hero('全店带薪工时', `${fmt(b.paid ?? 0, 0)} 小时 / 天`, `上一代 ${fmt(a.paid ?? 0, 0)}（${pct('paid')}）`)}
        ${hero('自提顾客平均等待', `${fmt(b.wait ?? 0, 1)} 分钟`, `上一代 ${fmt(a.wait ?? 0, 1)}（${pct('wait')}）`)}
        ${hero('线上作业工时 / 单', `${fmt(b.laborMinPerOrder ?? 0, 1)} 分钟`, `上一代 ${fmt(a.laborMinPerOrder ?? 0, 1)}（${pct('laborMinPerOrder')}）`)}
        ${hero('货架缺货率', `${fmt(b.oos ?? 0, 2)}%`, `上一代 ${fmt(a.oos ?? 0, 2)}%（${pct('oos')}）`)}
        ${hero('生鲜损耗', `${fmt(b.freshWaste ?? 0, 1)}%`, `上一代 ${fmt(a.freshWaste ?? 0, 1)}%（${pct('freshWaste')}）`)}
        ${hero('电网购电', `${fmt(b.gridKwh ?? 0, 0)} 千瓦时 / 天`, `上一代 ${fmt(a.gridKwh ?? 0, 0)}（${pct('gridKwh')}）`)}
        ${hero('员工 : 机器人', `${ratio(b)} : 1`, `${fmt(b.fte ?? 0, 0)} 人（8 小时折算）、${fmt(b.robots ?? 0, 0)} 台机器人`)}
        ${hero('10 年净现值（基准）', usdM(e.npv), `投资 ${usdM(e.capexTotal)}，回收期 ${fmt(e.payback, 1)} 年`)}
      </div>
    </section>

    <section>
      <h2>两代对比</h2>
      <p class="lead">± 是 95% 置信区间的半宽；同一组日子配对比较，差值的置信区间不含 0 才判「改善 / 变差」。</p>
      <div class="seg" id="cmp-switch"><button aria-pressed="true" data-i="0">现在（266 单）</button><button aria-pressed="false" data-i="1">2030 年（532 单）</button></div>
      <div class="table-wrap" id="cmp-table" style="margin-top:12px"></div>
    </section>

    <section>
      <h2>工时去了哪里</h2>
      <p class="lead">StoreX 的「门店作业员」一个岗位同时做补货、自提异常、年龄核验、配送装车和出口协助；站台拣货员兼做拆箱入格。</p>
      <div class="grid2">
        ${img(barChart({ title: '每天的带薪工时 · 266 单', subtitle: '小时 / 天', categories: data.hoursByGroup.labels, series: [
          { name: '上一代', color: SERIES.gen1, values: data.hoursByGroup.gen1 },
          { name: 'StoreX', color: SERIES.storex, values: data.hoursByGroup.storex },
        ] }), '每天的带薪工时，266 单')}
        ${img(barChart({ title: '每天的带薪工时 · 2030 年 532 单', subtitle: '小时 / 天', categories: data.hoursByGroup.labels, series: [
          { name: '上一代', color: SERIES.gen1, values: data.hoursByGroup.gen1y2030 },
          { name: 'StoreX 2030', color: SERIES.storex, values: data.hoursByGroup.storex2030 },
        ] }), '每天的带薪工时，532 单')}
      </div>
    </section>

    <section>
      <h2>货格仓本身值多少</h2>
      <p class="lead">「不建货格仓」保留 StoreX 的其他所有技术，只是线上订单全部用智能推车在卖场拣。货格仓的盈亏平衡点约 <b>${fmt(e.mfc.breakEven, 0)} 单 / 天</b>${e.mfc.breakEven > 266 ? '：开业时的 266 单还不够，订单增长以后才划算，所以货格机器人分三批买（12 → 16 → 20 台）' : '，开业时的 266 单已经超过'}。</p>
      <div class="table-wrap">${altTable()}</div>
    </section>

    <section>
      <h2>容量：订单从 100 涨到 800 单 / 天</h2>
      <div class="grid2">
        ${img(lineChart({ title: '每单的线上作业人工成本', subtitle: '美元 / 单（带薪）', x: data.capacity.volumes.map(String), digits: 2, series: capSeries('laborCostPerOrder') }), '每单的线上作业人工成本')}
        ${img(lineChart({ title: '全店每天的带薪工时', subtitle: '小时 / 天', x: data.capacity.volumes.map(String), digits: 0, series: capSeries('paid') }), '全店每天的带薪工时')}
      </div>
    </section>

    <section>
      <h2>设备怎么定</h2>
      <p class="lead">每项设备都用扫描实验来定：同一组日子，只改这一项。</p>
      <select id="sweep-pick">${data.sweeps.map((s, i) => `<option value="${i}">${s.title}</option>`).join('')}</select>
      <div id="sweep-body" style="margin-top:12px"></div>
    </section>

    <section>
      <h2>压力演练（2030 年订单量）</h2>
      <div class="table-wrap">${stressTable()}</div>
    </section>

    <section>
      <h2>商业分析</h2>
      <p class="lead">把一家上一代门店改造成 StoreX：2026 年改造，运营 10 年，2026 年不变价格，折现率 7%。设备价格取公开资料的常见区间。</p>
      <div class="heroes">
        ${hero('总投资', usdM(e.capexTotal), `开业时 ${usdM(e.capexOpening)}`)}
        ${hero('2030 年每年净节省', usdM(e.steady.net), `毛节省 ${usdM(e.steady.gross)}，运营成本 ${usdM(e.steady.opex)}`)}
        ${hero('内部收益率', `${fmt(e.irr, 1)}%`, `折现回收期 ${fmt(e.discountedPayback, 1)} 年`)}
        ${hero('保守情景净现值', usdM(e.scenarios.find((s) => s.key === 'conservative')?.npv ?? NaN), `回收期 ${fmt(e.scenarios.find((s) => s.key === 'conservative')?.payback ?? NaN, 1)} 年`)}
      </div>
      <div class="grid2" style="margin-top:16px">
        ${img(lineChart({ title: '累计现金流', subtitle: '百万美元（未折现）', x: e.rows.map((r) => String(r.year)), digits: 1, yMin: Math.min(...e.scenarios.flatMap((s) => s.cumulative.map((v) => v / 1e6))), series: e.scenarios.map((s, i) => ({ name: s.label, color: [SERIES.s4, SERIES.storex, SERIES.noMfc][i] as string, values: s.cumulative.map((v) => v / 1e6) })) }), '累计现金流')}
        ${img(tornadoChart({ title: '敏感性：10 年净现值', subtitle: '每次只改一个假设', base: e.npv, scale: 1e6, unit: ' 百万', items: e.sensitivity.map((s) => ({ label: s.label, low: { label: s.low.label, value: s.low.npv }, high: { label: s.high.label, value: s.high.npv } })) }), '敏感性')}
      </div>
    </section>

    <section>
      <h2>完整报告</h2>
      <p class="lead">规划报告、与上一代的对比、商业分析、系统设计和全部实验结果都在仓库的 StoreX/docs 目录。这一页的数字来自 ${fmt(data.days, 0)} 个仿真日（用时 ${fmt(data.runtime, 0)} 秒）。</p>
      <div class="links">
        <a href="${REPO}/01-planning-report.md" target="_blank" rel="noopener">规划报告</a>
        <a href="${REPO}/02-generation-comparison.md" target="_blank" rel="noopener">与上一代对比</a>
        <a href="${REPO}/03-business-analysis.md" target="_blank" rel="noopener">商业分析</a>
        <a href="${REPO}/04-system-design.md" target="_blank" rel="noopener">系统设计</a>
        <a href="${REPO}/results/README.md" target="_blank" rel="noopener">实验结果</a>
      </div>
    </section>
  </div>`;

  const sw = el.querySelector('#cmp-switch') as HTMLElement;
  const showCmp = (i: number) => {
    for (const x of sw.querySelectorAll('button')) x.setAttribute('aria-pressed', String(Number(x.dataset.i) === i));
    (el.querySelector('#cmp-table') as HTMLElement).innerHTML = cmpTable(i);
  };
  for (const x of sw.querySelectorAll<HTMLButtonElement>('button')) x.onclick = () => showCmp(Number(x.dataset.i));
  showCmp(0);
  const pick = el.querySelector('#sweep-pick') as HTMLSelectElement;
  const showSweep = () => ((el.querySelector('#sweep-body') as HTMLElement).innerHTML = sweepBody(Number(pick.value)));
  pick.onchange = showSweep;
  showSweep();
}

function cmpTable(i: number): string {
  const h = data.headline[i];
  if (!h) return '';
  const rows = h.rows
    .map((r) => {
      const k = meta(r.key);
      const d = k.digits;
      const cls = r.verdict === '改善' ? 'verdict-good' : r.verdict === '变差' ? 'verdict-bad' : '';
      return `<tr><td>${k.group} · ${k.label}（${k.unit}）</td><td>${fmt(h.a.mean[r.key] ?? 0, d)} ± ${fmt(h.a.ci[r.key] ?? 0, d)}</td><td>${fmt(h.b.mean[r.key] ?? 0, d)} ± ${fmt(h.b.ci[r.key] ?? 0, d)}</td><td>${r.diff > 0 ? '+' : ''}${fmt(r.diff, d)} ± ${fmt(r.half, d)}</td><td class="${cls}">${r.verdict}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>指标</th><th>${h.a.label}</th><th>${h.b.label}</th><th>配对差值</th><th>判断</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function altTable(): string {
  const keys = ['wait', 'waitP95', 'laborMinPerOrder', 'laborCostPerOrder', 'walkKm', 'paid', 'total$'];
  return data.alternatives
    .map((alt) => {
      const head = `<tr><th>${alt.title}</th>${alt.arms.map((x) => `<th>${x.label}</th>`).join('')}</tr>`;
      const body = keys.map((key) => {
        const k = meta(key);
        return `<tr><td>${k.label}（${k.unit}）</td>${alt.arms.map((x) => `<td>${fmt(x.mean[key] ?? 0, k.digits)}</td>`).join('')}</tr>`;
      });
      return `<table style="margin-bottom:12px"><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
    })
    .join('');
}

function capSeries(key: string) {
  const k = meta(key);
  return [
    { name: '上一代', color: SERIES.gen1, values: data.capacity.gen1.map((m) => m[key] ?? 0) },
    { name: '不建货格仓', color: SERIES.noMfc, values: data.capacity.noMfc.map((m) => m[key] ?? 0) },
    { name: 'StoreX', color: SERIES.storex, values: data.capacity.storex.map((m) => m[key] ?? 0) },
  ].map((s) => ({ ...s, values: s.values.map((v) => Number(v.toFixed(k.digits + 1))) }));
}

function sweepBody(i: number): string {
  const s = data.sweeps[i];
  if (!s) return '';
  const k = meta(s.chart);
  const idx = s.points.findIndex((p) => p.value === s.chosen);
  const chart = lineChart({ title: s.title, subtitle: `${k.label}（${k.unit}），竖线是 95% 置信区间`, x: s.points.map((p) => p.label), digits: k.digits, ...(idx >= 0 ? { highlight: idx } : {}), series: [{ name: k.label, color: SERIES.storex, values: s.points.map((p) => p.mean[s.chart] ?? 0), err: s.points.map((p) => p.half[s.chart] ?? 0) }] });
  const head = `<tr><th>${s.question}</th>${s.kpis.map((key) => `<th>${meta(key).label}（${meta(key).unit}）</th>`).join('')}</tr>`;
  const body = s.points.map((p) => `<tr class="${p.value === s.chosen ? 'chosen' : ''}"><td>${p.label}${p.value === s.chosen ? '（选用）' : ''}</td>${s.kpis.map((key) => `<td>${fmt(p.mean[key] ?? 0, meta(key).digits)} ± ${fmt(p.half[key] ?? 0, meta(key).digits)}</td>`).join('')}</tr>`);
  return `<div class="grid2"><div>${img(chart, s.title)}</div><div class="table-wrap"><table><thead>${head}</thead><tbody>${body.join('')}</tbody></table></div></div>`;
}

function stressTable(): string {
  const keys = ['done', 'onTime', 'wait', 'waitP95', 'robotFailures', 'paid'];
  const head = `<tr><th>情况</th>${keys.map((key) => `<th>${meta(key).label}（${meta(key).unit}）</th>`).join('')}</tr>`;
  const body = data.stress.map((c) => `<tr><td><b>${c.label}</b><br><small style="color:var(--ink2)">${c.detail}</small></td>${keys.map((key) => `<td>${fmt(c.mean[key] ?? 0, meta(key).digits)}</td>`).join('')}</tr>`);
  return `<table><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
}
