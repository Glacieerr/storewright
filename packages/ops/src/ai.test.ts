import { describe, expect, it } from 'vitest';
import type { RecommendationDraft } from '@storewright/ai';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { generateCatalog } from '@storewright/synth';
import { adoptionRate, aiModeOf, MAX_RECS, openRecs, recentRecs, recsByUrgency, recStale } from './ai';
import { replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { dateOf, weekOf } from './roster';
import { execute, type OpsContext } from './server';
import { currentRole, teamBoard } from './staff';
import { emptyState, type OpsState, type StoreStatic } from './types';

const model = new StoreModel(createTemplate('small'));
const catalog = generateCatalog(model, { seed: 7 });
const statics: StoreStatic = {
  storeId: 'S1',
  name: 'Test',
  rules: { approachingMin: 10, longWaitMin: 10, codeAttempts: 3, occupancyAlert: 0.9, slotLengthMin: 60, lockLeadMin: 90 },
  slots: [],
  roster: [
    { id: 'L1', name: 'Lead', role: 'LEAD', exceptionAuthorized: true },
    { id: 'P1', name: 'Picker', role: 'PICK', exceptionAuthorized: false },
  ],
  bins: [],
  planogram: [],
  replenish: DEFAULT_REPLENISH_RULES,
};
const ctx: OpsContext = { model, items: catalog.byId, hash: (s) => s, statics };
const T0 = Date.UTC(2026, 9, 21, 15, 0);
const HOUR = 3_600_000;

const draft = (over: Partial<RecommendationDraft> = {}): RecommendationDraft => ({
  module: 'FORECAST',
  target: 'store',
  action: { kind: 'INFO' },
  prediction: { value: 64, low: 52, high: 77, unit: 'ORDERS', from: T0 + HOUR, to: T0 + 4 * HOUR, baseline: 58 },
  confidence: 0.83,
  reasons: [{ factor: 'WEEKDAY_FACTOR', value: 1.18, effect: { kind: 'MULTIPLY', amount: 1.18 }, weight: 0.6, params: { dow: 6 } }],
  alternatives: [],
  model: { id: 'orders-hourly', version: 1, kind: 'seasonal-es' },
  expiresAt: T0 + 2 * HOUR,
  ...over,
});

class Store {
  s: OpsState = emptyState();
  log: AnyOpsEvent[] = [];
  now = T0;
  run(cmd: OpsCommand, actor: string) {
    const r = execute(this.s, { cmd, actor, at: this.now }, ctx);
    this.log.push(...r.events);
    return r.decision.ok ? 'OK' : r.decision.reject.code;
  }
}

describe('AI recommendations in the event stream', () => {
  it('issues, supersedes, resolves with reasons and keeps statistics', () => {
    const st = new Store();
    expect(st.run({ type: 'IssueRecommendation', draft: draft() }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.run({ type: 'IssueRecommendation', draft: draft() }, 'ai')).toBe('OK');
    const first = openRecs(st.s)[0];
    expect(first).toMatchObject({ id: 'REC-000001', mode: 'SHOW', status: 'OPEN', issuedAt: T0 });

    // 同一模块、同一对象的新建议取代旧建议
    st.now += 10 * 60_000;
    st.run({ type: 'IssueRecommendation', draft: draft({ confidence: 0.9 }) }, 'ai');
    expect(st.s.recs['REC-000001']?.status).toBe('SUPERSEDED');
    expect(openRecs(st.s).map((r) => r.id)).toEqual(['REC-000002']);

    // 普通员工不能处理；否决必须给出已知原因
    expect(st.run({ type: 'AcceptRecommendation', recId: 'REC-000002' }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.run({ type: 'OverrideRecommendation', recId: 'REC-000002', reason: 'BECAUSE' as never }, 'L1')).toBe('REASON_UNKNOWN');
    expect(st.run({ type: 'OverrideRecommendation', recId: 'REC-000002', reason: 'LOCAL_KNOWLEDGE', note: '  school event tonight  ' }, 'L1')).toBe('OK');
    expect(st.s.recs['REC-000002']).toMatchObject({ status: 'OVERRIDDEN', reason: 'LOCAL_KNOWLEDGE', note: 'school event tonight', resolvedBy: 'L1' });
    expect(st.run({ type: 'AcceptRecommendation', recId: 'REC-000002' }, 'L1')).toBe('REC_CLOSED');

    st.run({ type: 'IssueRecommendation', draft: draft({ target: 'store-pm' }) }, 'ai');
    expect(st.run({ type: 'AcceptRecommendation', recId: 'REC-000003' }, 'console')).toBe('OK');

    // 过期
    st.run({ type: 'IssueRecommendation', draft: draft({ target: 'other', expiresAt: st.now + 60_000 }) }, 'ai');
    st.now += 2 * 60_000;
    st.run({ type: 'Tick', release: false }, 'system');
    expect(st.s.recs['REC-000004']?.status).toBe('EXPIRED');

    const stats = st.s.aiStats.FORECAST;
    expect(stats).toMatchObject({ issued: 4, SUPERSEDED: 1, OVERRIDDEN: 1, ACCEPTED: 1, EXPIRED: 1, reasons: { LOCAL_KNOWLEDGE: 1 } });
    expect(adoptionRate(stats)).toBeCloseTo(0.5);
    expect(recentRecs(st.s)[0]?.id).toBe('REC-000004');

    // 事件重放得到同样的状态
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  it('validates drafts and unknown actions', () => {
    const st = new Store();
    expect(st.run({ type: 'IssueRecommendation', draft: draft({ module: 'MAGIC' as never }) }, 'ai')).toBe('MODULE_UNKNOWN');
    expect(st.run({ type: 'IssueRecommendation', draft: draft({ confidence: 1.4 }) }, 'ai')).toBe('INVALID_RECOMMENDATION');
    expect(st.run({ type: 'IssueRecommendation', draft: draft({ expiresAt: T0 }) }, 'ai')).toBe('INVALID_RECOMMENDATION');
    expect(st.run({ type: 'IssueRecommendation', draft: draft({ module: 'STAFFING', action: { kind: 'TELEPORT' } }) }, 'ai')).toBe('ACTION_UNKNOWN');
  });

  it('sets module modes with locking', () => {
    const st = new Store();
    expect(aiModeOf(st.s, 'STAFFING')).toBe('CONFIRM');
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'AUTO' }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'AUTO', locked: true }, 'L1')).toBe('OK');
    // 带班负责人不能加锁
    expect(st.s.aiModes.STAFFING).toMatchObject({ mode: 'AUTO', locked: false, by: 'L1' });
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'SHOW', locked: true }, 'console')).toBe('OK');
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'CONFIRM' }, 'L1')).toBe('MODE_LOCKED');
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'CONFIRM', locked: false }, 'console')).toBe('OK');
    expect(st.s.aiModes.STAFFING).toMatchObject({ mode: 'CONFIRM', locked: false });
    expect(st.run({ type: 'SetAiMode', module: 'FORECAST', mode: 'BOLD' as never }, 'L1')).toBe('MODE_UNKNOWN');
    // 新模式在之后发出的建议上生效
    st.run({ type: 'SetAiMode', module: 'FORECAST', mode: 'CONFIRM' }, 'L1');
    st.run({ type: 'IssueRecommendation', draft: draft() }, 'ai');
    expect(openRecs(st.s)[0]?.mode).toBe('CONFIRM');
  });

  it('keeps at most MAX_RECS recommendations, dropping the oldest resolved ones', () => {
    const st = new Store();
    for (let i = 0; i < MAX_RECS + 20; i++) {
      st.now += 1000;
      st.run({ type: 'IssueRecommendation', draft: draft({ target: `t${i}`, expiresAt: st.now + HOUR }) }, 'ai');
      if (i % 2 === 0) st.run({ type: 'DismissRecommendation', recId: `REC-${String(i + 1).padStart(6, '0')}` }, 'L1');
    }
    expect(Object.keys(st.s.recs).length).toBe(MAX_RECS);
    expect(st.s.recs['REC-000001']).toBeUndefined();
    expect(st.s.recs['REC-000002']?.status).toBe('OPEN');
    expect(st.s.aiStats.FORECAST?.issued).toBe(MAX_RECS + 20);
  });
});

describe('role changes and staff locks (5c)', () => {
  it('moves an associate between work roles, respects locks for AI moves', () => {
    const st = new Store();
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF' }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(st.run({ type: 'ChangeRole', associateId: 'L1', role: 'PICK' }, 'console')).toBe('ROLE_NOT_ALLOWED');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF' }, 'L1')).toBe('OK');
    expect(st.s.roles.P1).toBe('HANDOFF');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF' }, 'L1')).toBe('SAME_ROLE');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'PICK' }, 'L1')).toBe('OK');
    expect(st.s.roles.P1).toBeUndefined();
    // AI 调动建议：锁定后发出即过时
    const move = draft({ module: 'STAFFING', target: 'P1', action: { kind: 'MOVE_ASSOCIATE', params: { associateId: 'P1', to: 'HANDOFF' } } });
    expect(st.run({ type: 'LockAssociate', associateId: 'P1', locked: true }, 'L1')).toBe('OK');
    expect(st.run({ type: 'IssueRecommendation', draft: move }, 'ai')).toBe('ACTION_STALE');
    expect(st.run({ type: 'LockAssociate', associateId: 'P1', locked: false }, 'L1')).toBe('OK');
    expect(st.run({ type: 'IssueRecommendation', draft: move }, 'ai')).toBe('OK');
    const rec = openRecs(st.s).find((r) => r.module === 'STAFFING')!;
    expect(rec.mode).toBe('CONFIRM');
    expect(st.run({ type: 'AcceptRecommendation', recId: rec.id }, 'L1')).toBe('OK');
    expect(st.s.roles.P1).toBe('HANDOFF');
    expect(st.log.at(-1)).toMatchObject({ type: 'AssociateRoleChanged', payload: { associateId: 'P1', role: 'HANDOFF', from: 'PICK', recId: rec.id } });
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  // 带班负责人调配在岗员工（决策记录 0025）：临时调动带时长，到时由定时节拍调回原岗位
  it('临时调动：到时间自动回原岗位；提前调回后不会再调一次；时长不合理时拒绝', () => {
    const st = new Store();
    const MIN = 60_000;
    for (const minutes of [3, 30.5, 721]) expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF', minutes }, 'L1')).toBe('DURATION_INVALID');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF', minutes: 60 }, 'L1')).toBe('OK');
    expect(st.s.roles.P1).toBe('HANDOFF');
    expect(st.s.roleChanges?.P1).toEqual({ from: 'PICK', at: T0, by: 'L1', until: T0 + 60 * MIN });
    st.now = T0 + 59 * MIN;
    expect(st.run({ type: 'Tick', release: false }, 'system')).toBe('OK');
    expect(st.s.roles.P1).toBe('HANDOFF');
    st.now = T0 + 60 * MIN;
    expect(st.run({ type: 'Tick', release: false }, 'system')).toBe('OK');
    expect(st.log.at(-1)).toMatchObject({ type: 'AssociateRoleChanged', payload: { associateId: 'P1', role: 'PICK', from: 'HANDOFF', revert: true } });
    expect(st.s.roles.P1).toBeUndefined();
    expect(st.s.roleChanges?.P1).toBeUndefined();
    // 再调走 30 分钟，10 分钟后手动调回：记录清掉，到点也不会再调
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'STAGE', minutes: 30 }, 'L1')).toBe('OK');
    st.now += 10 * MIN;
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'PICK', minutes: 30 }, 'L1')).toBe('OK');
    expect(st.s.roleChanges?.P1).toBeUndefined();
    const before = st.log.length;
    st.now += 60 * MIN;
    st.run({ type: 'Tick', release: false }, 'system');
    expect(st.log.slice(before).filter((e) => e.type === 'AssociateRoleChanged')).toHaveLength(0);
    // AI 的调动建议写了「约 1 小时」：采纳后同样到时调回
    const move = draft({ module: 'STAFFING', target: 'P1', action: { kind: 'MOVE_ASSOCIATE', params: { associateId: 'P1', to: 'HANDOFF', hours: 1 } }, expiresAt: st.now + HOUR });
    expect(st.run({ type: 'IssueRecommendation', draft: move }, 'ai')).toBe('OK');
    const rec = openRecs(st.s).find((r) => r.module === 'STAFFING')!;
    expect(st.run({ type: 'AcceptRecommendation', recId: rec.id }, 'L1')).toBe('OK');
    expect(st.s.roleChanges?.P1?.until).toBe(st.now + HOUR);
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  it('在岗人员：每个人此刻的岗位、原岗位、几点回去、是否固定；带班负责人排在最前', () => {
    const st = new Store();
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'STAGE', minutes: 45 }, 'L1')).toBe('OK');
    expect(st.run({ type: 'LockAssociate', associateId: 'P1', locked: true }, 'L1')).toBe('OK');
    const board = teamBoard(statics, st.s, st.now);
    expect(board.members.map((m) => m.id)).toEqual(['L1', 'P1']);
    expect(board.members[1]).toMatchObject({ role: 'STAGE', base: 'PICK', on: true, locked: true, moved: { from: 'PICK', by: 'L1', until: T0 + 45 * 60_000 } });
    expect(board.members[1]?.task).toBeUndefined();
    expect(board.queue).toEqual({ PICK: 0, STAGE: 0, HANDOFF: 0, RESTOCK: 0, BACKROOM: 0 });
  });

  it('当天排了班的人：原岗位按排班算，调动到期回到排班的岗位', () => {
    const st = new Store();
    const date = dateOf(st.now);
    expect(st.run({ type: 'PublishSchedule', week: weekOf(date), shifts: [{ associateId: 'P1', date, from: 0, to: 1440, role: 'STAGE' }] }, 'L1')).toBe('OK');
    expect(currentRole(statics, st.s, 'P1', st.now)).toBe('STAGE');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'STAGE' }, 'L1')).toBe('SAME_ROLE');
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'PICK', minutes: 30 }, 'L1')).toBe('OK');
    expect(st.log.at(-1)).toMatchObject({ type: 'AssociateRoleChanged', payload: { role: 'PICK', from: 'STAGE', minutes: 30 } });
    expect(currentRole(statics, st.s, 'P1', st.now)).toBe('PICK');
    st.now += 30 * 60_000;
    st.run({ type: 'Tick', release: false }, 'system');
    expect(st.s.roles.P1).toBeUndefined();
    expect(currentRole(statics, st.s, 'P1', st.now)).toBe('STAGE');
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });
});

describe('建议页与补班邀请（决策记录 0026）', () => {
  it('只显示的建议：采纳就是「有用」、不执行；动作做不了的建议在节拍里自动收起；按紧急程度排', () => {
    const st = new Store();
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'SHOW' }, 'L1')).toBe('OK');
    const move = draft({ module: 'STAFFING', target: 'P1', action: { kind: 'MOVE_ASSOCIATE', params: { associateId: 'P1', to: 'HANDOFF' } } });
    expect(st.run({ type: 'IssueRecommendation', draft: move }, 'ai')).toBe('OK');
    const r1 = openRecs(st.s)[0]!;
    expect(r1.mode).toBe('SHOW');
    expect(st.run({ type: 'AcceptRecommendation', recId: r1.id }, 'L1')).toBe('OK');
    expect(st.s.recs[r1.id]?.status).toBe('ACCEPTED');
    expect(st.s.roles.P1).toBeUndefined();
    expect(st.run({ type: 'SetAiMode', module: 'STAFFING', mode: 'CONFIRM' }, 'L1')).toBe('OK');
    expect(st.run({ type: 'IssueRecommendation', draft: draft() }, 'ai')).toBe('OK');
    expect(st.run({ type: 'IssueRecommendation', draft: move }, 'ai')).toBe('OK');
    // 要执行的、更急的模块在前（订单量预测是纯信息，排最后）
    expect(recsByUrgency(st.s).map((r) => r.module)).toEqual(['STAFFING', 'FORECAST']);
    const r2 = recsByUrgency(st.s)[0]!;
    expect(recStale(st.s, r2, statics, st.now)).toBe(false);
    // 人已经被手动调过去了：这条建议做不了，节拍里自动收起
    expect(st.run({ type: 'ChangeRole', associateId: 'P1', role: 'HANDOFF' }, 'L1')).toBe('OK');
    expect(recStale(st.s, r2, statics, st.now)).toBe(true);
    expect(st.run({ type: 'Tick', release: false }, 'system')).toBe('OK');
    expect(st.s.recs[r2.id]?.status).toBe('EXPIRED');
    expect(openRecs(st.s).map((r) => r.module)).toEqual(['FORECAST']);
    expect(replay(st.log, emptyState(), statics)).toEqual(st.s);
  });

  it('直接给某人发补班邀请；同意「被拒后自动问下一个人」后，拒绝时 AI 的下一条邀请直接发出', () => {
    const st2: StoreStatic = {
      ...statics,
      roster: [...statics.roster, { id: 'P2', name: 'Picker 2', role: 'PICK', exceptionAuthorized: false }, { id: 'P3', name: 'Picker 3', role: 'PICK', exceptionAuthorized: false }],
    };
    const c2: OpsContext = { ...ctx, statics: st2 };
    const s = emptyState();
    const log: AnyOpsEvent[] = [];
    const run = (cmd: OpsCommand, actor: string) => {
      const r = execute(s, { cmd, actor, at: T0 }, c2);
      log.push(...r.events);
      return r.decision.ok ? 'OK' : r.decision.reject.code;
    };
    const date = dateOf(T0);
    const tomorrow = dateOf(T0 + 24 * HOUR);
    expect(run({ type: 'SendShiftOffer', associateId: 'P1', date, from: 600, to: 840 }, 'P1')).toBe('NOT_AUTHORIZED');
    expect(run({ type: 'SendShiftOffer', associateId: 'P1', date, from: 840, to: 600 }, 'L1')).toBe('SCHEDULE_INVALID');
    expect(run({ type: 'SendShiftOffer', associateId: 'P1', date, from: 600, to: 840, role: 'PICK', replaces: 'P2', autoNext: true }, 'L1')).toBe('OK');
    const first = Object.values(s.offers ?? {})[0]!;
    expect(first).toMatchObject({ associateId: 'P1', status: 'PENDING', autoNext: true, replaces: 'P2' });
    expect(first.recId).toBeUndefined();
    expect(run({ type: 'SendShiftOffer', associateId: 'P1', date, from: 600, to: 840 }, 'L1')).toBe('OFFER_PENDING');
    expect(run({ type: 'RespondShiftOffer', offerId: first.id, accept: false }, 'P1')).toBe('OK');
    // AI 问下一个人：同意过，直接发（邀请也带着「被拒后自动问下一个人」）
    const next = draft({ module: 'STAFFING', target: 'absence:AB0001', action: { kind: 'OFFER_SHIFT', params: { associateId: 'P3', date, from: 600, to: 840, role: 'PICK', replaces: 'P2', followUpOf: first.id } } });
    expect(run({ type: 'IssueRecommendation', draft: next }, 'ai')).toBe('OK');
    const rec = Object.values(s.recs).find((r) => r.target === 'absence:AB0001')!;
    expect(rec).toMatchObject({ mode: 'AUTO', status: 'AUTO_APPLIED' });
    expect(Object.values(s.offers ?? {}).find((o) => o.associateId === 'P3')).toMatchObject({ status: 'PENDING', autoNext: true, recId: rec.id });
    // 没同意过的仍然要带班负责人采纳；从建议的其他人选直接发，这条建议算采纳
    const plain = draft({ module: 'STAFFING', target: 'absence:AB0002', action: { kind: 'OFFER_SHIFT', params: { associateId: 'P1', date: tomorrow, from: 600, to: 840, role: 'PICK' } } });
    expect(run({ type: 'IssueRecommendation', draft: plain }, 'ai')).toBe('OK');
    const alt = Object.values(s.recs).find((r) => r.target === 'absence:AB0002')!;
    expect(alt).toMatchObject({ mode: 'CONFIRM', status: 'OPEN' });
    expect(run({ type: 'SendShiftOffer', associateId: 'P3', date: tomorrow, from: 600, to: 840, recId: alt.id }, 'L1')).toBe('OK');
    expect(s.recs[alt.id]?.status).toBe('ACCEPTED');
    expect(replay(log, emptyState(), st2)).toEqual(s);
  });
});
