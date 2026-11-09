import type { Board, Fix } from '../sim/board';
import type { DayPlan } from '../sim/plan';
import type { Incident } from '../twin/field';
import type { KpiPoint, LoopResult } from '../twin/loop';
import type { Cmd, Policy, Rec, UserDecision } from '../twin/types';
import type { HubDay, HubKey } from '../hub/types';
import type { YardPlan, YardVisit } from '@storewright/yard';
import type { LoopInput } from '../twin/loop';
import type { Role } from './roles';

/**
 * 值班助手的数据：此刻的调度台、每辆车的跟踪信息、闭环孪生（没跑就没有）、设施概况（只有网页有）、资料库。
 *
 * 网页、孪生服务、测试各自把手里的数据转成这一份；助手只读这些数据，不改任何东西：
 * 要改的（批准建议卡、改门改车）都做成「提议」，人确认以后由调用方执行，并记进操作记录。
 */

/** 一辆车此刻的样子（网页的实时跟踪行、孪生服务的车辆详情都能转成它） */
export interface VehRow {
  /** 车辆下标（三维和仿真里的编号） */
  vid: number;
  /** 显示的编号：作业编号或车名 */
  id: string;
  kind: string;
  type: string;
  status: 'pending' | 'moving' | 'working' | 'done';
  act: string;
  where?: string;
  origin: string;
  dest: string;
  next: string;
  nextPlan?: number;
  nextEta?: number;
  depart?: number;
  end?: number;
  delayMin?: number;
  temp?: { value: number; limit: number };
  load?: string;
  cargo?: string;
  remainKm?: number;
}

/** 设施此刻的概况（网页里三维的港口、机场、物流园、门店收货区按同一份计划算出来的） */
export type FacKey = 'port' | 'airport' | 'dc' | 'store';
export interface FacSnap {
  key: FacKey;
  name: string;
  /** 已经写好的几行概况 */
  lines: string[];
  kpi: { label: string; value: string; bad?: boolean }[];
  /** 看板用的数值（港口：闸口排队、堆场利用率；配送中心：月台门在用的比例……） */
  nums?: Record<string, number>;
}

/** 门店一个商品族此刻的库存：现场实际、孪生估计、平均每小时卖多少 */
export interface StockSnap {
  fam: string;
  label: string;
  units: number;
  est?: number;
  perHour: number;
  /** 这一天的需求（件）：按小时曲线往后推什么时候卖空 */
  daily: number;
}

/** 闭环孪生此刻的样子 */
export interface TwinSnap {
  policy: Policy;
  /** 当天全部的建议卡（按此刻过滤：卡的时刻 ≤ 此刻；状态按 statusAt） */
  recs: readonly Rec[];
  cmds: readonly Cmd[];
  decisions: readonly UserDecision[];
  /** 到此刻为止的累计结果：用孪生、不用孪生（同样的现场） */
  kpi?: KpiPoint;
  openKpi?: KpiPoint;
  incidents: readonly Incident[];
  stock: StockSnap[];
  /** 车载终端和门店发来的事件（到此刻为止） */
  events: { t: number; vid: number; ev: string; note?: string; place?: string }[];
  /** 整天的结果（交接班报告、复盘用；只用此刻以前的部分，复盘例外） */
  result?: LoopResult;
  open?: LoopResult;
}

export interface AssistCtx {
  /** 此刻（当天 0 点起的秒） */
  t: number;
  /** 方案（跨境的清关时间按方案不同） */
  gen?: 'g1' | 'g2' | 'g3';
  /** 这一天在演练的扰动（没有就是正常的一天） */
  drill?: { key: string; label: string; detail: string };
  /** 调度台当天的调度（指定的门、车、时刻）和分配库存的时刻（小时）：求解月台门、派车用 */
  day?: DayPlan;
  allocation?: number;
  board: Board;
  rows: VehRow[];
  twin?: TwinSnap;
  /** 设施概况：用到时才算 */
  fac?: () => Partial<Record<FacKey, FacSnap>>;
  /** 资料库：设计文档等（标题 + 正文，按小节切开检索） */
  docs?: { title: string; text: string }[];
  /** 监控画面的识别结果（网页才有）：每个机位认出几辆车、几辆排队、靠台的车靠好没有 */
  cams?: () => { label: string; kind: 'store' | 'dc' | 'port'; vehicles: number; queued: number; docked: number; misaligned: number }[];
  /** 分层看板上还开着的告警（网页才有） */
  alerts?: () => { label: string; level: string; state: 'warn' | 'alarm'; since: number; owner: string }[];
  /** 本店的箱在港口的状态（孪生服务接了港口 EDI 才有）：箱号、现在怎样、从什么时候起、最近装卸它的车船 */
  containers?: () => { id: string; state: string; since: number; vehicle?: string }[];
  /** 仓储中心当天的作业计划（港口物流中心、机场货站、物流园、门店停车场和收货场；src/hub/types.ts）：用到时才算 */
  hubs?: () => HubDay[];
  /** 仓储中心的场地排程输入（现在是门店收货场；src/hub/storeDay.ts 的 storeYardOf）：预约错峰按它用场地排程器（src/yard）算挪之前、挪之后，没有就用排队模型估 */
  yards?: () => Partial<Record<HubKey, HubYard>>;
  /** 推演临时扰动（某趟车晚、某个门停用、封路、班轮晚）用的现场模型输入：和闭环孪生同一份；没有就只能推演建议卡 */
  sim?: () => { input: LoopInput };
  /** 提问的人现在的角色（面板上选的）：提议按它检查权限；不给就按调度员 */
  role?: Role;
}

/** 一个场地的排程输入：场地布置、当天的访问、HubDay 里车的 flow 编号 → 访问编号 */
export interface HubYard {
  plan: YardPlan;
  visits: readonly YardVisit[];
  visitOf: (flowId: string) => string | undefined;
}

/** 回答里可以点的东西：跳到某个时刻、看某辆车、看建议卡、打开设施监控、看作业、接着问 */
export type Link =
  | { kind: 'time'; t: number; label: string }
  | { kind: 'vehicle'; vid: number; label: string }
  | { kind: 'card'; key: string; label: string }
  | { kind: 'facility'; fac: 'group' | 'port' | 'air' | 'dc' | 'store'; label: string }
  | { kind: 'op'; id: string; label: string }
  | { kind: 'panel'; panel: 'handover' | 'review' | 'audit' | 'dailyplan'; label: string };

/**
 * 确认后执行的动作：对建议卡做决定、套用调度台的修法、整天的排法；
 * notify 是通知（新的预约时段发给承运商、提醒现场）：孪生里不改任何数据，执行就是记进操作记录，由预约系统或人下发。
 */
export type Action =
  | { kind: 'decide'; key: string; action: 'approve' | 'reject'; option?: string }
  | { kind: 'fix'; fix: Fix }
  | { kind: 'day'; day: DayPlan }
  | { kind: 'notify'; to: string; text: string; hub?: HubKey; moves?: { id: string; label: string; from: number; to: number; cold?: boolean }[] };

/** 提议出来之前按规则表（policy.ts）检查的一条结果 */
export interface PolicyCheck {
  rule: string;
  label: string;
  /** block = 违反硬性规定（这条提议不给出）；warn = 要人特别留意；info = 说明（比如要谁批） */
  level: 'block' | 'warn' | 'info';
  ok: boolean;
  text: string;
}

/** 一条提议：执行什么、预计的效果；人点「确认执行」才执行 */
export interface Proposal {
  id: string;
  title: string;
  /** 预计的效果（孪生推演的结果） */
  effect: string;
  actions: Action[];
  /** low = 低风险（改门、停车检查、调设定温度、不处理）；high = 要花钱或改计划 */
  risk: 'low' | 'high';
  /** 预计多花的钱（美元）：审批按它分级 */
  cost: number;
  /** 规则检查的结果（值班助手给出提议前按 policy.ts 检查过） */
  checks?: PolicyCheck[];
  /** 要谁执行 / 批准（按提问人的角色和花费） */
  need?: Role;
  /** 只能人工逐条核实后执行（数据较差、批量太大）：不批量、不自动 */
  manualOnly?: boolean;
}

export interface ToolResult {
  tool: string;
  args: Record<string, unknown>;
  /** 结构化的结果（给孪生服务的调用方，以后也可以交给语言模型组织语言） */
  data: Record<string, unknown>;
  /** 写好的回答 */
  text: string;
  /** 数据来自哪里 */
  cite: string;
  links?: Link[];
  proposals?: Proposal[];
  followups?: string[];
  /** 一句话的结论（不给就用回答的第一行） */
  conclusion?: string;
  /** 缺参数、参数有歧义：问一句，给几个选项（面板上是按钮） */
  clarify?: Clarify;
}

export interface Clarify {
  question: string;
  options: string[];
}

/** 回答的依据：调了哪些工具（数据来自哪里）、数据截至的时刻、数据质量 */
export interface Basis {
  tools: { name: string; cite: string }[];
  /** 数据截至的时刻（当天的秒） */
  asOf: number;
  quality: { level: 'good' | 'fair' | 'poor' | 'plan'; label: string; text: string };
}

/** 把握：意图分类的把握 × 数据质量 × 模型验证（都是 0–1），以及为什么 */
export interface Certainty {
  value: number;
  level: '高' | '中' | '低';
  intent: number;
  data: number;
  model: number;
  notes: string[];
}

/** 下一步：做什么、谁来做（要谁批） */
export interface NextStep {
  text: string;
  who?: string;
  proposal?: string;
}

/** 数字核对：回答里的每个数字能不能在工具结果（或问题、规则表）里找到 */
export interface Grounding {
  total: number;
  grounded: number;
  /** 没找到出处的数字（是缺陷，评测会数出来） */
  missing: string[];
}

export interface Answer {
  q: string;
  intent: string;
  /** 意图分类的把握（0–1） */
  confidence: number;
  text: string;
  cites: string[];
  links: Link[];
  proposals: Proposal[];
  followups: string[];
  /** 这次调用了哪些查询工具（界面上可以展开看） */
  tools: { name: string; args: Record<string, unknown> }[];
  /** 回答的四段：结论、依据、把握、下一步 */
  conclusion: string;
  basis: Basis;
  certainty: Certainty;
  next: NextStep[];
  /** 需要先问清楚（这时不调工具或只列选项） */
  clarify?: Clarify;
  /** 超出值班助手的范围，没有回答（说明能做什么） */
  declined?: boolean;
  /** 问题里要求跳过确认、审批：拒绝了（提议照样要人确认） */
  refused?: boolean;
  /** 认出来的参数（车、商品族、门、仓储中心）：界面上可以展开看，评测按它算参数识别的准确率 */
  entities: { vehicles: string[]; fams: string[]; doors: string[]; hub?: HubKey; card?: number; fuzzy?: string[] };
  grounding: Grounding;
  /** 各个工具返回的结构化结果（评测、孪生服务的调用方用） */
  data: Record<string, unknown>[];
  /** 哪个引擎答的：builtin = 内置（规则 + 逻辑回归），claude / local = 大模型（可选模式，见 docs/06-llm-option.md）；engineNote = 说明（比如大模型出错改用内置） */
  engine?: string;
  engineNote?: string;
}
