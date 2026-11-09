import type { Proposal } from './types';

/**
 * 角色、审批和操作记录。
 *
 * - 只读：能看能问，不能执行；
 * - 调度员：低风险的（改门、提醒司机检查、调设定温度、不处理）和多花不超过 $100 的直接执行，更贵的提交站长审批；
 * - 站长：$1,000 以内直接执行，并审批调度员提交的；更贵的提交区域经理；
 * - 区域经理：都能执行、审批。
 * 审批单在仿真时间里放着没人批超过 20 分钟就往上一级报（站长 → 区域经理）。所有执行、提交、批准、驳回都记进操作记录。
 */
export type Role = 'viewer' | 'dispatcher' | 'manager' | 'regional';
export const ROLE_LABEL: Record<Role, string> = { viewer: '只读', dispatcher: '调度员', manager: '站长', regional: '区域经理' };
export const ROLES: Role[] = ['dispatcher', 'manager', 'regional', 'viewer'];
/** 不用审批就能执行的金额上限（美元） */
export const LIMIT: Record<Role, number> = { viewer: -1, dispatcher: 100, manager: 1000, regional: Infinity };
const RANK: Record<Role, number> = { viewer: 0, dispatcher: 1, manager: 2, regional: 3 };
/** 审批单多久没人批就往上报（秒，仿真时间） */
export const ESCALATE_AFTER = 20 * 60;

export const canExecute = (role: Role, p: Pick<Proposal, 'risk' | 'cost'>): boolean => role !== 'viewer' && (p.risk === 'low' || p.cost <= LIMIT[role]);
/** 这条提议该谁批 */
export const approverOf = (p: Pick<Proposal, 'cost'>): Role => (p.cost <= LIMIT.manager ? 'manager' : 'regional');
export const canApprove = (role: Role, need: Role): boolean => role !== 'viewer' && RANK[role] >= RANK[need];

export interface Approval {
  id: string;
  proposal: Proposal;
  /** 谁提交的、什么时候（仿真时刻） */
  by: Role;
  t: number;
  /** 该谁批（往上报以后会变） */
  need: Role;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: Role;
  decidedAt?: number;
  escalatedAt?: number;
}

export interface AuditEntry {
  /** 真实时间、仿真时刻 */
  at: string;
  t: number;
  who: Role;
  /** 执行、提交审批、批准、驳回、往上报 */
  act: 'execute' | 'request' | 'approve' | 'reject' | 'escalate';
  what: string;
  /** 从哪来的：值班助手的提议、闭环面板的建议卡、调度台 */
  via: string;
  effect: string;
  /** 规则表的检查结果（值班助手的提议才有） */
  policy?: string;
}
export const ACT_LABEL: Record<AuditEntry['act'], string> = { execute: '执行', request: '提交审批', approve: '批准并执行', reject: '驳回', escalate: '往上报' };

export class Approvals {
  readonly list: Approval[] = [];
  readonly log: AuditEntry[] = [];
  private seq = 0;

  record(e: Omit<AuditEntry, 'at'>): void {
    this.log.push({ at: new Date().toISOString(), ...e });
  }

  request(p: Proposal, by: Role, t: number, via: string, policy?: string): Approval {
    const a: Approval = { id: `A${++this.seq}`, proposal: p, by, t, need: approverOf(p), status: 'pending' };
    this.list.push(a);
    this.record({ t, who: by, act: 'request', what: p.title, via, effect: `${p.effect}（交${ROLE_LABEL[a.need]}审批）`, ...(policy ? { policy } : {}) });
    return a;
  }

  decide(id: string, ok: boolean, role: Role, t: number): Approval | undefined {
    const a = this.list.find((x) => x.id === id && x.status === 'pending');
    if (!a || !canApprove(role, a.need)) return undefined;
    a.status = ok ? 'approved' : 'rejected';
    a.decidedBy = role;
    a.decidedAt = t;
    this.record({ t, who: role, act: ok ? 'approve' : 'reject', what: a.proposal.title, via: `审批单 ${a.id}（${ROLE_LABEL[a.by]}提交）`, effect: ok ? a.proposal.effect : '没有执行' });
    return a;
  }

  /** 放了太久没人批的往上报；返回这次报上去的 */
  escalate(t: number): Approval[] {
    const out: Approval[] = [];
    for (const a of this.list) {
      if (a.status !== 'pending' || a.need === 'regional') continue;
      if (t - (a.escalatedAt ?? a.t) < ESCALATE_AFTER) continue;
      a.need = 'regional';
      a.escalatedAt = t;
      this.record({ t, who: a.by, act: 'escalate', what: a.proposal.title, via: `审批单 ${a.id}`, effect: `${ESCALATE_AFTER / 60} 分钟没人批，报区域经理` });
      out.push(a);
    }
    return out;
  }

  pending(role?: Role): Approval[] {
    return this.list.filter((a) => a.status === 'pending' && (!role || canApprove(role, a.need)));
  }

  /** 操作记录导出成表格（CSV，带表头） */
  csv(clock: (t: number) => string): string {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    return ['真实时间,仿真时刻,角色,动作,内容,来源,预计效果,规则检查', ...this.log.map((e) => [e.at, clock(e.t), ROLE_LABEL[e.who], ACT_LABEL[e.act], q(e.what), q(e.via), q(e.effect), q(e.policy ?? '')].join(','))].join('\n');
  }
}
