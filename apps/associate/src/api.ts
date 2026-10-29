import type { Reason } from '@storewright/ai';
import type { Rejection } from '@storewright/ops';
import type { Auth } from './live';
import { DEMO } from './demo/transport';

/** 登录与演示接口（命令走 LiveClient） */
async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok && !(body as { reject?: unknown }).reject) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function signIn(storeId: string, body: { associateId: string } | { role: 'console' | 'viewer' }): Promise<Auth> {
  const res = await fetch(`/api/stores/${storeId}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const r = await json<{ token: string; actor: string; role: Auth['role'] }>(res);
  return { storeId, token: r.token, actor: r.actor, role: r.role };
}

export interface RosterEntry {
  id: string;
  name: string;
  role: string;
  /** 学生兼职工与在岗时段（当天的分钟数，决策记录 0020） */
  employment?: 'STUDENT';
  shift?: { from: number; to: number };
}

export async function storeInfo(storeId: string): Promise<{ roster: RosterEntry[]; name: string }> {
  // 名单在快照里；登录前用查看者身份读取
  const viewer = await signIn(storeId, { role: 'viewer' });
  const res = await fetch(`/api/stores/${storeId}/snapshot`, { headers: { authorization: `Bearer ${viewer.token}` } });
  const r = await json<{ statics: { roster: RosterEntry[]; name: string } }>(res);
  return r.statics;
}

function post<T>(auth: Auth, path: string, body: unknown): Promise<T> {
  return fetch(`/api/stores/${auth.storeId}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }, body: JSON.stringify(body) }).then((r) => json<T>(r));
}

export interface CreatedOrder {
  orderId: string;
  shortCode: string;
  code: string;
  name: string;
}

export const demo = {
  createOrders: (auth: Auth, body: { type: 'PICKUP' | 'DELIVERY'; count: number; maxLines: number; release: boolean; slotInMin: number; mto?: boolean; oversized?: boolean }) => post<{ orders: CreatedOrder[]; rejected?: Array<{ index: number; reject?: Rejection }> }>(auth, '/demo/orders', body),
  parcels: (auth: Auth, count: number, trips: number) => post<{ ok: boolean; parcels?: string[] }>(auth, '/demo/parcels', { count, trips }),
  acceptTrip: (auth: Auth, tripId: string) => post<{ ok: boolean; code?: string; reject?: { code: string } }>(auth, `/demo/trips/${tripId}/accept`, { driverName: 'Driver' }),
  tick: (auth: Auth, release: boolean) => post<unknown>(auth, '/demo/tick', { release }),
  reset: (auth: Auth) => post<unknown>(auth, '/demo/reset', {}),
  asn: (auth: Auth, items: number) => post<{ ok: boolean; events?: Array<{ payload: { receiptId: string } }> }>(auth, '/demo/asn', { items }),
  sim: (auth: Auth, action: 'start' | 'stop', speed: number) => post<SimStatus>(auth, '/demo/sim', { action, speed }),
  autopilot: (auth: Auth, body: { action: 'start' | 'stop'; ordersPerHour?: number; pace?: number }) => post<AutoPilotStatus>(auth, '/demo/autopilot', body),
  autopilotStatus: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/demo/autopilot`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<AutoPilotStatus>(r)),
  autoRestock: (auth: Auth, on: boolean) => post<SimStatus>(auth, '/demo/sim', { action: 'autoRestock', on }),
  simStatus: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/demo/sim`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<SimStatus>(r)),
  shelfEmpty: (auth: Auth, itemId: string, silent: boolean) => post<{ ok: boolean }>(auth, '/demo/shelf-empty', { itemId, silent }),
  /** 数字孪生（决策记录 0016）：模拟设备故障（压缩机故障、卸货门没关、传感器断线）或修复 */
  fault: (auth: Auth, body: { target: string; mode?: 'FAIL' | 'OPEN' | 'OFFLINE' | 'DEGRADE' | 'SEAL' | 'STUCK'; on?: boolean }) => post<{ ok: boolean; sensorId?: string; faults?: string[]; repaired?: string[] }>(auth, '/demo/fault', body),
};

/** 自动运营（双线并行）的状态 */
export interface AutoPilotStatus {
  running: boolean;
  ordersPerHour: number;
  deliveryShare: number;
  pace: number;
  created: number;
  completed: number;
  open: number;
  avgMinutes?: number;
  trips: number;
  workers: Array<{ id: string; role: 'PICK' | 'STAGE' | 'HANDOFF' | 'DRIVER'; task?: string }>;
}

export interface SimStatus {
  running: boolean;
  speed: number;
  sold: number;
  lost: number;
  shrink: number;
  readings: number;
  /** 自动补货（虚拟补货员） */
  autoRestock?: boolean;
  autoRestocked?: number;
  drift: Array<{ itemId: string; name: string; locationId: string; truth: number; est: number; capacity: number; sensor?: string }>;
  /** 仿真里的门店时间（小时） */
  storeHour?: number;
}

/** 替代候选；AI 排序时带预计接受概率、理由和模型版本 */
export interface SubstituteSuggestion {
  itemId: string;
  name: string;
  gtin: string;
  unitPrice: number;
  /** 货架上的货位（决策记录 0026） */
  locationId?: string;
  p?: number;
  reasons?: Array<{ factor: string; value?: number; effect?: { kind: string; amount: number } }>;
}

export async function substitutes(auth: Auth, itemId: string): Promise<{ items: SubstituteSuggestion[]; model?: string }> {
  const res = await fetch(`/api/stores/${auth.storeId}/substitutes?itemId=${encodeURIComponent(itemId)}`, { headers: { authorization: `Bearer ${auth.token}` } });
  return json<{ items: SubstituteSuggestion[]; model?: string }>(res);
}

export function labelUrl(auth: Auth, path: string): string {
  const api = `/api/stores/${auth.storeId}/labels/${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(auth.token)}`;
  // 浏览器内演示模式没有服务器：标签页面向浏览器里的中枢取标签
  return DEMO ? `./label.html#${encodeURIComponent(api)}` : api;
}

/** AI 服务：模型仓库、重新训练、回滚、立即发出预测（决策记录 0010） */
export interface AiModelInfo {
  id: string;
  version: number;
  kind: string;
  status: 'CANDIDATE' | 'CHAMPION' | 'RETIRED' | 'REJECTED';
  trainedAt: number;
  data: { source: 'SIM' | 'LIVE' | 'MIXED'; days: number; from?: string; to?: string; seed?: number; liveDays?: number; simWeight?: number };
  metrics: Record<string, number>;
  gate?: { passed: boolean; against?: number; checks: Array<{ metric: string; rule: 'PRIMARY' | 'GUARDRAIL'; candidate: number; champion: number; change: number; ok: boolean }> };
  promotedAt?: number;
  note?: string;
}

export interface AiSummary {
  models: AiModelInfo[];
  champion?: number;
  context?: { history: { from: string; days: number; seed: number }; hours: number[] };
  /** 多源货架真相（决策记录 0022 · C1）：各种拣货员报告的可靠度 */
  shelfTruth?: { reliability: Array<{ kind: string; hit: number; miss: number; r: number }>; tracked: number };
  /** 替代推荐 2.0（决策记录 0023 · B4）：交付时记下的真实标签、从商品名里抽属性的效果 */
  substitution?: { labels: { n: number; accepted: number; top1: number; top1Accepted: number }; attributes: Record<string, { precision: number; recall: number; n: number }> };
}

/** 一个取货时段的产能（决策记录 0023 · B6） */
export interface SlotCapacity {
  start: number;
  end: number;
  booked: number;
  pick: number;
  handoff: number;
  capacity: number;
  remaining: number;
  closed: boolean;
}

export interface CapacityPoint {
  factor: number;
  offered: number;
  accepted: number;
  late: number;
  latePct: number;
}

export interface TrainResult {
  candidates: Array<{ version: number; kind: string; metrics: Record<string, number> }>;
  best: number;
  promoted: boolean;
  gate: NonNullable<AiModelInfo['gate']>;
}

export const ai = {
  models: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/models`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<AiSummary>(r)),
  retrain: (auth: Auth, kinds?: string[]) => post<TrainResult>(auth, '/ai/retrain', kinds ? { kinds } : {}),
  rollback: (auth: Auth) => post<{ ok: boolean; champion?: number; error?: string }>(auth, '/ai/rollback', {}),
  forecast: (auth: Auth) => post<{ ok: boolean }>(auth, '/ai/forecast', {}),
  scan: (auth: Auth) => post<{ shelves: number; counts: number }>(auth, '/ai/scan', {}),
  /** 运营预警：立即用推演看一次（决策记录 0021） */
  foresight: (auth: Auth) => post<{ problems: Array<{ kind: string }> }>(auth, '/ai/foresight', {}),
  /** 排班草稿（决策记录 0022）：week 是那一周里的任意一天，不给时为下周 */
  scheduleDraft: (auth: Auth, week?: string) => post<ScheduleDraft>(auth, '/ai/schedule/draft', week ? { week } : {}),
  /** 建议中枢的统计：这一轮先不发的提醒（正在交付 / 超出预算 / 营业时间外） */
  nudges: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/nudges`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ deferred: Record<'BUSY' | 'BUDGET' | 'NIGHT', number> }>(r)),
  /** 开店简报（决策记录 0022 · F1）：早、中、晚；不给时按当前时刻 */
  brief: (auth: Auth, part?: BriefPart) => fetch(`/api/stores/${auth.storeId}/ai/brief${part ? `?part=${part}` : ''}`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<Brief>(r)),
  /** 时段产能（决策记录 0023 · B6）：接下来每个取货时段还能接多少单；取舍曲线（仿真） */
  capacity: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/capacity`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ at: number; slots: SlotCapacity[] }>(r)),
  capacityCurve: (auth: Auth) => post<{ curve: CapacityPoint[] }>(auth, '/ai/capacity/curve', {}),
  /** 打烊复盘、周报（决策记录 0024 · F3、F5） */
  review: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/review`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<ClosingReview>(r)),
  weekly: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/weekly`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<WeeklyReport>(r)),
  /** 召回（决策记录 0024 · C5）：识别通知、演示通知 */
  parseRecall: (auth: Auth, text: string) => post<{ parsed: { product: string; size?: string; gtins: string[]; lots: string[]; from?: string; to?: string; reason?: string }; matches: RecallMatch[] }>(auth, '/ai/recall/parse', { text }),
  demoRecall: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/demo/recall`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ text: string }>(r)),
  /** 突发状况的时间线、食品安全记录（决策记录 0024 · E4、E5） */
  incidentReport: (auth: Auth, id: string) => fetch(`/api/stores/${auth.storeId}/incidents/${id}/report`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ timeline: Array<{ at: number; type: string; actor: string }> }>(r)),
  foodSafety: (auth: Auth, date: string) => fetch(`/api/stores/${auth.storeId}/ai/foodsafety?date=${date}`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<FoodSafetyLog>(r)),
  /** 演示：一车货的送货单二维码内容（决策记录 0024 · G3） */
  deliveryNote: (auth: Auth, receiptId: string) => fetch(`/api/stores/${auth.storeId}/demo/delivery-note/${receiptId}`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ text: string }>(r)),
  /** 顾客要求删除个人记录（决策记录 0023 · B4） */
  forgetCustomer: (auth: Auth, name: string) => post<{ removed: number }>(auth, '/ai/customers/forget', { name }),
  /** 卸货门计划（决策记录 0022 · A3） */
  docks: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/docks`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ at: number; plan: DockSlot[] }>(r)),
};

export type BriefPart = 'MORNING' | 'MIDDAY' | 'EVENING';

/** 开店简报里要注意的事、要店长决定的事：代码 + 参数 */
export interface BriefItem {
  code: string;
  params?: Record<string, string | number>;
}

export interface Brief {
  at: number;
  part: BriefPart;
  date: string;
  forecast?: { date: string; orders: number; low: number; high: number; usual: number; reasons: Reason[]; peakHour?: number; peakOrders?: number };
  soFar?: { orders: number; expected: number };
  inbound: { trucks: number; cases: number; arrived: number; next?: { supplier: string; at?: number } };
  staffing: { date: string; scheduled: number; gaps: Array<{ role: string; from: number; to: number; short: number }>; absences: number; pendingOffers: number };
  stats?: { date: string; orders: number; handedOff: number; late: number; avgWaitMin: number; shortLines: number; substitutions: number; coldAlerts: number; recs: number; adopted: number };
  watch: BriefItem[];
  decisions: BriefItem[];
}

export interface DockSlot {
  receiptId: string;
  supplier: string;
  cases: number;
  left: number;
  cold: boolean;
  arrived: boolean;
  arriveAt: number;
  startAt: number;
  endAt: number;
  waitMin: number;
}

export interface ScheduleDraft {
  ok: boolean;
  week: string;
  dates: string[];
  shifts: Array<{ associateId: string; date: string; from: number; to: number; role: string }>;
  metrics: { underHours: number; overHours: number; totalHours: number; hoursBy: Record<string, number>; weekendSpread: number; eveningSpread: number; violations: string[] };
  gaps: Array<{ day: number; role: string; from: number; to: number; heads: number; why: string }>;
  cover: Record<string, Record<string, number[]>>;
  need: Array<{ day: number; role: string; slots: number[] }>;
  naive: { underHours: number; overHours: number; totalHours: number };
  /** 生成草稿时用的营业前后可排班范围（改草稿后重新打分用同一个） */
  rules?: { open: { from: number; to: number } };
}

/** 本地助手（Phase 5d） */
export interface AskResponse {
  answer: string;
  source: 'LLM' | 'TEMPLATE';
  tools: Array<{ name: string; args: Record<string, unknown> }>;
  citations: string[];
  ms: number;
  fallback?: string;
  /** 写进事件流的问答编号（决策记录 0024 · F2），用来标「有用 / 没用」 */
  answerId?: string;
}

export const assistant = {
  status: (auth: Auth) => fetch(`/api/stores/${auth.storeId}/ai/assistant`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => json<{ llm: boolean; model?: string }>(r)),
  ask: (auth: Auth, question: string, lang: 'zh' | 'en') => post<AskResponse>(auth, '/ai/ask', { question, lang }),
};

/** 退货去向建议（Phase 6） */
export async function returnSuggestion(auth: Auth, returnId: string, index: number): Promise<{ disposition: string; p?: number; reasons: Array<{ factor: string; value?: number }>; model?: string }> {
  const res = await fetch(`/api/stores/${auth.storeId}/ai/return-suggestion?returnId=${encodeURIComponent(returnId)}&index=${index}`, { headers: { authorization: `Bearer ${auth.token}` } });
  return json(res);
}

/** 召回匹配到的商品（决策记录 0024 · C5） */
export interface RecallMatch {
  itemId: string;
  name: string;
  gtin: string;
  score: number;
  by: 'GTIN' | 'NAME';
  shelf: number;
  cases: number;
  openOrders: number;
}

/** 食品安全记录（决策记录 0024 · E5） */
export interface FoodSafetyLog {
  date: string;
  rows: Array<{ sensorId: string; tempZone?: string; min?: number; max?: number; avg?: number; minutesOut: number; readings: number; limit?: number }>;
  alerts: Array<{ id: string; sensorId: string; kind: string; severity: string; raisedAt: number; ackAt?: number; ackBy?: string; clearedAt?: number }>;
  tickets: Array<{ id: string; sensorId: string; reason: string; openedAt: number; closedAt?: number; fault?: string }>;
  confirmed?: { at: number; by: string; note?: string };
  summary: { sensors: number; withExcursion: number; alerts: number; acked: number; avgAckMin?: number; tickets: number };
}

/** 打烊复盘（决策记录 0024 · F3） */
export interface ClosingReview {
  date: string;
  actualLate: number;
  replay: number;
  baseline: number;
  factors: Record<'DEMAND' | 'STAFF' | 'PACE', number>;
  other: number;
  inputs: { orders: number; forecast: number; pace: number; pickers: number; scheduled: number; perOrderMin: number };
  shortages: { lines: number; lateTruckLines: number };
  recs: { issued: number; adopted: number; measured: number; hits: number };
  notes: BriefItem[];
}

/** 周报（决策记录 0024 · F5） */
export interface WeeklyReport {
  from: string;
  to: string;
  days: Array<{ date: string; orders: number; late?: number; avgWaitMin?: number; shortLines?: number; substitutions?: number }>;
  totals: { orders: number; late: number; handedOff: number; avgWaitMin: number; shortLines: number; substitutions: number; coldAlerts: number; recs: number; adopted: number };
  outcomes: Array<{ module: string; n: number; hitRate?: number; realized?: number }>;
  nextWeek: { orders: number; low: number; high: number; gaps: number; from: string };
}
