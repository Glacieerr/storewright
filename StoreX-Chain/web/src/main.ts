import '../../../StoreX/web/src/styles.css';
import './styles.css';
import './weather.css';
import * as THREE from 'three';
import { lineChart, SERIES } from '../../../StoreX/src/analysis/svg';
import { buildLayout } from '../../../StoreX/src/world/layout';
import { TraceCursor } from '../../../StoreX/web/src/tracePos';
import type { AgentTrace } from '../../../StoreX/src/ops/trace';
import { kpi } from '../../src/analysis/kpi';
import { setRegion, STORE } from '../../src/region/network';
import { regionSpecFrom, regionSpecText, type RegionSpec } from '../../src/region/regionGen';
import { RegionDialog } from './regionDialog';
import { applyFacilities, defaultFacilities, isDefault, laborCost, type Facilities } from '../../src/facility/config';
import { setFacilities } from '../../src/facility/state';
import { TRACE_DAY } from '../../src/analysis/studies';
import { applyFix, buildBoard, type Board, type BoardOp, type DayKpi } from '../../src/sim/board';
import { SCALE_NOTE } from '../../src/region/scale';
import { GEN_LABEL, LOAD_LABEL, LOADS, scenarioFor, withLoad, type ChainScenario, type Gen, type LoadLevel } from '../../src/sim/config';
import { allocationHour, dayIsEmpty, earliestDepart, emptyDay, hhmm, samePlan, standingOf, type DayPlan, type StandingPlan } from '../../src/sim/plan';
import { Dispatch, type CompareRow } from './dispatch';
import type { ChainResult } from '../../src/sim/engine';
import type { WEvent, WVehicle } from '../../src/sim/trace';
import raw from './data/results.json';
import { LoopPanel, type LoopData, type LoopView } from './loopPanel';
import { AssistantPanel } from './assistantPanel';
import { KpiPanel } from './kpiPanel';
import { LEVEL_LABEL, ownerText } from '../../src/assistant/kpiBoard';
import { dayClock, fromTrack, kpiAt, twinSnap } from '../../src/assistant/context';
import { cardProposal, statusAt } from '../../src/assistant/brief';
import type { AssistCtx, FacKey as AssistFac, FacSnap, VehRow } from '../../src/assistant/types';
import type { HubDay } from '../../src/hub/types';
import { placeResolver as resolveDoors } from '../../src/hub/doors';
import { storeYardOf } from '../../src/hub/storeDay';
import { jobFromBoard } from '../../src/site/trucks';
import type { LoopPlan, LoopRequest } from './loopWorker';
import type { LoopResult } from '../../src/twin/loop';
import type { UserDecision } from '../../src/twin/types';
import { decorVehicles } from './decor';
import { TrackPanel } from './trackPanel';
import { FacilityPanel, type FacData, type FacTab } from './facilityPanel';
import type { FacilityAdmin, FacKey } from './facilityAdmin';
import { FAMILIES } from '../../src/region/products';
import type { OpStop } from '../../src/sim/trace';
import { clock as tclock, trackRow, type TrackCtx, type TrackRow } from './tracking';
import { DRILLS, type Drill } from './drills';
import type { StoreRequest } from './storeWorker';
import { doorPlace } from '../../src/hub/doors';
import { REGION_PRESETS, RegionView, type Hover } from './three/view';
import type { SplitPair, SplitSide } from './three/split';
import { VKIND_COLOR, VKIND_LABEL, type VKind } from './three/vehicles';
import { WEATHER_LABEL, WEATHER_MODES, type WeatherMode } from './three/weather';
import { QUALITY_MODES, TIER_LABEL, type QualityMode, type QualityTier } from './three/quality';
import type { ChainRequest } from './worker';
import { initI18n, t as tr, tx } from './i18n';
import './lang.css';
import { setAppApi } from './appBus';
import { TourPlayer } from './tour';
import { facilitiesDiff, hasScenarioParams, mergeFacilities, mergeScenario, scenarioFromSearch, scenarioUrl, SCENARIO_FORMAT, SCENARIO_VERSION, type Scenario } from '../../src/scenario';
import type { TeachState } from '../../src/teach/types';
import { loadLibraryScenario, mountScenarioUi, showIssues, toast } from './scenarioUi';
import { mountOnboarding, onboardAuto } from './onboard';
import { mountTeachHost } from './teachHost';

initI18n();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/^-/, '−') : '—');
const clock = (t: number) => {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.floor(t / 60)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const GENS: Gen[] = ['g1', 'g2', 'g3'];
const DAY_END = 24 * 3600 - 60;
const ref = raw as unknown as { seeds: { compare: number }; gens: { gen: Gen; mean: Record<string, number> }[] };

// —— 状态 ——
let gen: Gen = 'g3';
let drill: Drill = 'none';
/** 负荷档位（压力测试）：平常 = 基线 */
let load: LoadLevel = 'normal';
/** 当前方案、日子、负荷下的场景 */
const scen = (g: Gen, sd: number): ChainScenario => applyFacilities(withLoad(scenarioFor(g, sd), load), facilities);
let seed = 1;
let result: ChainResult | undefined;
let own = 0;
/** 侧栏计数用的游标（和三维视图各走各的，不用等下一帧） */
let counter = new TraceCursor([], () => true);
let events: WEvent[] = [];
let t = 3 * 3600;
let playing = false;
let speed = 600;
let lastFrame = 0;
let hasPlayed = false;

// 区域：网页地址里的 ?region=（默认区域、random-编号、自定义的写法）；换区域要重建整个三维场景，所以换了就重新载入页面
const region = regionSpecFrom(new URLSearchParams(location.search).get('region'));
setRegion(region);
// 场景参数（分享链接、场景库、练习；src/scenario）：网址里有就先读出来。设施以网址为准（不读、也不覆盖本机存的管理台配置）；
// 方案、种子、负荷、演练在第一次仿真前设好，时刻、镜头这些等仿真跑完再套用（见文件末尾的 boot）
const urlScen = hasScenarioParams(location.search) ? scenarioFromSearch(location.search, location.hash) : undefined;
// 设施配置（管理台里改的布局、设备、排班）：存在本机浏览器里，打开网页时先套上
const FAC_KEY = 'storex-chain-facilities';
let facilities: Facilities = defaultFacilities();
try {
  const saved = urlScen?.scenario ? null : localStorage.getItem(FAC_KEY);
  if (urlScen?.scenario) facilities = mergeFacilities(defaultFacilities(), urlScen.scenario.facilities);
  if (saved) {
    // 每个设施按字段合并到默认值上：旧版本存的配置缺新加的字段（泊位、机位、装卸线）时用默认值
    const s = JSON.parse(saved) as Partial<Facilities>;
    const d = defaultFacilities();
    facilities = { port: { ...d.port, ...s.port }, airport: { ...d.airport, ...s.airport }, dc: { ...d.dc, ...s.dc }, store: { ...d.store, ...s.store } };
  }
} catch {
  facilities = defaultFacilities();
}
setFacilities(facilities);
const facReq = () => (isDefault(facilities) ? {} : { facilities });
const view = new RegionView($('view'));
view.setStoreLayout(buildLayout('storex'));
view.show();

// —— 后台线程：全链路仿真、综合店的门店仿真（StoreX 门店模型） ——
const chainWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const storeWorker = new Worker(new URL('./storeWorker.ts', import.meta.url), { type: 'module' });
const loopWorker = new Worker(new URL('./loopWorker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map<number, (d: Record<string, unknown>) => void>();
for (const w of [chainWorker, storeWorker, loopWorker]) {
  w.onmessage = (e) => {
    const cb = pending.get(e.data.id);
    pending.delete(e.data.id);
    cb?.(e.data);
  };
}
function call<T>(w: Worker, msg: Record<string, unknown>): Promise<T> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, (d) => (d.error ? reject(new Error(String(d.error))) : resolve(d as T)));
    w.postMessage({ ...msg, id });
  });
}

// —— 控件 ——
const genBox = $('gen');
for (const g of GENS) {
  const b = document.createElement('button');
  b.textContent = tx(GEN_LABEL[g]);
  b.dataset.gen = g;
  b.setAttribute('aria-pressed', String(g === gen));
  b.onclick = () => {
    gen = g;
    for (const x of genBox.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    void run();
  };
  genBox.append(b);
}
// 区域：默认 / 随机生成 / 自定义 + 编号；「随机」换一个编号，「自定义…」指定每一项，「生成」按新区域重建（重新载入页面）
const regionMode = $<HTMLSelectElement>('region-mode');
regionMode.value = region.mode;
const regionSeed = $<HTMLInputElement>('region-seed');
regionSeed.value = String(region.seed);
const goRegion = (spec: RegionSpec) => {
  const q = new URLSearchParams(location.search);
  q.delete('city');
  if (spec.mode === 'default') q.delete('region');
  else q.set('region', regionSpecText(spec));
  location.search = q.toString();
};
const seedOf = () => Math.max(1, Math.min(999999, Math.round(Number(regionSeed.value)) || 1));
const regionDlg = new RegionDialog($('region-dlg'), region, (spec) => goRegion(spec));
$('region-go').onclick = () => (regionMode.value === 'custom' ? regionDlg.open(seedOf()) : goRegion({ mode: regionMode.value as RegionSpec['mode'], seed: seedOf() }));
$('region-dice').onclick = () => goRegion({ mode: regionMode.value === 'custom' ? 'custom' : 'random', seed: 1 + Math.floor(Math.random() * 99999), ...(regionMode.value === 'custom' ? { options: region.options ?? {} } : {}) });
$('region-edit').onclick = () => regionDlg.open(seedOf());
const loadSel = $<HTMLSelectElement>('load');
for (const k of Object.keys(LOADS) as LoadLevel[]) {
  const L = LOADS[k];
  loadSel.add(new Option(k === 'normal' ? tr('{load}（基线）', { load: tx(LOAD_LABEL[k]) }) : tr('{load} · 需求 ×{demand}，班轮 {calls} 班 / 周，航班 {flights} 班 / 天', { load: tx(LOAD_LABEL[k]), demand: L.demand, calls: L.calls, flights: L.flights }), k));
}
loadSel.onchange = () => {
  load = loadSel.value as LoadLevel;
  void run();
};
const drillSel = $<HTMLSelectElement>('drill');
for (const d of DRILLS) drillSel.add(new Option(tx(d.label), d.key));
drillSel.onchange = () => {
  drill = drillSel.value as Drill;
  view.setWeatherDrill(drill);
  void run();
};
const seedInput = $<HTMLInputElement>('seed');
$('run').onclick = () => {
  seed = Math.max(1, Math.min(9999, Math.round(Number(seedInput.value) || 1)));
  void run();
};
$('dice').onclick = () => {
  seed = 1 + Math.floor(Math.random() * 9999);
  seedInput.value = String(seed);
  void run();
};
function renderHint(): void {
  const d = DRILLS.find((x) => x.key === drill);
  const who: Record<Gen, string> = {
    g1: tr('上一代：Storewright 的门店 + 传统供应链（按温区分开送、固定线路、看门店订单补货）'),
    g2: tr('StoreX：门店升级成 StoreX，上游和上一代一样'),
    g3: tr('StoreX 全链路：门店 + 上游由全链路孪生协同（共享销售数据、多温区合并配送、自动化配送中心、铁路、预清关）'),
  };
  $('hint').textContent = tr('{who}。动画是第 {traceDay} 天{v3}{v4}。', { who: who[gen], traceDay: TRACE_DAY, v3: load !== 'normal' ? tr('，负荷：{load}（需求 ×{demand}、班轮每周 {calls} 班、航班每天 {flights} 班、别家流量 ×{traffic}）', { load: tx(LOAD_LABEL[load]), demand: LOADS[load].demand, calls: LOADS[load].calls, flights: LOADS[load].flights, traffic: LOADS[load].traffic }) : '', v4: d && d.key !== 'none' ? tr('，演练：{detail}', { detail: tx(d.detail) }) : '' });
}

const presetBox = $('presets');
/** 视角 ↔ 设施监控的页 */
const PRESET_TAB: Partial<Record<string, FacTab>> = { overview: 'group', port: 'port', airport: 'air', dc: 'dc', flagship: 'store' };
const TAB_PRESET = { group: 'overview', port: 'port', air: 'airport', dc: 'dc', store: 'flagship' } as const;
for (const p of REGION_PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.onclick = () => {
    view.focus(p.key);
    const tab = PRESET_TAB[p.key];
    if (tab) showFacility(tab);
  };
  presetBox.append(b);
}
$('monitors').onclick = () => {
  const on = $('monitors').getAttribute('aria-pressed') !== 'true';
  $('monitors').setAttribute('aria-pressed', String(on));
  view.setMonitors(on);
};
// —— 天气（只改画面）和画质（自动按帧时间升降档）：选择存在本机浏览器里 ——
const WEATHER_KEY = 'storex-chain-weather';
const QUALITY_KEY = 'storex-chain-quality';
const weatherSel = $<HTMLSelectElement>('weather');
for (const m of WEATHER_MODES) weatherSel.add(new Option(WEATHER_LABEL[m], m));
const qualitySel = $<HTMLSelectElement>('quality');
for (const m of QUALITY_MODES) qualitySel.add(new Option(m === 'auto' ? tr('自动') : TIER_LABEL[m], m));
const showQuality = (tier: QualityTier, mode: QualityMode) => {
  (qualitySel.options[0] as HTMLOptionElement).text = tr('自动（{tier}）', { tier: TIER_LABEL[tier] });
  qualitySel.value = mode;
};
view.onQuality = showQuality;
try {
  const w = localStorage.getItem(WEATHER_KEY) as WeatherMode | null;
  if (w && WEATHER_MODES.includes(w)) weatherSel.value = w;
  const q = localStorage.getItem(QUALITY_KEY) as QualityMode | null;
  if (q && QUALITY_MODES.includes(q)) qualitySel.value = q;
} catch {
  /* 读不了就用自动 */
}
view.setWeather(weatherSel.value as WeatherMode);
view.setWeatherDrill(drill);
showQuality(view.setQuality(qualitySel.value as QualityMode), qualitySel.value as QualityMode);
weatherSel.onchange = () => {
  view.setWeather(weatherSel.value as WeatherMode);
  try {
    localStorage.setItem(WEATHER_KEY, weatherSel.value);
  } catch {
    /* 存不了就只在这次有效 */
  }
  renderWeather(true);
};
qualitySel.onchange = () => {
  showQuality(view.setQuality(qualitySel.value as QualityMode), qualitySel.value as QualityMode);
  try {
    localStorage.setItem(QUALITY_KEY, qualitySel.value);
  } catch {
    /* 存不了就只在这次有效 */
  }
};
let lastWeather = -1;
/** 时钟旁边写此刻的天气和能见度（每仿真 10 分钟更新一次） */
function renderWeather(force = false): void {
  const k = Math.floor(t / 600);
  if (!force && k === lastWeather) return;
  lastWeather = k;
  const w = view.weatherInfo();
  const vis = w.visKm >= 10 ? tr('10 公里以上') : `${w.visKm.toFixed(w.visKm < 2 ? 1 : 0)} ${tr('公里')}`;
  $('clock-weather').textContent = `${tr('{name} · 能见度 {vis}', { name: w.name, vis })}${w.mode === 'auto' ? '' : tr('（手动）')}`;
}
// 对比回放：开的时候默认比「现场 · 用孪生 ↔ 不用孪生」（闭环还没跑完就比另一天），关的时候三维回到原来的视图
$('split').onclick = () => {
  const on = $('split').getAttribute('aria-pressed') !== 'true';
  $('split').setAttribute('aria-pressed', String(on));
  // 两边的跟踪、设施面板会把半边画面挡掉一大块：对比时先收起来，关掉对比再展开
  const panels = ['track', 'facility'].map((id) => $(id));
  if (on) {
    splitPrevView = loopView;
    splitFolded = panels.filter((el) => !el.classList.contains('collapsed'));
    for (const el of splitFolded) el.querySelector<HTMLButtonElement>('[data-min]')?.click();
    void setSplit(loopData ? 'loop' : 'days', splitSeed === seed ? seed + 1 : splitSeed);
  } else {
    splitPair = undefined;
    splitTrack = undefined;
    view.setSplit(undefined);
    for (const el of splitFolded) if (el.classList.contains('collapsed')) el.querySelector<HTMLButtonElement>('[data-min]')?.click();
    splitFolded = [];
    if (loopView !== splitPrevView) {
      loopView = splitPrevView;
      loopPanel.setView(loopView);
      applyLoopView();
    }
  }
};
view.onSplitPair = (pair, sd) => void setSplit(pair, sd);
$('tags').onclick = () => {
  const on = $('tags').getAttribute('aria-pressed') !== 'true';
  $('tags').setAttribute('aria-pressed', String(on));
  view.setTagsVisible(on);
};
$('labels').onclick = () => {
  const on = $('labels').getAttribute('aria-pressed') !== 'true';
  $('labels').setAttribute('aria-pressed', String(on));
  view.setLabels(on);
};
$('planmap').onclick = () => {
  const on = $('planmap').getAttribute('aria-pressed') !== 'true';
  $('planmap').setAttribute('aria-pressed', String(on));
  view.setPlanMap(on);
};
$('export').onclick = async () => {
  const btn = $<HTMLButtonElement>('export');
  btn.disabled = true;
  btn.textContent = tr('正在导出…');
  try {
    const blob = await view.exportGlb();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `storex-chain-${gen}-${clock(t).replace(':', '')}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = tr('导出 .glb');
  }
};

// —— 调度台：当天的全部作业、常规计划和当天调度 ——
/** 三代的时刻表不一样：常规计划和当天调度按方案分开存 */
const standingByGen = new Map<Gen, StandingPlan>();
const dayByGen = new Map<Gen, DayPlan>();
const defaultsOf = (g: Gen) => standingOf(scenarioFor(g, 1));
const standingFor = (g: Gen) => standingByGen.get(g) ?? defaultsOf(g);
const dayFor = (g: Gen) => dayByGen.get(g) ?? emptyDay();
/** 原计划（什么都没改）的结果：改了计划以后拿来比 */
const baseline = new Map<string, { result: ChainResult; kpi: DayKpi }>();
const runKey = () => `${gen}:${seed}:${drill}:${load}`;
let vehicleList: WVehicle[] = [];
let selectedOp: string | undefined;
/** 车辆下标 → 作业（调度台）；现场视图里三维下标 → 现场车辆编号 */
let opByVehicle = new Map<number, BoardOp>();
let fieldVid = new Map<number, number>();

// —— 闭环孪生：现场 → 感知 → 孪生 → 决策 → 指令 → 现场 ——
let loopData: LoopData | undefined;
let loopView: LoopView = 'plan';
let loopDecisions: UserDecision[] = [];
/** 三维里画的车（现场视图时把现场改过的车换进去、新派的车接在后面），下标 → 作业编号 */
let shownList: WVehicle[] = [];
const loopPanel = new LoopPanel($('loop'), {
  onSettings: () => {
    loopDecisions = [];
    void runTwin(true);
  },
  onDecision: (d) => {
    // 按角色走：调度员能直接执行低风险的和便宜的，更贵的提交审批（值班助手面板里批）
    const r = loopData?.closed.recs.find((x) => x.key === d.key);
    if (r && !assistant.gate(cardProposal(r, d.option, d.action === 'reject'), tr('闭环面板的建议卡'))) return;
    loopDecisions = [...loopDecisions.filter((x) => x.key !== d.key), d];
    void runTwin(false);
  },
  onUndo: () => {
    loopDecisions = [];
    void runTwin(false);
  },
  onView: (v) => {
    // 对比回放开着：按钮换的是左边，对比的两边跟着换（计划 → 计划 ↔ 现场，比另一天时不变；
    // 现场 · 用孪生 → 用孪生 ↔ 不用孪生；现场 · 不用孪生 → 不用孪生 ↔ 用孪生），标题跟着换
    if (splitPair) {
      void setSplit(v === 'plan' ? (splitPair === 'days' ? 'days' : 'planField') : v === 'open' ? 'loopOpen' : 'loop', splitSeed);
      return;
    }
    loopView = v;
    applyLoopView();
  },
  onVehicle: (vid) => showFieldVehicle(vid),
  setTime: (sec) => {
    t = sec;
    drawFrame(true);
  },
});

/** 看现场的一辆车（闭环面板、值班助手）：跟踪面板和调度台选中它，三维切到现场视图 */
function showFieldVehicle(vid: number): void {
  {
    const shownIdx = [...fieldVid.entries()].find(([, v]) => v === vid)?.[0] ?? vid;
    trackPanel.select(shownIdx);
    const op = board?.ops.find((o) => o.vehicle === vid);
    if (op) {
      selectedOp = op.id;
      dispatch.selectByVehicle(vid);
      showSelection(op, true);
    } else view.setFollow(vid);
    if (loopView === 'plan') {
      loopView = 'closed';
      loopPanel.setView('closed');
      applyLoopView();
    }
  }
}

// —— 值班助手：问问题、看风险、提议（确认后执行）、角色和审批、交接班报告、建议复盘 ——
let docs: { title: string; text: string }[] | undefined;
/** 资料库：设计文档按需加载（单独的一块，不拖慢首屏） */
function loadDocs(): void {
  if (docs) return;
  docs = [];
  void Promise.all([import('../../docs/01-planning-report.md?raw'), import('../../docs/02-generation-comparison.md?raw'), import('../../docs/03-business-analysis.md?raw'), import('../../docs/04-system-design.md?raw')])
    .then(([a, b, c, d]) => {
      docs = [
        { title: tr('规划报告'), text: a.default },
        { title: tr('三代对比'), text: b.default },
        { title: tr('商业分析'), text: c.default },
        { title: tr('系统设计'), text: d.default },
      ];
    })
    .catch(() => {
      docs = [];
    });
}
/** 现场的每辆车此刻的跟踪信息（闭环跑完了按现场：延误、孪生估计的到达；没跑完按计划） */
function assistRows(): VehRow[] {
  const r = loopData?.closed;
  if (!r) return lastRows.map(fromTrack);
  const list = [...vehicleList];
  const vidOf = new Map<number, number>();
  r.vids.forEach((vid, k) => {
    let i = vid;
    if (vid >= own) {
      i = list.length;
      list.push({ ...(r.vehicles[k] as WVehicle), id: i });
    } else list[i] = r.vehicles[k] as WVehicle;
    vidOf.set(i, vid);
  });
  const shown = loopView === 'closed';
  const ctx: TrackCtx = {
    list,
    tracked: (i) => i < own || i >= vehicleList.length,
    opOf: (i) => (i < own ? opByVehicle.get(i) : undefined),
    field: { result: r, vidOf: (i: number) => vidOf.get(i) },
    pose: (i) => (shown ? view.vehicles.poseOf(i) : undefined),
    roadAt: (x, z) => view.roadAt(x, z),
  };
  const rows: VehRow[] = [];
  for (let i = 0; i < list.length; i++) {
    const row = trackRow(ctx, i, t);
    if (row) rows.push({ ...fromTrack(row), vid: vidOf.get(i) ?? i });
  }
  return rows;
}
/** 设施此刻的概况（值班助手问到时才算） */
/** 给值班助手的设施快照一律用中文（助手按中文理解和作答，英文界面显示时再逐行翻译）：填 {名字}，不查字典 */
const zhFill = (s: string, v: Record<string, unknown> = {}): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
function facSnaps(): Partial<Record<AssistFac, FacSnap>> {
  if (!result?.trace) return {};
  const p = view.port.info(t);
  const a = view.airport.info(t, idByVid, new Map());
  const d = view.dc.info(t);
  const sd = view.storeDocks.info(t);
  const rail = [view.railDcW.info(t), view.railDcE.info(t)].flatMap((x) => x.trains.filter((tr) => t >= tr.t0 - 1800 && t < tr.t1 + 1800).map((tr) => `${tr.label} ${tr.mode} ${tr.done}/${tr.n}`));
  return {
    port: {
      key: 'port',
      name: zhFill('港口'),
      kpi: view.port.kpi(),
      lines: [
        p.vessel ? zhFill('本店班轮 {label}：完成 {done}/{moves} 箱（靠泊 {dayClock}–{dayClock2}）', { label: p.vessel.label, done: p.vessel.done, moves: p.vessel.moves, dayClock: dayClock(p.vessel.berth[0]), dayClock2: dayClock(p.vessel.berth[1]) }) : zhFill('今天没有本店的班轮'),
        `${zhFill('泊位：')}${p.berths.map((b) => `${b.label}${b.ship ? ` ${b.ship}` : ''} ${b.status}`).join('；')}`,
        zhFill('闸口：场内外来集卡 {inside} 辆、排队 {queue} 辆，今天进闸 {inToday} 车次', { inside: p.gate.inside, queue: p.gate.queue, inToday: p.gate.inToday }),
        zhFill('堆场：{boxes}/{slots} 箱位', { boxes: p.yard.boxes, slots: p.yard.slots }),
      ],
      nums: { gateQueue: p.gate.queue, yardUse: p.yard.slots ? (p.yard.boxes / p.yard.slots) * 100 : 0 },
    },
    airport: {
      key: 'airport',
      name: zhFill('机场'),
      kpi: view.airport.kpi(),
      lines: [
        zhFill('航班：今天 {flights} 班（本店 {own} 班），在场 {length} 班', { flights: a.today?.flights ?? a.flights.length, own: a.today?.own ?? a.flights.filter((f) => f.own).length, length: a.flights.filter((f) => f.phase === 'ground').length }),
        ...a.flights.filter((f) => f.own).map((f) => `${f.id} ${f.label}：${f.status}${f.land !== undefined ? zhFill('，{v1}{land} 落地', { v1: f.id.endsWith('-1') ? `${zhFill('前一天')} ` : '', land: tclock(f.land) }) : ''}`),
        zhFill('货站：在库 {inside} 板，本店的货待提 {storeReady} 板', { inside: a.terminal.inside, storeReady: a.terminal.storeReady }),
      ],
    },
    dc: {
      key: 'dc',
      name: zhFill('物流园'),
      kpi: view.dc.kpi(),
      lines: [
        zhFill('月台门在用 {length}/{length2}；发货暂存 {out} 板、收货暂存 {in} 板', { length: d.doors.filter((x) => x.vid !== undefined).length, length2: d.doors.filter((x) => x.open).length, out: d.staged.out, in: d.staged.in }),
        zhFill('堆垛机 {cranesBusy}/{cranes} 在忙，搬运机器人 {amrBusy}/{amrTotal}；今天装车 {load} 车、卸车 {unload} 车', { cranesBusy: d.cranesBusy, cranes: d.cranes, amrBusy: d.amrBusy, amrTotal: d.amrTotal, load: d.trucksToday.load, unload: d.trucksToday.unload }),
        ...(rail.length ? [zhFill('货运站：{rail}', { rail: rail.join('；') })] : []),
      ],
      nums: { doorUse: (d.doors.filter((x) => x.vid !== undefined).length / Math.max(1, d.doors.filter((x) => x.open).length)) * 100 },
    },
    store: {
      key: 'store',
      name: STORE.name,
      kpi: view.storeDocks.kpi(),
      lines: [`${zhFill('收货口：')}${sd.docks.map((x) => `${x.id} ${x.label ?? zhFill('空')}${x.until !== undefined ? zhFill('（到 {until}）', { until: tclock(x.until) }) : ''}`).join('；')}`, zhFill('今天到了 {today} 车、{pallets} 板', { today: sd.today, pallets: sd.pallets })],
    },
  };
}
/**
 * 四处仓储中心当天的作业计划（港口物流中心、机场货站、物流园、门店停车场和收货场）：三维按它画，值班助手按它回答。
 * 车换了（换一天、重排调度台、切换计划 / 现场）就重新取；仿真里的车用调度台的作业编号，排队时间才接得到那一趟车上。
 */
let hubMemo: HubDay[] | undefined;
let storeJobs: { board: Board; fn: (vid: number, arrive: number) => string | undefined } | undefined;
function linkHubs(): void {
  if (!board) return;
  view.port.setOps(board.ops);
  view.dc.setOpOf((vid) => opByVehicle.get(vid)?.id);
  hubMemo = undefined;
}
function hubDays(): HubDay[] {
  if (hubMemo) return hubMemo;
  if (board && storeJobs?.board !== board) storeJobs = { board, fn: jobFromBoard(board.ops, STORE.key) };
  const days = [view.port.hubDay(), view.airport.hub((vid) => idByVid.get(vid)), view.dc.hubDay(), view.storeSite?.hub(storeJobs?.fn)];
  return (hubMemo = days.filter((h): h is HubDay => !!h));
}
/** 值班助手和分层看板每分钟都要一份此刻的数据：同一分钟、同一份计划和闭环结果只算一次（设施概况用到时才算） */
let ctxMemo: { minute: number; board: Board; loop: LoopData | undefined; docs: typeof docs; ctx: AssistCtx } | undefined;
function assistCtx(): AssistCtx | undefined {
  if (!board || !result?.trace) return undefined;
  const minute = Math.floor(t / 60);
  if (ctxMemo && ctxMemo.minute === minute && ctxMemo.board === board && ctxMemo.loop === loopData && ctxMemo.docs === docs) return ctxMemo.ctx;
  const lr = loopData;
  const trace = result.trace;
  const b = board;
  const dr = drill !== 'none' ? DRILLS.find((x) => x.key === drill) : undefined;
  let fac: ReturnType<typeof facSnaps> | undefined;
  const ctx: AssistCtx = {
    t,
    gen,
    ...(dr ? { drill: { key: dr.key, label: dr.label, detail: dr.detail } } : {}),
    board,
    day: dayFor(gen),
    allocation: allocationHour(scen(gen, seed)),
    rows: assistRows(),
    ...(lr ? { twin: twinSnap(lr.closed, lr.open, t, loopPanel.current.policy, lr.decisions, result.trace.storeDemand) } : {}),
    fac: () => (fac ??= facSnaps()),
    ...(docs?.length ? { docs } : {}),
    alerts: () => kpiPanel.book.open().map((a) => ({ label: a.label, level: LEVEL_LABEL[a.level], state: a.state, since: a.since, owner: ownerText(a) })),
    cams: () => view.cameraDetections(),
    hubs: hubDays,
    // 推演临时扰动（车晚出发、门关闭、船延误、封路）：和「现场」同一份输入，不处理地跑两遍比较
    sim: () => {
      const st = loopPanel.current;
      return { input: { vehicles: trace.vehicles, ops: b.ops, board: b, seed: st.seed, store: { stock: trace.storeStock, demand: trace.storeDemand }, direct: [...scen(gen, seed).flow.direct], level: st.level } };
    },
    // 门店收货场的预约错峰按真实的收货场排程验算（和孪生服务一样）
    yards: () => {
      const ss = view.storeSite;
      return ss?.site.yard ? { store: storeYardOf(ss.site.yard.plan, ss.trucks, ss.yardVisits) } : {};
    },
  };
  ctxMemo = { minute, board, loop: loopData, docs, ctx };
  return ctx;
}
const assistant = new AssistantPanel($('assistant'), {
  ctx: assistCtx,
  execute: (p) => {
    const decide = p.actions.flatMap((a) => (a.kind === 'decide' ? [a] : []));
    const fixes = p.actions.flatMap((a) => (a.kind === 'fix' ? [a.fix] : []));
    // 求解出来的整天调度（只改门和车，不用重新仿真）
    for (const a of p.actions) if (a.kind === 'day') applyDay(a.day, false);
    if (decide.length) {
      if (!loopData) return tr('闭环孪生还没跑完');
      const open = new Set(loopData.closed.recs.filter((r) => r.t <= t && statusAt(r, t) === 'proposed').map((r) => r.key));
      const ok = decide.filter((a) => open.has(a.key));
      if (!ok.length) return tr('这张建议卡已经处理过了（或者还没出来）');
      // 和闭环面板一样：决定在下一个 5 分钟生效
      const at = Math.ceil(t / 300) * 300;
      loopDecisions = [...loopDecisions.filter((x) => !ok.some((a) => a.key === x.key)), ...ok.map((a) => ({ t: at, key: a.key, action: a.action, ...(a.option ? { option: a.option } : {}) }) satisfies UserDecision)];
      void runTwin(false);
    }
    if (fixes.length) {
      let day = dayFor(gen);
      for (const f of fixes) day = applyFix(day, f);
      applyDay(
        day,
        fixes.some((f) => f.kind === 'depart' || f.kind === 'arrive'),
      );
    }
    return undefined;
  },
  counterfactual: async (key) => {
    if (!loopData || !result?.trace) return tr('闭环孪生还没跑完');
    const r = loopData.closed.recs.find((x) => x.key === key);
    if (!r) return tr('没有这张建议卡');
    const best = r.options[r.best];
    const flip: UserDecision = r.status === 'done' ? { t: r.t, key, action: 'reject' } : { t: r.t, key, action: 'approve', ...(best ? { option: best.key } : {}) };
    const st = loopPanel.current;
    const res = await call<{ closed: LoopResult }>(loopWorker, { seed: st.seed, level: st.level, region, ...facReq(), policy: st.policy, decisions: [...loopDecisions.filter((d) => d.key !== key), flip], closedOnly: true, ...(st.quality !== 'good' ? { quality: st.quality } : {}) } as Record<string, unknown>);
    const a = loopData.closed.kpi;
    const b = res.closed.kpi;
    const sc = (k: typeof a) => k.lateMin + k.hotMin * 2 + k.shortMin * 1.5 + k.cost / 12;
    const d = sc(b) - sc(a);
    const what = r.status === 'done' ? tr('不执行') : tr('执行「{label}」', { label: best?.label ?? '' });
    return tr('如果当时{what}：全天迟到 {lateMin} 分钟（实际 {lateMin2}）、超温 {hotMin}（{hotMin2}）、缺货 {shortMin}（{shortMin2}）、多花 ${cost}（${cost2}）；合计分{v10}。', { what, lateMin: Math.round(b.lateMin), lateMin2: Math.round(a.lateMin), hotMin: Math.round(b.hotMin), hotMin2: Math.round(a.hotMin), shortMin: Math.round(b.shortMin), shortMin2: Math.round(a.shortMin), cost: Math.round(b.cost), cost2: Math.round(a.cost), v10: Math.abs(d) < 0.5 ? tr('一样') : d > 0 ? tr('多 {d}，当时的决定是对的', { d: Math.round(d) }) : tr('少 {d}，当时反过来会更好', { d: Math.round(-d) }) });
  },
  link: (l) => {
    const go = (id: string) => $(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (l.kind === 'time') {
      t = Math.max(0, Math.min(DAY_END, l.t));
      drawFrame(true);
    } else if (l.kind === 'vehicle') {
      if (loopData && l.vid >= own) showFieldVehicle(l.vid);
      else selectVehicleIndex(l.vid, true);
      go('view');
    } else if (l.kind === 'card') {
      loopPanel.focusCard(l.key);
      go('loop');
    } else if (l.kind === 'facility') {
      showFacility(l.fac);
      go('view');
    } else if (l.kind === 'op') {
      const op = board?.byId.get(l.id);
      if (op) {
        selectedOp = op.id;
        dispatch.select(op.id, true);
        go('dispatch');
      }
    }
  },
});
// —— 分层看板：集团、区域、设施、作业四层指标，超阈值告警，没人确认往上报 ——
const BOARD_KEYS: Record<string, string> = { service: 'service', onTime18: 'onTime', costPerCase: 'costPerCase', co2PerCase: 'co2PerCase' };
const kpiPanel = new KpiPanel($('kpiboard'), {
  input: () => {
    const ctx = assistCtx();
    if (!ctx || !result) return undefined;
    const mean = ref.gens.find((g) => g.gen === gen)?.mean ?? {};
    return {
      ctx,
      summary: Object.fromEntries(Object.entries(BOARD_KEYS).map(([k, key]) => [k, kpi(key).get(result as ChainResult)])),
      base: Object.fromEntries(Object.entries(BOARD_KEYS).flatMap(([k, key]) => (mean[key] !== undefined ? [[k, mean[key] as number]] : []))),
      approvals: assistant.approvals.pending().length,
    };
  },
  role: () => assistant.currentRole,
  notify: (text) => assistant.notify(text),
});


/** 车辆下标 → 作业编号（调度台的作业）或现场新派的车名 */
function loopLabel(vid: number): string {
  const op = board?.ops.find((o) => o.vehicle === vid);
  if (op) return op.id;
  const r = loopData?.closed;
  const k = r ? r.vids.indexOf(vid) : -1;
  return k >= 0 ? (r?.vehicles[k]?.label.replace(/（.*$/, '') ?? tr('车 {vid}', { vid })) : tr('车 {vid}', { vid });
}

/** 跑闭环：plan = 计划换了（重新传给后台线程，用孪生和不用孪生都重跑）；否则只重跑用孪生的那一遍 */
let loopReq = 0;
async function runTwin(plan: boolean): Promise<void> {
  if (!result?.trace || !board) return;
  const my = ++loopReq;
  const sc = scen(gen, seed);
  const st = loopPanel.current;
  loopPanel.setBusy(tr('现场在跑…'));
  try {
    const msg: Omit<LoopRequest, 'id'> = {
      seed: st.seed,
      level: st.level,
      region,
      ...facReq(),
      policy: st.policy,
      decisions: loopDecisions,
      ...(st.quality !== 'good' ? { quality: st.quality } : {}),
      ...(plan || !loopData ? { plan: { vehicles: result.trace.vehicles, board, store: { stock: result.trace.storeStock, demand: result.trace.storeDemand }, direct: [...sc.flow.direct] } satisfies LoopPlan } : { closedOnly: true }),
    };
    const r = await call<{ closed: LoopResult; open?: LoopResult; ms: number }>(loopWorker, msg as Record<string, unknown>);
    if (my !== loopReq) return;
    loopData = { closed: r.closed, open: r.open ?? (loopData?.open as LoopResult), ms: r.ms, decisions: loopDecisions, labelOf: loopLabel };
    loopPanel.setBusy(undefined);
    loopPanel.setData(loopData);
    loopPanel.setTime(t);
    applyLoopView(true);
    assistant.refresh();
    // 对比回放开着：按新的闭环结果（或新的一天）重建右边
    if (splitPair) void setSplit(splitPair, splitSeed);
    assistant.greet(`${runKey()}:${JSON.stringify(region)}`);
    // 分层看板按新的闭环结果刷（和上面画面那次排在一起，接下来的任务里刷）
    panelsSoon();
    loadDocs();
  } catch (err) {
    loopPanel.setBusy(tr('闭环出错：{err}', { err: String(err) }));
  }
}

/** 三维里显示计划，还是现场（用孪生 / 不用孪生）：现场视图把改过去处的车换进去、新派的车接在后面，车按延误平移；later 见 drawFrame */
function applyLoopView(later = false): void {
  if (!board) return;
  const r = loopView === 'closed' ? loopData?.closed : loopView === 'open' ? loopData?.open : undefined;
  fieldVid = new Map();
  if (!r) {
    // 计划视图：三维里已经是这份车辆清单（rebuildBoard 刚排过）时不再重排——港口、物流园、机场一天的作业重排一遍要两三秒，
    // 第一次打开时闭环推演一完成就会走到这里，以前会把同样的东西整套再算一遍
    if (shownList !== vehicleList) {
      shownList = vehicleList;
      view.setVehicles(vehicleList, placeResolver(board), gen === 'g1' ? 'gen1' : 'storex', (i) => opByVehicle.get(i)?.pallets);
      linkHubs();
    }
    view.setTimeShift(undefined);
    view.setIncidents([]);
    drawFrame(true, later);
    return;
  }
  const list = [...vehicleList];
  const delays: (Float32Array | undefined)[] = new Array(list.length).fill(undefined);
  const ends: number[] = new Array(list.length).fill(Infinity);
  r.vids.forEach((vid, k) => {
    let i = vid;
    if (vid >= own) {
      i = list.length;
      list.push({ ...(r.vehicles[k] as WVehicle), id: i });
      delays.push(undefined);
      ends.push(Infinity);
    } else list[i] = r.vehicles[k] as WVehicle;
    fieldVid.set(i, vid);
    delays[i] = r.delays[k];
    ends[i] = r.ends[k] ?? Infinity;
  });
  shownList = list;
  view.setVehicles(list, placeResolver(board), gen === 'g1' ? 'gen1' : 'storex', (i) => opByVehicle.get(i)?.pallets);
  linkHubs();
  view.setTimeShift({ delays, ends });
  view.setIncidents(r.incidents.map((x) => ({ x: x.x, z: x.z, r: x.r, t0: x.t0, t1: x.t1, text: x.text })));
  drawFrame(true, later);
}

const dispatch = new Dispatch($('dispatch'), $('opcard'), {
  setTime: (sec) => {
    t = sec;
    drawFrame(true);
  },
  onSelect: (op, focus) => {
    selectedOp = op?.id;
    trackPanel.select(op && op.vehicle >= 0 ? op.vehicle : undefined);
    showSelection(op, focus);
  },
  onDay: (day, rerun) => applyDay(day, rerun),
  onStanding: (p) => {
    standingByGen.set(gen, p);
    void run(true);
  },
});
dispatch.attachCurves($('hourly'));
/** 当天调度变了：只改门和车不用重新仿真，改时刻要 */
function applyDay(day: DayPlan, rerun: boolean): void {
  dayByGen.set(gen, day);
  if (rerun) void run(true);
  else rebuildBoard();
}
view.onPick = (vehicle) => selectVehicleIndex(vehicle, true);
// 对比回放点了右半边的车：同一天等于点左边同一个作业；另一天在右边选中它（光圈、路线、停靠点只画在右边）
view.onPickRight = (vehicle) => {
  if (splitPair !== 'days') return selectVehicleIndex(vehicle, true);
  splitSel = vehicle;
  const op = splitOther?.board.ops.find((o) => o.vehicle === vehicle);
  view.selectRight(vehicle, true, op ? marksOf(op) : []);
  renderTracking(true);
};

// —— 实时跟踪：所有车辆的位置、状态、预计到达，侧栏是选中车辆的详细信息 ——
const trackPanel = new TrackPanel($('track'), $('vcard'), {
  onSelect: (i) => selectVehicleIndex(i, true),
  onFollow: (i) => view.setFollow(i),
  onOps: (i) => {
    const op = i < own ? opByVehicle.get(i) : undefined;
    if (!op) return;
    dispatch.selectByVehicle(i);
    $('dispatch').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  onLayout: (inset) => view.setLeftInset(inset),
});
new ResizeObserver(() => trackPanel.layout()).observe($('view'));
// 管理台第一次打开时才加载（单独一块，不拖慢首屏）
let adminP: Promise<FacilityAdmin> | undefined;
const adminOf = (): Promise<FacilityAdmin> =>
  (adminP ??= import('./facilityAdmin').then(
    ({ FacilityAdmin }) =>
      new FacilityAdmin(
        $('admin'),
        {
          kpi: (f) => (f === 'port' ? view.port.kpi() : f === 'airport' ? view.airport.kpi() : f === 'dc' ? view.dc.kpi() : view.storeDocks.kpi()),
          // 按作业量排班：港口、机场的每小时作业量从三维里的设施作业取
          sources: () => ({ port: view.port, airport: view.airport }),
          apply: (f) => {
            try {
              localStorage.setItem(FAC_KEY, JSON.stringify(f));
            } catch {
              /* 存不了（隐私模式）也照样重新载入，只是下次打开回到默认 */
            }
            // 网址带着场景参数（分享链接、练习）时：设施以网址为准，换成新设施的链接再载入，方案、时刻、镜头照旧
            if (hasScenarioParams(location.search)) reloadWith({ ...currentScenario(), facilities: facilitiesDiff(defaultFacilities(), f) });
            else location.reload();
          },
        },
        facilities,
      ),
  ));
const TAB_FAC: Record<FacTab, FacKey> = { group: 'dc', port: 'port', air: 'airport', dc: 'dc', store: 'store' };
const facility = new FacilityPanel($('facility'), {
  onVehicle: (i) => selectVehicleIndex(i, true),
  onFocus: (tab) => view.focus(TAB_PRESET[tab]),
  onManage: (tab) => void adminOf().then((a) => a.open(TAB_FAC[tab], facilities)),
  onLayout: (inset) => view.setRightInset(inset),
});
new ResizeObserver(() => facility.layout()).observe($('view'));
function showFacility(tab: FacTab): void {
  facility.setTab(tab);
  renderFacility(true);
}
/** 选中三维里的一辆车（下标是三维里的下标）：调度台选中它的作业，三维画路线并跟随，跟踪面板和侧栏显示它 */
function selectVehicleIndex(i: number, focus: boolean): void {
  trackPanel.select(i);
  const op = i < own ? opByVehicle.get(i) : undefined;
  if (op) {
    selectedOp = op.id;
    dispatch.selectByVehicle(i);
    showSelection(op, focus);
  } else view.selectVehicle(i, focus);
  renderTracking(true);
}
let lastTrack = -1;
let lastTrackReal = 0;
/** 跟踪面板最近一次的行（设施监控借它的编号和预计到达） */
let lastRows: TrackRow[] = [];
const idByVid = new Map<number, string>();
let lastFac = -1;
let lastFacReal = 0;
function renderTracking(force = false): void {
  const now = performance.now();
  const minute = Math.floor(t / 60);
  if (!force && (minute === lastTrack || now - lastTrackReal < 200)) return;
  lastTrack = minute;
  lastTrackReal = now;
  const r = loopView === 'closed' ? loopData?.closed : loopView === 'open' ? loopData?.open : undefined;
  const ctx: TrackCtx = {
    list: shownList,
    tracked: (i) => i < own || i >= vehicleList.length,
    opOf: (i) => (i < own ? opByVehicle.get(i) : undefined),
    ...(r ? { field: { result: r, vidOf: (i: number) => fieldVid.get(i) } } : {}),
    pose: (i) => view.vehicles.poseOf(i),
    roadAt: (x, z) => view.roadAt(x, z),
  };
  const rows: TrackRow[] = [];
  for (let i = 0; i < shownList.length; i++) {
    const row = trackRow(ctx, i, t);
    if (row) rows.push(row);
  }
  trackPanel.setMode(!!r);
  trackPanel.setRows(rows);
  lastRows = rows;
  idByVid.clear();
  for (const x of rows) idByVid.set(x.i, x.id);
  const tags = (list: TrackRow[], sel: number | undefined) =>
    list
      .filter((x) => x.status === 'moving' || x.status === 'working')
      .map((x) => {
        const eta = x.nextEta ?? x.nextPlan;
        const text = x.status === 'moving' ? `${x.id} → ${tx(x.next)}${eta !== undefined ? ` ${tclock(eta)}` : ''}` : `${x.id} · ${tx(x.act).replace(/^在/, '').replace(/（.*）/, '').slice(0, 10)}`;
        const late = (x.delayMin ?? 0) >= 10 || (x.temp && x.temp.value > x.temp.limit);
        return { i: x.i, text, cls: `${x.status}${late ? ' late' : ''}${x.i === sel ? ' sel' : ''}` };
      });
  view.setTags(tags(rows, trackPanel.selected));
  // 对比回放：右边的车头标签按右边那一组算（同一个作业两边的预计到达可以直接比）
  const right = view.splitVehicles;
  if (splitTrack && right) {
    const ctx2: TrackCtx = { ...splitTrack, pose: (i) => right.poseOf(i), roadAt: (x, z) => view.roadAt(x, z) };
    const rows2: TrackRow[] = [];
    for (let i = 0; i < ctx2.list.length; i++) {
      const row = trackRow(ctx2, i, t);
      if (row) rows2.push(row);
    }
    view.setSplitTags(tags(rows2, splitPair === 'days' ? splitSel : trackPanel.selected));
  }
}

/** 设施监控：只算正在看的那一页（每仿真分钟、最多每 0.4 秒一次） */
function renderFacility(force = false): void {
  if (!result?.trace || !board) return;
  const now = performance.now();
  const minute = Math.floor(t / 60);
  if (!force && (minute === lastFac || now - lastFacReal < 400)) return;
  lastFac = minute;
  lastFacReal = now;
  const idOf = (vid: number) => idByVid.get(vid) ?? `#${vid}`;
  const h = Math.min(23, Math.max(0, Math.floor(t / 3600)));
  const series = result.trace.series;
  const data: FacData = { t, idOf };
  if (facility.tab === 'group') {
    const pk = view.port.kpi();
    const ak = view.airport.kpi();
    const dk = view.dc.kpi();
    const sk = view.storeDocks.kpi();
    const dc = view.dc.info(t);
    const sd = view.storeDocks.info(t);
    const air = view.airport.info(t, idByVid, new Map());
    const moving = lastRows.filter((x) => x.status === 'moving').length;
    const working = lastRows.filter((x) => x.status === 'working').length;
    const deliveries = board.ops.filter((o) => o.stops?.some((st) => st.key === STORE.key));
    const onTime = deliveries.filter((o) => o.stops?.find((st) => st.key === STORE.key)?.onTime).length;
    const alerts: NonNullable<FacData['group']>['alerts'] = [];
    for (const x of lastRows) {
      if ((x.delayMin ?? 0) >= 10) alerts.push({ text: tr('{id} 晚了 {delayMin} 分钟（{next}）', { id: x.id, delayMin: x.delayMin, next: tx(x.next || x.act) }), vid: x.i });
      if (x.temp && x.temp.value > x.temp.limit) alerts.push({ text: tr('{id} 货温 {value} °C 超过 {limit} °C', { id: x.id, value: x.temp.value.toFixed(1), limit: x.temp.limit }), vid: x.i });
    }
    for (const k of [...pk, ...ak, ...dk, ...sk]) if (k.bad) alerts.push({ text: `${k.label}：${k.value}` });
    const g = (pick: { label: string; value: string; bad?: boolean }[], label: string) => pick.find((x) => x.label.startsWith(label));
    const portMain = g(pk, tr('本店班轮完工'));
    const sum = (r: { crew: Record<string, number> }[]) => r.reduce((a, x) => a + 8 * Object.values(x.crew).reduce((p, q) => p + q, 0), 0);
    data.group = {
      scene: [
        [tr('方案'), tx(GEN_LABEL[gen])],
        [tr('区域'), region.mode === 'default' ? tr('默认区域') : `${region.mode === 'random' ? tr('随机生成') : tr('自定义')} ${tr('· 编号 {seed}', { seed: region.seed })}`],
        [tr('负荷'), load === 'normal' ? tr('平常（基线）') : tr('{load}（需求 ×{demand}）', { load: tx(LOAD_LABEL[load]), demand: LOADS[load].demand })],
        [tr('设施配置'), isDefault(facilities) ? tr('默认') : tr('管理台里改过')],
      ],
      kpi: [
        [tr('车船飞机'), tr('在途 {moving} · 作业中 {working} · 当天 {length}', { moving, working, length: lastRows.length })],
        [tr('门店到货准点'), deliveries.length ? tr('{onTime}/{length} 车（{onTime2}%）', { onTime, length: deliveries.length, onTime2: Math.round((onTime / deliveries.length) * 100) }) : '—'],
        [tr('门店库存'), `${(result.trace.series.storeDays?.[Math.min(23, Math.floor(t / 3600))] ?? 0).toFixed(2)} ${tr('天')}`],
        [tr('配送中心库存'), `${(result.trace.series.dcDays?.[Math.min(23, Math.floor(t / 3600))] ?? 0).toFixed(1)} ${tr('天')}`],
      ],
      facilities: [
        { tab: 'port', name: tr('港口'), status: portMain ? tr('本店班轮 {value}', { value: portMain.value }) : tr('今天没有本店的班轮'), bad: !!portMain?.bad },
        { tab: 'air', name: tr('机场'), status: `${air.flights.filter((f) => f.status !== '已离场' && f.status !== '未到').length} ${tr('个航班在场 · 当天 {length} 班', { length: air.flights.length })}`, bad: ak.some((x) => x.bad) },
        { tab: 'dc', name: tr('物流园'), status: tr('月台门在用 {length}/{length2} · 发货暂存 {out} 板 · 堆垛机 {cranesBusy}/{cranes}', { length: dc.doors.filter((x) => x.vid !== undefined).length, length2: dc.doors.filter((x) => x.open).length, out: dc.staged.out, cranesBusy: dc.cranesBusy, cranes: dc.cranes }), bad: dk.some((x) => x.bad) },
        { tab: 'store', name: tr('综合店'), status: tr('收货口在用 {length}/{length2} · 今天 {today} 车 {pallets} 板', { length: sd.docks.filter((x) => x.vid !== undefined).length, length2: sd.docks.length, today: sd.today, pallets: sd.pallets }), bad: sk.some((x) => x.bad) },
      ],
      labor: [
        { name: tr('港口'), cost: laborCost(facilities.port.staff), hours: sum(facilities.port.staff) },
        { name: tr('机场货站和机坪'), cost: laborCost(facilities.airport.staff), hours: sum(facilities.airport.staff) },
        { name: tr('物流园（配送中心）'), cost: laborCost(facilities.dc.staff), hours: sum(facilities.dc.staff) },
        { name: tr('综合店'), cost: laborCost(facilities.store.staff), hours: sum(facilities.store.staff) },
      ],
      alerts: alerts.slice(0, 12),
    };
  }
  if (facility.tab === 'port') data.port = { info: view.port.info(t), rail: view.railPort.info(t), ...(view.shipVid !== undefined ? { shipVid: view.shipVid } : {}) };
  if (facility.tab === 'air') {
    const labels = new Map(view.vehicles.items.map((v, i) => [i, v.label] as const));
    const byId = new Map([...idByVid].map(([vid, id]) => [id, vid] as const));
    data.air = { ...view.airport.info(t, idByVid, labels), vidOf: (id) => byId.get(id) };
  }
  if (facility.tab === 'dc') data.dc = { info: view.dc.info(t), rail: [view.railDcW.info(t), view.railDcE.info(t)], ...(series.dcDays?.[h] !== undefined ? { dcDays: series.dcDays[h] as number } : {}) };
  if (facility.tab === 'store') {
    const key = STORE.key;
    const rows = new Map(lastRows.map((x) => [x.i, x] as const));
    const deliveries = board.ops
      .filter((o) => o.vehicle >= 0 && o.stops?.some((st) => st.key === key))
      .map((o) => {
        const st = o.stops?.find((x) => x.key === key) as OpStop;
        const row = rows.get(o.vehicle);
        const status = t < (o.depart ?? o.t0) ? '未出发' : t < st.arrive ? '在途' : t < st.start ? '到店等收货' : t < st.end ? '卸货中' : '已卸完';
        const eta = status === '在途' ? (row?.nextEta ?? row?.nextPlan) : t >= st.arrive ? st.arrive : undefined;
        return { vid: o.vehicle, id: idOf(o.vehicle), label: o.label, plan: st.arrive, ...(eta !== undefined ? { eta } : {}), status, pallets: st.pallets, late: !st.onTime };
      })
      .sort((a, b) => a.plan - b.plan);
    const lr = loopView === 'open' ? loopData?.open : loopData?.closed;
    const slot = Math.max(0, Math.floor(t / 300));
    const demand = result.trace.storeDemand;
    const stock = FAMILIES.map((f) => {
      const sk = lr?.stocks.get(f.key);
      const units = sk ? (sk.truth[Math.min(sk.truth.length - 1, slot)] ?? 0) : (result?.trace?.storeStock[f.key] ?? 0);
      const est = sk ? sk.est[Math.min(sk.est.length - 1, slot)] : undefined;
      const d = demand[f.key] ?? 0;
      return { label: f.label, units, ...(est !== undefined ? { est } : {}), ...(d > 0 ? { days: units / d } : {}) };
    }).filter((x) => x.units > 0 || (x.est ?? 0) > 0);
    let out = 0;
    let done = 0;
    let total = 0;
    for (const x of lastRows) {
      if (x.kind !== 'van') continue;
      total++;
      if (x.status === 'done') done++;
      else if (x.status === 'moving') out++;
    }
    data.store = {
      docks: view.storeDocks.info(t),
      deliveries,
      stock,
      stockNote: lr ? tr('现场每 5 分钟的库存（闭环孪生的现场真值）和孪生的估计') : tr('当天 0 点的库存；运行闭环孪生以后按每 5 分钟更新，并显示孪生的估计'),
      vans: { out, done, total },
      ...(series.storeDays?.[h] !== undefined ? { days: series.storeDays[h] as number } : {}),
      lost: (series.lost ?? []).slice(0, h + 1).reduce((a, b) => a + b, 0),
    };
  }
  facility.setData(data);
}

/** 三维里高亮选中作业的车：路线、停靠点（门店、月台门）标签 */
function showSelection(op: BoardOp | undefined, focus: boolean): void {
  if (!op || op.vehicle < 0) {
    view.selectVehicle(undefined, false);
    return;
  }
  view.selectVehicle(op.vehicle, focus, marksOf(op));
}
/** 一个作业的停靠点标签：月台门（装车 / 卸货的时段）、每一站（几点到、迟到没有） */
function marksOf(op: BoardOp): { text: string; pos: THREE.Vector3 }[] {
  const marks: { text: string; pos: THREE.Vector3 }[] = [];
  if (op.door && op.dockAt) {
    const place = view.world.net.places.get(doorPlace(op.door) as string);
    const p = place?.reverse?.[place.reverse.length - 1];
    if (p) marks.push({ text: `${op.door} ${op.kind === 'delivery' ? tr('装车') : tr('卸货')} ${clock(op.dockAt[0])}–${clock(op.dockAt[1])}`, pos: new THREE.Vector3(p.x, 14, p.z) });
  }
  (op.stops ?? []).forEach((st, i) => {
    const site = view.world.sites.get(st.key);
    if (site) marks.push({ text: `${i + 1} ${st.name} ${clock(st.start)}${st.onTime ? '' : ` ${tr('迟到')}`}`, pos: new THREE.Vector3(site.center.x, 24, site.center.z) });
  });
  return marks;
}

function boardCtx(sc: ChainScenario) {
  return { allocation: allocationHour(sc), crossDock: sc.dc.crossDock };
}

/** 重新排门、排车（不用重新仿真），刷新调度台和三维里的车 */
function rebuildBoard(): void {
  if (!result?.trace) return;
  const sc = scen(gen, seed);
  const day = dayFor(gen);
  board = buildBoard(result.trace.ops, day, boardCtx(sc));
  opByVehicle = new Map(board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
  view.setVehicles(vehicleList, placeResolver(board), gen === 'g1' ? 'gen1' : 'storex', (i) => opByVehicle.get(i)?.pallets);
  linkHubs();
  shownList = vehicleList;
  view.setTimeShift(undefined);
  view.setIncidents([]);
  // 调度台的计划变了：现场按新计划重跑（调度员在建议卡上的决定作废）
  loopDecisions = [];
  void runTwin(true);
  const clash = new Set(board.issues.filter((i) => i.code === 'door-conflict').flatMap((i) => i.ops));
  view.setDoorBookings(board.doors.flatMap((d) => d.bookings.map((b) => ({ door: b.door, t0: b.t0, t1: b.t1, mode: b.mode, conflict: clash.has(b.op) }))));
  const defaults = standingOf(sc);
  const standing = standingFor(gen);
  const base = baseline.get(runKey());
  const planChanged = !samePlan(standing, defaults);
  const receiveNote = sc.fleet.consolidated
    ? tr('默认从 {receiveFrom} 开始收货，{multi} 前开始卸货算准时', { receiveFrom: hhmm(sc.store.receiveFrom), multi: hhmm(sc.fleet.dueBy.multi) })
    : tr('默认从 {receiveFrom} 开始收货；冷藏、冷冻 {chilled} 前，常温 {ambient} 前，面包 08:00 前开始卸货算准时', { receiveFrom: hhmm(sc.store.receiveFrom), chilled: hhmm(sc.fleet.dueBy.chilled), ambient: hhmm(sc.fleet.dueBy.ambient) });
  dispatch.setData({
    board,
    day,
    standing,
    defaults,
    ...(base && (planChanged || !dayIsEmpty(day)) ? { baseKpi: base.kpi } : {}),
    ...(base && planChanged ? { compare: compareRows(base.result, result) } : {}),
    earliest: earliestDepart(sc),
    receiveNote,
    receiveFrom: sc.store.receiveFrom,
    genLabel: tx(GEN_LABEL[gen]),
    dayNo: TRACE_DAY,
    // 求解页用：分配库存的时刻、门店当天的需求（补货批量）
    allocation: allocationHour(sc),
    storeDemand: result.trace.storeDemand,
  });
  dispatch.setTime(t);
  const op = selectedOp ? board.byId.get(selectedOp) : undefined;
  if (op) {
    dispatch.select(op.id, false, true);
    showSelection(op, false);
  } else {
    selectedOp = undefined;
    view.selectVehicle(undefined, false);
  }
}

/** 常规计划改了以后：18 周平均和原计划比 */
function compareRows(base: ChainResult, plan: ChainResult): CompareRow[] {
  const keys = ['costPerCase', 'costTotal', 'service', 'onTime', 'waste', 'freshRemain', 'storeInv', 'dcInv', 'outKm', 'fleet', 'dwell', 'seaLead', 'co2PerCase'];
  return keys.map((key) => {
    const k = kpi(key);
    return { label: tx(k.label), unit: tx(k.unit), digits: k.digits ?? 1, base: k.get(base), plan: k.get(plan), better: k.better };
  });
}

// —— 运行 ——
/** 车辆在三维里停哪：配送中心按调度台排的月台门，门店按排的卸货口 */
// —— 对比回放：三维分成左右两半，同一个世界、同一个时钟比两组车（右边的车层由 three/split.ts 画） ——
let splitPair: SplitPair | undefined;
let splitSeed = 2;
let splitPrevView: LoopView = 'plan';
/** 对比时收起来的面板（关掉对比时展开） */
let splitFolded: HTMLElement[] = [];
/** 另一天的仿真结果（同样的方案、演练、负荷、区域和设施，换一组需求、船期和路况；这一天调度台的改动对得上的照用）；edits：用上了几处 */
let splitOther: { key: string; board: Board; list: WVehicle[]; own: number; edits: number } | undefined;
/** 右边的跟踪信息（车头标签按它算）；右边是另一天时，右边自己选中的车 */
let splitTrack: Omit<TrackCtx, 'pose' | 'roadAt'> | undefined;
let splitSel: number | undefined;
let splitReq = 0;
let splitMinute = -1;
async function setSplit(pair: SplitPair, sd: number): Promise<void> {
  if (!board || !result?.trace) return;
  if (pair !== 'days' && !loopData) pair = 'days';
  splitPair = pair;
  splitSeed = sd;
  // 左边：比闭环的两遍时是现场（用孪生 / 不用孪生），比计划和另一天时是计划
  const leftView: LoopView = pair === 'loop' ? 'closed' : pair === 'loopOpen' ? 'open' : 'plan';
  if (loopView !== leftView) {
    loopView = leftView;
    loopPanel.setView(leftView);
    applyLoopView();
  }
  const side = await splitSide(pair, sd);
  if (!side || splitPair !== pair || splitSeed !== sd) return;
  splitTrack = side.track;
  splitSel = undefined;
  view.setSplit(side, pair, sd);
  updateSplitLabels(true);
  renderTracking(true);
}
async function splitSide(pair: SplitPair, sd: number): Promise<(SplitSide & { track: Omit<TrackCtx, 'pose' | 'roadAt'> }) | undefined> {
  if (!board) return undefined;
  if (pair !== 'days') {
    // 和 applyLoopView 一样：现场改过的车换进去、孪生派出来的车接在后面，车按每分钟的延误平移
    const r = pair === 'loop' ? loopData?.open : loopData?.closed;
    if (!r) return undefined;
    const list = [...vehicleList];
    const delays: (Float32Array | undefined)[] = new Array(list.length).fill(undefined);
    const ends: number[] = new Array(list.length).fill(Infinity);
    const vidOf = new Map<number, number>();
    r.vids.forEach((vid, k) => {
      let i = vid;
      if (vid >= own) {
        i = list.length;
        list.push({ ...(r.vehicles[k] as WVehicle), id: i });
        delays.push(undefined);
        ends.push(Infinity);
      } else list[i] = r.vehicles[k] as WVehicle;
      vidOf.set(i, vid);
      delays[i] = r.delays[k];
      ends[i] = r.ends[k] ?? Infinity;
    });
    const track = { list, tracked: (i: number) => i < own || i >= vehicleList.length, opOf: (i: number) => (i < own ? opByVehicle.get(i) : undefined), field: { result: r, vidOf: (i: number) => vidOf.get(i) } };
    return { list, resolve: placeResolver(board), shift: { delays, ends }, sameDay: true, track };
  }
  // 另一天也按这一天调度台的改动跑：固定方案一样；改过出发、到达时刻的车次那一天也有就照改，月台门、车辆按作业编号对得上的照用
  const standing = standingFor(gen);
  const day = dayFor(gen);
  const planChanged = !samePlan(standing, standingOf(scen(gen, sd)));
  const timesChanged = Object.keys(day.depart).length + Object.keys(day.arrive).length > 0;
  const key = `${gen}:${sd}:${drill}:${load}:${JSON.stringify(region)}:${JSON.stringify(facReq())}:${planChanged ? JSON.stringify(standing) : ''}:${JSON.stringify(day)}`;
  if (splitOther?.key !== key) {
    const my = ++splitReq;
    const r = await call<{ result: ChainResult }>(chainWorker, { gen, seed: sd, drill, load, region, ...facReq(), ...(planChanged ? { standing } : {}), ...(timesChanged ? { day: { depart: day.depart, arrive: day.arrive } } : {}) } satisfies Omit<ChainRequest, 'id'>);
    if (my !== splitReq) return undefined;
    const tr = r.result.trace;
    const list: WVehicle[] = [...(tr?.vehicles ?? [])];
    const n = list.length;
    list.push(...decorVehicles(n));
    const ob = buildBoard(tr?.ops ?? [], day, boardCtx(scen(gen, sd)));
    const edits = dayIsEmpty(day) ? 0 : ob.ops.filter((o) => o.moved).length;
    splitOther = { key, board: ob, list, own: n, edits };
  }
  const other = splitOther;
  const byVehicle = new Map(other.board.ops.filter((o) => o.vehicle >= 0).map((o) => [o.vehicle, o]));
  const track = { list: other.list, tracked: (i: number) => i < other.own, opOf: (i: number) => byVehicle.get(i) };
  return { list: other.list, resolve: placeResolver(other.board), sameDay: false, track };
}
/** 两边此刻的指标（每仿真分钟更新一次）：闭环的两遍比迟到、超温、缺货、措施的钱；计划比到店车次、准点和场地等门 */
function updateSplitLabels(force = false): void {
  if (!splitPair || !view.splitOn) return;
  const minute = Math.floor(t / 60);
  if (!force && minute === splitMinute) return;
  splitMinute = minute;
  const field = (r: LoopResult | undefined, title: string) => {
    const k = r ? kpiAt(r.series, t) : undefined;
    return { title, kpi: k ? tr('到 {t}：迟到 {late} 分 · 超温 {hot} 分 · 缺货 {short} 分 · 措施 ${cost}', { t: tclock(t), late: Math.round(k.late), hot: Math.round(k.hot), short: Math.round(k.short), cost: Math.round(k.cost) }) : '—' };
  };
  const plan = (b: Board, title: string) => {
    const stops = b.ops.flatMap((o) => (o.stops ?? []).filter((st) => st.key === STORE.key));
    const done = stops.filter((st) => st.arrive <= t);
    const wait = b.ops.reduce((a, o) => a + (o.dockAt && o.dockAt[0] <= t ? (o.yardWait ?? 0) : 0), 0) / 60;
    return { title, kpi: tr('到 {t}：到店 {length}/{length2} 车次 · 准点 {length3} · 场地等门 {wait} 分', { t: tclock(t), length: done.length, length2: stops.length, length3: done.filter((st) => st.onTime).length, wait: Math.round(wait) }) };
  };
  if (splitPair === 'loop') view.setSplitLabels(field(loopData?.closed, tr('现场 · 用孪生')), field(loopData?.open, tr('现场 · 不用孪生')));
  else if (splitPair === 'loopOpen') view.setSplitLabels(field(loopData?.open, tr('现场 · 不用孪生')), field(loopData?.closed, tr('现场 · 用孪生')));
  else if (splitPair === 'planField' && board) view.setSplitLabels(plan(board, tr('计划 · 第 {seed} 组', { seed })), field(loopData?.closed, tr('现场 · 用孪生')));
  else if (board && splitOther) view.setSplitLabels(plan(board, tr('这一天 · 第 {seed} 组', { seed })), plan(splitOther.board, `${tr('另一天 · 第 {splitSeed} 组', { splitSeed })}${splitOther.edits ? tr('（用上这一天 {edits} 处调度改动）', { edits: splitOther.edits }) : ''}`));
}

/** 仿真的地点 → 调度台排的门、收货口（和孪生服务共用 src/hub/doors.ts 的同一份对应） */
function placeResolver(b: Board): (vehicle: number, key: string) => string | undefined {
  return resolveDoors(b.ops);
}
let board: Board | undefined;
let storeKey = '';
let storeGen: 'gen1' | 'storex' = 'storex';
/** 演示导览「一个集装箱从船到货架」（web/src/tour.ts，在下面接好）：每次仿真完告诉它数据换了 */
let tour: TourPlayer | undefined;
/** 仿真完的时候机场、港口的作业还在分段排：排完再告诉导览一次（等着开始的导览这时才开始） */
let tourAfterPlans = false;
view.onPlans = () => {
  hubMemo = undefined;
  ctxMemo = undefined;
  if (tourAfterPlans) {
    tourAfterPlans = false;
    tour?.ready();
  }
  // 设施作业刚排完（排完的最后一段还在这个任务里）：面板接着一个一个刷
  drawFrame(true, true);
};
/** 跑一次仿真；replan = 调度台改了计划（保持时刻和播放状态，只换数据） */
async function run(replan = false): Promise<void> {
  renderHint();
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  $('busy').hidden = false;
  $('busy-text').textContent = replan ? tr('按调整后的计划重新仿真 18 周（{gen}）…', { gen: tx(GEN_LABEL[gen]) }) : tr('正在仿真 18 周的全链路（{gen}，第 {seed} 组）…', { gen: tx(GEN_LABEL[gen]), seed });
  const wasPlaying = playing;
  setPlaying(false);
  try {
    const sc = scen(gen, seed);
    const standing = standingFor(gen);
    const day = dayFor(gen);
    const planChanged = !samePlan(standing, standingOf(sc));
    const timesChanged = Object.keys(day.depart).length + Object.keys(day.arrive).length > 0;
    const r = await call<{ result: ChainResult; ms: number }>(chainWorker, { gen, seed, drill, load, region, ...facReq(), ...(planChanged ? { standing } : {}), ...(timesChanged ? { day: { depart: day.depart, arrive: day.arrive } } : {}) } satisfies Omit<ChainRequest, 'id'>);
    result = r.result;
    const key = runKey();
    const kpiOf = (x: ChainResult) => buildBoard(x.trace?.ops ?? [], emptyDay(), boardCtx(sc)).kpi;
    if (!planChanged && !timesChanged) baseline.set(key, { result: r.result, kpi: kpiOf(r.result) });
    else if (!baseline.has(key)) {
      const b = await call<{ result: ChainResult }>(chainWorker, { gen, seed, drill, load, region, ...facReq() } satisfies Omit<ChainRequest, 'id'>);
      baseline.set(key, { result: b.result, kpi: kpiOf(b.result) });
    }
    const trace = result.trace;
    view.setSeed(seed);
    view.setLoad(LOADS[load].traffic);
    const list: WVehicle[] = [...(trace?.vehicles ?? [])];
    own = list.length;
    list.push(...decorVehicles(list.length));
    vehicleList = list;
    rebuildBoard();
    counter = new TraceCursor(list.slice(0, own), () => true);
    events = buildEvents(trace?.events ?? [], list.slice(0, own));
    $('clock-note').textContent = tr('仿真 {ms} 秒 · 当天 {own} 辆车、船、飞机', { ms: fmt(r.ms / 1000, 1), own });
    renderSummary();
    renderLegend();
    renderHourly();
    drawFrame(true, true);
    if (replan ? wasPlaying : wasPlaying || !hasPlayed) setPlaying(true);
    hasPlayed = true;
    $('busy').hidden = true;
    tour?.ready();
    tourAfterPlans = view.plansPending;
  } catch (err) {
    $('busy-text').textContent = tr('仿真出错：{err}', { err: String(err) });
  } finally {
    btn.disabled = false;
  }
  void loadStore();
}

/** 综合店的生鲜食品区：上一代是 Storewright 那一代的门店，StoreX 和全链路是 StoreX 门店；店里的人和机器人用 StoreX 的仿真 */
async function loadStore(): Promise<void> {
  const generation = gen === 'g1' ? 'gen1' : 'storex';
  const key = `${generation}:${seed}`;
  if (key === storeKey) return;
  storeKey = key;
  try {
    if (generation !== storeGen) {
      storeGen = generation;
      view.setStoreLayout(buildLayout(generation));
      view.setStoreAgents([]);
    }
    const r = await call<{ agents: AgentTrace[] }>(storeWorker, { generation, seed } satisfies Omit<StoreRequest, 'id'>);
    if (storeKey !== key) return;
    view.setStoreAgents(r.agents);
  } catch {
    storeKey = '';
  }
}

/** 动态：仿真记录的事件 + 从轨迹里找出的几个时刻（第一辆车出发、班轮、铁路、综合店到货） */
function buildEvents(base: readonly WEvent[], list: readonly WVehicle[]): WEvent[] {
  const out: WEvent[] = [...base];
  const delivery = list.filter((v) => /配送车 ·/.test(v.label));
  if (delivery.length) {
    const first = Math.min(...delivery.map((v) => v.segs[0]?.t0 ?? Infinity));
    const last = Math.max(...delivery.map((v) => v.segs[v.segs.length - 1]?.t1 ?? 0));
    if (first >= 0 && first < 86400) out.push({ t: first, text: tr('第一辆门店配送车出发（全天 {length} 车次）', { length: delivery.length }) });
    if (last > 0 && last < 86400) out.push({ t: last, text: tr('最后一辆门店配送车回到车场') });
  }
  for (const v of list) {
    for (const s of v.segs) {
      if (s.t0 < 0 || s.t0 >= 86400) continue;
      if (v.kind === 'ship' && s.act === '进港') out.push({ t: s.t0, text: tr('本周班轮进港') });
      if (v.kind === 'ship' && s.act === '离港') out.push({ t: s.t0, text: tr('班轮卸完离港') });
      if (v.kind === 'train' && s.act?.startsWith('港口')) out.push({ t: s.t0, text: tr('港口铁路接驳发车（{exec} 个自己的箱）', { exec: /(\d+) 箱/.exec(v.label)?.[1] ?? '' }) });
      if (v.kind === 'train' && s.act === '在货运站卸箱') out.push({ t: s.t0, text: tr('港口铁路接驳到达物流园货运站') });
      if (v.kind === 'train' && s.act === '班列进站') out.push({ t: s.t1, text: tr('洲际铁路班列到达物流园货运站（本店 {exec} 箱，查验卸箱后进配送中心）', { exec: /(\d+) 箱/.exec(v.label)?.[1] ?? '' }) });
      if (s.act === `在${STORE.name}卸货`) out.push({ t: s.t0, text: tr('{split}到{name}卸货', { split: tx(v.label.split(' · ')[0] ?? ''), name: tx(STORE.name) }) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// —— 播放 ——
const playBtn = $<HTMLButtonElement>('play');
const timeInput = $<HTMLInputElement>('time');
/** 播放循环的编号：暂停后很快又播放时，上一轮还没退出的循环认出自己过时了就停下 */
let loopToken = 0;
function setPlaying(on: boolean): void {
  const was = playing;
  playing = on;
  view.setPlaying(on);
  playBtn.textContent = on ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', on ? tr('暂停') : tr('播放'));
  // 已经在播放就不再开第二个循环（两个循环一起走，时钟会快一倍，还可能倒退）
  if (on && !was) {
    lastFrame = performance.now();
    const my = ++loopToken;
    requestAnimationFrame((now) => loop(now, my));
  }
}
playBtn.onclick = () => {
  if (!playing && t >= DAY_END - 60) t = 0;
  setPlaying(!playing);
};
timeInput.oninput = () => {
  t = Number(timeInput.value);
  drawFrame(true);
};
$<HTMLSelectElement>('speed').onchange = (e) => (speed = Number((e.target as HTMLSelectElement).value));
function loop(now: number, my: number): void {
  if (!playing || my !== loopToken) return;
  // 帧的时间戳可能早于刚才设的 lastFrame（主线程忙了一阵以后）：不让时钟倒退
  const dt = Math.max(0, Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
  t = Math.min(DAY_END, t + dt * speed);
  drawFrame();
  if (t >= DAY_END) setPlaying(false);
  else requestAnimationFrame((n) => loop(n, my));
}

let lastPanel = -1;
/**
 * 几个重的面板整体刷新（值班助手、分层看板、跟踪表、设施概况）一个面板一个任务地接着刷，不和换一天的排车、画面挤在同一个长任务里：
 * 换一天、闭环结果回来、设施作业排完时用（drawFrame(true, true)）。已经排着的不再排（轮到时按那一刻的时刻刷）；?syncplans=1 时当场刷完。
 */
const panelsNow = new URLSearchParams(location.search).get('syncplans') === '1';
let panelJobs: (() => void)[] | undefined;
function panelsSoon(): void {
  const jobs = [() => assistant.setTime(t, true), () => kpiPanel.setTime(t, true), () => renderTracking(true), () => renderFacility(true)];
  if (panelsNow) {
    for (const j of jobs) j();
    return;
  }
  if (panelJobs) return;
  panelJobs = jobs;
  const next = (): void => {
    const job = panelJobs?.shift();
    if (!job) return void (panelJobs = undefined);
    job();
    if (panelJobs?.length) setTimeout(next, 0);
    else panelJobs = undefined;
  };
  setTimeout(next, 0);
}
/** 画一帧：时钟、三维、各个面板；force = 不管节流都刷；later = 重的面板放到接下来的几个任务里刷（panelsSoon） */
function drawFrame(force = false, later = false): void {
  view.setTime(t);
  dispatch.setTime(t);
  loopPanel.setTime(t);
  if (!later) assistant.setTime(t, force);
  updateSplitLabels(force);
  if (!later) kpiPanel.setTime(t, force);
  timeInput.value = String(Math.round(t));
  const c = clock(t);
  $('time-label').textContent = c;
  $('clock').textContent = c;
  renderWeather(force);
  // 跟随别家的船、货机时，横幅上写它此刻在做什么
  const ft = view.followText();
  if (ft !== undefined && $('follow-text').textContent !== ft) $('follow-text').textContent = ft;
  const minute = Math.floor(t / 120);
  if (force || minute !== lastPanel) {
    lastPanel = minute;
    renderLive();
    renderLog();
  }
  if (later) panelsSoon();
  else {
    renderTracking(force);
    renderFacility(force);
  }
}

// —— 面板 ——
function renderLive(): void {
  if (!result?.trace) return;
  const list = view.vehicles.items;
  const n: Record<string, number> = {};
  let shipAct = '';
  for (let i = 0; i < own; i++) {
    const p = counter.pose(i, t);
    if (!p) continue;
    const kind = (list[i] as WVehicle).kind;
    n[kind] = (n[kind] ?? 0) + 1;
    if (kind === 'ship') shipAct = p.act ?? '';
  }
  const h = Math.min(23, Math.floor(t / 3600));
  const series = result.trace.series;
  const lostToday = (series.lost ?? []).slice(0, h + 1).reduce((a, b) => a + b, 0);
  const tiles: [string, string][] = [
    [`${(n.truck ?? 0) + (n.reefer ?? 0) + (n.ev ?? 0)}`, tr('路上的货车（配送、进货）')],
    [`${n.van ?? 0}`, tr('线上配送车、面包车')],
    [`${n.drayage ?? 0} / ${n.train ?? 0}`, tr('集装箱拖车 / 铁路班列')],
    [shipAct ? tx(shipAct.replace(/（.*）/, '')) : '—', tr('自己的班轮')],
    [`${n.plane ?? 0}`, tr('货运航班（在场）')],
    [fmt(series.dcDays?.[h] ?? 0, 1), tr('配送中心库存（天）')],
    [fmt(series.storeDays?.[h] ?? 0, 2), tr('门店库存（天）')],
    [fmt(lostToday / 1000, 1), tr('今天到现在的缺货（千件）')],
  ];
  $('live').innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join('');
}

const SUMMARY = ['service', 'storeInv', 'waste', 'freshRemain', 'dcInv', 'dcLabor', 'outKm', 'fleet', 'arrivals', 'costTotal', 'costPerCase', 'co2Local'];
function renderSummary(): void {
  if (!result) return;
  const base = ref.gens.find((g) => g.gen === 'g1')?.mean ?? {};
  const rows = SUMMARY.map((key) => {
    const k = kpi(key);
    const v = k.get(result as ChainResult);
    let delta = '—';
    let cls = '';
    if (gen !== 'g1' && base[key] !== undefined) {
      const b = base[key] as number;
      const pct = b !== 0 ? ((v - b) / Math.abs(b)) * 100 : 0;
      delta = `${pct > 0 ? '+' : ''}${fmt(pct, 0)}%`;
      if (Math.abs(pct) >= 1 && k.better !== 'none') cls = (pct < 0) === (k.better === 'lower') ? 'good' : 'bad';
    }
    return `<span class="k">${tx(k.label)}</span><span class="v">${fmt(v, k.digits ?? 1)}<small> ${tx(k.unit)}</small></span><span class="delta ${cls}">${delta}</span>`;
  });
  $('summary').innerHTML = `<span class="head">${tr('指标')}</span><span class="head" style="text-align:right">${tr('这次')}</span><span class="head" style="text-align:right" title="${tr('上一代 {compare} 个种子的平均', { compare: ref.seeds.compare })}">${tr('比上一代')}</span>${rows.join('')}`;
}

function renderLegend(): void {
  const list = view.vehicles.items;
  const counts = new Map<string, number>();
  for (const v of list) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  $('legend').innerHTML = '';
  for (const kind of Object.keys(VKIND_LABEL) as VKind[]) {
    const c = counts.get(kind);
    if (!c) continue;
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', String(!view.vehicles.hidden.has(kind)));
    b.innerHTML = `<span class="mark bar" style="background:${VKIND_COLOR[kind]}"></span><span>${VKIND_LABEL[kind]}</span><span class="count">${c}</span>`;
    b.onclick = () => {
      if (view.vehicles.hidden.has(kind)) view.vehicles.hidden.delete(kind);
      else view.vehicles.hidden.add(kind);
      b.setAttribute('aria-pressed', String(!view.vehicles.hidden.has(kind)));
      view.invalidate();
      drawFrame(true);
    };
    $('legend').append(b);
  }
  const traffic = document.createElement('button');
  traffic.setAttribute('aria-pressed', String(view.vehicles.traffic));
  traffic.innerHTML = `<span class="mark bar" style="background:#a3a6ab"></span><span>${tr('社会车流（背景，不参与仿真）')}</span><span class="count"></span>`;
  traffic.onclick = () => {
    view.vehicles.traffic = !view.vehicles.traffic;
    traffic.setAttribute('aria-pressed', String(view.vehicles.traffic));
    view.invalidate();
  };
  $('legend').append(traffic);
  const note = document.createElement('p');
  note.className = 'note legend-scale';
  note.textContent = tx(SCALE_NOTE);
  $('legend').append(note);
}

let logIdx = -1;
function renderLog(): void {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as WEvent).t <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === logIdx) return;
  logIdx = lo;
  const recent = events.slice(Math.max(0, lo - 14), lo).reverse();
  $('log').innerHTML = recent.map((e) => `<li><time>${clock(e.t)}</time><span>${esc(tx(e.text))}</span></li>`).join('') || `<li><span>${tr('还没有动静（夜里 2 点以后车辆陆续出发）')}</span></li>`;
}

/** 当天每小时：配送中心和门店的库存天数、缺货件数 */
function renderHourly(): void {
  const series = result?.trace?.series;
  if (!series) return;
  const hours = Array.from({ length: 24 }, (_, i) => String(i));
  const color = gen === 'g1' ? SERIES.gen1 : gen === 'g2' ? SERIES.storex : SERIES.noMfc;
  const charts = [
    lineChart({ title: tr('配送中心库存（当天每小时）'), subtitle: tr('天的需求'), x: hours, digits: 1, series: [{ name: tx(GEN_LABEL[gen]), color, values: (series.dcDays ?? []).map((v) => Number(v.toFixed(2))) }] }),
    lineChart({ title: tr('门店库存（当天每小时）'), subtitle: tr('天的需求'), x: hours, digits: 2, series: [{ name: tx(GEN_LABEL[gen]), color, values: (series.storeDays ?? []).map((v) => Number(v.toFixed(3))) }] }),
    lineChart({ title: tr('门店缺货（当天每小时）'), subtitle: tr('件'), x: hours, digits: 0, series: [{ name: tx(GEN_LABEL[gen]), color, values: (series.lost ?? []).map((v) => Math.round(v)) }] }),
  ];
  const names = [tr('配送中心库存'), tr('门店库存'), tr('门店缺货')];
  $('hourly').innerHTML = charts.map((svg, i) => `<img alt="${tr('{names}（当天每小时）', { names: names[i] })}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`).join('');
}

// —— 鼠标悬停、跟随 ——
const tip = $('tip');
view.onHover = (h: Hover | undefined) => {
  if (!h) {
    tip.hidden = true;
    return;
  }
  tip.hidden = false;
  // 对比回放右半边是另一天的车：作业按那一天的调度台找，点一下在右边选中
  const other = h.kind === 'vehicle' && h.half === 'right' && splitPair === 'days';
  const op = h.kind === 'vehicle' ? (other ? splitOther?.board : board)?.ops.find((o) => o.vehicle === h.picked.v.id) : undefined;
  if (h.kind === 'vehicle') tip.innerHTML = `<b>${esc(op ? `${op.id} · ` : '')}${esc(h.picked.v.label)}</b>${esc(tx(h.picked.act ?? ''))}${op?.unitId ? `<br>${tr('车辆 {unitId}', { unitId: esc(op.unitId) })}${op.door ? ` ${tr('· 月台门 {door}', { door: esc(op.door) })}` : ''}` : ''}<br><small>${other ? tr('另一天的车 · 点一下在右边选中，看路线和停靠点') : op ? tr('点一下在调度台里选中，看路线和停靠点') : tr('点一下跟随')}</small>`;
  // 港口、机场里别家的船、货机：船名或航班号、船型或机型、在做什么
  else if (h.kind === 'ext') tip.innerHTML = `<b>${esc(h.card.name)} · ${esc(tx(h.card.type))}</b>${esc(tx(h.card.act))}<br><small>${tr('别家的{v1}，不参与仿真 · 点一下跟随', { v1: h.target.src === 'port' ? tr('船') : tr('航班') })}</small>`;
  else tip.innerHTML = `<b>${esc(h.agent.label)}</b>${esc(tx(h.act ?? tr('待命')))}`;
  tip.style.left = `${Math.min($('view').clientWidth - 220, h.x + 14)}px`;
  tip.style.top = `${h.y + 14}px`;
};
view.onFollow = (v) => {
  $('follow').hidden = !v;
  if (v) $('follow-text').textContent = view.followText() ?? tr('跟随：{label}', { label: tx(v.label) });
};
$('follow-stop').onclick = () => view.setFollow(undefined);

// —— 标签页 ——
const rendered = new Set<string>(['twin']);
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.onclick = () => {
    const tab = b.dataset.tab as string;
    for (const x of document.querySelectorAll<HTMLButtonElement>('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== `tab-${tab}`;
    if (!rendered.has(tab)) {
      rendered.add(tab);
      // 报告、网络规划、说明用到时才加载（各自单独一块，不拖慢首屏）
      if (tab === 'report') void import('./report').then((m) => m.renderReport($('tab-report')));
      if (tab === 'network') void import('./networkTab').then((m) => m.renderNetwork($('tab-network')));
      if (tab === 'about') void import('./about').then((m) => m.renderAbout($('tab-about')));
    }
    if (tab === 'twin') view.show();
    else {
      view.hide();
      setPlaying(false);
    }
    history.replaceState(null, '', tab === 'twin' ? location.pathname + location.search : `#${tab}`);
  };
}
if (location.hash === '#report' || location.hash === '#network' || location.hash === '#about') document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${location.hash.slice(1)}"]`)?.click();

// —— 场景（src/scenario）：分享链接、场景库、导入的场景文件、练习的起始场景都走这里；别的模块通过 web/src/appBus.ts 调 ——
/** 带着场景参数重新载入页面（区域、设施不同要重建三维场景）；连续重载太多次就停下（防止死循环） */
function reloadWith(s: Scenario): void {
  try {
    const now = Date.now();
    const hist = (JSON.parse(sessionStorage.getItem('storex-chain-reloads') ?? '[]') as number[]).filter((x) => now - x < 15000);
    if (hist.length >= 3) {
      toast(tr('这个场景需要的区域或设施没能套上（页面已经重新载入了几次），先停在这里'), { kind: 'error' });
      return;
    }
    sessionStorage.setItem('storex-chain-reloads', JSON.stringify([...hist, now]));
  } catch {
    /* 读不了会话存储也照样载入 */
  }
  location.href = scenarioUrl(`${location.origin}${location.pathname}`, s, new URLSearchParams(location.search));
}
/** 这个场景要不要重新载入页面：区域（按规整后的写法比）或设施和现在的不一样 */
function needsReload(s: Scenario): boolean {
  const sameRegion = regionSpecText(regionSpecFrom(s.region ?? 'default')) === regionSpecText(region);
  return !sameRegion || JSON.stringify(mergeFacilities(defaultFacilities(), s.facilities)) !== JSON.stringify(facilities);
}
/** 方案、种子、负荷、演练（不写就是默认值）：设到状态和控件上，不跑仿真 */
function presetSim(s: Scenario): boolean {
  const want = { gen: s.gen ?? 'g3', seed: s.seed ?? 1, load: s.load ?? 'normal', drill: s.drill ?? 'none' };
  const changed = want.gen !== gen || want.seed !== seed || want.load !== load || want.drill !== drill;
  ({ gen, seed, load, drill } = want);
  for (const x of genBox.querySelectorAll<HTMLButtonElement>('button')) x.setAttribute('aria-pressed', String(x.dataset.gen === gen));
  seedInput.value = String(seed);
  loadSel.value = load;
  drillSel.value = drill;
  view.setWeatherDrill(drill);
  return changed;
}
/** 跟随的车：调度台的作业编号（M03、DR-02），大小写、补零、连字符都不讲究 */
function opForFollow(key: string): BoardOp | undefined {
  if (!board) return undefined;
  const direct = board.byId.get(key) ?? board.byId.get(key.toUpperCase());
  if (direct) return direct;
  const m = /^([a-z]+)-?0*(\d+)$/i.exec(key.trim());
  if (!m) return undefined;
  return board.ops.find((o) => {
    const n = /^([A-Z]+)-?0*(\d+)$/.exec(o.id);
    return !!n && n[1] === (m[1] as string).toUpperCase() && n[2] === m[2];
  });
}
/** 套用场景：区域、设施不同就重新载入页面；方案、种子、负荷、演练不同就重新仿真（这几项不写 = 默认值）；
 * 时刻、速度、播放、镜头、跟随、天气、页签不写就保持现在的样子；练习、导览发事件给各自的模块 */
async function applyScenario(s: Scenario): Promise<void> {
  if (needsReload(s)) {
    reloadWith(s);
    return;
  }
  // 正在放的导览会接着改时刻和镜头：换场景先停下（场景自己要放导览的，最后再开始）
  if (tour?.isActive) tour.stop();
  if (presetSim(s) || !result) await run();
  if (s.time !== undefined) t = Math.max(0, Math.min(DAY_END, s.time));
  if (s.speed !== undefined) {
    speed = s.speed;
    $<HTMLSelectElement>('speed').value = String(s.speed);
  }
  if (s.weather) {
    weatherSel.value = s.weather;
    view.setWeather(s.weather);
  }
  drawFrame(true);
  renderWeather(true);
  if (s.camera?.position && s.camera.target) {
    view.setFollow(undefined);
    view.camera.position.set(...s.camera.position);
    view.controls.target.set(...s.camera.target);
    view.controls.update();
    view.invalidate();
  } else if (s.camera?.preset) {
    view.focus(s.camera.preset, false);
    const tab = PRESET_TAB[s.camera.preset];
    if (tab) showFacility(tab);
  }
  if (s.follow) {
    const op = opForFollow(s.follow);
    if (op && op.vehicle >= 0) selectVehicleIndex(op.vehicle, true);
    else toast(tr('没找到要跟随的车「{id}」', { id: s.follow }), { kind: 'warn' });
  }
  if (s.play !== undefined) setPlaying(s.play && t < DAY_END);
  if (s.tab) document.querySelector<HTMLButtonElement>(`.tabs button[data-tab="${s.tab}"]`)?.click();
  if (s.exercise) document.dispatchEvent(new CustomEvent('storex:open-teach', { detail: { exercise: s.exercise } }));
  if (s.tour) document.dispatchEvent(new CustomEvent('storex:start-tour', { detail: { tour: s.tour } }));
}
/** 现在的设置写成场景（分享链接、导出场景文件、练习批改）：设施只写和默认的差别，镜头写位置和目标点 */
function currentScenario(): Scenario {
  const fac = facilitiesDiff(defaultFacilities(), facilities);
  const p = view.camera.position;
  const g = view.controls.target;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const fv = view.followed;
  const follow = fv !== undefined ? opByVehicle.get(fv)?.id : undefined;
  const tab = document.querySelector<HTMLButtonElement>('.tabs button[aria-selected="true"]')?.dataset.tab;
  return {
    format: SCENARIO_FORMAT,
    version: SCENARIO_VERSION,
    ...(region.mode !== 'default' ? { region: regionSpecText(region) } : {}),
    gen,
    seed,
    load,
    drill,
    ...(Object.keys(fac).length ? { facilities: fac } : {}),
    time: Math.round(Math.min(t, DAY_END)),
    speed,
    play: playing,
    camera: { position: [r1(p.x), r1(p.y), r1(p.z)], target: [r1(g.x), r1(g.y), r1(g.z)] },
    ...(follow ? { follow } : {}),
    ...(weatherSel.value !== 'auto' ? { weather: weatherSel.value as WeatherMode } : {}),
    ...(tab && tab !== 'twin' ? { tab: tab as Scenario['tab'] } : {}),
  };
}
// 练习批改要的「起始场景」结果：在单独的后台线程里跑（不动主线程那个后台线程里的区域和设施），按场景缓存
let teachWorker: Worker | undefined;
const teachMemo = new Map<string, Promise<NonNullable<TeachState['baseline']>>>();
function teachRun(s: Scenario): Promise<NonNullable<TeachState['baseline']>> {
  const g = s.gen ?? 'g3';
  const sd = s.seed ?? 1;
  const ld = s.load ?? 'normal';
  const dr = s.drill ?? 'none';
  const fac = mergeFacilities(defaultFacilities(), s.facilities);
  const key = JSON.stringify([regionSpecText(regionSpecFrom(s.region ?? 'default')), g, sd, ld, dr, facilitiesDiff(defaultFacilities(), fac)]);
  let p = teachMemo.get(key);
  if (!p) {
    if (!teachWorker) {
      teachWorker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      teachWorker.onmessage = (e) => {
        const cb = pending.get(e.data.id);
        pending.delete(e.data.id);
        cb?.(e.data);
      };
    }
    p = call<{ result: ChainResult }>(teachWorker, { gen: g, seed: sd, drill: dr, load: ld, region: regionSpecFrom(s.region ?? 'default'), facilities: fac } satisfies Omit<ChainRequest, 'id'>).then(({ result: res }) => {
      const sc = applyFacilities(withLoad(scenarioFor(g, sd), ld), fac);
      return { scenario: s, result: res, kpi: buildBoard(res.trace?.ops ?? [], emptyDay(), boardCtx(sc)).kpi };
    });
    p.catch(() => teachMemo.delete(key));
    teachMemo.set(key, p);
  }
  return p;
}
setAppApi({
  applyScenario,
  currentScenario,
  teachState: async (answers, start) => {
    if (!result || !board) return undefined;
    const st: TeachState = { scenario: currentScenario(), result, kpi: board.kpi, answers };
    if (start) st.baseline = await teachRun(start);
    return st;
  },
  time: () => t,
});
mountScenarioUi();
mountTeachHost();
mountOnboarding({ auto: onboardAuto(!!urlScen) });
// 演示导览：顶栏按钮、欢迎卡和场景里的 tour=container（'storex:start-tour' 事件）都能开始；数据取此刻的仿真、调度台、仓储中心计划和门店模型
tour = new TourPlayer($('view').parentElement as HTMLElement, {
  view,
  data: () => {
    if (!board || !result?.trace) return undefined;
    const sc = scen(gen, seed);
    return { vehicles: vehicleList.slice(0, own), ops: board.ops, hubs: hubDays(), portBoxes: view.port.info(t).boxes, storeAgents: view.storeAgents, dwellDays: sc.port.dwellDays, crossDock: !!sc.dc.crossDock, freshRemainPct: result.store.freshRemainPct, storeKey: STORE.key };
  },
  setTime: (x) => {
    t = x;
    drawFrame(true);
  },
  setPlaying,
  isPlaying: () => playing,
  getSpeed: () => speed,
  setSpeed: (x) => {
    speed = x;
  },
  busy: () => !$('busy').hidden || view.plansPending,
});
$('tour-btn').onclick = () => tour?.start();

/** 打开网页：网址里有场景（或场景库的编号）就先把方案这些设好再跑第一次仿真，跑完套用时刻、镜头……；
 * 导览、练习这种「一次性」的参数套用后从网址里去掉（刷新不会再放一遍） */
async function boot(): Promise<void> {
  let s = urlScen?.scenario;
  if (urlScen) showIssues(urlScen, tr('链接里的场景'));
  if (urlScen?.library) {
    const lib = await loadLibraryScenario(urlScen.library);
    showIssues(lib, tr('场景库里的场景'));
    if (lib.scenario) s = mergeScenario(lib.scenario, s ?? {});
  }
  if (s && needsReload(s)) {
    reloadWith(s);
    return;
  }
  if (s) presetSim(s);
  await run();
  if (s) await applyScenario(s);
  document.dispatchEvent(new CustomEvent('storex:ready', { detail: { scenario: !!s } }));
  const q = new URLSearchParams(location.search);
  if (q.has('tour') || q.has('ex')) {
    q.delete('tour');
    q.delete('ex');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
  }
}
void boot();

// 开发时给调试和截图脚本用（打包后不存在）
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __twin: unknown }).__twin = { view, board: () => board, tour: () => tour };
