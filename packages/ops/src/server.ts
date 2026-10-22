import type { Item, Order } from '@storewright/domain';
import type { CommandEnvelope } from './commands';
import { decide, type Decision, type OpsContext } from './decide';
import type { AnyOpsEvent, PendingEvent } from './events';
import { applyEvent } from './apply';
import type { LineInfo, OpsState, OrderInfo } from './types';

/**
 * 服务端入口：命令处理、事件编号、由合成订单生成订单信息。
 * 员工端和模拟器只引用 '@storewright/ops'，不会把规划算法打进前端包。
 */
export * from './decide';

/** 给 decide 产生的事件编上序号、写入时间和操作者（还没有应用到状态） */
export { buildBins, buildPlanogram, initialInventory, storageArea } from '@storewright/algorithms';

export function stamp(s: OpsState, pending: readonly PendingEvent[], env: CommandEnvelope): AnyOpsEvent[] {
  return pending.map((p, i) => ({ ...p, seq: s.seq + i + 1, at: env.at, actor: env.actor }) as AnyOpsEvent);
}

/** 校验并立即应用（测试和单进程场景用；服务端在持久化成功之后再应用） */
export function execute(s: OpsState, env: CommandEnvelope, ctx: OpsContext): { decision: Decision; events: AnyOpsEvent[] } {
  const decision = decide(s, env, ctx);
  if (!decision.ok) return { decision, events: [] };
  const events = stamp(s, decision.events, env);
  for (const e of events) applyEvent(s, e, ctx.statics);
  return { decision, events };
}

/** 由领域订单（例如合成数据）生成订单信息：行上带商品名称、条码和主货位，客户端不需要商品目录 */
export function orderInfoFrom(o: Order, items: ReadonlyMap<string, Item>, slotStart: number, slotLengthMin: number): OrderInfo {
  const lines: LineInfo[] = o.lines.map((l) => {
    const item = items.get(l.itemId);
    if (!item) throw new Error(`Unknown item ${l.itemId}`);
    return {
      lineId: l.lineId,
      itemId: item.id,
      gtin: item.gtin,
      name: item.name,
      qty: l.qty,
      tempZone: item.tempZone,
      locationId: item.locationIds[0] ?? '',
      allowSubstitution: l.allowSubstitution,
      ageRestricted: item.handling.includes('AGE_RESTRICTED'),
      unitPrice: item.unitPrice,
    };
  });
  const out: OrderInfo = {
    id: o.id,
    shortCode: o.shortCode,
    firstName: o.customer.firstName,
    lastName: o.customer.lastName,
    type: o.type,
    fulfillmentType: o.fulfillmentType,
    express: o.express,
    slotStart,
    slotLengthMin,
    lines,
  };
  if (o.destinationKm) out.destinationKm = o.destinationKm;
  return out;
}
