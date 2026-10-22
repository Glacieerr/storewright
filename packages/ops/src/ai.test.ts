import { describe, expect, it } from 'vitest';
import type { RecommendationDraft } from '@storewright/ai';
import { DEFAULT_REPLENISH_RULES } from '@storewright/algorithms';
import { createTemplate, StoreModel } from '@storewright/store-config';
import { generateCatalog } from '@storewright/synth';
import { adoptionRate, aiModeOf, MAX_RECS, openRecs, recentRecs } from './ai';
import { replay } from './apply';
import type { OpsCommand } from './commands';
import type { AnyOpsEvent } from './events';
import { execute, type OpsContext } from './server';
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
});
