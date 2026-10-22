import type { CommandEnvelope, OpsCommand } from '../commands';
import type { AnyOpsEvent, PendingEvent } from '../events';
import type { OpsState, StoreStatic } from '../types';
import { moduleEnabled, no, type ModuleContext, type ModuleResult, type OpsModule } from './framework';
import { mtoModule } from './mto';
import { oversizedModule } from './oversized';
import { parcelModule } from './parcel';
import { returnsModule } from './returns';

/** 已登记的扩展模块（新增模块在这里加一行） */
export const MODULES: readonly OpsModule[] = [mtoModule, returnsModule, oversizedModule, parcelModule];

const BY_COMMAND = new Map<OpsCommand['type'], OpsModule>();
for (const m of MODULES) for (const c of m.commands) BY_COMMAND.set(c, m);

export function moduleFor(cmd: OpsCommand): OpsModule | undefined {
  return BY_COMMAND.get(cmd.type);
}

/** 模块命令：先检查门店配置里的开关，关闭时拒绝 */
export function decideModule(s: OpsState, env: CommandEnvelope, m: OpsModule, ctx: ModuleContext): ModuleResult {
  if (!moduleEnabled(ctx.statics, m.id)) return no('MODULE_DISABLED', { module: m.id });
  return m.decide(s, env, ctx);
}

export function applyModuleEvent(s: OpsState, e: AnyOpsEvent, st?: StoreStatic): boolean {
  for (const m of MODULES) if (m.apply(s, e, st)) return true;
  return false;
}

export function moduleTick(s: OpsState, at: number, st: StoreStatic): PendingEvent[] {
  const out: PendingEvent[] = [];
  for (const m of MODULES) if (m.tick && moduleEnabled(st, m.id)) out.push(...m.tick(s, at, st));
  return out;
}

export { moduleEnabled, type ModuleContext, type ModuleId, type OpsModule } from './framework';
export { MTO_BUFFER_MIN, mtoBoard } from './mto';
export { oversizedByOrder } from './oversized';
export { PARCEL_GRACE_MIN, parcelTrips, suggestParcelSlot } from './parcel';
export { allowedDispositions, returnBlocks, type ReturnBlock } from './returns';
