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

export async function storeInfo(storeId: string): Promise<{ roster: Array<{ id: string; name: string; role: string }>; name: string }> {
  // 名单在快照里；登录前用查看者身份读取
  const viewer = await signIn(storeId, { role: 'viewer' });
  const res = await fetch(`/api/stores/${storeId}/snapshot`, { headers: { authorization: `Bearer ${viewer.token}` } });
  const r = await json<{ statics: { roster: Array<{ id: string; name: string; role: string }>; name: string } }>(res);
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
  createOrders: (auth: Auth, body: { type: 'PICKUP' | 'DELIVERY'; count: number; maxLines: number; release: boolean; slotInMin: number; mto?: boolean; oversized?: boolean }) => post<{ orders: CreatedOrder[] }>(auth, '/demo/orders', body),
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
};

/** 本地助手（Phase 5d） */
export interface AskResponse {
  answer: string;
  source: 'LLM' | 'TEMPLATE';
  tools: Array<{ name: string; args: Record<string, unknown> }>;
  citations: string[];
  ms: number;
  fallback?: string;
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
