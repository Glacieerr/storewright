import './lab.css';
import { selectedModel, setForecastReport, type ForecastReport, type Metric, type ModelScore } from '../../src/analysis/forecast';
import { labCall, type Progress } from './labClient';
import { mountLineChart } from './labCharts';
import { isEn, t as tr, tx } from './i18n';

/**
 * 「对比与报告」页的预测：在后台线程里用仿真产生的历史数据训练模型（门店销量、班轮和班列晚到、路上用时），
 * 和现在的规则并排比，按验证期的误差自动选（哪个准用哪个）。训练好的结果交给 forecast.ts（setForecastReport），
 * 别的模块（值班助手）可以直接问 forecastDemand / forecastDelay / forecastTravel；同时在 window 上发一个 storex-forecast 事件。
 */
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const sgn = (x: number) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}%` : '—');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WEEK = [tr('一'), tr('二'), tr('三'), tr('四'), tr('五'), tr('六'), tr('日')];

export function mountForecast(root: HTMLElement): void {
  root.classList.add('lab');
  root.innerHTML = `
    <h2>${tr('预测：学到的模型和现在的规则比')}</h2>
    <p class="lead">${tr('用仿真产生的历史数据训练模型，和系统现在用的规则并排比：门店每天每个商品族的销量（一次 18 周的运行）、本店班轮和洲际班列的晚到（12 次独立的 18 周运行）、配送车路上的用时（全链路方案连续 30 天的现场）。前面的时段训练、中间一段验证，按验证期的误差自动选模型（哪个准用哪个），后面的时段是选好以后才检验的，不偷看。')}</p>
    <div class="lab-status"><span class="lab-bar"><i></i></span><span class="fc-msg">${tr('等这一节滚到眼前时开始训练…')}</span><button class="lab-btn fc-again" hidden>${tr('重新训练')}</button></div>
    <div class="fc-body"></div>`;
  const bar = root.querySelector('.lab-bar > i') as HTMLElement;
  const msg = root.querySelector('.fc-msg') as HTMLElement;
  const again = root.querySelector('.fc-again') as HTMLButtonElement;
  const body = root.querySelector('.fc-body') as HTMLElement;
  let running = false;
  const start = async () => {
    if (running) return;
    running = true;
    again.disabled = true;
    body.style.opacity = body.childElementCount ? '0.5' : '';
    try {
      const r = await labCall<ForecastReport>({ type: 'forecast' }, (p: Progress) => {
        bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
        msg.textContent = tr('训练中：{text}', { text: tx(p.text) });
      });
      setForecastReport(r);
      window.dispatchEvent(new CustomEvent('storex-forecast', { detail: r }));
      bar.style.width = '100%';
      msg.textContent = tr('训练和检验用了 {ms} 秒（全链路方案、平常负荷，区域和设施配置跟「孪生」页一样）。', { ms: (r.ms / 1000).toFixed(1) });
      render(body, r);
    } catch (err) {
      msg.textContent = tr('训练出错：{err}', { err: String(err) });
    } finally {
      running = false;
      again.disabled = false;
      again.hidden = false;
      body.style.opacity = '';
    }
  };
  again.onclick = () => void start();
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          void start();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(root);
  } else void start();
}

function card(title: string, r: ForecastReport, target: 'demand' | 'vessel' | 'train' | 'road'): string {
  const sel = selectedModel(target, undefined, r);
  const models: ModelScore[] = target === 'demand' ? r.demand.overall : target === 'road' ? r.road.models : r[target].models;
  const rule = models.find((m) => m.rule);
  const learned = !!sel && sel.key !== 'rule';
  if (target === 'demand') {
    const t = r.demand.selectedTest;
    return `<div class="lab-card"><div class="k">${title}</div><div class="v">${f1(t.wape)}%</div><div class="m">${tr('加权误差（检验期）· 规则 {f1}%', { f1: f1(rule?.test.wape ?? NaN) })}</div><span class="lab-tag ${learned ? 'learned' : ''}">${learned ? tr('大多数商品族用学到的模型') : tr('继续用规则')}</span></div>`;
  }
  const m = models.find((x) => x.key === sel?.key);
  const unit = target === 'road' ? tr('分钟') : tr('小时');
  return `<div class="lab-card"><div class="k">${title}</div><div class="v">${f1(m?.test.mae ?? NaN)} ${unit}</div><div class="m">${tr('平均误差（检验期）· 规则 {f1} {unit}', { f1: f1(rule?.test.mae ?? NaN), unit })}</div><span class="lab-tag ${learned ? 'learned' : ''}">${learned ? `${tr('用')}${isEn() ? ' ' : ''}${esc(tx(sel?.label.replace(/（.*）$/, '') ?? ''))}` : tr('继续用规则')}</span></div>`;
}

function rows(title: string, models: ModelScore[], picked: string, unit: string, mae: (m: Metric) => string): string {
  return [
    `<tr class="group"><td colspan="6">${title}</td></tr>`,
    ...models.map((m) => `<tr${m.key === picked ? ' class="chosen"' : ''}><td>${m.key === picked ? '<span class="lab-pick">' : ''}${esc(tx(m.label))}${m.key === picked ? '</span>' : ''}${m.rule ? `${isEn() ? ' ' : ''}${tr('（规则）')}` : ''}</td><td>${mae(m.valid)} ${unit}</td><td>${mae(m.test)} ${unit}</td><td>${f1(m.test.wape)}%</td><td>${sgn(m.test.bias)}</td><td>${m.test.n}</td></tr>`),
  ].join('');
}

function render(body: HTMLElement, r: ForecastReport): void {
  const d = r.demand;
  const famBig = [...d.families].sort((a, b) => b.test.actual.reduce((s, x) => s + x, 0) - a.test.actual.reduce((s, x) => s + x, 0));
  const ruleD = d.overall.find((m) => m.rule) as ModelScore;
  const ridgeD = d.overall.find((m) => m.key === 'ridge') as ModelScore;
  const road = r.road;
  const rr = road.models.find((m) => m.key === 'rule') as ModelScore;
  const rRidge = road.models.find((m) => m.key === 'ridge') as ModelScore;
  const rTwin = road.models.find((m) => m.key === 'twin') as ModelScore;
  const legsPerDay = (road.legs.train + road.legs.test) / Math.max(1, road.days.length);
  const v = r.vessel;
  const vRule = v.models.find((m) => m.rule) as ModelScore;
  const vMed = v.models.find((m) => m.key === 'median') as ModelScore;
  const counts = new Map<string, number>();
  for (const f of d.families) counts.set(f.selected, (counts.get(f.selected) ?? 0) + 1);
  body.innerHTML = `
    <div class="lab-cards">
      ${card(tr('门店销量（每天每个商品族）'), r, 'demand')}
      ${card(tr('本店班轮到港晚到'), r, 'vessel')}
      ${card(tr('洲际班列到站晚到'), r, 'train')}
      ${card(tr('配送车路上的用时'), r, 'road')}
    </div>
    <h3>${tr('每个模型的误差')}</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>${tr('模型')}</th><th>${tr('验证期平均误差')}</th><th>${tr('检验期平均误差')}</th><th>${tr('检验期加权误差')}</th><th>${tr('偏差')}</th><th>${tr('检验个数')}</th></tr></thead>
      <tbody>
        ${rows(tr('门店销量（件 / 天；全部商品族合计，「选中」看下面每个商品族）'), d.overall, [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'rule', tr('件'), (m) => f0(m.mae))}
        ${rows(tr('本店班轮到港晚到'), v.models, v.selected, tr('小时'), (m) => f1(m.mae))}
        ${rows(tr('洲际班列到站晚到'), r.train.models, r.train.selected, tr('小时'), (m) => f1(m.mae))}
        ${rows(tr('配送车路上的用时'), road.models, road.selected, tr('分钟'), (m) => f1(m.mae))}
      </tbody>
    </table></div>
    <p class="lab-note">${tr('加权误差 = 误差绝对值之和 ÷ 实际之和；偏差为正 = 估多了。选模型只看验证期，打勾的是选中的。')}</p>
    <div class="lab-grid">
      <div><div class="lab-row"><label>${tr('商品族')} <select class="fc-fam">${famBig.map((f) => `<option value="${f.key}">${esc(tx(f.label))}</option>`).join('')}</select></label></div><div class="fc-chart-demand"></div></div>
      <div class="fc-chart-road"></div>
    </div>
    <details class="lc-table"><summary>${tr('每个商品族选了哪个模型（检验期的加权误差）')}</summary><div class="table-wrap"><table>
      <thead><tr><th>${tr('商品族')}</th><th>${tr('规则')}</th><th>${tr('岭回归')}</th><th>${tr('指数平滑')}</th><th>${tr('选中')}</th></tr></thead>
      <tbody>${d.families.map((f) => `<tr><td>${esc(tx(f.label))}</td>${(['rule', 'ridge', 'hw'] as const).map((k) => `<td${k === f.selected ? ' class="lab-pick"' : ''}>${f1(f.models.find((m) => m.key === k)?.test.wape ?? NaN)}%</td>`).join('')}<td>${esc(tx((f.models.find((m) => m.key === f.selected)?.label ?? '').replace(/（.*）$/, '')))}</td></tr>`).join('')}</tbody>
    </table></div></details>
    <p class="lab-note"><b>${tr('门店销量。')}</b>${tr('规则看不到促销日历，促销那几天总是估少、过后又估多；岭回归把星期几、促销和近 4 周的水平一起学进去，加权误差从 {f1}% 降到 {f12}%（17 个商品族里 {get} 个选了它）。仿真里门店预测设定的误差是期望需求的 ±{f0}%：岭回归对期望需求的误差是 {f13}%，按验证期逐个商品族选的模型是 {f14}%{v7}。就算完全知道期望需求，对实际销量也有 {f15}% 的误差（每天的随机波动），任何模型都消不掉，要靠安全库存。', { f1: f1(ruleD.test.wape), f12: f1(ridgeD.test.wape), get: counts.get('ridge') ?? 0, f0: f0(d.assumed), f13: f1(d.vsExpected.ridge.wape), f14: f1(d.selectedVsExpected.wape), v7: d.selectedVsExpected.wape <= d.assumed + 0.05 ? tr('，这个设定做得到') : tr('，比设定的大，说明设定偏乐观'), f15: f1(d.oracle.wape) })}</p>
    <p class="lab-note"><b>${tr('船期。')}</b>${tr('仿真里每班船的晚到是独立随机的，学到的模型只能学到分布：历史中位数（{f1} 小时）比规划的平均晚到（{f12} 小时）平均误差{v3} {f13}%，但偏低（偏差 {sgn}）；排泊位和拖车按 90% 分位数（{f14} 小时）留余量，检验期 {f0}% 的班次在余量以内。班列{v8}。', { f1: f1(v.median), f12: f1(v.planned * 24), v3: vMed.test.mae <= vRule.test.mae ? tr('小') : tr('大'), f13: f1(Math.abs(((vMed.test.mae - vRule.test.mae) / Math.max(1e-9, vRule.test.mae)) * 100)), sgn: sgn(vMed.test.bias), f14: f1(v.p90), f0: f0(v.coverage * 100), v8: r.train.selected === 'rule' ? tr('的验证期里学到的模型没有比规则准，继续用规则') : tr('用学到的模型') })}</p>
    <p class="lab-note"><b>${tr('路上用时。')}</b>${tr('计划用时比实际平均{v1} {f1}%（高峰时段慢得最多：路网的拥堵表不知道现实比它更堵）。岭回归跨天训练，误差 {f12} 分钟，是计划用时误差的 {f0}%；孪生每天从零学起，一天只有约 {f02} 程可学，学到的偏差太小（误差 {f13} 分钟）{v7}。', { v1: rr.test.bias < 0 ? tr('少') : tr('多'), f1: f1(Math.abs(rr.test.bias)), f12: f1(rRidge.test.mae), f0: f0((rRidge.test.mae / Math.max(1e-9, rr.test.mae)) * 100), f02: f0(legsPerDay), f13: f1(rTwin.test.mae), v7: rRidge.test.mae < rTwin.test.mae ? tr('——可以把跨天训练的系数接进孪生，作为每天开始时的初值') : '' })}</p>`;
  const famSel = body.querySelector('.fc-fam') as HTMLSelectElement;
  const demandEl = body.querySelector('.fc-chart-demand') as HTMLElement;
  let dispose = () => {};
  const drawDemand = () => {
    dispose();
    const f = d.families.find((x) => x.key === famSel.value) ?? famBig[0];
    if (!f) return;
    const t0 = d.window.test;
    const sel = f.models.find((m) => m.key === f.selected);
    dispose = mountLineChart(demandEl, {
      title: tr('{label}：检验期每天的销量和预测', { label: tx(f.label) }),
      subtitle: `${tr('第 {t0}–{days} 天（第 15–18 周），件；选中的是', { t0: t0 + 1, days: d.days })}${isEn() ? ' ' : ''}${tx((sel?.label ?? '').replace(/（.*）$/, ''))}`,
      x: f.test.actual.map((_, i) => tr('第 {t0} 天（周{week}）', { t0: t0 + i + 1, week: WEEK[(t0 + i) % 7] })),
      tick: (i) => ((t0 + i) % 7 === 0 ? tr('第 {t0} 天', { t0: t0 + i + 1 }) : undefined),
      series: [
        { name: tr('实际'), color: 'var(--ink2)', values: f.test.actual },
        { name: tr('岭回归'), color: 'var(--c1)', values: f.test.pred.ridge },
        { name: tr('规则'), color: 'var(--c2)', values: f.test.pred.rule },
        { name: tr('指数平滑'), color: 'var(--c3)', values: f.test.pred.hw },
      ],
      fmt: (x) => f0(x),
      aria: tr('{label}检验期每天的实际销量和三个模型的预测', { label: tx(f.label) }),
    });
  };
  famSel.onchange = drawDemand;
  drawDemand();
  // 从最早到最晚出发的每个小时都占一格，没有车出发的小时空着（只画至少 2 程出发的时段，零星的几程看数据表上面的误差表）
  const busy = road.byHour.filter((h) => h.n >= 2);
  const span = busy.length ? busy : road.byHour;
  const h0 = Math.min(...span.map((h) => h.hour));
  const h1 = Math.max(...span.map((h) => h.hour));
  const hours = Array.from({ length: Math.max(0, h1 - h0 + 1) }, (_, i) => road.byHour.find((h) => h.hour === h0 + i) ?? { hour: h0 + i, n: 0, actual: NaN, ridge: NaN, twin: NaN });
  const val = (x: number) => (Number.isFinite(x) ? x * 100 : null);
  mountLineChart(body.querySelector('.fc-chart-road') as HTMLElement, {
    title: tr('路上用时：实际比计划慢多少（按出发的小时）'),
    subtitle: tr('检验期 {test} 程（第 {testDays}–{testDays2} 天），实际或预测用时 ÷ 计划用时；只画出发至少 2 程的时段', { test: road.legs.test, testDays: road.testDays[0], testDays2: road.testDays[road.testDays.length - 1] }),
    x: hours.map((h) => tr('{hour} 点出发（{n} 程）', { hour: h.hour, n: h.n })),
    tick: (i) => ((hours[i]?.hour ?? 0) % 2 === 0 ? `${hours[i]?.hour ?? ''} ${tr('点')}` : undefined),
    series: [
      { name: tr('实际'), color: 'var(--ink2)', values: hours.map((h) => val(h.actual)), markers: true },
      { name: tr('岭回归'), color: 'var(--c1)', values: hours.map((h) => val(h.ridge)), markers: true },
      { name: tr('计划'), color: 'var(--c2)', values: hours.map(() => 100) },
      { name: tr('孪生学到的'), color: 'var(--c3)', values: hours.map((h) => val(h.twin)), markers: true },
    ],
    fmt: (x) => `${x.toFixed(0)}%`,
    aria: tr('按出发的小时，实际用时、计划用时和两个学到的模型预测的用时（占计划用时的百分比）'),
  });
}
