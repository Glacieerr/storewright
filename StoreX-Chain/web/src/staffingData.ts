import type { Activity } from '../../src/facility/staffing';
import type { AirInfo } from './three/ops/airport';
import type { PortInfo } from './three/ops/port';

/**
 * 港口、机场每小时的作业量（给排班求解）：从三维设施作业的计划里每 15 分钟看一次，取每个小时里的最多台数；
 * 进闸的集卡、装卸的箱、拆组的集装板按小时首尾的累计数相减。
 */
export interface FacilitySources {
  port?: { info(t: number): PortInfo };
  airport?: { info(t: number, flightIds: Map<number, string>, labels: Map<number, string>): AirInfo };
}

const zeros = () => new Array<number>(24).fill(0);

export function facilityActivity(src: FacilitySources): Pick<Activity, 'port' | 'airport'> {
  const out: Pick<Activity, 'port' | 'airport'> = {};
  if (src.port) {
    const port = src.port;
    const a = { cranes: zeros(), rtg: zeros(), tt: zeros(), gate: zeros(), ships: zeros(), moves: zeros() };
    const done = (i: PortInfo) => i.other.done + (i.vessel?.done ?? 0);
    let prev = port.info(0);
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < 4; k++) {
        const i = port.info(h * 3600 + k * 900 + 450);
        const cranes = i.equip.filter((e) => e.kind.startsWith('岸桥') && /^(卸船|装船|移位)/.test(e.now));
        a.cranes[h] = Math.max(a.cranes[h] as number, cranes.length);
        a.ships[h] = Math.max(a.ships[h] as number, new Set(cranes.map((e) => e.kind)).size);
        a.rtg[h] = Math.max(a.rtg[h] as number, i.equip.filter((e) => e.id.startsWith('RTG') && e.now !== '待命').length);
        const tt = /(\d+)\s*辆在作业/.exec(i.equip.find((e) => e.id === '场内集卡')?.now ?? '');
        a.tt[h] = Math.max(a.tt[h] as number, tt ? Number(tt[1]) : 0);
      }
      const next = port.info(Math.min(86399, (h + 1) * 3600));
      a.gate[h] = Math.max(0, next.gate.inToday - prev.gate.inToday);
      a.moves[h] = Math.max(0, done(next) - done(prev));
      prev = next;
    }
    out.port = a;
  }
  if (src.airport) {
    const air = src.airport;
    const a = { stands: zeros(), flights: zeros(), ulds: zeros() };
    const ids = new Map<number, string>();
    const labels = new Map<number, string>();
    const moved = (i: AirInfo) => i.flights.reduce((s, f) => s + f.done + (f.loaded ?? 0), 0);
    let prev = air.info(0, ids, labels);
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < 4; k++) {
        const i = air.info(h * 3600 + k * 900 + 450, ids, labels);
        a.stands[h] = Math.max(a.stands[h] as number, i.today?.inUse ?? 0);
      }
      const next = air.info(Math.min(86399, (h + 1) * 3600), ids, labels);
      a.flights[h] = next.flights.filter((f) => f.land !== undefined && f.land >= h * 3600 && f.land < (h + 1) * 3600).length;
      a.ulds[h] = Math.max(0, moved(next) - moved(prev));
      prev = next;
    }
    out.airport = a;
  }
  return out;
}
