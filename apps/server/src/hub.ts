import type { ToteLabelData } from '@storewright/labels';
import { clientProjection, locationIndex, sellableCases, type OpsCommand, type OpsCommandType, type OpsState } from '@storewright/ops';
import type { StoreConfig, TemplateName } from '@storewright/store-config';
import { AiService } from './ai';
import { Assistant, type LlmConfig } from './assistant';
import { buildEvalSet, runEval } from './assistant/eval';
import { createDemoStore, newSalt, randomCode, type DemoStore } from './demo';
import { toBase64Url, type HubPlatform } from './platform';
import { StoreRuntime, type HubMessage } from './runtime';
import { sensorCommand } from './sensing';
import type { HubStorage, SessionRole, SessionRow } from './storage';
import { StoreSim } from './storeSim';
import { AutoPilot } from './autopilot';

/**
 * 门店中枢：全部接口的处理逻辑，与传输方式无关。
 *
 * - 服务端（app.ts）把 Fastify 的 HTTP 请求和 WebSocket 连接交给这里；
 * - 浏览器内演示模式（员工端的 SharedWorker）把页面里的请求和「WebSocket」消息交给这里。
 * 两种方式跑的是同一份代码，所以演示网页和本地后端的行为完全一致。这个文件不能引用 Node 专有的模块。
 *
 * 接口：
 * - 命令：POST /api/stores/:id/commands（带会话令牌），返回产生的事件或拒绝原因；
 * - 实时：connect(门店, 令牌, 序号)，先补发错过的事件（或发快照），之后推送新事件；
 * - 标签：取货框、大件、暂存格位、后仓箱和库位标签的 SVG 预览和 ZPL；
 * - 演示：创建测试订单、司机接单（生成验证码，只把明文返回给控制台）、清空门店、门店仿真、到货通知；
 * - AI：模型版本与回测指标、重新训练、回滚、立即发出预测、助手问答（决策记录 0010）。
 */

export interface HubOptions {
  storage: HubStorage;
  platform: HubPlatform;
  /** 演示模式：允许控制台、查看者身份和演示接口 */
  demo: boolean;
  /** 非演示模式下控制台身份需要的密钥 */
  consoleKey?: string;
  storeIds?: string[];
  /** 用到时才建店（浏览器里减少启动时间）；默认启动时全部建好 */
  lazyStores?: boolean;
  /** 传感器与 POS 接入的密钥（演示模式下可以不设） */
  sensorKey?: string;
  /** 排程：每隔 tickMs 发一次 Tick，每隔 releaseMs 生成一次拣货批次；0 表示不启动 */
  tickMs?: number;
  releaseMs?: number;
  /** 本地语言模型（OpenAI 兼容接口）；不设置时助手用模板模式 */
  llm?: LlmConfig;
  log?: (level: 'warn' | 'error', msg: unknown) => void;
}

export interface HubRequest {
  method: string;
  /** 不含查询参数的路径，例如 /api/stores/demo/commands */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HubResponse {
  status: number;
  body: unknown;
  /** 不是 JSON 时的内容类型（body 为字符串） */
  type?: string;
}

export interface StoreEntry {
  runtime: StoreRuntime;
  demo: DemoStore;
  lastRelease: number;
  sim: StoreSim;
  /** 自动运营（虚拟顾客与虚拟员工，和员工手机上的操作双线并行） */
  auto: AutoPilot;
  ai: AiService;
  assistant: Assistant;
  /** 发给设备的快照缓存（同一序号、同一分钟内的新连接共用一次序列化；决策记录 0014） */
  snap?: { ref: OpsState; seq: number; bucket: number; json: string };
  /** 门店静态数据的 JSON 和哈希（设备已有同一版本时不再发送） */
  staticsJson?: { json: string; hash: string };
}

/**
 * 推送消息只序列化一次（决策记录 0014）：同一条消息推给所有设备时共用同一段 JSON 文本，
 * 设备几百台时序列化的开销不再乘以设备数。
 */
const frames = new WeakMap<object, string>();
export function frameOf(m: object): string {
  let f = frames.get(m);
  if (f === undefined) {
    f = JSON.stringify(m);
    frames.set(m, f);
  }
  return f;
}

export interface HubConnection {
  /** 客户端发来的消息（JSON 文本） */
  receive(raw: string): void;
  close(): void;
}

/** 员工可以提交的命令 */
export const ASSOCIATE_COMMANDS = new Set<OpsCommandType>([
  'ClaimWalk',
  'UnclaimWalk',
  'BindLabel',
  'PickItem',
  'ReportNotFound',
  'CompleteWalk',
  'ReprintLabel',
  'StageTote',
  'RecoverTote',
  'StartPrep',
  // 司机没来时改派（只有带班负责人，作业核心里检查）
  'RedispatchTrip',
  'JoinPrep',
  'ScanPrepTote',
  'VerifyCode',
  'VerifyManually',
  'VerifyAge',
  'RecordPlacement',
  'CompleteHandoff',
  // 后仓补取、收货、上架、盘点、补货（Phase 4）
  'ClaimException',
  'ExceptionFound',
  'ExceptionMissing',
  'DeliverException',
  'ArriveTruck',
  'ReceiveCases',
  'CloseReceipt',
  'PutAwayCase',
  'ChangeCaseStatus',
  'CreateCount',
  'ClaimCount',
  'CompleteCount',
  'RequestReplenishment',
  'ClaimReplenishment',
  'ReleaseReplenishment',
  'CompleteReplenishment',
  'CancelReplenishment',
  'ConfirmShelf',
  // AI 建议与运行模式（Phase 5，作业核心再检查是否为带班负责人）
  'AcceptRecommendation',
  'OverrideRecommendation',
  'DismissRecommendation',
  'SetAiMode',
  'ChangeRole',
  'LockAssociate',
  'AddNote',
  'RemoveNote',
  // 扩展模块（Phase 6）
  'StartMto',
  'CompleteMto',
  'PullMto',
  'DiscardMto',
  'StartReturn',
  'ScanReturnItem',
  'SetReturnDisposition',
  'CompleteReturn',
  'ClaimOversized',
  'ReleaseOversized',
  'ScanOversized',
  'StageOversized',
  'InductParcel',
  'StageParcel',
  'ReportParcelDamaged',
]);

/** 控制台（演示中代替订单平台、顾客和司机）可以提交的命令 */
/**
 * 按需加载（决策记录 0015）：标签生成（含二维码库）只在打印标签时、门店配置的完整校验（含 zod）只在访客提交自己的门店时才用到，
 * 浏览器里的门店中枢因此小一些、打开快一些。
 */
const labelsLib = () => import('@storewright/labels');
const configValidator = () => import('@storewright/store-config/validate');

/** 大型店（门店编号 large）的员工人数 */
export const LARGE_STORE_STAFF = 300;

export const CONSOLE_COMMANDS = new Set<OpsCommandType>(['CancelOrder', 'LockOrder', 'ReleaseWalks', 'UpdateEta', 'CheckIn', 'CancelTripDriver', 'RedispatchTrip', 'CreateAsn', 'ArriveTruck', 'RecordSales', 'RequestReplenishment', 'CreateCount', 'AcceptRecommendation', 'OverrideRecommendation', 'DismissRecommendation', 'SetAiMode', 'ChangeRole', 'LockAssociate', 'AddNote', 'RemoveNote', 'CreateMtoTicket', 'DiscardMto', 'StartReturn', 'CreateParcelAsn', 'HandOffParcels', 'InductParcel']);

/** 各命令必填的字段与类型（其余校验在 decide 中） */
const FIELDS: Partial<Record<OpsCommandType, Record<string, 'string' | 'number' | 'boolean' | 'array'>>> = {
  CancelOrder: { orderId: 'string', reason: 'string' },
  LockOrder: { orderId: 'string' },
  ClaimWalk: { walkId: 'string' },
  UnclaimWalk: { walkId: 'string' },
  BindLabel: { walkId: 'string', labelId: 'string' },
  PickItem: { walkId: 'string', toteId: 'string', lineId: 'string', qty: 'number' },
  ReportNotFound: { walkId: 'string', toteId: 'string', lineId: 'string', qty: 'number', resolution: 'string' },
  CompleteWalk: { walkId: 'string' },
  ReprintLabel: { toteId: 'string' },
  StageTote: { labelId: 'string', slotCode: 'string' },
  RecoverTote: { labelId: 'string' },
  UpdateEta: { etaAt: 'number' },
  StartPrep: { key: 'string' },
  JoinPrep: { key: 'string' },
  ScanPrepTote: { key: 'string', labelId: 'string' },
  VerifyCode: { key: 'string', code: 'string' },
  VerifyManually: { key: 'string' },
  VerifyAge: { key: 'string' },
  RecordPlacement: { tripId: 'string', orderId: 'string', position: 'string' },
  CompleteHandoff: { key: 'string' },
  ClaimException: { exceptionId: 'string' },
  ExceptionFound: { exceptionId: 'string', caseId: 'string', binEmpty: 'boolean' },
  ExceptionMissing: { exceptionId: 'string' },
  DeliverException: { exceptionId: 'string', slotCode: 'string' },
  CreateAsn: { supplier: 'string', lines: 'array' },
  ArriveTruck: { receiptId: 'string' },
  ReceiveCases: { receiptId: 'string', gtin: 'string', cases: 'number' },
  CloseReceipt: { receiptId: 'string' },
  PutAwayCase: { caseId: 'string', binCode: 'string' },
  ChangeCaseStatus: { caseId: 'string', status: 'string' },
  CreateCount: { binCode: 'string' },
  ClaimCount: { countId: 'string' },
  CompleteCount: { countId: 'string', results: 'array' },
  RecordSales: { lines: 'array' },
  RequestReplenishment: { itemId: 'string' },
  ClaimReplenishment: { taskIds: 'array' },
  ReleaseReplenishment: { taskIds: 'array' },
  CompleteReplenishment: { taskId: 'string', caseId: 'string', locationId: 'string', units: 'number' },
  CancelReplenishment: { taskId: 'string' },
  ConfirmShelf: { itemId: 'string', units: 'number' },
  AcceptRecommendation: { recId: 'string' },
  OverrideRecommendation: { recId: 'string', reason: 'string' },
  DismissRecommendation: { recId: 'string' },
  SetAiMode: { module: 'string', mode: 'string' },
  ChangeRole: { associateId: 'string', role: 'string' },
  LockAssociate: { associateId: 'string', locked: 'boolean' },
  AddNote: { text: 'string' },
  RemoveNote: { noteId: 'string' },
  CreateMtoTicket: { orderId: 'string', menuId: 'string', qty: 'number' },
  StartMto: { ticketId: 'string' },
  CompleteMto: { ticketId: 'string' },
  PullMto: { ticketId: 'string' },
  DiscardMto: { ticketId: 'string' },
  StartReturn: { kind: 'string' },
  ScanReturnItem: { returnId: 'string', code: 'string', qty: 'number', condition: 'string' },
  SetReturnDisposition: { returnId: 'string', index: 'number', disposition: 'string' },
  CompleteReturn: { returnId: 'string' },
  ClaimOversized: { orderId: 'string', maxPieces: 'number' },
  ReleaseOversized: { pieceIds: 'array' },
  ScanOversized: { pieceId: 'string', code: 'string' },
  StageOversized: { pieceId: 'string', area: 'string' },
  CreateParcelAsn: { carrier: 'string', parcels: 'array' },
  InductParcel: { code: 'string' },
  StageParcel: { parcelId: 'string', slotCode: 'string' },
  ReportParcelDamaged: { parcelId: 'string' },
  HandOffParcels: { tripRef: 'string' },
};

function validShape(cmd: unknown): cmd is OpsCommand {
  if (!cmd || typeof cmd !== 'object') return false;
  const c = cmd as Record<string, unknown>;
  if (typeof c.type !== 'string') return false;
  const f = FIELDS[c.type as OpsCommandType];
  if (!f) return true;
  return Object.entries(f).every(([k, t]) => {
    const v = c[k];
    if (t === 'array') return Array.isArray(v) && v.length <= 500 && v.every((x) => (typeof x === 'object' && x !== null) || typeof x === 'string');
    return typeof v === t && (t !== 'number' || Number.isFinite(v));
  });
}

export function toteLabelData(s: OpsState, toteId: string, nameMaxLength: number): ToteLabelData | undefined {
  const t = s.totes[toteId];
  const o = t ? s.orders[t.orderId] : undefined;
  if (!t || !o || !t.labelId) return undefined;
  return {
    labelId: t.labelId,
    version: t.labelVersion,
    firstName: o.firstName,
    lastName: o.lastName,
    nameMaxLength,
    orderShortCode: o.shortCode,
    index: t.index,
    count: t.count,
    slotStart: o.slotStart,
    type: o.type,
    tempZone: t.tempZone,
    ageRestricted: t.lines.some((l) => o.lines.find((x) => x.lineId === l.lineId)?.ageRestricted),
    chemical: t.chemical,
  };
}

/** 大件标签：与取货框标签同一版式，「第几件 / 共几件」按这一单的大件计数（先扫后打，一件一签） */
export function oversizedLabelData(s: OpsState, pieceId: string, nameMaxLength: number): ToteLabelData | undefined {
  const p = s.oversized[pieceId];
  const o = p ? s.orders[p.orderId] : undefined;
  if (!p || !o || !p.labelId) return undefined;
  return { labelId: p.labelId, version: 1, toteNo: 'BULK', kind: 'PIECE', firstName: o.firstName, lastName: o.lastName, nameMaxLength, orderShortCode: o.shortCode, index: p.index, count: p.count, slotStart: o.slotStart, type: o.type, tempZone: 'AMBIENT', ageRestricted: false, chemical: false };
}

const sheet = (title: string, svgs: string[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:16px;font-family:system-ui;background:#f3f4f6}main{display:flex;flex-wrap:wrap;gap:12px}svg{width:406px;height:auto;background:#fff}@media print{body{margin:0;background:#fff}main{gap:0}svg{width:4in;page-break-after:always}}</style></head><body><main>${svgs.join('')}</main></body></html>`;

const ok = (body: unknown, status = 200): HubResponse => ({ status, body });
const err = (status: number, error: string): HubResponse => ({ status, body: { error } });
const svg = (body: string): HubResponse => ({ status: 200, body, type: 'image/svg+xml' });
const zpl = (body: string): HubResponse => ({ status: 200, body, type: 'text/plain; charset=utf-8' });
const html = (body: string): HubResponse => ({ status: 200, body, type: 'text/html; charset=utf-8' });

interface Ctx {
  req: HubRequest;
  params: Record<string, string>;
  e: StoreEntry;
  token: string | undefined;
  body: Record<string, unknown>;
}

type Handler = (c: Ctx) => Promise<HubResponse>;

interface Route {
  method: 'GET' | 'POST';
  parts: string[];
  handler: Handler;
}

export class Hub {
  readonly stores = new Map<string, StoreEntry>();
  /** 「你的商店」：按配置建的门店（编号 my-<配置哈希前 10 位>，演示模式才有） */
  private readonly customConfigs = new Map<string, StoreConfig>();
  private readonly creating = new Map<string, Promise<StoreEntry>>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly routes: Route[] = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private salt = '';

  private constructor(private readonly opts: HubOptions) {
    this.defineRoutes();
  }

  static async create(opts: HubOptions): Promise<Hub> {
    const hub = new Hub(opts);
    // 验证码哈希的盐保存在存储里，重启后仍能核验
    hub.salt = await opts.storage.metaOrInit('code_salt', newSalt(opts.platform));
    if (!opts.lazyStores) for (const id of hub.storeIds) await hub.store(id);
    return hub;
  }

  get storeIds(): string[] {
    return this.opts.storeIds ?? ['demo'];
  }

  /** 门店（不存在或不在名单里时返回 undefined）；第一次用到时建店 */
  async store(id: string): Promise<StoreEntry | undefined> {
    const have = this.stores.get(id);
    if (have) return have;
    if (!this.storeIds.includes(id) && !this.customConfigs.has(id)) return undefined;
    let p = this.creating.get(id);
    if (!p) {
      p = this.createStore(id);
      this.creating.set(id, p);
    }
    return p;
  }

  private async createStore(id: string): Promise<StoreEntry> {
    const { storage, platform } = this.opts;
    // 门店编号 hardware 使用家居建材模板（第二个行业，决策记录 0011）；large 是两层的大型店、300 名员工（容量测试，决策记录 0014）；其他使用中型超市模板
    const template: TemplateName | undefined = id === 'hardware' ? 'hardware' : id === 'large' ? 'large' : undefined;
    const custom = this.customConfigs.get(id);
    const demo = createDemoStore({ id, salt: this.salt, platform, ...(custom ? { config: custom } : template ? { template } : {}), ...(id === 'large' ? { staff: LARGE_STORE_STAFF } : {}) });
    const runtime = new StoreRuntime(id, demo.ctx, demo.statics, storage.events);
    await runtime.init();
    // 建店时载入期初库存（只载入一次）
    if (runtime.state.counters.cases === 0) await runtime.submit({ cmd: { type: 'LoadInventory', cases: demo.openingInventory(Date.now()).cases }, actor: 'system', at: Date.now() });
    // 每店的 AI 服务：载入模型仓库，没有当前版本时做仿真预训练
    const ai = new AiService(runtime, demo, storage);
    await ai.init();
    const e: StoreEntry = { runtime, demo, lastRelease: 0, sim: new StoreSim(runtime), auto: new AutoPilot(runtime, demo), ai, assistant: new Assistant(runtime, demo, ai, this.opts.llm) };
    this.stores.set(id, e);
    if (this.timers.length) void ai.tick().catch((x: unknown) => this.log('error', x));
    return e;
  }

  private log(level: 'warn' | 'error', msg: unknown): void {
    this.opts.log?.(level, msg);
  }

  async sessionOf(token: string | undefined, storeId: string): Promise<SessionRow | undefined> {
    if (!token) return undefined;
    let s = this.sessions.get(token);
    if (!s) {
      s = await this.opts.storage.findSession(token);
      if (!s) return undefined;
      this.sessions.set(token, s);
    }
    return s.storeId === storeId ? s : undefined;
  }

  /** 处理一个请求（HTTP 或浏览器内的等价请求） */
  async handle(req: HubRequest): Promise<HubResponse> {
    try {
      if (req.method === 'GET' && req.path === '/api/health') return ok({ ok: true, db: this.opts.storage.kind, stores: [...this.stores.keys()], time: Date.now() });
      // 「你的商店」（决策记录 0013）：按访客自己搭的门店配置建一家实时门店；同样的配置得到同一个门店编号，
      // 改过布局就是新的门店（旧的作业记录不会和新布局混在一起）
      if (req.method === 'POST' && req.path === '/api/custom-stores') {
        if (!this.opts.demo) return err(403, 'forbidden');
        const { validateStoreConfig } = await configValidator();
        const v = validateStoreConfig((req.body as { config?: unknown } | undefined)?.config);
        if (!v.ok) return ok({ ok: false, issues: v.issues.slice(0, 20) }, 400);
        const id = `my-${this.opts.platform.sha256Hex(JSON.stringify(v.config)).slice(0, 10)}`;
        if (!this.customConfigs.has(id)) this.customConfigs.set(id, v.config);
        await this.store(id);
        return ok({ ok: true, storeId: id });
      }
      const segs = req.path.split('/').filter(Boolean);
      for (const r of this.routes) {
        if (r.method !== req.method || r.parts.length !== segs.length) continue;
        const params: Record<string, string> = {};
        let match = true;
        for (let i = 0; i < r.parts.length; i++) {
          const p = r.parts[i] as string;
          const v = segs[i] as string;
          if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(v);
          else if (p !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        const e = await this.store(params.storeId ?? '');
        if (!e) return err(404, 'store_not_found');
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
        return await r.handler({ req, params, e, token, body });
      }
      return err(404, 'not_found');
    } catch (x) {
      this.log('error', x);
      return err(500, 'internal_error');
    }
  }

  /**
   * 实时连接：先发 hello 和快照（或补发的事件），之后推送新事件。
   * 返回 undefined 表示门店不存在或令牌无效（调用方关闭连接，代码 4401）。
   */
  async connect(storeId: string, token: string | undefined, after: number, send: (frame: string) => void, knownStatics?: string): Promise<HubConnection | undefined> {
    const e = await this.store(storeId);
    const s = e ? await this.sessionOf(token, storeId) : undefined;
    if (!e || !s) return undefined;
    const rt = e.runtime;
    const statics = this.staticsOf(e);
    let known = knownStatics;
    const sync = (a: number) => {
      const missing = a > rt.state.seq ? undefined : rt.eventsAfter(a);
      if (!missing || a === 0) {
        send(this.snapshotFrame(e, known === statics.hash));
        known = statics.hash;
      } else if (missing.length) send(frameOf({ t: 'events', events: missing }));
    };
    send(JSON.stringify({ t: 'hello', storeId, seq: rt.state.seq, serverTime: Date.now(), actor: s.actor, staticsHash: statics.hash }));
    sync(after);
    const unsubscribe = rt.subscribe((m: HubMessage) => (m.t === 'reset' ? sync(0) : send(frameOf(m))), { device: true });
    return {
      receive(raw) {
        let m: { t?: string; id?: number; after?: number };
        try {
          m = JSON.parse(raw) as typeof m;
        } catch {
          return;
        }
        if (m.t === 'ping') send(JSON.stringify({ t: 'pong', id: m.id, serverTime: Date.now() }));
        else if (m.t === 'resync') sync(Number(m.after ?? 0));
      },
      close: unsubscribe,
    };
  }

  private staticsOf(e: StoreEntry): { json: string; hash: string } {
    if (!e.staticsJson) {
      const json = JSON.stringify(e.runtime.statics);
      e.staticsJson = { json, hash: this.opts.platform.sha256Hex(json).slice(0, 16) };
    }
    return e.staticsJson;
  }

  /** 设备快照：精简后的状态（完成超过一小时的作业不发）+ 静态数据（设备已有同一版本时省略） */
  private snapshotFrame(e: StoreEntry, skipStatics: boolean): string {
    const rt = e.runtime;
    const now = Date.now();
    const bucket = Math.floor(now / 60_000);
    let c = e.snap;
    if (!c || c.ref !== rt.state || c.seq !== rt.state.seq || c.bucket !== bucket) {
      c = { ref: rt.state, seq: rt.state.seq, bucket, json: JSON.stringify(clientProjection(rt.state, now)) };
      e.snap = c;
    }
    const st = this.staticsOf(e);
    return `{"t":"snapshot","state":${c.json}${skipStatics ? '' : `,"statics":${st.json}`},"staticsHash":"${st.hash}","serverTime":${now}}`;
  }

  /** 传感器入口（MQTT 等）：直接提交命令 */
  submitSensor(storeId: string, cmd: Extract<OpsCommand, { type: 'RecordSensor' }>): void {
    void this.store(storeId).then((e) => e?.runtime.submit({ cmd, actor: 'sensor', at: Date.now() }));
  }

  /** 启动排程（Tick、拣货批次、AI） */
  start(): void {
    const { tickMs, releaseMs: rel } = this.opts;
    if (!tickMs || this.timers.length) return;
    const releaseMs = rel ?? 10 * 60_000;
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        for (const e of this.stores.values()) {
          const release = now - e.lastRelease >= releaseMs;
          if (release) e.lastRelease = now;
          void e.runtime.submit({ cmd: { type: 'Tick', release }, actor: 'system', at: now }).catch((x: unknown) => this.log('error', x));
          void e.ai.tick(now).catch((x: unknown) => this.log('error', x));
        }
      }, tickMs),
    );
    for (const e of this.stores.values()) void e.ai.tick().catch((x: unknown) => this.log('error', x));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const e of this.stores.values()) {
      e.sim.stop();
      e.auto.stop();
    }
  }

  private on(method: 'GET' | 'POST', path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  }

  private defineRoutes(): void {
    const o = this.opts;
    const authed = (h: (c: Ctx, s: SessionRow) => Promise<HubResponse>): Handler => async (c) => {
      const s = await this.sessionOf(c.token, c.e.runtime.id);
      return s ? h(c, s) : err(401, 'unauthorized');
    };
    const consoleOnly = (h: Handler): Handler => async (c) => {
      const s = await this.sessionOf(c.token, c.e.runtime.id);
      if (!s || s.role !== 'console') return err(s ? 403 : 401, s ? 'forbidden' : 'unauthorized');
      return h(c);
    };
    // AI 管理：控制台或带班负责人
    const aiManager = (h: Handler): Handler => async (c) => {
      const s = await this.sessionOf(c.token, c.e.runtime.id);
      const allowed = !!s && (s.role === 'console' || (s.role === 'associate' && c.e.runtime.statics.roster.find((a) => a.id === s.actor)?.role === 'LEAD'));
      return allowed ? h(c) : err(s ? 403 : 401, s ? 'forbidden' : 'unauthorized');
    };
    // 标签上有顾客姓名，需要会话令牌（可以放在查询参数里，方便在新窗口打开打印）
    const labelAuthed = (h: Handler): Handler => async (c) => ((await this.sessionOf(c.token ?? c.req.query.token, c.e.runtime.id)) ? h(c) : err(401, 'unauthorized'));
    const file = (name: string | undefined) => /^(.+)\.(svg|zpl)$/.exec(name ?? '');
    const deviceAuth = (c: Ctx) => (o.sensorKey ? c.req.headers['x-sensor-key'] === o.sensorKey : o.demo);

    // 会话：演示阶段从名单中选择身份，不使用密码
    this.on('POST', '/api/stores/:storeId/session', async ({ e, body }) => {
      let actor: string;
      let role: SessionRole;
      if (typeof body.associateId === 'string' && body.associateId) {
        const a = e.demo.statics.roster.find((x) => x.id === body.associateId);
        if (!a) return err(404, 'associate_not_found');
        actor = a.id;
        role = 'associate';
      } else if (body.role === 'console' || body.role === 'viewer') {
        if (!o.demo && body.key !== o.consoleKey) return err(403, 'forbidden');
        role = body.role;
        actor = body.role;
      } else return err(400, 'bad_request');
      const token = toBase64Url(o.platform.randomBytes(24));
      await o.storage.addSession(token, { storeId: e.runtime.id, actor, role }, Date.now());
      return ok({ token, actor, role });
    });

    this.on('GET', '/api/stores/:storeId/snapshot', authed(async ({ e }) => ok({ statics: e.runtime.statics, state: e.runtime.state, serverTime: Date.now() })));
    this.on('GET', '/api/stores/:storeId/events', authed(async ({ e, req }) => ok({ events: await o.storage.events.load(e.runtime.id, Number(req.query.after ?? 0)) })));

    this.on(
      'POST',
      '/api/stores/:storeId/commands',
      authed(async ({ e, body }, s) => {
        if (!validShape(body.cmd)) return err(400, 'bad_command');
        const cmd = body.cmd;
        const allowed = s.role === 'associate' ? ASSOCIATE_COMMANDS.has(cmd.type) : s.role === 'console' ? CONSOLE_COMMANDS.has(cmd.type) : false;
        if (!allowed) return err(403, 'command_not_allowed');
        // 控制台代替顾客 / 司机签到、上报到达时间，以及司机取消接单
        const asDriverOrCustomer = s.role === 'console' && (cmd.type === 'CheckIn' || cmd.type === 'UpdateEta' || cmd.type === 'CancelTripDriver');
        const actor = asDriverOrCustomer ? ('tripId' in cmd && cmd.tripId ? 'driver' : 'customer') : s.actor;
        const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : undefined;
        const r = await e.runtime.submit({ cmd, actor, at: Date.now() }, id);
        return ok(r, r.ok ? 200 : 409);
      }),
    );

    // 替代品候选（拣货员报告缺货时）；当前版本是学习排序时按预计接受概率排序（决策记录 0010）
    this.on('GET', '/api/stores/:storeId/substitutes', authed(async ({ e, req }) => ok(e.ai.substitutes(String(req.query.itemId ?? '')))));

    // 标签（SVG 预览 / ZPL）
    const max = (e: StoreEntry) => e.demo.ctx.model.config.rules.labels.nameMaxLength;
    this.on(
      'GET',
      '/api/stores/:storeId/labels/tote/:file',
      labelAuthed(async ({ e, params }) => {
        const m = file(params.file);
        const data = m ? toteLabelData(e.runtime.state, m[1] as string, max(e)) : undefined;
        if (!m || !data) return err(404, 'label_not_found');
        const L = await labelsLib();
        return m[2] === 'svg' ? svg(L.toteLabelSvg(data)) : zpl(L.toteLabelZpl(data));
      }),
    );
    this.on(
      'GET',
      '/api/stores/:storeId/labels/oversized/:file',
      labelAuthed(async ({ e, params }) => {
        const m = file(params.file);
        const data = m ? oversizedLabelData(e.runtime.state, m[1] as string, max(e)) : undefined;
        if (!m || !data) return err(404, 'label_not_found');
        const L = await labelsLib();
        return m[2] === 'svg' ? svg(L.toteLabelSvg(data)) : zpl(L.toteLabelZpl(data));
      }),
    );
    this.on(
      'GET',
      '/api/stores/:storeId/labels/walk/:walkId',
      labelAuthed(async ({ e, params }) => {
        const w = e.runtime.state.walks[params.walkId ?? ''];
        if (!w) return err(404, 'walk_not_found');
        const L = await labelsLib();
        const svgs = w.toteIds.map((id) => toteLabelData(e.runtime.state, id, max(e))).filter((d): d is ToteLabelData => !!d).map((d) => L.toteLabelSvg(d));
        return html(sheet(`Labels ${w.id}`, svgs));
      }),
    );
    this.on('GET', '/api/stores/:storeId/labels/slots', async ({ e }) => {
      const L = await labelsLib();
      return html(sheet('Staging slot labels', e.runtime.statics.slots.map((s) => L.slotLabelSvg(s.code, s.tempZone))));
    });
    this.on('GET', '/api/stores/:storeId/labels/slot/:file', async ({ e, params }) => {
      const m = file(params.file);
      const slot = m ? e.runtime.statics.slots.find((s) => s.code === m[1]) : undefined;
      if (!m || !slot) return err(404, 'slot_not_found');
      const L = await labelsLib();
      return m[2] === 'svg' ? svg(L.slotLabelSvg(slot.code, slot.tempZone)) : zpl(L.slotLabelZpl(slot.code, slot.tempZone));
    });

    // 演示接口
    this.on(
      'POST',
      '/api/stores/:storeId/demo/orders',
      consoleOnly(async ({ e, body }) => {
        const type = body.type === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
        const count = Math.min(Math.max(1, Math.floor(Number(body.count ?? 1))), 20);
        const now = Date.now();
        // 时段起点：至少 slotInMin 分钟之后，按 5 分钟取整
        const slotStart = Math.ceil((now + Number(body.slotInMin ?? 40) * 60_000) / 300_000) * 300_000;
        const created: Array<{ orderId: string; shortCode: string; code: string; name: string }> = [];
        for (let i = 0; i < count; i++) {
          const index = Object.keys(e.runtime.state.orders).length;
          const ord = e.demo.makeOrder({ index, type, slotStart, maxLines: Number(body.maxLines ?? 5), oversized: !!body.oversized });
          const r = await e.runtime.submit({ cmd: { type: 'CreateOrder', order: ord.info, codeHash: ord.codeHash }, actor: 'console', at: Date.now() });
          if (!r.ok) return ok(r, 409);
          // 演示「熟食现做」：每单加一份菜单上的熟食
          const menu = e.runtime.statics.mtoMenu ?? [];
          if (body.mto && menu.length) await e.runtime.submit({ cmd: { type: 'CreateMtoTicket', orderId: ord.info.id, menuId: (menu[index % menu.length] as { id: string }).id, qty: 1 }, actor: 'console', at: Date.now() });
          created.push({ orderId: ord.info.id, shortCode: ord.info.shortCode, code: ord.code, name: `${ord.info.firstName} ${ord.info.lastName}` });
          if (body.release) await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: ord.info.id }, actor: 'console', at: Date.now() });
        }
        if (body.release) await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
        return ok({ orders: created });
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/demo/trips/:tripId/accept',
      consoleOnly(async ({ e, params, body }) => {
        const tripId = params.tripId ?? '';
        const code = randomCode(o.platform);
        const r = await e.runtime.submit({ cmd: { type: 'AcceptTrip', tripId, driverName: String(body.driverName ?? 'Driver'), codeHash: e.demo.hashCode(tripId, code) }, actor: 'driver', at: Date.now() });
        return ok(r.ok ? { ...r, code } : r, r.ok ? 200 : 409);
      }),
    );
    this.on('POST', '/api/stores/:storeId/demo/tick', consoleOnly(async ({ e, body }) => ok(await e.runtime.submit({ cmd: { type: 'Tick', release: !!body.release }, actor: 'system', at: Date.now() }))));
    this.on(
      'POST',
      '/api/stores/:storeId/demo/reset',
      consoleOnly(async ({ e }) => {
        if (!o.demo) return err(403, 'forbidden');
        await e.runtime.reset();
        await e.runtime.submit({ cmd: { type: 'LoadInventory', cases: e.demo.openingInventory(Date.now()).cases }, actor: 'system', at: Date.now() });
        if (o.tickMs) await e.ai.issueForecast();
        return ok({ ok: true });
      }),
    );

    // AI：模型仓库（任何会话可以查看）；重新训练、回滚、立即发出预测（控制台或带班负责人）
    this.on('GET', '/api/stores/:storeId/ai/models', authed(async ({ e }) => ok(e.ai.summary())));
    this.on(
      'POST',
      '/api/stores/:storeId/ai/retrain',
      aiManager(async ({ e, body }) => {
        const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k): k is string => typeof k === 'string').slice(0, 10) : undefined;
        const seed = Number.isInteger(body.seed) ? (body.seed as number) : Math.floor(Math.random() * 1e6);
        return ok(await e.ai.train({ ...(kinds?.length ? { kinds } : {}), seed }));
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/ai/rollback',
      aiManager(async ({ e }) => {
        const v = await e.ai.rollback();
        return v ? ok({ ok: true, champion: v.version }) : ok({ ok: false, error: 'nothing_to_roll_back' }, 409);
      }),
    );
    this.on('POST', '/api/stores/:storeId/ai/scan', aiManager(async ({ e }) => ok({ shelves: await e.ai.scanShelves(), counts: await e.ai.scanCounts(), dispatch: await e.ai.scanDispatch(), plan: !!(await e.ai.issueStaffPlan())?.ok })));
    // 本地助手：任何会话都可以提问；评测集（控制台或带班负责人）
    this.on('GET', '/api/stores/:storeId/ai/assistant', authed(async ({ e }) => ok(e.assistant.status())));
    this.on(
      'POST',
      '/api/stores/:storeId/ai/ask',
      authed(async ({ e, body }) => {
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) return err(400, 'bad_request');
        const r = await e.assistant.ask(question, body.lang === 'en' ? 'en' : 'zh');
        return ok({ answer: r.answer, source: r.source, tools: r.tools, citations: r.citations, ms: r.ms, ...(r.fallback ? { fallback: r.fallback } : {}) });
      }),
    );
    this.on('POST', '/api/stores/:storeId/ai/assistant/eval', aiManager(async ({ e, body }) => ok(await runEval(e.assistant, buildEvalSet(e.runtime, e.demo, e.ai), body.mode === 'AUTO' ? 'AUTO' : 'TEMPLATE'))));
    // 退货去向建议（扫描后显示；员工的选择与建议一起记录）
    this.on(
      'GET',
      '/api/stores/:storeId/ai/return-suggestion',
      authed(async ({ e, req }) => {
        const r = e.ai.returnSuggestion(String(req.query.returnId ?? ''), Number(req.query.index ?? -1));
        return r ? ok(r) : err(404, 'not_found');
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/ai/forecast',
      aiManager(async ({ e }) => {
        const r = await e.ai.issueForecast();
        if (!r) return ok({ ok: false, error: 'no_model' }, 409);
        return ok(r, r.ok ? 200 : 409);
      }),
    );

    // 演示：包裹到货通知（N 个包裹，分成 K 个行程）
    this.on(
      'POST',
      '/api/stores/:storeId/demo/parcels',
      consoleOnly(async ({ e, body }) => {
        const n = Math.min(Math.max(1, Math.floor(Number(body.count ?? 8))), 60);
        const trips = Math.min(Math.max(1, Math.floor(Number(body.trips ?? 2))), 10);
        const seq = Object.keys(e.runtime.state.parcels).length;
        const sizes = ['S', 'S', 'M', 'S', 'M', 'L'] as const;
        // 重量与尺寸一致：小件 0.3–3 kg，中件 2–8 kg，大件 6–20 kg
        const weightFor = (size: 'S' | 'M' | 'L', i: number) => {
          const [lo, hi] = size === 'S' ? [0.3, 3] : size === 'M' ? [2, 8] : [6, 20];
          return Math.round((lo + (((i * 37) % 10) / 10) * (hi - lo)) * 10) / 10;
        };
        const parcels = Array.from({ length: n }, (_, i) => {
          const sizeClass = sizes[i % sizes.length] as 'S' | 'M' | 'L';
          return { parcelId: `PKG${String(seq + i + 1).padStart(5, '0')}`, tripRef: `TR-${String.fromCharCode(65 + (i % trips))}`, sizeClass, weightKg: weightFor(sizeClass, i) };
        });
        const r = await e.runtime.submit({ cmd: { type: 'CreateParcelAsn', carrier: 'Regional Parcel', parcels, expectedInMin: Number(body.expectedInMin ?? 90) }, actor: 'console', at: Date.now() });
        return ok(r.ok ? { ok: true, parcels: parcels.map((p) => p.parcelId) } : r, r.ok ? 200 : 409);
      }),
    );

    // 感知层：传感器读数（原型指南 7.9 节的 JSON，可以一次发一条或一批）与 POS 销售流水
    this.on('POST', '/api/stores/:storeId/sensors', async (c) => {
      if (!deviceAuth(c)) return err(401, 'unauthorized');
      const list = Array.isArray(c.req.body) ? (c.req.body as unknown[]) : [c.req.body];
      let accepted = 0;
      const rejected: Array<{ index: number; error: string }> = [];
      for (let i = 0; i < Math.min(list.length, 500); i++) {
        const r = sensorCommand(list[i]);
        if (!r.ok) {
          rejected.push({ index: i, error: r.error });
          continue;
        }
        const res = await c.e.runtime.submit({ cmd: r.cmd, actor: 'sensor', at: Date.now() });
        if (res.ok) accepted++;
        else rejected.push({ index: i, error: res.reject.code });
      }
      return ok({ accepted, rejected });
    });
    this.on('POST', '/api/stores/:storeId/pos/sales', async (c) => {
      if (!deviceAuth(c)) return err(401, 'unauthorized');
      const lines = c.body.lines;
      if (!Array.isArray(lines)) return err(400, 'bad_request');
      const clean = lines.filter((l): l is { itemId: string; qty: number } => !!l && typeof (l as { itemId?: unknown }).itemId === 'string' && Number.isFinite((l as { qty?: unknown }).qty)).slice(0, 2000);
      return ok(await c.e.runtime.submit({ cmd: { type: 'RecordSales', lines: clean }, actor: 'pos', at: Date.now() }));
    });

    // 演示：自动运营（双线并行）
    this.on('GET', '/api/stores/:storeId/demo/autopilot', consoleOnly(async ({ e }) => ok(e.auto.status)));
    this.on(
      'POST',
      '/api/stores/:storeId/demo/autopilot',
      consoleOnly(async ({ e, body }) => {
        if (body.action === 'stop') e.auto.stop();
        else e.auto.start({ ordersPerHour: Number(body.ordersPerHour ?? e.auto.status.ordersPerHour), deliveryShare: Number(body.deliveryShare ?? e.auto.status.deliveryShare), pace: Number(body.pace ?? e.auto.status.pace) });
        return ok(e.auto.status);
      }),
    );

    // 演示：门店客流与传感器仿真、让货架变空、到货通知
    this.on('GET', '/api/stores/:storeId/demo/sim', consoleOnly(async ({ e }) => ok(e.sim.status)));
    this.on(
      'POST',
      '/api/stores/:storeId/demo/sim',
      consoleOnly(async ({ e, body }) => {
        if (body.action === 'stop') e.sim.stop();
        else if (body.action === 'autoRestock') e.sim.setAutoRestock(body.on === true);
        else e.sim.start(Number(body.speed ?? 30));
        return ok(e.sim.status);
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/demo/shelf-empty',
      consoleOnly(async ({ e, body }) => {
        const done = await e.sim.emptyShelf(String(body.itemId ?? ''), !!body.silent);
        return ok({ ok: done }, done ? 200 : 404);
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/demo/asn',
      consoleOnly(async ({ e, body }) => {
        const n = Math.min(Math.max(1, Number(body.items ?? 6)), 40);
        // 选后仓没货、卖得快的商品
        const st = e.runtime.statics;
        const pick = [...st.planogram].filter((p) => !sellableCases(e.runtime.state, p.itemId).length).sort((a, b) => b.baseVelocity - a.baseVelocity || a.itemId.localeCompare(b.itemId)).slice(0, n);
        const lines = pick.map((p, i) => ({ itemId: p.itemId, gtin: p.gtin, name: p.name, cases: 1 + (i % 3), packQty: p.packQty }));
        const r = await e.runtime.submit({ cmd: { type: 'CreateAsn', supplier: 'Regional DC', lines }, actor: 'console', at: Date.now() });
        return ok(r, r.ok ? 200 : 409);
      }),
    );

    // 后仓标签：箱标签（每箱）、收货单的全部箱标签、库位标签、货架货位标签
    this.on('GET', '/api/stores/:storeId/labels/case/:file', async ({ e, params }) => {
      const m = file(params.file);
      const c = m ? e.runtime.state.cases[m[1] as string] : undefined;
      if (!m || !c) return err(404, 'case_not_found');
      const data = { caseId: c.id, gtin: c.gtin, name: c.name, packQty: c.packQty, receivedAt: c.receivedAt };
      const L = await labelsLib();
      return m[2] === 'svg' ? svg(L.caseLabelSvg(data)) : zpl(L.caseLabelZpl(data));
    });
    this.on('GET', '/api/stores/:storeId/labels/receipt/:receiptId', async ({ e, params }) => {
      const id = params.receiptId ?? '';
      const cases = Object.values(e.runtime.state.cases).filter((c) => c.receiptId === id);
      const L = await labelsLib();
      return html(sheet(`Case labels ${id}`, cases.map((c) => L.caseLabelSvg({ caseId: c.id, gtin: c.gtin, name: c.name, packQty: c.packQty, receivedAt: c.receivedAt }))));
    });
    this.on('GET', '/api/stores/:storeId/labels/bins', async ({ e }) => {
      const L = await labelsLib();
      return html(sheet('Backroom bin labels', e.runtime.statics.bins.map((b) => L.locationLabelSvg(b.code, `${b.status === 'SELLABLE' ? 'BACKROOM' : b.status} · ${b.tempZone}`))));
    });
    this.on('GET', '/api/stores/:storeId/labels/location/:file', async ({ e, params }) => {
      const m = file(params.file);
      const code = m?.[1]?.toUpperCase() ?? '';
      const bin = e.runtime.statics.bins.find((b) => b.code === code);
      const items = locationIndex(e.runtime.statics).get(code);
      if (!m || (!bin && !items)) return err(404, 'location_not_found');
      const caption = bin ? `${bin.status === 'SELLABLE' ? 'BACKROOM' : bin.status} · ${bin.tempZone}` : `SHELF · ${items?.length ?? 0} ITEMS`;
      const L = await labelsLib();
      return m[2] === 'svg' ? svg(L.locationLabelSvg(code, caption)) : zpl(L.locationLabelZpl(code, caption));
    });
  }
}
