import type { ToteLabelData } from '@storewright/labels';
import { generateRecallNotices, matchRecall, parseRecallNotice } from '@storewright/ai';
import { formatGs1 } from '@storewright/domain';
import { clientProjection, dateOf, locationIndex, outcomeSummary, pickBlockedItems, sellableCases, shelfNow, weekOf, type OpsCommand, type OpsCommandType, type OpsState, RECOVERY_CODES } from '@storewright/ops';
import type { StoreConfig, TemplateName } from '@storewright/store-config';
import { AiService } from './ai';
import { OpsAiService } from './aiOps';
import { openingBrief } from './brief';
import { foodSafetyLog } from './foodsafety';
import { closingReview, weeklyReport } from './review';
import { SOP, SOP_QUIZ } from './assistant/sop';
import { Assistant, type LlmConfig } from './assistant';
import { buildEvalSet, runEval } from './assistant/eval';
import { createDemoStore, newSalt, randomCode, type DemoStore } from './demo';
import { toBase64Url, type HubPlatform } from './platform';
import { StoreRuntime, type HubMessage } from './runtime';
import { sensorCommand } from './sensing';
import type { HubStorage, SessionRole, SessionRow } from './storage';
import { StoreSim } from './storeSim';
import { AutoPilot } from './autopilot';
import { TwinService, type FaultMode } from './twin';

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
 * - AI：模型版本与回测指标、重新训练、回滚、立即发出预测、助手问答（决策记录 0010）；
 * - 数字孪生：设备遥测接入、孪生快照与推送、回放到任意时刻、演示用的设备故障（决策记录 0016）。
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
  /** 数字孪生：设备遥测、告警规则、回放、健康度（决策记录 0016） */
  twin: TwinService;
  /** 门店 AI 第二轮的实时部分：拣货时长、订单量展望、缺货预判、运营预警、建议中枢（决策记录 0021） */
  opsAi: OpsAiService;
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
  // 店员代签到、退出交付准备（决策记录 0026）
  'CheckIn',
  'AbandonPrep',
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
  'ReturnExceptionItems',
  // 放回队列（决策记录 0026）
  'ReleaseException',
  'ReleaseCount',
  // 门店设置（决策记录 0026）：带班负责人可以改，作业核心里检查
  'SetStoreSettings',
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
  // 顺路核对：拣货员跳过（决策记录 0022 · C3）
  'SkipWalkCheck',
  // 冷链与分框（决策记录 0023 · B3、B7）：剩下的行转给别人、框装满了加一个框
  'HandOverLines',
  'AddTote',
  // AI 建议与运行模式（Phase 5，作业核心再检查是否为带班负责人）
  'AcceptRecommendation',
  'OverrideRecommendation',
  'DismissRecommendation',
  'SetAiMode',
  'ChangeRole',
  'LockAssociate',
  'AddNote',
  'RemoveNote',
  // 设备告警的确认（带班负责人，作业核心里检查；决策记录 0016）
  'AcknowledgeAlert',
  // 提醒：收到的人标记已读（决策记录 0021）
  'ReadNudge',
  // 排班与补位（决策记录 0022）：发布排班、报告缺勤只有带班负责人（作业核心里检查）；补班邀请由被邀请的人答复
  'PublishSchedule',
  'ReportAbsence',
  'RespondShiftOffer',
  // 设备报修（带班负责人，作业核心里检查；决策记录 0022）
  'RequestMaintenance',
  'CloseMaintenance',
  // 时段产能（带班负责人，作业核心里检查；决策记录 0023）
  'CloseSlot',
  'ReopenSlot',
  // 交付时记下顾客对替代品的反应（决策记录 0023 · B4）
  'RateSubstitution',
  // 门店助手的回答「有用 / 没用」（决策记录 0024 · F2）、现场操作提示看过了（D4）
  'RateAnswer',
  'AckSop',
  // 「下一步」照着做了 / 换一个（决策记录 0024 · D3）
  'NextTaskFeedback',
  // 现场应对（决策记录 0024）：召回、突发状况由带班负责人开启（作业核心里检查），清单上的步骤谁都可以打勾
  'OpenRecall',
  'MarkRecallStep',
  'CloseRecall',
  'StartIncident',
  'CheckIncidentStep',
  'EndIncident',
  'ConfirmFoodSafetyLog',
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
  // 决策记录 0026：删掉扫错的退货行、打印大件标签、处理多出和损坏的包裹、按行程交给司机
  'RemoveReturnLine',
  'PrintOversizedLabel',
  'ResolveParcel',
  'HandOffParcels',
  // 决策记录 0026：带班负责人在手机上报修、关报修单、直接发补班邀请（作业核心只认带班负责人）
  'RequestMaintenance',
  'CloseMaintenance',
  'SendShiftOffer',
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

export const CONSOLE_COMMANDS = new Set<OpsCommandType>(['CancelOrder', 'LockOrder', 'ReleaseWalks', 'UpdateEta', 'CheckIn', 'CancelTripDriver', 'RedispatchTrip', 'CreateAsn', 'UpdateAsnEta', 'ArriveTruck', 'RecordSales', 'RequestReplenishment', 'CreateCount', 'AcceptRecommendation', 'OverrideRecommendation', 'DismissRecommendation', 'SetAiMode', 'ChangeRole', 'LockAssociate', 'AddNote', 'RemoveNote', 'CreateMtoTicket', 'DiscardMto', 'StartReturn', 'CreateParcelAsn', 'HandOffParcels', 'InductParcel', 'ResolveParcel', 'AcknowledgeAlert', 'ReadNudge', 'PublishSchedule', 'ReportAbsence', 'SendShiftOffer', 'RequestMaintenance', 'CloseMaintenance', 'CloseSlot', 'ReopenSlot', 'RateSubstitution', 'OpenRecall', 'MarkRecallStep', 'CloseRecall', 'StartIncident', 'CheckIncidentStep', 'EndIncident', 'ConfirmFoodSafetyLog', 'RateAnswer', 'AckSop', 'SetStoreSettings']);

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
  AbandonPrep: { key: 'string' },
  ReleaseException: { exceptionId: 'string' },
  ReleaseCount: { countId: 'string' },
  ReturnExceptionItems: { exceptionId: 'string' },
  CreateAsn: { supplier: 'string', lines: 'array' },
  UpdateAsnEta: { receiptId: 'string', expectedAt: 'number' },
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
  SkipWalkCheck: { walkId: 'string', itemId: 'string' },
  HandOverLines: { walkId: 'string' },
  AddTote: { walkId: 'string', toteId: 'string' },
  CloseSlot: { slotStart: 'number' },
  RateSubstitution: { orderId: 'string', lineId: 'string', accepted: 'boolean' },
  OpenRecall: { title: 'string', itemIds: 'array' },
  MarkRecallStep: { recallId: 'string', step: 'string', done: 'boolean' },
  CloseRecall: { recallId: 'string' },
  StartIncident: { kind: 'string' },
  CheckIncidentStep: { incidentId: 'string', stepId: 'string' },
  EndIncident: { incidentId: 'string' },
  ConfirmFoodSafetyLog: { date: 'string' },
  RateAnswer: { answerId: 'string', helpful: 'boolean' },
  AckSop: { sopId: 'string' },
  NextTaskFeedback: { kind: 'string', ref: 'string', taken: 'boolean' },
  ReopenSlot: { slotStart: 'number' },
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
  RemoveReturnLine: { returnId: 'string', index: 'number' },
  SetReturnDisposition: { returnId: 'string', index: 'number', disposition: 'string' },
  CompleteReturn: { returnId: 'string' },
  ClaimOversized: { orderId: 'string', maxPieces: 'number' },
  ReleaseOversized: { pieceIds: 'array' },
  ScanOversized: { pieceId: 'string', code: 'string' },
  StageOversized: { pieceId: 'string', area: 'string' },
  PrintOversizedLabel: { pieceId: 'string' },
  CreateParcelAsn: { carrier: 'string', parcels: 'array' },
  InductParcel: { code: 'string' },
  StageParcel: { parcelId: 'string', slotCode: 'string' },
  ReportParcelDamaged: { parcelId: 'string' },
  ResolveParcel: { parcelId: 'string', action: 'string' },
  HandOffParcels: { tripRef: 'string' },
  AcknowledgeAlert: { alertId: 'string' },
  ReadNudge: { nudgeId: 'string' },
  PublishSchedule: { week: 'string', shifts: 'array' },
  ReportAbsence: { associateId: 'string', date: 'string' },
  RespondShiftOffer: { offerId: 'string', accept: 'boolean' },
  SendShiftOffer: { associateId: 'string', date: 'string', from: 'number', to: 'number' },
  RequestMaintenance: { sensorId: 'string' },
  CloseMaintenance: { ticketId: 'string', fault: 'string' },
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
    const sim = new StoreSim(runtime);
    // 数字孪生：客流计数跟着门店客流仿真的门店时间走（仿真没有运行时按墙上时钟）
    const twin = new TwinService(runtime, storage.events, { demo: this.opts.demo, storeHour: () => (sim.status.running ? sim.status.storeHour : undefined) });
    await twin.init();
    // 前场收银通道（决策记录 0022 · A3）：入口客流计数最近 10 分钟、再往前 10 分钟的平均（每小时人数）；
    // 人工收银通道数和三维场景的布置一致（按一楼的宽度，3–10 条），另有 4 台自助收银
    const shoppers = () => {
      const now = Date.now();
      const avg = (from: number, to: number) => {
        const b = twin.series('C-ENTRANCE', from, to).filter((x) => x.n > 0);
        return b.length ? b.reduce((a, x) => a + x.avg, 0) / b.length : undefined;
      };
      const cur = avg(now - 10 * 60_000, now);
      if (cur === undefined) return undefined;
      const before = avg(now - 20 * 60_000, now - 10 * 60_000);
      return before === undefined ? { now: cur } : { now: cur, before };
    };
    const width = demo.ctx.model.config.layout.floors[0]?.widthM ?? 60;
    const lanes = { manual: Math.min(10, Math.max(3, Math.round(width / 12))), self: 4 };
    // 演示门店：运营预警每分钟看一次、严重告警 2 分钟没人确认就升级、订单量展望更快跟上实际（方便在演示里看到效果）
    const opsAi = new OpsAiService(runtime, ai, { ...(this.opts.demo ? { foresightMs: 60_000, nudgeMs: 10_000, escalateAfterMin: 2, outlookDriftMin: 3, outlookMinObsMin: 8, storeScanMs: 60_000 } : {}), shoppers, lanes });
    const e: StoreEntry = { runtime, demo, lastRelease: 0, sim, auto: new AutoPilot(runtime, demo), ai, assistant: new Assistant(runtime, demo, ai, this.opts.llm), twin, opsAi };
    this.stores.set(id, e);
    if (this.timers.length) {
      void ai.tick().catch((x: unknown) => this.log('error', x));
      twin.start();
    }
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
    // 孪生的查看端（模拟器、控制台）订阅遥测推送；员工手机不订阅，只记下在线（孪生健康度用，决策记录 0016）
    let twinOff: (() => void) | undefined;
    if (s.role === 'associate') e.twin.deviceConnected(s.actor, 1);
    return {
      receive(raw) {
        let m: { t?: string; id?: number; after?: number; on?: boolean };
        try {
          m = JSON.parse(raw) as typeof m;
        } catch {
          return;
        }
        if (m.t === 'ping') send(JSON.stringify({ t: 'pong', id: m.id, serverTime: Date.now() }));
        else if (m.t === 'resync') sync(Number(m.after ?? 0));
        else if (m.t === 'twin') {
          twinOff?.();
          twinOff = undefined;
          if (m.on !== false) {
            twinOff = e.twin.subscribe((f) => send(frameOf(f)));
            send(frameOf(e.twin.frame()));
          }
        }
      },
      close: () => {
        unsubscribe();
        twinOff?.();
        if (s.role === 'associate') e.twin.deviceConnected(s.actor, -1);
      },
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

  /** 设备遥测入口（MQTT）：交给门店的孪生服务 */
  submitTelemetry(storeId: string, reading: { sensorId: string; value: number; at: number }): void {
    void this.store(storeId).then((e) => e?.twin.ingest([reading]));
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
          void e.opsAi.tick(now).catch((x: unknown) => this.log('error', x));
        }
      }, tickMs),
    );
    for (const e of this.stores.values()) {
      void e.ai.tick().catch((x: unknown) => this.log('error', x));
      e.twin.start();
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const e of this.stores.values()) {
      e.sim.stop();
      e.auto.stop();
      e.twin.stop();
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
      // 回收专区的标签（每个温区一个，决策记录 0026）：移到回收专区时扫一下
      const zones = [...new Set(e.runtime.statics.slots.map((s) => s.tempZone))];
      return html(sheet('Staging slot labels', [...e.runtime.statics.slots.map((s) => L.slotLabelSvg(s.code, s.tempZone)), ...zones.map((z) => L.slotLabelSvg(RECOVERY_CODES[z], z))]));
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
        // 被拒的单跳过、接着建下一张（决策记录 0026：以前遇到第一个拒绝就停下）；全部被拒才算失败
        const rejected: Array<{ index: number; reject: unknown }> = [];
        for (let i = 0; i < count; i++) {
          const index = Object.keys(e.runtime.state.orders).length;
          const ord = e.demo.makeOrder({ index: index + rejected.length, type, slotStart, maxLines: Number(body.maxLines ?? 5), oversized: !!body.oversized });
          const r = await e.runtime.submit({ cmd: { type: 'CreateOrder', order: ord.info, codeHash: ord.codeHash }, actor: 'console', at: Date.now() });
          if (!r.ok) {
            rejected.push({ index: i, reject: 'reject' in r ? r.reject : undefined });
            continue;
          }
          // 演示「熟食现做」：每单加一份菜单上的熟食
          const menu = e.runtime.statics.mtoMenu ?? [];
          if (body.mto && menu.length) await e.runtime.submit({ cmd: { type: 'CreateMtoTicket', orderId: ord.info.id, menuId: (menu[index % menu.length] as { id: string }).id, qty: 1 }, actor: 'console', at: Date.now() });
          created.push({ orderId: ord.info.id, shortCode: ord.info.shortCode, code: ord.code, name: `${ord.info.firstName} ${ord.info.lastName}` });
          if (body.release) await e.runtime.submit({ cmd: { type: 'LockOrder', orderId: ord.info.id }, actor: 'console', at: Date.now() });
        }
        if (body.release && created.length) await e.runtime.submit({ cmd: { type: 'ReleaseWalks' }, actor: 'console', at: Date.now() });
        if (!created.length && rejected.length) return ok({ ok: false, reject: rejected[0]?.reject, orders: [], rejected }, 409);
        return ok({ orders: created, ...(rejected.length ? { rejected } : {}) });
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
      authed(async ({ e, body }, sess) => {
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) return err(400, 'bad_request');
        const r = await e.assistant.ask(question, body.lang === 'en' ? 'en' : 'zh');
        // 问答写进事件流（决策记录 0024 · F2），之后可以标「有用 / 没用」
        const answerId = `QA${String((e.runtime.state.answerStats?.answered ?? 0) + 1).padStart(5, '0')}`;
        const logged = await e.runtime.submit({ cmd: { type: 'LogAnswer', answerId, question, tools: r.tools.map((x) => x.name), source: r.source, by: sess.actor }, actor: 'ai', at: Date.now() });
        return ok({ answer: r.answer, source: r.source, tools: r.tools, citations: r.citations, ms: r.ms, ...(r.fallback ? { fallback: r.fallback } : {}), ...(logged.ok ? { answerId } : {}) });
      }),
    );
    this.on('POST', '/api/stores/:storeId/ai/assistant/eval', aiManager(async ({ e, body }) => ok(await runEval(e.assistant, buildEvalSet(e.runtime, e.demo, e.ai), body.mode === 'AUTO' ? 'AUTO' : 'TEMPLATE'))));
    // 门店 AI 第二轮（决策记录 0021）：每件商品找得到的概率（给订单平台标「可能缺货」，决策 AS-06）、运营预警立即看一次、提醒统计
    this.on(
      'GET',
      '/api/stores/:storeId/ai/availability',
      authed(async ({ e, req }) => {
        const want = typeof req.query.itemIds === 'string' && req.query.itemIds ? new Set(req.query.itemIds.split(',').slice(0, 500)) : undefined;
        const now = Date.now();
        const items = e.runtime.statics.planogram
          .filter((p) => !want || want.has(p.itemId) || want.has(p.gtin))
          .map((p) => {
            const f = e.ai.findProbability(p.itemId, 1, 0, now);
            return {
              itemId: p.itemId,
              gtin: p.gtin,
              name: p.name,
              pFind: f.p,
              est: Math.round(f.est),
              ...(f.silence !== undefined ? { silence: f.silence } : {}),
              // 拣货员报告（决策记录 0022 · C1）：找不到时更可能是放错了地方还是真的没了
              ...(f.belief ? { reports: f.belief.used.length, pMisplaced: f.belief.pMisplaced, pGone: f.belief.pGone } : {}),
              likelyOut: f.p < 0.35,
            };
          });
        return ok({ at: now, items });
      }),
    );
    this.on(
      'POST',
      '/api/stores/:storeId/ai/foresight',
      aiManager(async ({ e }) => {
        const r = await e.opsAi.scanForesight();
        return ok({ problems: r?.problems ?? [], options: (r?.options ?? []).map((o) => ({ action: o.action, kpi: o.kpi, gain: o.gain, cost: o.cost, robust: o.robust })), kpi: r?.base.kpi, basis: r?.base.basis, reasons: r?.reasons ?? [] });
      }),
    );
    this.on('GET', '/api/stores/:storeId/ai/nudges', aiManager(async ({ e }) => ok(e.opsAi.stats())));
    // 开店简报（决策记录 0022 · F1）：早、中、晚三次，不指定时按当前时刻
    this.on(
      'GET',
      '/api/stores/:storeId/ai/brief',
      authed(async ({ e, req }) => {
        const part = req.query.part === 'MORNING' || req.query.part === 'MIDDAY' || req.query.part === 'EVENING' ? req.query.part : undefined;
        return ok(openingBrief(e.runtime, e.ai, Date.now(), part));
      }),
    );
    // 时段产能（决策记录 0023 · B6）：订单平台按这个接口决定每个时段还能不能接单；取舍曲线（仿真）
    this.on('GET', '/api/stores/:storeId/ai/capacity', authed(async ({ e }) => ok({ at: Date.now(), slots: e.opsAi.slotCapacity() })));
    this.on('POST', '/api/stores/:storeId/ai/capacity/curve', aiManager(async ({ e }) => ok(e.opsAi.capacityTradeoff() ?? { curve: [] })));
    // 顾客要求删除个人记录（决策记录 0023 · B4）：替代品标签删掉，以后不用他的到店习惯和替代偏好
    this.on(
      'POST',
      '/api/stores/:storeId/ai/customers/forget',
      aiManager(async ({ e, body }) => {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
        if (!name) return err(400, 'bad_request');
        return ok(await e.ai.forgetCustomer(name));
      }),
    );
    // 现场操作提示（决策记录 0024 · D4）：某条操作规范的文字和小测验
    this.on(
      'GET',
      '/api/stores/:storeId/sop/:sopId',
      authed(async ({ params, req }) => {
        const lang = req.query.lang === 'en' ? 'en' : 'zh';
        const sop = SOP.find((x) => x.id === params.sopId);
        if (!sop) return err(404, 'sop_not_found');
        const quiz = (SOP_QUIZ[sop.id] ?? []).map((q) => ({ q: q.q[lang], options: q.options.map((o) => o[lang]), answer: q.answer }));
        return ok({ id: sop.id, title: sop[lang].title, text: sop[lang].text, quiz });
      }),
    );
    // 打烊复盘、周报（决策记录 0024 · F3、F5）
    this.on('GET', '/api/stores/:storeId/ai/review', authed(async ({ e, req }) => ok(closingReview(e.runtime, e.ai, Date.now(), typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : undefined))));
    this.on('GET', '/api/stores/:storeId/ai/weekly', authed(async ({ e }) => ok(weeklyReport(e.runtime, e.ai))));
    // 卸货门计划（决策记录 0022 · A3）
    this.on('GET', '/api/stores/:storeId/ai/docks', authed(async ({ e }) => ok({ at: Date.now(), plan: e.opsAi.dockPlan() })));
    // 运行监控与效果追踪（决策记录 0022 · H3、F4）：各模型此刻的健康度、各模块的说到做到率
    this.on(
      'GET',
      '/api/stores/:storeId/ai/health',
      authed(async ({ e }) => {
        const s = e.runtime.state;
        const outcomes = Object.fromEntries(Object.entries(s.aiStats).flatMap(([m, st]) => {
          const o = outcomeSummary(st);
          return o ? [[m, o]] : [];
        }));
        return ok({ at: Date.now(), models: e.ai.health(), published: s.aiHealth?.at, outcomes });
      }),
    );
    // 排班草稿（决策记录 0022 · D1）：本周或下周，按订单量预测和名单生成；人确认后用 PublishSchedule 发布
    this.on(
      'POST',
      '/api/stores/:storeId/ai/schedule/draft',
      aiManager(async ({ e, body }) => {
        const week = typeof body.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.week) ? weekOf(body.week) : weekOf(dateOf(Date.now() + 7 * 86_400_000));
        const d = e.ai.scheduleDraft(week);
        if (!d) return ok({ ok: false, error: 'no_model' }, 409);
        const shifts = d.draft.shifts.map((x) => ({ associateId: x.associateId, date: d.dates[x.day] as string, from: x.from, to: x.to, role: x.role }));
        const need = d.demand.map((x) => ({ day: x.day, role: x.role, slots: x.slots }));
        return ok({ ok: true, week, dates: d.dates, shifts, metrics: d.draft.metrics, gaps: d.draft.gaps, cover: d.draft.cover, need, naive: d.naive.metrics, rules: d.rules });
      }),
    );
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

    // 数字孪生（决策记录 0016）：孪生快照（打开时取一次）、回放到 t 时刻、某个传感器的分钟汇总、设备遥测接入、演示用的设备故障
    this.on('GET', '/api/stores/:storeId/twin', authed(async ({ e }) => ok(e.twin.snapshot())));
    this.on(
      'GET',
      '/api/stores/:storeId/twin/at',
      authed(async ({ e, req }) => {
        const now = Date.now();
        const t = Number(req.query.t);
        if (!Number.isFinite(t)) return err(400, 'bad_request');
        return ok(e.twin.at(Math.min(now, Math.max(e.twin.firstAt ?? now, t))));
      }),
    );
    this.on(
      'GET',
      '/api/stores/:storeId/twin/series',
      authed(async ({ e, req }) => {
        const to = Number(req.query.to ?? Date.now());
        const from = Number(req.query.from ?? to - 3600_000);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return err(400, 'bad_request');
        const sensor = String(req.query.sensor ?? '');
        return ok({ sensor, buckets: e.twin.series(sensor, from, to) });
      }),
    );
    this.on('POST', '/api/stores/:storeId/telemetry', async (c) => {
      if (!deviceAuth(c)) return err(401, 'unauthorized');
      const raw: unknown[] = Array.isArray(c.req.body) ? (c.req.body as unknown[]) : Array.isArray(c.body.readings) ? (c.body.readings as unknown[]) : [c.req.body];
      const now = Date.now();
      const readings = raw.slice(0, 500).map((r) => {
        const x = (r ?? {}) as { sensor?: unknown; sensorId?: unknown; value?: unknown; ts?: unknown; at?: unknown };
        const ts = typeof x.ts === 'string' ? Date.parse(x.ts) : Number(x.at ?? x.ts ?? now);
        return { sensorId: String(x.sensor ?? x.sensorId ?? ''), value: Number(x.value), at: Number.isFinite(ts) ? ts : now };
      });
      return ok(c.e.twin.ingest(readings, now));
    });
    this.on(
      'POST',
      '/api/stores/:storeId/demo/fault',
      consoleOnly(async ({ e, body }) => {
        if (!o.demo || !e.twin.sim) return err(403, 'forbidden');
        const target = String(body.target ?? '');
        if (body.on === false) return ok({ ok: true, repaired: e.twin.sim.repair(target || 'ALL'), faults: e.twin.sim.faultList() });
        // 慢性故障（决策记录 0022）：DEGRADE 制冷慢慢变差、SEAL 门封漏气、STUCK 读数卡住
        const modes: FaultMode[] = ['OFFLINE', 'OPEN', 'DEGRADE', 'SEAL', 'STUCK'];
        const mode: FaultMode = modes.includes(body.mode as FaultMode) ? (body.mode as FaultMode) : 'FAIL';
        const sensorId = e.twin.sim.fault(target, mode);
        return sensorId ? ok({ ok: true, sensorId, faults: e.twin.sim.faultList() }) : ok({ ok: false, error: 'no_sensor' }, 404);
      }),
    );

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
        // 供应商预计到达（决策记录 0022 · A3）：默认 30 分钟后
        const inMin = Number.isFinite(Number(body.inMin)) ? Math.min(24 * 60, Math.max(0, Number(body.inMin))) : 30;
        const supplier = typeof body.supplier === 'string' && body.supplier.trim() ? body.supplier.trim().slice(0, 40) : 'Regional DC';
        const r = await e.runtime.submit({ cmd: { type: 'CreateAsn', supplier, lines, expectedAt: Date.now() + inMin * 60_000 }, actor: 'console', at: Date.now() });
        return ok(r, r.ok ? 200 : 409);
      }),
    );

    // 演示：一车货的送货单二维码内容（决策记录 0024 · G3、C4）：每行一条 GS1 数据（条码、保质期、批号、箱数），第一行是订单号。
    // 冷藏商品 3 天后到期（演示临期建议），冷冻 120 天，常温 180 天；最后一行少一箱（演示和到货通知的差异）
    this.on(
      'GET',
      '/api/stores/:storeId/demo/delivery-note/:receiptId',
      authed(async ({ e, params }) => {
        const r = e.runtime.state.receipts[params.receiptId ?? ''];
        if (!r) return err(404, 'receipt_not_found');
        const day = (n: number) => {
          const d = new Date(Date.now() + n * 86_400_000);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const zone = new Map(e.runtime.statics.planogram.map((p) => [p.itemId, p.tempZone]));
        const lines = r.expected.map((l, i) => {
          const z = zone.get(l.itemId);
          const life = z === 'CHILLED' ? 3 : z === 'FROZEN' ? 120 : i % 3 === 0 ? 3 : 180;
          const count = i === r.expected.length - 1 && l.cases > 1 ? l.cases - 1 : l.cases;
          return formatGs1({ gtin: l.gtin, expiry: day(life), lot: `L${r.id.slice(1)}${String(i + 1).padStart(2, '0')}`, count });
        });
        return ok({ text: [`(400)${r.id}`, ...lines].join('\n') });
      }),
    );
    // 召回（决策记录 0024 · C5）：粘贴通知 → 抽取 → 和商品目录匹配（附每件商品的货架、后仓、未完成订单），人确认后用 OpenRecall 开启
    this.on(
      'POST',
      '/api/stores/:storeId/ai/recall/parse',
      aiManager(async ({ e, body }) => {
        const text = typeof body.text === 'string' ? body.text.slice(0, 5000) : '';
        if (!text.trim()) return err(400, 'bad_request');
        const parsed = parseRecallNotice(text);
        const st = e.runtime.statics;
        const s = e.runtime.state;
        const matches = matchRecall(parsed, st.planogram.map((p) => ({ id: p.itemId, name: p.name, gtin: p.gtin })))
          .slice(0, 20)
          .map((m) => {
            const p = st.planogram.find((x) => x.itemId === m.item.id);
            return {
              itemId: m.item.id,
              name: m.item.name,
              gtin: m.item.gtin,
              score: m.score,
              by: m.by,
              shelf: p ? Math.round(shelfNow(s, p).est) : 0,
              cases: Object.values(s.cases).filter((c) => c.itemId === m.item.id && c.units > 0).length,
              openOrders: Object.values(s.orders).filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.lines.some((l) => l.itemId === m.item.id)).length,
            };
          });
        return ok({ parsed, matches });
      }),
    );
    // 演示：一条合成的召回通知（挑一件货架上有、后仓也有的商品）
    this.on(
      'GET',
      '/api/stores/:storeId/demo/recall',
      authed(async ({ e }) => {
        const s = e.runtime.state;
        const st = e.runtime.statics;
        const pool = st.planogram.filter((p) => shelfNow(s, p).est > 0 && sellableCases(s, p.itemId).length > 0);
        const items = (pool.length ? pool : st.planogram).map((p) => ({ id: p.itemId, name: p.name, gtin: p.gtin }));
        const k = Math.floor(Math.random() * 1000);
        const [n] = generateRecallNotices(items, k + 1, 1);
        return ok({ text: n?.text ?? '' });
      }),
    );
    // 收银拦截（决策记录 0024 · C5）：POS 按这个接口拦截召回中的商品
    this.on('GET', '/api/stores/:storeId/recalls/blocked', authed(async ({ e }) => ok({ gtins: [...pickBlockedItems(e.runtime.state)].map((id) => e.runtime.statics.planogram.find((p) => p.itemId === id)?.gtin).filter(Boolean) })));
    // 突发状况的时间线（决策记录 0024 · E4）：开始到结束之间的关键事件（不含销售流水、传感器读数这类）
    this.on(
      'GET',
      '/api/stores/:storeId/incidents/:incidentId/report',
      authed(async ({ e, params }) => {
        const x = e.runtime.state.incidents?.[params.incidentId ?? ''];
        if (!x) return err(404, 'incident_not_found');
        const end = x.endedAt ?? Date.now();
        const quiet = new Set(['SalesRecorded', 'SensorReading', 'NudgesSent', 'NudgesClosed', 'NudgeRead', 'AiHealthPublished', 'OutcomeRecorded', 'DemandOutlookPublished', 'PickWalkEstimated', 'ColdRiskFlagged', 'ToteFactorsUpdated']);
        const events = (await this.opts.storage.events.load(e.runtime.id)).filter((ev) => ev.at >= x.startedAt && ev.at <= end && !quiet.has(ev.type));
        return ok({ incident: x, timeline: events.slice(0, 500).map((ev) => ({ at: ev.at, type: ev.type, actor: ev.actor })) });
      }),
    );
    // 食品安全记录（决策记录 0024 · E5）
    this.on(
      'GET',
      '/api/stores/:storeId/ai/foodsafety',
      authed(async ({ e, req }) => {
        const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : dateOf(Date.now());
        return ok(foodSafetyLog(e.runtime.state, e.twin.defs, (id, from, to) => e.twin.series(id, from, to), date));
      }),
    );
    // 拍照识别文字（没有二维码的送货单、只印了日期的标签）需要视觉模型：默认没有接（可选下载，决策记录 0024 · G3）
    this.on('POST', '/api/stores/:storeId/ai/vision/read', authed(async () => ok({ ok: false, error: 'vision_model_not_configured' }, 501)));
    // 后仓标签：箱标签（每箱）、收货单的全部箱标签、库位标签、货架货位标签
    this.on('GET', '/api/stores/:storeId/labels/case/:file', async ({ e, params }) => {
      const m = file(params.file);
      const c = m ? e.runtime.state.cases[m[1] as string] : undefined;
      if (!m || !c) return err(404, 'case_not_found');
      const data = { caseId: c.id, gtin: c.gtin, name: c.name, packQty: c.packQty, receivedAt: c.receivedAt, ...(c.lot ? { lot: c.lot } : {}), ...(c.expiry ? { expiry: c.expiry } : {}) };
      const L = await labelsLib();
      return m[2] === 'svg' ? svg(L.caseLabelSvg(data)) : zpl(L.caseLabelZpl(data));
    });
    this.on('GET', '/api/stores/:storeId/labels/receipt/:receiptId', async ({ e, params, req }) => {
      const id = params.receiptId ?? '';
      // ?cases=C-…,C-…：只打刚收的这几箱（决策记录 0026）
      const only = new Set(String(req.query.cases ?? '').split(',').map((x) => x.trim()).filter(Boolean));
      const cases = Object.values(e.runtime.state.cases).filter((c) => c.receiptId === id && (!only.size || only.has(c.id)));
      const L = await labelsLib();
      return html(sheet(`Case labels ${id}`, cases.map((c) => L.caseLabelSvg({ caseId: c.id, gtin: c.gtin, name: c.name, packQty: c.packQty, receivedAt: c.receivedAt, ...(c.lot ? { lot: c.lot } : {}), ...(c.expiry ? { expiry: c.expiry } : {}) }))));
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
