import { create } from 'zustand';
import { createTemplate, generateStoreConfig, StoreModel, validateStoreConfig, type ConfigIssue, type GeneratorParams, type StoreConfig, type TemplateName } from '@storewright/store-config';
import { defaultNightCrew, defaultScenario, DISRUPTION_MINUTES, scaledStaffing, shiftStaffing, storeSizing, type Advice, type AdviceAction, type AdviceArea, type Disruption, type DisruptionKind, type FrontInput, type InboundAdjust, type Role, type Staffing } from '@storewright/sim-engine';
import { SimClient } from '../sim/client';
import type { AdviceResult, DayDigest, PolicyDigest, PolicyName, SimRequest, Timeline, WhatIfDigest } from '../sim/protocol';
import { applyLang, ensureLang, getLang, t, type Lang } from '../i18n';
import { digestOf, loadCosts, loadSavedScenarios, persistCosts, persistScenarios, type SavedScenario } from './scenarios';
import type { CostParams } from '@storewright/sim-engine';
import { buildGeometry, type StoreGeometry } from '../scene/layout';
import type { SiteSettings } from '../scene/site';
import type { MenuTarget } from '../scene/contextTarget';
import { clock, setRange, setTime } from './clock';

export type ViewMode = 'iso' | '3d' | 'top';
export type CameraCmd = 'in' | 'out' | 'reset' | 'rotateLeft' | 'rotateRight' | 'front' | 'side' | 'bird' | 'street';
export type DataTab = 'live' | 'ai' | 'compare' | 'report' | 'events' | 'edit' | 'ops';
export type SplitOrder = 'scene-left' | 'scene-right';
export type Overlay = 'temp' | 'heat' | 'stock' | 'areas' | 'none';
export type AppMode = 'sim' | 'edit';
/** 孪生时间轴：回放（过去）、实时（现在）、推演（未来） */
export type TwinMode = 'live' | 'replay' | 'forecast';
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
  /** 编辑器里选中的区域（场景里只显示它的拖拽把手） */
  areaSel?: string;
  /** 「你的商店」：打开着的门店项目、项目页是否显示（决策记录 0013） */
  project?: { id: string; name: string };
  yourStore: boolean;
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
  /** 数字孪生（决策记录 0016）：孪生时间轴在看过去（回放）、现在（实时）还是未来（推演） */
  twin: { mode: TwinMode; t?: number };
  setTwin(mode: TwinMode, t?: number): void;
  /** 孪生数据（设备读数、回放）每次变化加一 */
  twinVersion: number;
  /** 推演方案：各岗位在岗人数的调整 */
  forecastDelta: Record<'PICK' | 'STAGE' | 'HANDOFF', number>;
  setForecastDelta(d: Partial<Record<'PICK' | 'STAGE' | 'HANDOFF', number>>): void;
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
  /** 星期几（0 = 周一，默认周四）：到货车辆按星期排班（决策记录 0019） */
  weekday: number;
  setWeekday(w: number): void;
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
  /** 学生兼职工（决策记录 0020）：启用、名单人数（undefined 表示按门店规模自动）、可以做的岗位 */
  students: { enabled: boolean; count?: number; roles: Role[] };
  setStudents(patch: Partial<{ enabled: boolean; count: number; roles: Role[] }>): void;
  studentCount(): number;
  /** 发给仿真的学生设置（没有启用时为 undefined） */
  studentsReq(): { count: number; roles: Role[] } | undefined;
  /** AI 建议（决策记录 0020）：当前方案的分析结果；方案变了就过时，打开「AI 建议」标签时重新分析 */
  aiAdvice: { status: 'idle' | 'running' | 'ready' | 'error'; result?: AdviceResult; stale: boolean };
  runAdvise(front?: FrontInput): Promise<void>;
  /** 采纳的建议对到货、后仓的改动（随仿真请求发出） */
  aiAdjust: InboundAdjust;
  inboundReq(): InboundAdjust | undefined;
  /** 这次打开以来采纳的建议（可以撤销）与忽略的建议 */
  aiLog: AiLogEntry[];
  /** 每个时段的收银通道计划、停车场引导（采纳前场建议后写进当天计划） */
  checkoutPlan?: Array<{ floorId: string; byHour: number[] }>;
  parkingGuide?: { fromHour: number; toHour: number };
  adoptAdvice(a: Advice): void;
  dismissAdvice(a: Advice, reason: string): void;
  undoAdvice(id: string): void;
  /** 本机累计的反馈：采纳、忽略的次数与忽略原因（决策记录 0010 原则 2：否决原因是下一轮改进的数据） */
  aiFeedback: AiFeedback;
  /** 当前设置的仿真请求（不含类型和序号） */
  simBase(): Omit<SimRequest, 'type' | 'reqId'>;
  /** 采纳与不采纳对比：同一天按现在的设置、撤掉全部采纳的设置各跑一遍 */
  aiCompare: { status: 'idle' | 'running' | 'ready' | 'error'; adopted?: WhatIfDigest; baseline?: WhatIfDigest; count?: number };
  runAiCompare(): Promise<void>;
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
  setAreaSel(id: string | undefined): void;
  setYourStore(open: boolean): void;
  openProject(p: { id: string; name: string; config: StoreConfig; sizing?: { ordersPerDay: number; staffScale: number } }, edit?: boolean): void;
  closeProject(): void;
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

/** 一条建议的处理记录（决策记录 0020） */
export interface AiLogEntry {
  id: string;
  area: AdviceArea;
  code: string;
  params: Record<string, string | number>;
  action?: AdviceAction;
  status: 'adopted' | 'dismissed';
  reason?: string;
  at: number;
  /** 采纳前的值（撤销时恢复） */
  prev?: unknown;
}

/** 本机累计的反馈：每类建议采纳、忽略几次，忽略的原因 */
export interface AiFeedback {
  adopted: number;
  dismissed: number;
  byCode: Record<string, { adopted: number; dismissed: number }>;
  reasons: Record<string, number>;
}

const FEEDBACK_KEY = 'storewright.ai.feedback';

function loadFeedback(): AiFeedback {
  try {
    const raw = window.localStorage.getItem(FEEDBACK_KEY);
    const v = raw ? (JSON.parse(raw) as AiFeedback) : undefined;
    if (v && typeof v.adopted === 'number' && v.byCode && v.reasons) return v;
  } catch {
    // 读不到本机存储时从零开始
  }
  return { adopted: 0, dismissed: 0, byCode: {}, reasons: {} };
}

function bumpFeedback(f: AiFeedback, a: Advice, status: 'adopted' | 'dismissed', reason?: string): AiFeedback {
  const c = f.byCode[a.code] ?? { adopted: 0, dismissed: 0 };
  const next: AiFeedback = {
    adopted: f.adopted + (status === 'adopted' ? 1 : 0),
    dismissed: f.dismissed + (status === 'dismissed' ? 1 : 0),
    byCode: { ...f.byCode, [a.code]: { adopted: c.adopted + (status === 'adopted' ? 1 : 0), dismissed: c.dismissed + (status === 'dismissed' ? 1 : 0) } },
    reasons: reason ? { ...f.reasons, [reason]: (f.reasons[reason] ?? 0) + 1 } : f.reasons,
  };
  try {
    window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(next));
  } catch {
    // 存不下时只在这次打开里记着
  }
  return next;
}
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
        students: { ...st.students, roles: [...st.students.roles] },
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
      students: st.students ? { ...st.students, roles: [...st.students.roles] } : get().students,
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
        { config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, school: site.school, railway: site.railway, weekday: get().weekday, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai, students: get().studentsReq(), inbound: get().inboundReq() },
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
  weekday: 3,
  setWeekday(w) {
    if (w === get().weekday) return;
    set({ weekday: w });
    void get().simulate();
  },
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
  students: { enabled: false, roles: ['pick', 'handoff'] },
  setStudents(patch) {
    set({ students: { ...get().students, ...patch } });
    void get().simulate();
  },
  studentCount() {
    const { students, sizing, template } = get();
    const k = sizing?.staffScale ?? (template === 'small' ? 0.3 : template === 'large' ? 2.5 : 1);
    // 中型店名单上 6 个学生（每天来 3–4 个），按规模伸缩
    return students.count ?? Math.max(2, Math.round(6 * k));
  },
  studentsReq() {
    const { students } = get();
    return students.enabled && students.roles.length ? { count: get().studentCount(), roles: [...students.roles] } : undefined;
  },
  aiAdvice: { status: 'idle', stale: true },
  async runAdvise(front) {
    const { config, template, policy, seed, demandFactor, staffing, site, sizing } = get();
    set({ aiAdvice: { ...get().aiAdvice, status: 'running' } });
    const req = client.latestAdvise + 1;
    try {
      const nightCrew = { enabled: get().nightCrew.enabled, crew: get().nightCrewSize() };
      const result = await client.advise(
        { config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, school: site.school, railway: site.railway, weekday: get().weekday, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai, students: get().studentsReq(), inbound: get().inboundReq() },
        front,
      );
      if (client.latestAdvise !== req) return;
      set({ aiAdvice: { status: 'ready', result, stale: false } });
    } catch {
      if (client.latestAdvise === req) set({ aiAdvice: { status: 'error', stale: true } });
    }
  },
  simBase() {
    const { config, template, policy, seed, demandFactor, staffing, site, sizing } = get();
    const nightCrew = { enabled: get().nightCrew.enabled, crew: get().nightCrewSize() };
    return { config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, school: site.school, railway: site.railway, weekday: get().weekday, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai, students: get().studentsReq(), inbound: get().inboundReq() };
  },
  aiCompare: { status: 'idle' },
  async runAiCompare() {
    const st = get();
    const adopted = st.aiLog.filter((e) => e.status === 'adopted' && e.action);
    const current = st.simBase();
    // 撤掉全部采纳：到货、后仓的改动不发；排班减去加的人；夜班恢复采纳前的人数
    const staffing = structuredClone(current.staffing ?? st.staffing);
    let night = { ...st.nightCrew };
    for (const e of [...adopted].reverse()) {
      const act = e.action as AdviceAction;
      if (act.kind === 'STAFF') for (let h = act.fromHour; h < act.toHour; h++) staffing[act.role][h] = Math.max(0, (staffing[act.role][h] ?? 0) - act.delta);
      if (act.kind === 'NIGHT_CREW') night = e.prev as AppState['nightCrew'];
      // 用 AI 排班：恢复采纳前每小时的人数
      if (act.kind === 'STAFF_PLAN') Object.assign(staffing, structuredClone(e.prev as { pick: number[]; stage: number[]; handoff: number[] }));
    }
    const k = st.sizing?.staffScale ?? (st.template === 'small' ? 0.3 : st.template === 'large' ? 2.5 : 1);
    const baseline = { ...current, staffing, nightCrew: { enabled: night.enabled, crew: night.crew ?? defaultNightCrew(k) }, inbound: undefined };
    set({ aiCompare: { status: 'running', count: adopted.length } });
    const req = client.latestWhatIf + 1;
    try {
      const [a, b] = await client.whatif([current, baseline]);
      if (client.latestWhatIf !== req) return;
      set({ aiCompare: { status: 'ready', adopted: a, baseline: b, count: adopted.length } });
    } catch {
      if (client.latestWhatIf === req) set({ aiCompare: { status: 'error' } });
    }
  },
  aiAdjust: {},
  inboundReq() {
    const a = get().aiAdjust;
    return a.receivers !== undefined || a.slotting || a.liftOrder || (a.appt && Object.keys(a.appt).length) ? structuredClone(a) : undefined;
  },
  aiLog: [],
  aiFeedback: loadFeedback(),
  adoptAdvice(a) {
    const act = a.action;
    if (!act || get().aiLog.some((e) => e.id === a.id && e.status === 'adopted')) return;
    const st = get();
    let prev: unknown;
    const adj = structuredClone(st.aiAdjust);
    switch (act.kind) {
      case 'MOVE_APPOINTMENT':
        adj.appt = { ...(adj.appt ?? {}), [act.deliveryId]: act.to };
        set({ aiAdjust: adj });
        break;
      case 'RECEIVERS':
        prev = adj.receivers;
        set({ aiAdjust: { ...adj, receivers: act.to } });
        break;
      case 'SLOTTING':
        set({ aiAdjust: { ...adj, slotting: act.policy } });
        break;
      case 'LIFT_ORDER':
        set({ aiAdjust: { ...adj, liftOrder: act.policy } });
        break;
      case 'NIGHT_CREW':
        prev = { ...st.nightCrew };
        set({ nightCrew: { enabled: true, crew: act.to } });
        break;
      case 'STAFF': {
        const arr = [...st.staffing[act.role]];
        for (let h = act.fromHour; h < act.toHour; h++) arr[h] = Math.max(0, (arr[h] ?? 0) + act.delta);
        set({ staffing: { ...st.staffing, [act.role]: arr } });
        break;
      }
      case 'CHECKOUT_PLAN':
        prev = st.checkoutPlan;
        set({ checkoutPlan: act.lanes });
        break;
      case 'PARKING_GUIDE':
        prev = st.parkingGuide;
        set({ parkingGuide: { fromHour: act.fromHour, toHour: act.toHour } });
        break;
      case 'STAFF_PLAN':
        prev = { pick: [...st.staffing.pick], stage: [...st.staffing.stage], handoff: [...st.staffing.handoff] };
        set({ staffing: { ...st.staffing, pick: [...act.staffing.pick], stage: [...act.staffing.stage], handoff: [...act.staffing.handoff] } });
        break;
    }
    const entry: AiLogEntry = { id: a.id, area: a.area, code: a.code, params: a.params, action: act, status: 'adopted', at: Date.now(), ...(prev !== undefined ? { prev } : {}) };
    set({ aiLog: [...get().aiLog, entry], aiFeedback: bumpFeedback(get().aiFeedback, a, 'adopted'), aiAdvice: { ...get().aiAdvice, stale: true } });
    void get().simulate();
  },
  dismissAdvice(a, reason) {
    set({ aiLog: [...get().aiLog, { id: a.id, area: a.area, code: a.code, params: a.params, status: 'dismissed', reason, at: Date.now() }], aiFeedback: bumpFeedback(get().aiFeedback, a, 'dismissed', reason) });
  },
  undoAdvice(id) {
    const st = get();
    const e = [...st.aiLog].reverse().find((x) => x.id === id);
    if (!e) return;
    set({ aiLog: st.aiLog.filter((x) => x !== e) });
    if (e.status !== 'adopted' || !e.action) return;
    const act = e.action;
    const adj = structuredClone(st.aiAdjust);
    switch (act.kind) {
      case 'MOVE_APPOINTMENT':
        if (adj.appt) delete adj.appt[act.deliveryId];
        set({ aiAdjust: adj });
        break;
      case 'RECEIVERS':
        if (e.prev === undefined) delete adj.receivers;
        else adj.receivers = e.prev as number;
        set({ aiAdjust: adj });
        break;
      case 'SLOTTING':
        delete adj.slotting;
        set({ aiAdjust: adj });
        break;
      case 'LIFT_ORDER':
        delete adj.liftOrder;
        set({ aiAdjust: adj });
        break;
      case 'NIGHT_CREW':
        set({ nightCrew: e.prev as AppState['nightCrew'] });
        break;
      case 'STAFF': {
        const arr = [...st.staffing[act.role]];
        for (let h = act.fromHour; h < act.toHour; h++) arr[h] = Math.max(0, (arr[h] ?? 0) - act.delta);
        set({ staffing: { ...st.staffing, [act.role]: arr } });
        break;
      }
      case 'CHECKOUT_PLAN':
        set({ checkoutPlan: e.prev as AppState['checkoutPlan'] });
        break;
      case 'PARKING_GUIDE':
        set({ parkingGuide: e.prev as AppState['parkingGuide'] });
        break;
      case 'STAFF_PLAN': {
        const p = e.prev as { pick: number[]; stage: number[]; handoff: number[] };
        set({ staffing: { ...st.staffing, pick: [...p.pick], stage: [...p.stage], handoff: [...p.handoff] } });
        break;
      }
    }
    set({ aiAdvice: { ...get().aiAdvice, stale: true } });
    void get().simulate();
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
    set({ template: t, config, ...derive(config), staffing: defaultScenario(t).staffing, sizing: undefined, demandFactor: 1, floor: 'F1', selection: undefined, nightCrew: { enabled: get().nightCrew.enabled }, aiAdjust: {}, aiLog: [], checkoutPlan: undefined, parkingGuide: undefined });
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
  setAreaSel(id) {
    set({ areaSel: id });
  },
  yourStore: false,
  setYourStore(open) {
    set({ yourStore: open });
  },
  openProject(p, edit = false) {
    if (get().mode === 'edit') get().exitEdit(false);
    const config = cloneConfig(p.config);
    // 日订单量和排班按门店规模（与生成器相同的规则），需求的时段分布取最接近的模板
    const aisles = config.layout.runs.filter((r) => r.kind === 'AISLE').length;
    const size: TemplateName = config.industry === 'HARDWARE' ? 'hardware' : aisles <= 11 ? 'small' : aisles <= 23 ? 'medium' : 'large';
    const s = storeSizing(aisles);
    const sizing = p.sizing ?? { ordersPerDay: s.ordersPerDay, staffScale: s.staffScale };
    set({
      project: { id: p.id, name: p.name },
      yourStore: false,
      template: size,
      sizing,
      staffing: shiftStaffing(scaledStaffing(sizing.staffScale), config.hours.openMin, config.hours.closeMin),
      demandFactor: 1,
      config,
      ...derive(config),
      floor: 'F1',
      selection: undefined,
    });
    void get().simulate();
    if (edit) get().enterEdit();
  },
  closeProject() {
    if (get().mode === 'edit') get().exitEdit(true);
    set({ project: undefined, yourStore: true });
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
  twin: { mode: 'live' },
  setTwin(mode, t) {
    set({ twin: t === undefined ? { mode } : { mode, t } });
  },
  twinVersion: 0,
  forecastDelta: { PICK: 0, STAGE: 0, HANDOFF: 0 },
  setForecastDelta(d) {
    set({ forecastDelta: { ...get().forecastDelta, ...d } });
  },
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
    // 通道数按生成结果数（二楼通道 0 = 按货梯位置自动铺满）
    const aisles = config.layout.runs.filter((r) => r.kind === 'AISLE').length;
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
    // 季节决定供应商直送的频次（夏天冰品多……）、学校和铁路道口影响到店时间，也要重新仿真（决策记录 0019）
    const changed = (k: keyof SiteSettings) => patch[k] !== undefined && patch[k] !== prev[k];
    if (changed('traffic') || changed('weather') || changed('season') || changed('school') || changed('railway') || dynChanged) void get().simulate();
  },
  async simulate() {
    const { config, template, policy, seed, demandFactor, staffing, site, sizing } = get();
    set({ status: 'running', error: undefined });
    const req = client.latest + 1;
    try {
      const nightCrew = { enabled: get().nightCrew.enabled, crew: get().nightCrewSize() };
      const timeline = await client.simulate({ config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, policy, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, school: site.school, railway: site.railway, weekday: get().weekday, lang: get().lang, nightCrew, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai, students: get().studentsReq(), inbound: get().inboundReq() });
      if (client.latest !== req) return; // 有更新的请求，丢弃旧结果
      const cur = get();
      const sim = cur.model.config === config ? { model: cur.model, geo: cur.geo } : derive(config);
      // 首次加载从 10:00 开始（门店已经忙起来）；之后重新仿真时保留当前时刻
      const keep = clock.time > timeline.start ? clock.time : 10 * 3600;
      setRange(timeline.start, timeline.end);
      setTime(keep);
      set({ timeline, status: 'ready', simModel: sim.model, simGeo: sim.geo, aiAdvice: { ...get().aiAdvice, stale: true } });
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
      const results = await client.compare({ config, demandTemplate: template, ordersPerDay: sizing?.ordersPerDay, seed, demandFactor, staffing, traffic: site.traffic, weather: site.weather, season: site.season, weatherSeed: site.seed, school: site.school, railway: site.railway, weekday: get().weekday, lang: get().lang, incidents: get().incidents, shelfStock: get().shelfStock, restockRequests: get().restockRequests, ai: get().ai, students: get().studentsReq(), inbound: get().inboundReq() });
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
