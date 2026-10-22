import { ev, type PendingEvent } from '../events';
import type { MtoTicket, OpsState } from '../types';
import { no, yes, type OpsModule } from './framework';

/**
 * 熟食现做（工作流设计 4.8）：
 * 建议开始时间 = 时段起点 − 制作时长 − 缓冲；完成后放入保温区并计时，超过保温时限由排程自动丢弃；
 * 交付准备时取出（准备时最后取热食）。订单取消时未完成的现做单一并丢弃。
 */

export const MTO_BUFFER_MIN = 10;

const COMMANDS = new Set(['CreateMtoTicket', 'StartMto', 'CompleteMto', 'PullMto', 'DiscardMto'] as const);

export const mtoModule: OpsModule = {
  id: 'mto',
  commands: COMMANDS,
  decide(s, env, ctx) {
    const { cmd } = env;
    switch (cmd.type) {
      case 'CreateMtoTicket': {
        const o = s.orders[cmd.orderId];
        if (!o) return no('ORDER_NOT_FOUND');
        if (o.status === 'CANCELLED' || o.status === 'COMPLETED') return no('ORDER_COMPLETED');
        const m = ctx.statics.mtoMenu?.find((x) => x.id === cmd.menuId);
        if (!m) return no('MENU_NOT_FOUND');
        const qty = Math.max(1, Math.min(20, Math.round(cmd.qty)));
        const startAt = o.slotStart - (m.prepMin + MTO_BUFFER_MIN) * 60_000;
        return yes([ev('MtoTicketCreated', { ticketId: `MT${String(s.counters.mto + 1).padStart(4, '0')}`, orderId: o.id, menuId: m.id, name: m.name, qty, hot: m.hot, holdMin: m.holdMin, startAt, dueAt: o.slotStart - 5 * 60_000 })]);
      }
      case 'StartMto': {
        const t = s.mto[cmd.ticketId];
        if (!t) return no('TICKET_NOT_FOUND');
        if (t.status !== 'QUEUED') return no('TICKET_STATE', { status: t.status });
        return yes([ev('MtoStarted', { ticketId: t.id })]);
      }
      case 'CompleteMto': {
        const t = s.mto[cmd.ticketId];
        if (!t) return no('TICKET_NOT_FOUND');
        if (t.status !== 'COOKING') return no('TICKET_STATE', { status: t.status });
        const slot = cmd.slotCode?.trim().toUpperCase();
        if (slot && ctx.statics.hotSlots?.length && !ctx.statics.hotSlots.includes(slot)) return no('SLOT_NOT_FOUND');
        return yes([ev('MtoCompleted', { ticketId: t.id, ...(slot ? { slotCode: slot } : {}), discardAt: env.at + t.holdMin * 60_000 })]);
      }
      case 'PullMto': {
        const t = s.mto[cmd.ticketId];
        if (!t) return no('TICKET_NOT_FOUND');
        if (t.status !== 'HELD') return no('TICKET_STATE', { status: t.status });
        return yes([ev('MtoPulled', { ticketId: t.id })]);
      }
      case 'DiscardMto': {
        const t = s.mto[cmd.ticketId];
        if (!t) return no('TICKET_NOT_FOUND');
        if (t.status === 'PULLED' || t.status === 'DISCARDED') return no('TICKET_STATE', { status: t.status });
        return yes([ev('MtoDiscarded', { ticketId: t.id, reason: 'MANUAL' })]);
      }
      default:
        return no('INVALID_ORDER');
    }
  },
  apply(s, e) {
    switch (e.type) {
      case 'MtoTicketCreated': {
        const p = e.payload;
        s.mto[p.ticketId] = { id: p.ticketId, orderId: p.orderId, menuId: p.menuId, name: p.name, qty: p.qty, hot: p.hot, holdMin: p.holdMin, status: 'QUEUED', createdAt: e.at, startAt: p.startAt, standardStartAt: p.startAt, dueAt: p.dueAt };
        s.counters.mto += 1;
        return true;
      }
      case 'MtoStartAdjusted': {
        const t = s.mto[e.payload.ticketId];
        if (t) {
          t.startAt = e.payload.startAt;
          t.aiAdjusted = true;
        }
        return true;
      }
      case 'MtoStarted': {
        const t = s.mto[e.payload.ticketId];
        if (t) {
          t.status = 'COOKING';
          t.startedAt = e.at;
          t.associateId = e.actor;
        }
        return true;
      }
      case 'MtoCompleted': {
        const t = s.mto[e.payload.ticketId];
        if (t) {
          t.status = 'HELD';
          t.completedAt = e.at;
          t.discardAt = e.payload.discardAt;
          if (e.payload.slotCode) t.slotCode = e.payload.slotCode;
        }
        return true;
      }
      case 'MtoPulled': {
        const t = s.mto[e.payload.ticketId];
        if (t) {
          t.status = 'PULLED';
          t.pulledAt = e.at;
        }
        return true;
      }
      case 'MtoDiscarded': {
        const t = s.mto[e.payload.ticketId];
        if (t) {
          t.status = 'DISCARDED';
          t.discardedAt = e.at;
          t.discardReason = e.payload.reason;
        }
        return true;
      }
      default:
        return false;
    }
  },
  tick(s, at) {
    const out: PendingEvent[] = [];
    for (const t of Object.values(s.mto)) {
      // 保温超时：强制丢弃（决策 M-03、D-10）
      if (t.status === 'HELD' && t.discardAt !== undefined && t.discardAt <= at) out.push(ev('MtoDiscarded', { ticketId: t.id, reason: 'HOLD_EXPIRED' }));
      // 订单已取消：还没取出的现做单丢弃
      const o = s.orders[t.orderId];
      if (o?.status === 'CANCELLED' && (t.status === 'QUEUED' || t.status === 'COOKING' || t.status === 'HELD')) out.push(ev('MtoDiscarded', { ticketId: t.id, reason: 'ORDER_CANCELLED' }));
    }
    return out;
  },
};

/** 熟食看板：排队中按建议开始时间，制作中按开始时间，保温中按丢弃时间 */
export function mtoBoard(s: OpsState): { queued: MtoTicket[]; cooking: MtoTicket[]; held: MtoTicket[] } {
  const all = Object.values(s.mto);
  return {
    queued: all.filter((t) => t.status === 'QUEUED').sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)),
    cooking: all.filter((t) => t.status === 'COOKING').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    held: all.filter((t) => t.status === 'HELD').sort((a, b) => (a.discardAt ?? 0) - (b.discardAt ?? 0)),
  };
}
