import { create } from 'zustand';
import { createTemplate, generateStoreConfig, StoreModel, validateStoreConfig, type ConfigIssue, type GeneratorParams, type StoreConfig, type TemplateName } from '@storewright/store-config';
import { defaultNightCrew, defaultScenario, DISRUPTION_MINUTES, scaledStaffing, shiftStaffing, storeSizing, type Disruption, type DisruptionKind, type Role, type Staffing } from '@storewright/sim-engine';
import { SimClient } from '../sim/client';
import type { DayDigest, PolicyDigest, PolicyName, Timeline } from '../sim/protocol';
import { applyLang, ensureLang, getLang, t, type Lang } from '../i18n';
import { digestOf, loadCosts, loadSavedScenarios, persistCosts, persistScenarios, type SavedScenario } from './scenarios';
import type { CostParams } from '@storewright/sim-engine';
import { buildGeometry, type StoreGeometry } from '../scene/layout';
import type { SiteSettings } from '../scene/site';
import type { MenuTarget } from '../scene/contextTarget';
import { clock, setRange, setTime } from './clock';

export type ViewMode = 'iso' | '3d' | 'top';
export type CameraCmd = 'in' | 'out' | 'reset' | 'rotateLeft' | 'rotateRight' | 'front' | 'side' | 'bird' | 'street';
export type DataTab = 'live' | 'compare' | 'report' | 'events' | 'edit' | 'ops';
export type SplitOrder = 'scene-left' | 'scene-right';
export type Overlay = 'temp' | 'heat' | 'stock' | 'none';
export type AppMode = 'sim' | 'edit';
/** 画质：高 = 阴影 + 高分辨率，中 = 无阴影，低 = 无阴影 + 标准分辨率 */
export type Quality = 'high' | 'medium' | 'low';
/** 建筑查看方式：内部（无外壳）、半剖（一半外观一半内部）、外观 */
export type BuildingView = 'interior' | 'cutaway' | 'exterior';

export type Selection =
  | { type: 'associate'; id: string }
  | { type: 'run'; id: string }
  | { type: 'car'; id: string }
  | { type: 'staging'; id: string }
  | { type: 'facility'; id: string };

export interface Focus {
  x: number;
  y: number;
  z: number;
  seq: number;
}

interface AppState {
  template: TemplateName;
  policy: PolicyName;
  seed: number;
  demandFactor: number;
  staffing: Staffing;
  /** 自定义门店：按规模插值的日订单量与排班倍数（模板门店为空，使用模板默认值） */
  sizing?: { ordersPerDay: number; staffScale: number };
  config: StoreConfig;
  model: StoreModel;
  geo: StoreGeometry;
  timeline?: Timeline;
  /** 与 timeline 对应的门店模型（编辑时 model/geo 是草稿预览，人和车仍按仿真时的布局移动） */
  simModel: StoreModel;
  simGeo: StoreGeometry;
  status: 'running' | 'ready' | 'error';
  error?: string;
  view: ViewMode;
  floor: string;
  overlay: Overlay;
  mode: AppMode;
  selection?: Selection;
  focus?: Focus;
  /** 镜头指令：缩放、复位、旋转 90°、预设机位（序号递增触发） */
  zoomCmd?: { kind: CameraCmd; seq: number };
  zoom(kind: CameraCmd): void;
  /** 把镜头对准一个点并让半径 radius 米的范围填满画面（导览用；保持当前视线方向） */
  frameCmd?: { x: number; y: number; z: number; radius: number; seq: number };
  frame(x: number, y: number, z: number, radius: number): void;
  /** 自动镜头巡游：开启时由巡游导演接管镜头，界面收起 */
  cinematic: boolean;
  setCinematic(on: boolean): void;
  /** 门店实况（连接后端的 Live 模式） */
  live: { status: 'off' | 'connecting' | 'live' | 'offline'; url: string; storeId: string; error?: string };
  /** 场景中只显示实时数据（隐藏仿真的人和车） */
  liveView: boolean;
  /** 实时状态每次变化加一 */
  liveVersion: number;
  setLiveView(on: boolean): void;
  /** 巡游当前镜头的字幕与进度 */
  cinematicCaption?: { text: string; i: number; n: number };
  /** 导览：当前步骤（未开始时为空） */
  tourStep?: number;
  setTourStep(step?: number): void;
  /** 右键菜单 */
  menu?: { x: number; y: number; target: MenuTarget };
  setMenu(m?: { x: number; y: number; target: MenuTarget }): void;
  minimap: boolean;
  help: boolean;
  sound: boolean;
  toggle(key: 'minimap' | 'help' | 'sound'): void;
  /** 镜头跟随的对象（员工或车辆 id） */
  follow?: string;
  setFollow(id?: string): void;
  /** 编辑模式：每次通过校验的修改都会实时应用到仿真 */
  draft?: StoreConfig;
  draftIssues: ConfigIssue[];
  /** 编辑中选中的通道（多选）；editRunId 为最后选中的一条，属性面板显示它 */
  editRunId?: string;
  editSel: string[];
  /** 编辑工具：选择 / 拖动，或画新通道 */
  editTool: 'select' | 'draw';
  setEditTool(t: 'select' | 'draw'): void;
  /** 编辑操作的提示（例如旋转后接不上走廊） */
  editNotice?: { text: string; seq: number };
  notifyEdit(text: string): void;
  editBaseline?: StoreConfig;
  history: StoreConfig[];
  future: StoreConfig[];
  /** 分屏布局 */
  split: SplitOrder;
  ratio: number;
  tab: DataTab;
  /** 策略对比（后台计算） */
  compare: { status: 'idle' | 'running' | 'ready' | 'error'; results?: PolicyDigest[] };
  /** 界面语言 */
  lang: Lang;
  setLang(l: Lang): void;
  /** 保存的方案（本机）与 A / B 对比的选择（'current' 为当前方案） */
  scenarios: SavedScenario[];
  ab: [string, string];
  setAB(i: 0 | 1, id: string): void;
  saveScenario(name: string, thumb?: string): SavedScenario | undefined;
  removeScenario(id: string): void;
  renameScenario(id: string, name: string): void;
  loadScenario(id: string): void;
  /** 经营账的单价假设 */
  costs: CostParams;
  setCosts(patch: Partial<CostParams>): void;
  /** 连续多天模拟 */
  multiDay: { status: 'idle' | 'running' | 'ready' | 'error'; days?: DayDigest[]; done?: number; total?: number; configVersion?: number };
  runMultiDay(days: number): Promise<void>;
  /** 周边环境：道路风格、随机种子、拥堵强度 */
  site: SiteSettings;
  setSite(patch: Partial<SiteSettings>): void;
  /** 修改营业时间（写入草稿并实时应用），排班随之平移 */
  setHours(openMin: number, closeMin: number): void;
  /** 当前门店规模和营业时间下的默认排班 */
  defaultStaffing(): Staffing;
  quality: Quality;
  setQuality(q: Quality): void;
  /** 突发状况设置 */
  incidents: { small: boolean; randomLarge: boolean; manual: Disruption[] };
  setIncidents(patch: Partial<{ small: boolean; randomLarge: boolean }>): void;
  /** 从当前时刻起触发一个大事件 */
  triggerIncident(kind: DisruptionKind): void;
  removeIncident(id: string): void;
  /** 货架存量模型（Phase 4）：货架空 → Exception → 补货任务 → 货架恢复 */
  shelfStock: boolean;
  setShelfStock(on: boolean): void;
  /** AI 模块：按预测排班（总工时不变）、修正到店时间、替代推荐 */
  ai: boolean;
  setAi(on: boolean): void;
  /** 手动请求的补货（点击货架）：商品与仿真时刻 */
  restockRequests: Array<{ itemId: string; t: number }>;
  requestRestock(itemId: string): void;
  /** 夜班补货组：启用与人数（undefined 表示按门店规模自动） */
  nightCrew: { enabled: boolean; crew?: number };
  setNightCrew(patch: { enabled?: boolean; crew?: number }): void;
  nightCrewSize(): number;
  buildingView: BuildingView;
  /** 半剖时剖切面的位置（0–1，沿门店宽度方向） */
  cutPos: number;
  setBuildingView(v: BuildingView): void;
  setCutPos(p: number): void;
  /** 按生成参数重建整个门店（作为一次可撤销的编辑实时应用） */
  applyGenerated(params: GeneratorParams): ConfigIssue[];

  setTemplate(t: TemplateName): void;
  setPolicy(p: PolicyName): void;
  setView(v: ViewMode): void;
  setFloor(f: string): void;
  setOverlay(o: Overlay): void;
  select(s?: Selection): void;
  focusOn(x: number, y: number, z: number): void;
  setDemandFactor(f: number): void;
  reassign(from: Role, to: Role): void;
  adjustStaff(role: Role, delta: number): void;
  resetScenario(): void;
  simulate(): Promise<void>;
  enterEdit(): void;
  exitEdit(apply: boolean): void;
  updateDraft(fn: (draft: StoreConfig) => void): void;
  /** additive：按住 Shift / ⌘ 点选时加入或移出多选 */
  setEditRun(id?: string, additive?: boolean): void;
  setEditSel(ids: string[]): void;
  loadDraft(config: unknown): ConfigIssue[];
  undo(): void;
  redo(): void;
  setTab(t: DataTab): void;
  swapSplit(): void;
  setRatio(r: number): void;
  runCompare(): Promise<void>;
}

const client = new SimClient();
let liveTimer: number | undefined;
let compareTimer: number | undefined;

function derive(config: StoreConfig): { model: StoreModel; geo: StoreGeometry } {
  const model = new StoreModel(config);
  return { model, geo: buildGeometry(model) };
}

function cloneConfig(c: StoreConfig): StoreConfig {
  return JSON.parse(JSON.stringify(c)) as StoreConfig;
}

const initialConfig = createTemplate('medium');
const initialDerived = derive(initialConfig);

/** 从当前小时起修改排班 */
function staffingFrom(staffing: Staffing, hour: number, fn: (h: number, s: Staffing) => void): Staffing {
  const next: Staffing = { pick: [...staffing.pick], stage: [...staffing.stage], handoff: [...staffing.handoff], exception: [...staffing.exception] };
  for (let h = hour; h < 24; h++) fn(h, next);
  return next;
}

export const useApp = create<AppState>((set, get) => ({
  template: 'medium',
  policy: 'optimized',
  seed: 1,
  demandFactor: 1,
  staffing: defaultScenario('medium').staffing,
  config: initialConfig,
  ...initialDerived,
  simModel: initialDerived.model,
  simGeo: initialDerived.geo,
  status: 'running',
  view: 'iso',
  floor: 'F1',
  overlay: 'temp',
  mode: 'sim',
  draftIssues: [],
  history: [],
  future: [],
  split: 'scene-left',
  ratio: 62,
  tab: 'live',
  compare: { status: 'idle' },
  lang: getLang(),
  setLang(l) {
    if (l === get().lang) return;
    void ensureLang(l).then(() => {
      applyLang(l);
      set({ lang: l });
      // 事件提醒等文字在 Worker 里生成，换语言后重新仿真一次（约 0.1–0.3 秒）
      void get().simulate();
    });
  },
  scenarios: loadSavedScenarios(),
  ab: ['current', 'current'],
  setAB(i, id) {
    const ab: [string, string] = [...get().ab];
    ab[i] = id;
    set({ ab });
  },
  saveScenario(name, thumb) {
    const st = get();
    if (!st.timeline) return undefined;
    const sc: SavedScenario = {
      id: `S${Date.now().toString(36)}`,
      name: name.trim() || t('方案 {0}', st.scenarios.length + 1),
      savedAt: Date.now(),
      thumb,
      settings: {
        template: st.template,
        policy: st.policy,
        seed: st.seed,
        demandFactor: st.demandFactor,
        staffing: structuredClone(st.staffing),
        site: { ...st.site },
        sizing: st.sizing ? { ...st.sizing } : undefined,
        incidents: structuredClone(st.incidents),
        nightCrew: { ...st.nightCrew },
        config: cloneConfig(st.config),
      },
      digest: digestOf(st.timeline, st.config),
    };
    const scenarios = [...st.scenarios, sc];
    set({ scenarios, ab: st.ab[0] === 'current' && st.ab[1] === 'current' ? [sc.id, 'current'] : st.ab });
    persistScenarios(scenarios);
    return sc;
  },
  removeScenario(id) {
    const scenarios = get().scenarios.filter((x) => x.id !== id);
    const ab = get().ab.map((x) => (x === id ? 'current' : x)) as [string, string];
    set({ scenarios, ab });
    persistScenarios(scenarios);
  },
  renameScenario(id, name) {
    const scenarios = get().scenarios.map((x) => (x.id === id ? { ...x, name } : x));
    set({ scenarios });
    persistScenarios(scenarios);
  },
  loadScenario(id) {
    const sc = get().scenarios.find((x) => x.id === id);
    if (!sc) return;
    if (get().mode === 'edit') get().exitEdit(false);
    const st = sc.settings;
    const config = cloneConfig(st.config);
    set({
      template: st.template,
      policy: st.policy,
      seed: st.seed,
      demandFactor: st.demandFactor,
      staffing: structuredClone(st.staffing),
      site: { ...st.site },
      sizing: st.sizing ? { ...st.sizing } : undefined,
      incidents: structuredClone(st.incidents),
      nightCrew: { ...st.nightCrew },
      config,
      ...derive(config),
      floor: 'F1',
      selection: undefined,
    });
    void get().simulate();
  },
  costs: loadCosts(),
  setCosts(patch) {
    const costs = { ...get().costs, ...patch };
    set({ costs });
    persistCosts(costs);
  },
  multiDay: { status: 'idle' },
  async runMultiDay(days) {
    const { config, template, policy, seed, demandFactor, staffing, site, sizing } = get();
    set({ multiDay: { status: 'running', done: 0, total: days, configVersion: config.configVersion } });
    const nightCrew = { enabled: get().nightCrew.enabled, crew: get().nightCrewSize() };
    const req = client.latestMultiDay + 1;
    try {
      const result = await client.multiDay(
        { config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai },
        days,
        (done, total) => {
          if (client.latestMultiDay === req) set({ multiDay: { ...get().multiDay, done, total } });
        },
      );
      if (client.latestMultiDay !== req) return;
      set({ multiDay: { status: 'ready', days: result, done: days, total: days, configVersion: config.configVersion } });
    } catch {
      set({ multiDay: { status: 'error' } });
    }
  },
  site: { style: 'suburban', seed: 1, traffic: 1, weather: 'clear', season: 'autumn' },
  // 手机等触屏设备默认关闭实时阴影
  quality: typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'medium' : 'high',
  setQuality(q) {
    set({ quality: q });
  },
  incidents: { small: true, randomLarge: false, manual: [] },
  setIncidents(patch) {
    set({ incidents: { ...get().incidents, ...patch } });
    void get().simulate();
  },
  triggerIncident(kind) {
    const [a, b] = DISRUPTION_MINUTES[kind];
    const start = Math.round(clock.time);
    const d: Disruption = { id: `M${Date.now() % 100000}-${kind}`, kind, start, end: start + Math.round(((a + b) / 2) * 60) };
    set({ incidents: { ...get().incidents, manual: [...get().incidents.manual, d] } });
    void get().simulate();
  },
  removeIncident(id) {
    set({ incidents: { ...get().incidents, manual: get().incidents.manual.filter((d) => d.id !== id) } });
    void get().simulate();
  },
  shelfStock: true,
  setShelfStock(on) {
    set({ shelfStock: on });
    void get().simulate();
  },
  ai: true,
  setAi(on) {
    set({ ai: on });
    void get().simulate();
  },
  restockRequests: [],
  requestRestock(itemId) {
    set({ restockRequests: [...get().restockRequests, { itemId, t: Math.round(clock.time) }] });
    void get().simulate();
  },
  nightCrew: { enabled: true },
  setNightCrew(patch) {
    set({ nightCrew: { ...get().nightCrew, ...patch } });
    void get().simulate();
  },
  nightCrewSize() {
    const { nightCrew, sizing, template } = get();
    const k = sizing?.staffScale ?? (template === 'small' ? 0.3 : template === 'large' ? 2.5 : 1);
    return nightCrew.crew ?? defaultNightCrew(k);
  },
  buildingView: 'interior',
  cutPos: 0.5,
  setBuildingView(v) {
    set({ buildingView: v });
  },
  setCutPos(p) {
    set({ cutPos: Math.min(0.95, Math.max(0.05, p)) });
  },

  setTemplate(t) {
    const config = createTemplate(t);
    set({ template: t, config, ...derive(config), staffing: defaultScenario(t).staffing, sizing: undefined, demandFactor: 1, floor: 'F1', selection: undefined, nightCrew: { enabled: get().nightCrew.enabled } });
    void get().simulate();
  },
  setPolicy(p) {
    set({ policy: p });
    void get().simulate();
  },
  setView(v) {
    set({ view: v });
  },
  setFloor(f) {
    set({ floor: f });
  },
  setOverlay(o) {
    set({ overlay: o });
  },
  select(s) {
    set({ selection: s, follow: s && get().follow === s.id ? get().follow : undefined });
  },
  zoom(kind) {
    set({ zoomCmd: { kind, seq: (get().zoomCmd?.seq ?? 0) + 1 } });
  },
  frame(x, y, z, radius) {
    set({ frameCmd: { x, y, z, radius, seq: (get().frameCmd?.seq ?? 0) + 1 } });
  },
  live: { status: 'off', url: 'http://localhost:8787', storeId: 'demo' },
  liveView: false,
  liveVersion: 0,
  setLiveView(on) {
    set({ liveView: on });
  },
  cinematic: false,
  setCinematic(on) {
    set({ cinematic: on, ...(on ? { selection: undefined, follow: undefined, menu: undefined, tourStep: undefined } : {}) });
  },
  setTourStep(step) {
    set({ tourStep: step });
  },
  setFollow(id) {
    set({ follow: id });
  },
  setMenu(m) {
    set({ menu: m });
  },
  minimap: typeof window === 'undefined' || window.innerWidth > 900,
  help: false,
  sound: false,
  toggle(key) {
    set({ [key]: !get()[key] } as Partial<AppState>);
  },
  focusOn(x, y, z) {
    set({ focus: { x, y, z, seq: (get().focus?.seq ?? 0) + 1 } });
  },
  setDemandFactor(f) {
    set({ demandFactor: f });
    void get().simulate();
  },
  reassign(from, to) {
    const hour = Math.floor(clock.time / 3600);
    const staffing = staffingFrom(get().staffing, hour, (h, s) => {
      if ((s[from][h] ?? 0) > 0) {
        s[from][h] = (s[from][h] as number) - 1;
        s[to][h] = (s[to][h] ?? 0) + 1;
      }
    });
    set({ staffing });
    void get().simulate();
  },
  adjustStaff(role, delta) {
    const hour = Math.floor(clock.time / 3600);
    const staffing = staffingFrom(get().staffing, hour, (h, s) => {
      if ((s[role][h] ?? 0) > 0 || delta > 0) s[role][h] = Math.max(0, (s[role][h] ?? 0) + delta);
    });
    set({ staffing });
    void get().simulate();
  },
  resetScenario() {
    set({ staffing: get().defaultStaffing(), demandFactor: 1 });
    void get().simulate();
  },
  defaultStaffing() {
    const { sizing, template } = get();
    const hours = (get().draft ?? get().config).hours;
    const base = sizing ? scaledStaffing(sizing.staffScale) : defaultScenario(template).staffing;
    return shiftStaffing(base, hours.openMin, hours.closeMin);
  },
  setHours(openMin, closeMin) {
    if (get().mode !== 'edit') get().enterEdit();
    get().updateDraft((d) => {
      d.hours = { openMin, closeMin };
    });
    set({ staffing: get().defaultStaffing() });
  },
  applyGenerated(params) {
    if (get().mode !== 'edit') get().enterEdit();
    const config = generateStoreConfig(params);
    // 日订单量和排班按门店规模连续插值；需求的时段分布取最接近的模板，排班再平移到营业时间
    const aisles = params.ambientAisles + params.frozenAisles + params.gmAislesF1 + (params.secondFloor?.gmAisles ?? 0);
    const size: TemplateName = aisles <= 11 ? 'small' : aisles <= 23 ? 'medium' : 'large';
    const s = storeSizing(aisles);
    const sizing = { ordersPerDay: s.ordersPerDay, staffScale: Math.round(s.staffScale * (params.staffScale ?? 1) * 100) / 100 };
    set({ template: size, sizing, staffing: shiftStaffing(scaledStaffing(sizing.staffScale), config.hours.openMin, config.hours.closeMin) });
    const issues = get().loadDraft(config);
    if (!issues.length) set({ floor: 'F1', editRunId: undefined, editSel: [] });
    return issues;
  },
  setSite(patch) {
    const prev = get().site;
    set({ site: { ...prev, ...patch } });
    // 拥堵强度和天气影响到店时间与作业，需要重新仿真；道路风格、种子、季节只影响画面
    // （「多变」天气由季节和种子生成，这两项改了也要重新仿真）
    const next = get().site;
    const dynChanged = next.weather === 'dynamic' && ((patch.season !== undefined && patch.season !== prev.season) || (patch.seed !== undefined && patch.seed !== prev.seed));
    if ((patch.traffic !== undefined && patch.traffic !== prev.traffic) || (patch.weather !== undefined && patch.weather !== prev.weather) || dynChanged) void get().simulate();
  },
  async simulate() {
    const { config, template, policy, seed, demandFactor, staffing, site, sizing } = get();
    set({ status: 'running', error: undefined });
    const req = client.latest + 1;
    try {
      const nightCrew = { enabled: get().nightCrew.enabled, crew: get().nightCrewSize() };
      const timeline = await client.simulate({ config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai });
      if (client.latest !== req) return; // 有更新的请求，丢弃旧结果
      const cur = get();
      const sim = cur.model.config === config ? { model: cur.model, geo: cur.geo } : derive(config);
      // 首次加载从 10:00 开始（门店已经忙起来）；之后重新仿真时保留当前时刻
      const keep = clock.time > timeline.start ? clock.time : 10 * 3600;
      setRange(timeline.start, timeline.end);
      setTime(keep);
      set({ timeline, status: 'ready', simModel: sim.model, simGeo: sim.geo });
      // 策略对比在另一个 Worker 中稍后计算，不影响播放
      window.clearTimeout(compareTimer);
      compareTimer = window.setTimeout(() => void get().runCompare(), 400);
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },
  enterEdit() {
    const base = cloneConfig(get().config);
    set({ mode: 'edit', tab: 'edit', draft: cloneConfig(base), editBaseline: base, history: [], future: [], draftIssues: [], editRunId: undefined, editSel: [], editTool: 'select', selection: undefined });
  },
  exitEdit(keep) {
    window.clearTimeout(liveTimer);
    const { editBaseline, draft, draftIssues, config, tab } = get();
    const nextTab = tab === 'edit' ? 'live' : tab;
    const closed = { mode: 'sim' as const, draft: undefined, draftIssues: [], editRunId: undefined, editSel: [], editTool: 'select' as const, editBaseline: undefined, history: [], future: [], tab: nextTab };
    if (!keep && editBaseline) {
      // 撤销全部修改：恢复进入编辑前的配置并重新仿真
      set({ config: editBaseline, ...derive(editBaseline), ...closed });
      void get().simulate();
      return;
    }
    // 保留最后一次通过校验的布局；还在防抖等待中的修改立即应用
    const pending = !!draft && draftIssues.length === 0 && draft.configVersion !== config.configVersion;
    const final = pending && draft ? draft : config;
    set({ config: final, ...derive(final), ...closed });
    if (pending) void get().simulate();
  },
  updateDraft(fn) {
    const draft = get().draft;
    if (!draft) return;
    const next = cloneConfig(draft);
    fn(next);
    next.configVersion = draft.configVersion + 1;
    set({ history: [...get().history.slice(-49), draft], future: [] });
    applyDraft(next);
  },
  setEditRun(id, additive) {
    if (!additive) {
      set({ editRunId: id, editSel: id ? [id] : [] });
      return;
    }
    if (!id) return;
    const cur = get().editSel;
    const sel = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set({ editSel: sel, editRunId: sel[sel.length - 1] });
  },
  setEditSel(ids) {
    set({ editSel: ids, editRunId: ids[ids.length - 1] });
  },
  editSel: [],
  editTool: 'select',
  setEditTool(t) {
    set({ editTool: t });
  },
  notifyEdit(text) {
    set({ editNotice: { text, seq: (get().editNotice?.seq ?? 0) + 1 } });
  },
  loadDraft(config) {
    const res = validateStoreConfig(config);
    if (!res.ok) {
      set({ draftIssues: res.issues });
      return res.issues;
    }
    const draft = get().draft;
    if (draft) set({ history: [...get().history.slice(-49), draft], future: [] });
    // 版本号保持递增，界面据此判断改动是否已经应用到仿真
    applyDraft({ ...res.config, configVersion: Math.max(draft?.configVersion ?? 0, get().config.configVersion) + 1 });
    return [];
  },
  undo() {
    const { history, draft } = get();
    const prev = history[history.length - 1];
    if (!prev || !draft) return;
    set({ history: history.slice(0, -1), future: [draft, ...get().future] });
    applyDraft(prev);
  },
  redo() {
    const { future, draft } = get();
    const next = future[0];
    if (!next || !draft) return;
    set({ future: future.slice(1), history: [...get().history, draft] });
    applyDraft(next);
  },
  setTab(tab) {
    if (tab === 'edit' && get().mode !== 'edit') get().enterEdit();
    else set({ tab });
  },
  swapSplit() {
    set({ split: get().split === 'scene-left' ? 'scene-right' : 'scene-left' });
  },
  setRatio(r) {
    set({ ratio: Math.min(78, Math.max(32, r)) });
  },
  async runCompare() {
    const { config, template, seed, demandFactor, staffing, site, sizing } = get();
    set({ compare: { ...get().compare, status: 'running' } });
    const req = client.latestCompare + 1;
    try {
      const results = await client.compare({ config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, lang: get().lang, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai });
      if (client.latestCompare !== req) return;
      set({ compare: { status: 'ready', results } });
    } catch {
      set({ compare: { status: 'error' } });
    }
  },
}));

/**
 * 把草稿用于预览；通过校验时，稍后实时应用到仿真（不暂停播放）。
 */
function applyDraft(next: StoreConfig): void {
  const res = validateStoreConfig(next);
  let preview: { model: StoreModel; geo: StoreGeometry } | undefined;
  try {
    preview = derive(next);
  } catch {
    preview = undefined;
  }
  useApp.setState({ draft: next, draftIssues: res.ok ? [] : res.issues, ...(preview ?? {}) });
  window.clearTimeout(liveTimer);
  if (!res.ok) return;
  liveTimer = window.setTimeout(() => {
    useApp.setState({ config: res.config });
    void useApp.getState().simulate();
  }, 350);
}
