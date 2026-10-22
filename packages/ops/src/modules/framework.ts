import type { CommandEnvelope, OpsCommand, RejectCode, Rejection } from '../commands';
import type { AnyOpsEvent, PendingEvent } from '../events';
import type { OpsState, StoreStatic } from '../types';

/**
 * 可插拔的流程模块（Phase 6，决策记录 0011）。
 *
 * 每个模块声明自己的命令、命令处理、事件应用和排程（可选），以及「是否启用」（门店配置里的模块开关）。
 * 作业核心遇到模块命令时先检查开关，关闭时拒绝；事件应用和 Tick 依次交给各模块。
 * 新增一个业务模块只需要在这里登记，不改动拣货、暂存、交付等核心流程。
 */

export type ModuleId = 'mto' | 'returns' | 'oversized' | 'parcel';

export type ModuleResult = { ok: true; events: PendingEvent[] } | { ok: false; reject: Rejection };

export interface ModuleContext {
  statics: StoreStatic;
  /** 商品条码（任意位数）→ 商品 */
  itemByGtin(gtin: string): { id: string; gtin: string; name: string; tempZone: string; unitPrice: number; chemical?: boolean; sealedOnly?: boolean } | undefined;
  /** 带班负责人或控制台 */
  canManage: boolean;
}

export interface OpsModule {
  id: ModuleId;
  commands: ReadonlySet<OpsCommand['type']>;
  decide(s: OpsState, env: CommandEnvelope, ctx: ModuleContext): ModuleResult;
  apply(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): boolean;
  tick?(s: OpsState, at: number, st: StoreStatic): PendingEvent[];
}

export const no = (code: RejectCode, params?: Record<string, string | number>): ModuleResult => ({ ok: false, reject: params ? { code, params } : { code } });
export const yes = (events: PendingEvent[]): ModuleResult => ({ ok: true, events });

export function moduleEnabled(st: StoreStatic | undefined, id: ModuleId): boolean {
  return !!st?.modules?.[id];
}
