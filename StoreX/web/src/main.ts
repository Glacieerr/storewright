import { clock, H } from '../../src/core/sim';
import type { DayResult } from '../../src/ops/day';
import type { TraceEvent } from '../../src/ops/trace';
import { kpi } from '../../src/analysis/kpi';
import { lineChart, SERIES } from '../../src/analysis/svg';
import { buildLayout } from '../../src/world/layout';
import { renderAbout } from './about';
import { GROUPS, groupOf, MapView, onDuty } from './render';
import { TraceCursor } from './tracePos';
import type { StoreView3D, Preset as CameraPreset } from './three/view3d';
import { renderReport } from './report';
import { baselineOf, defaults, PRESETS, type Knobs, type Preset } from './scenario';
import type { DayRequest } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ORDERS = [100, 180, 266, 400, 532, 666, 800];
const START = 5 * H;
const END = 23 * H;

// —— 状态 ——
let knobs: Knobs = defaults('storex', 1);
let day: DayResult | undefined;
let base: DayResult | undefined;
let t = 7 * H;
let playing = false;
let speed = 300;
let lastFrame = 0;
let reqId = 0;
const map = new MapView($<HTMLCanvasElement>('map'));
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pending = new Map<number, (r: { result?: DayResult; ms?: number; error?: string }) => void>();
worker.onmessage = (e) => {
  const cb = pending.get(e.data.id);
  pending.delete(e.data.id);
  cb?.(e.data);
};
function simulate(k: Knobs, trace: boolean): Promise<{ result: DayResult; ms: number }> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => (r.result ? resolve({ result: r.result, ms: r.ms ?? 0 }) : reject(new Error(r.error))));
    worker.postMessage({ id, knobs: k, trace } satisfies DayRequest);
  });
}

// —— 控件 ——
const presetBox = $('preset');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.dataset.preset = p.key;
  b.setAttribute('aria-pressed', String(p.key === knobs.preset));
  b.onclick = () => {
    knobs = defaults(p.key as Preset, knobs.seed);
    syncControls();
    void run();
  };
  presetBox.append(b);
}
const ordersSel = $<HTMLSelectElement>('orders');
for (const v of ORDERS) ordersSel.add(new Option(`${v}`, `${v}`));
const num = (id: string) => $<HTMLInputElement>(id);
const chk = (id: string) => $<HTMLInputElement>(id);

function syncControls(): void {
  for (const b of presetBox.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.preset === knobs.preset));
  num('seed').value = String(knobs.seed);
  ordersSel.value = String(knobs.orders);
  const sx = knobs.preset !== 'gen1';
  for (const id of ['bots', 'amr', 'carts', 'gates']) {
    num(id).value = String(knobs[id as 'bots']);
    num(id).disabled = !sx;
  }
  chk('outage').checked = knobs.outage;
  chk('fallback').checked = knobs.fallback;
  chk('surge').checked = knobs.surge;
  chk('outage').disabled = !sx;
  chk('fallback').disabled = !sx || !knobs.outage;
}

function readControls(): void {
  knobs.seed = Math.max(1, Math.min(9999, Math.round(Number(num('seed').value) || 1)));
  knobs.orders = Number(ordersSel.value);
  if (knobs.preset !== 'gen1') {
    knobs.bots = clampInt(num('bots').value, 0, 40);
    knobs.amr = clampInt(num('amr').value, 0, 8);
    knobs.carts = clampInt(num('carts').value, 0, 6);
    knobs.gates = clampInt(num('gates').value, 0, 8);
    knobs.outage = chk('outage').checked;
    knobs.fallback = chk('fallback').checked;
  }
  knobs.surge = chk('surge').checked;
  chk('fallback').disabled = knobs.preset === 'gen1' || !knobs.outage;
}
const clampInt = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

$('run').onclick = () => {
  readControls();
  void run();
};
$('dice').onclick = () => {
  knobs.seed = 1 + Math.floor(Math.random() * 9999);
  num('seed').value = String(knobs.seed);
  readControls();
  void run();
};
chk('outage').onchange = () => readControls();

// —— 运行一天 ——
async function run(): Promise<void> {
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  $('busy').hidden = false;
  $('busy-text').textContent = `正在仿真这一天（${PRESETS.find((p) => p.key === knobs.preset)?.label}，第 ${knobs.seed} 天）…`;
  const wasPlaying = playing;
  setPlaying(false);
  try {
    const k = { ...knobs };
    const [main, cmp] = await Promise.all([simulate(k, true), k.preset === 'gen1' ? Promise.resolve(undefined) : simulate(baselineOf(k), false)]);
    day = main.result;
    base = cmp?.result;
    const layout = buildLayout(day.generation);
    map.setLayout(layout);
    map.setAgents(day.trace?.agents ?? []);
    counter = new TraceCursor(day.trace?.agents ?? []);
    events = day.trace?.events ?? [];
    if (view3d) {
      view3d.setLayout(layout);
      view3d.setAgents(day.trace?.agents ?? []);
      renderPresets();
    }
    $('clock-note').textContent = `仿真 ${fmt(main.ms / 1000, 1)} 秒 · ${fmt(day.events / 1000, 0)} 千个事件`;
    renderSummary();
    renderHourly();
    renderLegend();
    if (t < START || t > END) t = 7 * H;
    drawFrame();
    if (wasPlaying || !hasPlayed) setPlaying(true);
    hasPlayed = true;
  } catch (err) {
    $('busy-text').textContent = `仿真出错：${String(err)}`;
    return;
  } finally {
    btn.disabled = false;
  }
  $('busy').hidden = true;
}
let hasPlayed = false;
let counter = new TraceCursor([]);

// —— 二维 / 三维 ——
let view: '2d' | '3d' = new URLSearchParams(location.search).get('view') === '3d' ? '3d' : '2d';
let view3d: StoreView3D | undefined;
let presetLabels: Record<CameraPreset, string> | undefined;
let events: TraceEvent[] = [];

// —— 播放 ——
const playBtn = $<HTMLButtonElement>('play');
const timeInput = $<HTMLInputElement>('time');
function setPlaying(on: boolean): void {
  playing = on;
  playBtn.textContent = on ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', on ? '暂停' : '播放');
  if (on) {
    lastFrame = performance.now();
    requestAnimationFrame(loop);
  }
}
playBtn.onclick = () => {
  if (!playing && t >= END - 60) t = 7 * H;
  setPlaying(!playing);
};
timeInput.oninput = () => {
  t = Number(timeInput.value);
  drawFrame();
};
$<HTMLSelectElement>('speed').onchange = (e) => (speed = Number((e.target as HTMLSelectElement).value));
function loop(now: number): void {
  if (!playing) return;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  t = Math.min(END, t + dt * speed);
  drawFrame();
  if (t >= END) setPlaying(false);
  else requestAnimationFrame(loop);
}

let lastPanel = -1;
function drawFrame(): void {
  if (view === '3d' && view3d) view3d.setTime(t);
  else map.draw(t);
  timeInput.value = String(Math.round(t));
  const c = clock(t);
  $('time-label').textContent = c;
  $('clock').textContent = c;
  // 面板每模拟 1 分钟更新一次就够了
  const minute = Math.floor(t / 60);
  if (minute !== lastPanel) {
    lastPanel = minute;
    renderLive();
    renderLog();
  }
}

// —— 面板 ——
function renderLive(): void {
  if (!day) return;
  const orders = day.orders ?? [];
  const ready = orders.filter((o) => o.readyAt <= t).length;
  const done = orders.filter((o) => o.doneAt <= t).length;
  const waiting = orders.filter((o) => o.mode !== 'delivery' && o.waitMin > 0 && o.doneAt - o.waitMin * 60 <= t && t < o.doneAt).length;
  const agents = day.trace?.agents ?? [];
  const staff = agents.filter((a) => a.on && onDuty(a.on, t)).length;
  let robotsBusy = 0;
  let shoppers = 0;
  agents.forEach((a, i) => {
    const p = counter.pose(i, t);
    if (!p) return;
    if (a.kind === 'shopper') shoppers++;
    else if (p.busy && p.act && !a.on && groupOf(a.kind).shape === 'square') robotsBusy++;
  });
  const outIdx = Math.max(0, Math.min(day.hourly.shelfOut.length - 1, Math.floor((t - 7 * H) / 900)));
  const out = t < 7 * H ? 0 : (day.hourly.shelfOut[outIdx] ?? 0);
  const tiles: [string, string][] = [
    [`${ready} / ${orders.length}`, '线上订单已备好'],
    [`${done}`, '已交付 / 装车'],
    [`${waiting}`, '正在等货的顾客'],
    [`${shoppers}`, '店里的顾客'],
    [`${staff}`, '在岗员工'],
    [`${robotsBusy}`, '在干活的机器人'],
    [`${out}`, '空着的货架（商品数）'],
    [`${day.robots.total}`, '机器人（台）'],
  ];
  $('live').innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
}

const SUMMARY_KPIS = ['wait', 'waitP95', 'laborMinPerOrder', 'paid', 'oos', 'freshWaste', 'gridKwh', 'total$'];
function renderSummary(): void {
  if (!day) return;
  const rows = SUMMARY_KPIS.map((key) => {
    const k = kpi(key);
    const v = k.get(day as DayResult);
    let delta = '';
    let cls = '';
    if (base) {
      const b = k.get(base);
      const pct = b !== 0 ? ((v - b) / Math.abs(b)) * 100 : 0;
      delta = `${pct > 0 ? '+' : ''}${fmt(pct, 0)}%`;
      if (Math.abs(pct) >= 1 && k.better !== 'none') cls = (pct < 0) === (k.better === 'lower') ? 'good' : 'bad';
    }
    return `<span class="k">${k.label}</span><span class="v">${fmt(v, k.digits ?? 1)}<small> ${k.unit}</small></span><span class="delta ${cls}">${delta}</span>`;
  });
  const head = base ? `<span class="head">指标</span><span class="head" style="text-align:right">这一天</span><span class="head" style="text-align:right">比上一代</span>` : '';
  $('summary').innerHTML = head + rows.join('');
}

function renderLegend(): void {
  if (!day) return;
  const agents = day.trace?.agents ?? [];
  $('legend').innerHTML = '';
  for (const g of GROUPS) {
    const n = agents.filter((a) => g.kinds.includes(a.kind)).length;
    if (!n) continue;
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', String(!map.hidden.has(g.key)));
    b.innerHTML = `<span class="mark ${g.shape}" style="background:var(${g.color})"></span><span>${g.label}</span><span class="count">${n}</span>`;
    b.onclick = () => {
      if (map.hidden.has(g.key)) map.hidden.delete(g.key);
      else map.hidden.add(g.key);
      b.setAttribute('aria-pressed', String(!map.hidden.has(g.key)));
      if (view3d) {
        view3d.agents.hidden = new Set(map.hidden);
        view3d.invalidate();
      }
      drawFrame();
    };
    $('legend').append(b);
  }
}

let logIdx = 0;
function renderLog(): void {
  // 二分找到 t 之前的最后一条
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as TraceEvent).t <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === logIdx && $('log').childElementCount) return;
  logIdx = lo;
  const recent = events.slice(Math.max(0, lo - 14), lo).reverse();
  $('log').innerHTML = recent.map((e) => `<li><time>${clock(e.t)}</time><span>${esc(e.text)}</span></li>`).join('') || '<li><span>还没有动静</span></li>';
}

function renderHourly(): void {
  if (!day) return;
  const hours = Array.from({ length: 18 }, (_, i) => i + 5);
  const name = PRESETS.find((p) => p.key === knobs.preset)?.label ?? '';
  const series = (f: (r: DayResult) => number[], digits: number) => [
    ...(base ? [{ name: '上一代（同一天）', color: SERIES.gen1, values: hours.map((h) => f(base as DayResult)[h] ?? 0) }] : []),
    { name, color: knobs.preset === 'gen1' ? SERIES.gen1 : SERIES.storex, values: hours.map((h) => f(day as DayResult)[h] ?? 0) },
  ].map((s) => ({ ...s, values: s.values.map((v) => Number(v.toFixed(digits + 1))) }));
  const charts = [
    lineChart({ title: '每小时在岗的员工', subtitle: '人（不含夜班和固定岗位）', x: hours.map(String), digits: 0, series: series((r) => r.hourly.staffOnDuty, 0) }),
    lineChart({ title: '每小时交付的线上订单', subtitle: '单', x: hours.map(String), digits: 0, series: series((r) => r.hourly.ordersDone, 0) }),
    lineChart({ title: '自提顾客的平均等待', subtitle: '分钟，按交付时刻', x: hours.map(String), digits: 1, series: series((r) => r.hourly.pickupWait, 1) }),
  ];
  $('hourly').innerHTML = charts.map((svg, i) => `<img alt="${['每小时在岗的员工', '每小时交付的线上订单', '自提顾客的平均等待'][i]}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`).join('');
}

// —— 鼠标悬停：显示是谁、在做什么 ——
async function setView(v: '2d' | '3d'): Promise<void> {
  view = v;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#view-switch button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  $('map').hidden = v === '3d';
  $('view3d').hidden = v !== '3d';
  $('toolbar3d').hidden = v !== '3d';
  if (v === '3d') {
    if (!view3d) {
      const mod = await import('./three/view3d');
      presetLabels = mod.PRESET_LABELS;
      view3d = new mod.StoreView3D($('view3d'));
      view3d.agents.hidden = new Set(map.hidden);
      view3d.onHover = (p) => {
        if (!p) {
          tip.hidden = true;
          return;
        }
        tip.hidden = false;
        tip.innerHTML = `<b>${esc(p.agent.label)}</b>${esc(p.act ?? '待命')}`;
        tip.style.left = `${Math.min($('view3d').clientWidth - 170, p.x + 14)}px`;
        tip.style.top = `${p.y + 14}px`;
      };
      if (day) {
        view3d.setLayout(buildLayout(day.generation));
        view3d.setAgents(day.trace?.agents ?? []);
      }
      renderPresets();
    }
    view3d.setTime(t);
    view3d.show();
  } else {
    view3d?.hide();
    map.resize();
  }
  drawFrame();
}

/** 三维工具条：视角按方案变（上一代没有货格仓和自提中心，有暂存间） */
function renderPresets(): void {
  if (!view3d || !presetLabels || !day) return;
  const list: CameraPreset[] = day.generation === 'gen1' ? ['overview', 'staging', 'floor', 'checkout'] : ['overview', 'mfc', 'hub', 'floor', 'checkout'];
  const box = $('presets3d');
  box.innerHTML = '';
  for (const p of list) {
    const b = document.createElement('button');
    b.textContent = (presetLabels as Record<CameraPreset, string>)[p];
    b.onclick = () => view3d?.focus(p);
    box.append(b);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#view-switch button')) b.onclick = () => void setView(b.dataset.view as '2d' | '3d');
$('mode3d').onclick = () => {
  const ext = $('mode3d').getAttribute('aria-pressed') !== 'true';
  $('mode3d').setAttribute('aria-pressed', String(ext));
  view3d?.setMode(ext ? 'exterior' : 'cutaway');
};
$('labels3d').onclick = () => {
  const on = $('labels3d').getAttribute('aria-pressed') !== 'true';
  $('labels3d').setAttribute('aria-pressed', String(on));
  view3d?.setLabels(on);
};
$('export3d').onclick = async () => {
  if (!view3d) return;
  const blob = await view3d.exportGlb();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `storex-${day?.generation ?? 'store'}-${clock(t).replace(':', '')}.glb`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

const tip = $('tip');
$('map').addEventListener('mousemove', (e) => {
  const p = map.hit(e.clientX, e.clientY);
  if (!p) {
    tip.hidden = true;
    return;
  }
  const box = $('map').getBoundingClientRect();
  tip.hidden = false;
  tip.innerHTML = `<b>${esc(p.agent.label)}</b>${esc(p.act ?? '待命')}`;
  tip.style.left = `${Math.min(box.width - 160, e.clientX - box.left + 14)}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
});
$('map').addEventListener('mouseleave', () => (tip.hidden = true));

// —— 标签页 ——
const rendered = new Set<string>(['twin']);
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.onclick = () => {
    const tab = b.dataset.tab as string;
    for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== `tab-${tab}`;
    if (!rendered.has(tab)) {
      rendered.add(tab);
      if (tab === 'report') renderReport($('tab-report'));
      if (tab === 'about') renderAbout($('tab-about'));
    }
    if (tab === 'twin') map.resize();
    if (tab !== 'twin') setPlaying(false);
    history.replaceState(null, '', tab === 'twin' ? location.pathname : `#${tab}`);
  };
}
if (location.hash === '#report' || location.hash === '#about') document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();

// —— 尺寸和配色变化 ——
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    map.resize();
    drawFrame();
  }, 120);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  map.resize();
  drawFrame();
});

function fmt(x: number, d: number): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, '−');
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

syncControls();
void run();
if (view === '3d') void setView('3d');
