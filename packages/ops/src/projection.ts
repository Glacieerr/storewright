import type { OpsState } from './types';

/**
 * 发给设备的快照（决策记录 0014）：服务端保留完整状态，设备只需要正在进行的作业。
 * 完成或取消超过 retainMin 分钟的订单，它们的框、标签、批次不再随快照发出；完成超过 retainMin 分钟的交付会话也不发。
 * 这些订单本身保留（今日统计、最近完成、退货选单要用），但商品明细只留在服务端（trimmed = true）。
 * 之后的事件照常应用：应用事件时找不到的记录会被跳过。
 */
export const CLIENT_RETAIN_MIN = 60;

export function clientProjection(s: OpsState, now: number, retainMin = CLIENT_RETAIN_MIN): OpsState {
  const cutoff = now - retainMin * 60_000;
  const finishedOrder = new Set<string>();
  for (const o of Object.values(s.orders)) {
    const end = o.status === 'COMPLETED' ? o.completedAt : o.status === 'CANCELLED' ? o.cancelledAt : undefined;
    if (end !== undefined && end < cutoff) finishedOrder.add(o.id);
  }
  if (!finishedOrder.size && !Object.values(s.sessions).some((x) => x.status === 'COMPLETED' && (x.completedAt ?? now) < cutoff)) return s;
  const totes: OpsState['totes'] = {};
  for (const [id, t] of Object.entries(s.totes)) {
    // 还在暂存区或回收专区的框（取消订单的框等着处理）一直保留
    if (finishedOrder.has(t.orderId) && t.status !== 'STAGED' && t.status !== 'PULLED' && t.status !== 'RECOVERY') continue;
    totes[id] = t;
  }
  const labels: OpsState['labels'] = {};
  for (const [id, l] of Object.entries(s.labels)) if (!l.toteId || totes[l.toteId]) labels[id] = l;
  const walks: OpsState['walks'] = {};
  for (const [id, w] of Object.entries(s.walks)) {
    if (w.status === 'COMPLETED' && w.toteIds.every((t) => !totes[t])) continue;
    walks[id] = w;
  }
  const sessions: OpsState['sessions'] = {};
  for (const [id, x] of Object.entries(s.sessions)) {
    if (x.status === 'COMPLETED' && (x.completedAt ?? now) < cutoff) continue;
    sessions[id] = x;
  }
  const orders: OpsState['orders'] = {};
  for (const [id, o] of Object.entries(s.orders)) orders[id] = finishedOrder.has(id) ? { ...o, lines: [], lineResults: {}, trimmed: true } : o;
  return { ...s, orders, totes, labels, walks, sessions };
}
