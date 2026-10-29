import { ev } from '../events';
import type { ReturnDisposition, ReturnLine } from '../types';
import { no, yes, type OpsModule } from './framework';

/**
 * 退货（工作流设计 4.10）：
 * - 顾客退货逐件扫描，核对原订单（不在原订单里的商品标记出来）；配送退回整单处理；
 * - 每件选择去向：可售回架（货架估算增加）、报废、危险品回收、退供应商；AI 给出建议，员工决定，是否采纳计入统计；
 * - 完成时发出「退货完成」事件（退款由外部系统处理），所有件都要有去向。
 */

const COMMANDS_EXTRA = ['RemoveReturnLine'] as const;
const COMMANDS = new Set([...COMMANDS_EXTRA, 'StartReturn', 'ScanReturnItem', 'SetReturnDisposition', 'CompleteReturn'] as const);
const DISPOSITIONS: readonly ReturnDisposition[] = ['RESTOCK', 'DISPOSE', 'HAZMAT', 'VENDOR'];

/** 规则禁止某个去向的原因 */
export type ReturnBlock = 'COLD_CHAIN' | 'NOT_SEALED' | 'DAMAGED' | 'CHEMICAL_OPENED' | 'CHEMICAL_TRASH';

/**
 * 退货去向的硬性规则（决策 RT-02，AI 只在允许的去向里建议，员工也只能在允许的去向里选）：
 * - 冷藏、冷冻、热食一律不能回架（食品安全）；
 * - 超市的散件（食品、日用品、个护）只有未开封、包装完好才能回架；
 * - 损坏的商品不能回架；
 * - 化学品不能按普通垃圾报废；开封或损坏的化学品只能走危险品回收。
 * 返回每个被禁止的去向和原因；没有列出的去向允许。
 */
export function returnBlocks(line: Pick<ReturnLine, 'condition' | 'tempZone' | 'chemical' | 'sealedOnly'>): Partial<Record<ReturnDisposition, ReturnBlock>> {
  const out: Partial<Record<ReturnDisposition, ReturnBlock>> = {};
  if (line.chemical) {
    out.DISPOSE = 'CHEMICAL_TRASH';
    if (line.condition !== 'SEALED') {
      out.RESTOCK = 'CHEMICAL_OPENED';
      out.VENDOR = 'CHEMICAL_OPENED';
    }
  }
  if (!out.RESTOCK) {
    if (line.tempZone === 'CHILLED' || line.tempZone === 'FROZEN' || line.tempZone === 'HOT') out.RESTOCK = 'COLD_CHAIN';
    else if (line.condition === 'DAMAGED') out.RESTOCK = 'DAMAGED';
    else if (line.sealedOnly && line.condition !== 'SEALED') out.RESTOCK = 'NOT_SEALED';
  }
  return out;
}

/** 允许的去向（按 回架、报废、危险品回收、退供应商 的顺序） */
export function allowedDispositions(line: Pick<ReturnLine, 'condition' | 'tempZone' | 'chemical' | 'sealedOnly'>): ReturnDisposition[] {
  const blocked = returnBlocks(line);
  return DISPOSITIONS.filter((d) => !blocked[d]);
}

export const returnsModule: OpsModule = {
  id: 'returns',
  commands: COMMANDS,
  decide(s, env, ctx) {
    const { cmd } = env;
    switch (cmd.type) {
      case 'StartReturn': {
        if (cmd.orderId && !s.orders[cmd.orderId]) return no('ORDER_NOT_FOUND');
        return yes([ev('ReturnStarted', { returnId: `RT${String(s.counters.returns + 1).padStart(4, '0')}`, ...(cmd.orderId ? { orderId: cmd.orderId } : {}), kind: cmd.kind === 'DELIVERY' ? 'DELIVERY' : 'CUSTOMER' })]);
      }
      case 'ScanReturnItem': {
        const r = s.returns[cmd.returnId];
        if (!r) return no('RETURN_NOT_FOUND');
        if (r.status !== 'OPEN') return no('RETURN_CLOSED');
        const item = ctx.itemByGtin(cmd.code.trim());
        if (!item) return no('ITEM_NOT_FOUND', { itemId: cmd.code });
        const qty = Math.max(1, Math.min(50, Math.round(cmd.qty)));
        const o = r.orderId ? s.orders[r.orderId] : undefined;
        const inOrder = !!o?.lines.some((l) => l.itemId === item.id || l.gtin === item.gtin);
        // 退的件数不能比订单里交出去的多（决策记录 0026）
        if (o && inOrder) {
          const handed = o.lines.filter((l) => l.itemId === item.id || l.gtin === item.gtin).reduce((n, l) => n + (o.lineResults[l.lineId]?.picked ?? 0), 0);
          const already = r.lines.filter((l) => l.itemId === item.id).reduce((n, l) => n + l.qty, 0);
          if (handed > 0 && already + qty > handed) return no('RETURN_QTY_EXCEEDED', { remaining: Math.max(0, handed - already) });
        }
        const condition = cmd.condition === 'OPENED' || cmd.condition === 'DAMAGED' ? cmd.condition : 'SEALED';
        return yes([ev('ReturnItemScanned', { returnId: r.id, itemId: item.id, gtin: item.gtin, name: item.name, qty, condition, inOrder, tempZone: item.tempZone, unitPrice: item.unitPrice, ...(item.chemical ? { chemical: true } : {}), ...(item.sealedOnly ? { sealedOnly: true } : {}) })]);
      }
      case 'RemoveReturnLine': {
        const r = s.returns[cmd.returnId];
        if (!r) return no('RETURN_NOT_FOUND');
        if (r.status !== 'OPEN') return no('RETURN_CLOSED');
        if (!r.lines[cmd.index]) return no('RETURN_NOT_FOUND');
        return yes([ev('ReturnLineRemoved', { returnId: r.id, index: cmd.index })]);
      }
      case 'SetReturnDisposition': {
        const r = s.returns[cmd.returnId];
        if (!r) return no('RETURN_NOT_FOUND');
        if (r.status !== 'OPEN') return no('RETURN_CLOSED');
        const line = r.lines[cmd.index];
        if (!line || !DISPOSITIONS.includes(cmd.disposition)) return no('QTY_INVALID', { remaining: 0 });
        const blocked = returnBlocks(line)[cmd.disposition];
        if (blocked) return no('DISPOSITION_NOT_ALLOWED', { reason: blocked });
        const ai = cmd.aiSuggested && DISPOSITIONS.includes(cmd.aiSuggested) ? cmd.aiSuggested : undefined;
        return yes([ev('ReturnDispositionSet', { returnId: r.id, index: cmd.index, disposition: cmd.disposition, ...(ai ? { aiSuggested: ai } : {}) })]);
      }
      case 'CompleteReturn': {
        const r = s.returns[cmd.returnId];
        if (!r) return no('RETURN_NOT_FOUND');
        if (r.status !== 'OPEN') return no('RETURN_CLOSED');
        if (!r.lines.length || r.lines.some((l) => !l.disposition)) return no('RETURN_INCOMPLETE');
        const refundValue = Math.round(r.lines.reduce((a, l) => a + l.unitPrice * l.qty, 0) * 100) / 100;
        const restocked = r.lines.filter((l) => l.disposition === 'RESTOCK').map((l) => ({ itemId: l.itemId, qty: l.qty }));
        // 可售回架（决策记录 0026）：给补货员一个「退货放回货架」的任务，放回后货架估算才增加
        const tasks = restocked
          .map((x, k) => {
            const pe = ctx.statics.planogram.find((p) => p.itemId === x.itemId);
            return pe ? ev('ShelfCheckRequested', { checkId: `SC${String(s.counters.checks + 1 + k).padStart(4, '0')}`, itemId: x.itemId, locationId: pe.locationId, reason: 'RETURN', expected: x.qty }) : undefined;
          })
          .filter((x): x is NonNullable<typeof x> => !!x);
        return yes([ev('ReturnCompleted', { returnId: r.id, refundValue, restocked }), ...tasks]);
      }
      default:
        return no('INVALID_ORDER');
    }
  },
  apply(s, e, st) {
    switch (e.type) {
      case 'ReturnStarted': {
        const p = e.payload;
        s.returns[p.returnId] = { id: p.returnId, ...(p.orderId ? { orderId: p.orderId } : {}), kind: p.kind, status: 'OPEN', createdAt: e.at, associateId: e.actor, lines: [] };
        s.counters.returns += 1;
        return true;
      }
      case 'ReturnLineRemoved': {
        const r = s.returns[e.payload.returnId];
        if (r) r.lines.splice(e.payload.index, 1);
        return true;
      }
      case 'ReturnItemScanned': {
        const r = s.returns[e.payload.returnId];
        if (r) {
          const p = e.payload;
          r.lines.push({ itemId: p.itemId, gtin: p.gtin, name: p.name, qty: p.qty, condition: p.condition, inOrder: p.inOrder, tempZone: p.tempZone, unitPrice: p.unitPrice, ...(p.chemical ? { chemical: true } : {}), ...(p.sealedOnly ? { sealedOnly: true } : {}) });
        }
        return true;
      }
      case 'ReturnDispositionSet': {
        const r = s.returns[e.payload.returnId];
        const l = r?.lines[e.payload.index];
        if (l) {
          l.disposition = e.payload.disposition;
          if (e.payload.aiSuggested) l.aiSuggested = e.payload.aiSuggested;
          // 去向判断的采纳率：员工的选择与 AI 建议相同记为采纳，不同记为否决
          if (e.payload.aiSuggested) {
            const stats = (s.aiStats.RETURNS ??= { issued: 0, ACCEPTED: 0, OVERRIDDEN: 0, DISMISSED: 0, EXPIRED: 0, SUPERSEDED: 0, AUTO_APPLIED: 0, reasons: {} });
            stats.issued++;
            if (e.payload.aiSuggested === e.payload.disposition) stats.ACCEPTED++;
            else stats.OVERRIDDEN++;
          }
        }
        return true;
      }
      case 'ReturnCompleted': {
        const r = s.returns[e.payload.returnId];
        if (r) {
          r.status = 'COMPLETED';
          r.completedAt = e.at;
          r.refundValue = e.payload.refundValue;
          // 回架的商品在补货员放回货架、确认件数后才加到货架估算（决策记录 0026）
        }
        return true;
      }
      default:
        return false;
    }
  },
};
