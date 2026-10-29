import { ev, type PendingEvent } from '../events';
import type { OpsState, Parcel, ParcelSlot, StoreStatic } from '../types';
import { no, yes, type OpsModule } from './framework';

/**
 * 包裹中转（工作流设计 4.9，决策 IP-01～IP-04）：
 * - 到货通知（ASN）先到；扫描包裹编码入站；没有通知的标为多出（放到待核实区）；
 * - 超过预计到货时间 + 宽限期仍未入站的，由排程标为短少；损坏的放到损坏区；
 * - 按行程暂存，司机交接时整行程确认（行程里还有已入站但没暂存的包裹时不能交接）。
 */

export const PARCEL_GRACE_MIN = 30;

const COMMANDS = new Set(['CreateParcelAsn', 'InductParcel', 'StageParcel', 'ReportParcelDamaged', 'HandOffParcels', 'ResolveParcel'] as const);

export const parcelModule: OpsModule = {
  id: 'parcel',
  commands: COMMANDS,
  decide(s, env, ctx) {
    const { cmd, at } = env;
    switch (cmd.type) {
      case 'CreateParcelAsn': {
        const parcels = cmd.parcels
          .filter((p) => p && typeof p.parcelId === 'string' && p.parcelId.trim() && !s.parcels[p.parcelId.trim().toUpperCase()])
          .slice(0, 200)
          .map((p) => ({ parcelId: p.parcelId.trim().toUpperCase(), tripRef: String(p.tripRef ?? '').trim().toUpperCase() || 'UNASSIGNED', sizeClass: p.sizeClass === 'L' || p.sizeClass === 'M' ? p.sizeClass : ('S' as const), weightKg: Math.max(0, Number(p.weightKg) || 0) }));
        if (!parcels.length) return no('NOTHING_TO_RELEASE');
        const expectedBy = at + Math.max(5, Math.min(24 * 60, cmd.expectedInMin ?? 120)) * 60_000;
        return yes([ev('ParcelAsnReceived', { asnId: `PA${String(s.counters.asns + 1).padStart(4, '0')}`, carrier: String(cmd.carrier ?? '').slice(0, 40) || 'Carrier', expectedBy, parcels })]);
      }
      case 'InductParcel': {
        const code = cmd.code.trim().toUpperCase();
        if (!code) return no('PARCEL_NOT_FOUND');
        const p = s.parcels[code];
        // 到货通知里没有的编码：确认是多出的包裹才登记（决策记录 0026：扫错、输错的编码不再直接变成「多出」）
        if (!p) return cmd.extra === true ? yes([ev('ParcelOver', { parcelId: code })]) : no('PARCEL_NOT_FOUND');
        if (p.status !== 'EXPECTED' && p.status !== 'SHORT') return no('PARCEL_STATE', { status: p.status });
        return yes([ev('ParcelInducted', { parcelId: p.id })]);
      }
      case 'StageParcel': {
        const p = s.parcels[cmd.parcelId.trim().toUpperCase()];
        if (!p) return no('PARCEL_NOT_FOUND');
        if (p.status !== 'INDUCTED' && p.status !== 'STAGED') return no('PARCEL_STATE', { status: p.status });
        const slot = cmd.slotCode.trim().toUpperCase();
        const def = ctx.statics.parcelSlots?.find((x) => x.code === slot);
        if (!def) return no('SLOT_NOT_FOUND');
        if (p.slotCode === slot) return no('SAME_SLOT');
        if (slotUsage(s, slot) >= def.capacity) return no('SLOT_FULL');
        return yes([ev('ParcelStaged', { parcelId: p.id, slotCode: slot })]);
      }
      case 'ReportParcelDamaged': {
        const p = s.parcels[cmd.parcelId.trim().toUpperCase()];
        if (!p) return no('PARCEL_NOT_FOUND');
        if (p.status === 'HANDED_OFF' || p.status === 'DAMAGED') return no('PARCEL_STATE', { status: p.status });
        return yes([ev('ParcelDamaged', { parcelId: p.id })]);
      }
      case 'ResolveParcel': {
        const p = s.parcels[cmd.parcelId.trim().toUpperCase()];
        if (!p) return no('PARCEL_NOT_FOUND');
        if (p.status !== 'OVER' && p.status !== 'DAMAGED') return no('PARCEL_STATE', { status: p.status });
        return yes([ev('ParcelResolved', { parcelId: p.id, action: cmd.action === 'RETURN' ? 'RETURN' : 'HOLD' })]);
      }
      case 'HandOffParcels': {
        const trip = cmd.tripRef.trim().toUpperCase();
        const inTrip = Object.values(s.parcels).filter((p) => p.tripRef === trip);
        const staged = inTrip.filter((p) => p.status === 'STAGED');
        if (!staged.length) return no('TRIP_NOT_READY');
        if (inTrip.some((p) => p.status === 'INDUCTED')) return no('TRIP_NOT_READY');
        return yes([ev('ParcelsHandedOff', { tripRef: trip, parcelIds: staged.map((p) => p.id) })]);
      }
      default:
        return no('INVALID_ORDER');
    }
  },
  apply(s, e) {
    switch (e.type) {
      case 'ParcelAsnReceived':
        for (const p of e.payload.parcels) s.parcels[p.parcelId] = { id: p.parcelId, asnId: e.payload.asnId, carrier: e.payload.carrier, tripRef: p.tripRef, sizeClass: p.sizeClass, weightKg: p.weightKg, status: 'EXPECTED', expectedBy: e.payload.expectedBy };
        s.counters.asns += 1;
        return true;
      case 'ParcelResolved': {
        const p = s.parcels[e.payload.parcelId];
        if (p) p.status = e.payload.action === 'RETURN' ? 'RETURNED' : 'HELD';
        return true;
      }
      case 'ParcelInducted': {
        const p = s.parcels[e.payload.parcelId];
        if (p) {
          p.status = 'INDUCTED';
          p.inductedAt = e.at;
        }
        return true;
      }
      case 'ParcelOver':
        s.parcels[e.payload.parcelId] = { id: e.payload.parcelId, carrier: '', sizeClass: 'M', weightKg: 0, status: 'OVER', inductedAt: e.at };
        return true;
      case 'ParcelStaged': {
        const p = s.parcels[e.payload.parcelId];
        if (p) {
          p.status = 'STAGED';
          p.slotCode = e.payload.slotCode;
        }
        return true;
      }
      case 'ParcelDamaged': {
        const p = s.parcels[e.payload.parcelId];
        if (p) {
          p.status = 'DAMAGED';
          delete p.slotCode;
        }
        return true;
      }
      case 'ParcelShort': {
        const p = s.parcels[e.payload.parcelId];
        if (p) p.status = 'SHORT';
        return true;
      }
      case 'ParcelsHandedOff':
        for (const id of e.payload.parcelIds) {
          const p = s.parcels[id];
          if (p) {
            p.status = 'HANDED_OFF';
            p.handedOffAt = e.at;
            delete p.slotCode;
          }
        }
        return true;
      default:
        return false;
    }
  },
  tick(s, at) {
    const out: PendingEvent[] = [];
    for (const p of Object.values(s.parcels)) if (p.status === 'EXPECTED' && p.expectedBy !== undefined && p.expectedBy + PARCEL_GRACE_MIN * 60_000 <= at) out.push(ev('ParcelShort', { parcelId: p.id }));
    return out;
  },
};

function slotUsage(s: OpsState, code: string): number {
  return Object.values(s.parcels).filter((p) => p.status === 'STAGED' && p.slotCode === code).length;
}

const SIZE_RANK: Record<ParcelSlot['size'], number> = { S: 0, M: 1, L: 2 };

/**
 * 格位建议（包裹中转的 AI 接入点，规则打分）：同一行程已经在用的格位优先（司机一次取走）；
 * 其次是尺寸合适、还有空位、离门口近的格位。返回格位和理由代码。
 */
export function suggestParcelSlot(s: OpsState, st: StoreStatic, parcel: Parcel): { slotCode: string; reason: 'SAME_TRIP' | 'SIZE_AND_DISTANCE' } | undefined {
  const slots = st.parcelSlots ?? [];
  const free = (x: ParcelSlot) => slotUsage(s, x.code) < x.capacity;
  const fits = (x: ParcelSlot) => SIZE_RANK[x.size] >= SIZE_RANK[parcel.sizeClass];
  const sameTrip = slots.find((x) => free(x) && fits(x) && Object.values(s.parcels).some((p) => p.status === 'STAGED' && p.slotCode === x.code && p.tripRef === parcel.tripRef));
  if (sameTrip) return { slotCode: sameTrip.code, reason: 'SAME_TRIP' };
  // 尺寸刚好合适的优先（大格位留给大包裹），同尺寸里离门口近的优先（列表顺序）
  const cand = slots.filter((x) => free(x) && fits(x)).sort((a, b) => SIZE_RANK[a.size] - SIZE_RANK[b.size]);
  const empty = cand.find((x) => slotUsage(s, x.code) === 0 || !Object.values(s.parcels).some((p) => p.status === 'STAGED' && p.slotCode === x.code && p.tripRef !== parcel.tripRef));
  const pick = empty ?? cand[0];
  return pick ? { slotCode: pick.code, reason: 'SIZE_AND_DISTANCE' } : undefined;
}

/** 按行程汇总包裹（包裹页与控制台使用） */
export function parcelTrips(s: OpsState): Array<{ tripRef: string; parcels: Parcel[] }> {
  const m = new Map<string, Parcel[]>();
  for (const p of Object.values(s.parcels)) {
    // 已交接、已退回、放在异常区的不算在行程里（决策记录 0026）
    if (!p.tripRef || p.status === 'HANDED_OFF' || p.status === 'RETURNED' || p.status === 'HELD') continue;
    const list = m.get(p.tripRef) ?? [];
    list.push(p);
    m.set(p.tripRef, list);
  }
  return [...m.entries()].map(([tripRef, parcels]) => ({ tripRef, parcels: parcels.sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.tripRef.localeCompare(b.tripRef));
}
