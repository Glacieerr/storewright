import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from './commands';
import { ev, type AnyOpsEvent, type PendingEvent } from './events';
import type { OpsState, StoreSettings } from './types';

/**
 * 门店设置（决策记录 0026）：
 * - 要求扫码：点选代替扫码的操作（命令带 tap）被拒绝，拣货必须扫到商品条码；演示和培训时关掉；
 * - 交付准备什么时候能开始：顾客到店前也可以（默认；冷藏冷冻框最后取），或者顾客到了才能开始。
 * 控制台和带班负责人可以改。
 */

type SettingsCommand = Extract<OpsCommand, { type: 'SetStoreSettings' }>;
export const SETTINGS_COMMANDS = new Set<OpsCommand['type']>(['SetStoreSettings']);
export function isSettingsCommand(cmd: OpsCommand): cmd is SettingsCommand {
  return SETTINGS_COMMANDS.has(cmd.type);
}

export const PREP_GATES: ReadonlyArray<NonNullable<StoreSettings['prepGate']>> = ['ANY', 'ARRIVED'];

type Result = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };
const no = (code: RejectCode): Result => ({ ok: false, reject: { code } });
const yes = (events: PendingEvent[]): Result => ({ ok: true, events });

export function decideSettings(s: OpsState, env: CommandEnvelope & { cmd: SettingsCommand }, canManage: boolean): Result {
  if (!canManage) return no('NOT_AUTHORIZED');
  const c = env.cmd;
  const next: StoreSettings = {};
  if (c.requireScan !== undefined) {
    if (typeof c.requireScan !== 'boolean') return no('SETTING_INVALID');
    next.requireScan = c.requireScan;
  }
  if (c.prepGate !== undefined) {
    if (!PREP_GATES.includes(c.prepGate)) return no('SETTING_INVALID');
    next.prepGate = c.prepGate;
  }
  const cur = s.settings ?? {};
  const changed = (Object.keys(next) as Array<keyof StoreSettings>).filter((k) => cur[k] !== next[k]);
  if (!changed.length) return yes([]);
  return yes([ev('StoreSettingsChanged', Object.fromEntries(changed.map((k) => [k, next[k]])) as StoreSettings)]);
}

export function applySettingsEvent(s: OpsState, e: AnyOpsEvent): boolean {
  if (e.type !== 'StoreSettingsChanged') return false;
  s.settings = { ...(s.settings ?? {}), ...e.payload };
  return true;
}

/** 门店要求扫码 */
export const requireScan = (s: OpsState): boolean => !!s.settings?.requireScan;
