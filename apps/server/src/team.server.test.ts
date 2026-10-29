import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamBoard } from '@storewright/ops';
import { Hub, type StoreEntry } from './hub';
import { webPlatform } from './platform';
import { memoryStorage } from './storage';

/** 在岗人员与调配（决策记录 0025）：带班负责人临时调人、到时间门店的定时节拍调回；普通员工只能看；助手按此刻的岗位回答 */

// 在岗按班次判断：固定在今天上午 11 点跑（时钟照常走）
beforeEach(() => {
  const t = new Date();
  t.setHours(11, 0, 0, 0);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(t);
});
afterEach(() => {
  vi.useRealTimers();
});

async function store(): Promise<{ hub: Hub; e: StoreEntry; call: (method: string, path: string, body?: unknown, token?: string) => ReturnType<Hub['handle']> }> {
  const hub = await Hub.create({ storage: memoryStorage(), platform: webPlatform, demo: true, storeIds: ['demo'] });
  const e = hub.stores.get('demo');
  if (!e) throw new Error('no store');
  const call = (method: string, path: string, body?: unknown, token?: string) => hub.handle({ method, path, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return { hub, e, call };
}

async function token(call: Awaited<ReturnType<typeof store>>['call'], who: { role?: string; associateId?: string }): Promise<string> {
  return ((await call('POST', '/api/stores/demo/session', who)).body as { token: string }).token;
}

const rejectOf = (r: Awaited<ReturnType<Hub['handle']>>) => (r.body as { reject?: { code: string } }).reject?.code;

describe('在岗人员与调配（决策记录 0025）', () => {
  it('带班负责人把 Sam 临时调到交付 30 分钟：在岗人员显示新岗位和回去的时间，助手也这样回答；普通员工不能调；到时间自动回拣货', async () => {
    const { hub, e, call } = await store();
    const lead = await token(call, { associateId: 'A08' });
    const a01 = await token(call, { associateId: 'A01' });
    const cmd = { type: 'ChangeRole', associateId: 'A03', role: 'HANDOFF', minutes: 30 };
    expect(rejectOf(await call('POST', '/api/stores/demo/commands', { cmd }, a01))).toBe('NOT_AUTHORIZED');
    expect(rejectOf(await call('POST', '/api/stores/demo/commands', { cmd: { ...cmd, minutes: 1000 } }, lead))).toBe('DURATION_INVALID');
    expect(rejectOf(await call('POST', '/api/stores/demo/commands', { cmd: { ...cmd, role: 'LEAD' } }, lead))).toBe('ROLE_NOT_ALLOWED');
    expect((await call('POST', '/api/stores/demo/commands', { cmd }, lead)).status).toBe(200);
    const at = e.runtime.state.roleChanges?.A03?.at as number;
    const sam = teamBoard(e.runtime.statics, e.runtime.state, Date.now()).members.find((m) => m.id === 'A03');
    expect(sam).toMatchObject({ role: 'HANDOFF', base: 'PICK', on: true, moved: { from: 'PICK', by: 'A08', until: at + 30 * 60_000 } });

    // 助手：交付岗有谁（写明临时、几点回拣货）
    const ask = await call('POST', '/api/stores/demo/ai/ask', { question: '现在交付岗有哪些人？', lang: 'zh' }, a01);
    expect((ask.body as { answer: string }).answer).toMatch(/Sam（临时，\d\d:\d\d 回拣货）/);

    // 门店的定时节拍：30 分钟后调回拣货
    await e.runtime.submit({ cmd: { type: 'Tick', release: false }, actor: 'system', at: at + 30 * 60_000 });
    expect(e.runtime.state.roles.A03).toBeUndefined();
    expect(e.runtime.state.roleChanges?.A03).toBeUndefined();
    hub.stop();
  });
});
