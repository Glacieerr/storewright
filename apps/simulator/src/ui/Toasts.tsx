import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { clock } from '../state/clock';
import type { Notification } from '../sim/protocol';
import { focusNotification } from './Inspector';
import { clockText } from './format';
import { translate } from '../i18n';

interface Toast {
  id: number;
  n: Notification;
  born: number;
}

const LIFETIME_MS = 5000;
let toastSeq = 0;

function firstAfter(list: readonly Notification[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid]?.t ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 播放经过警报事件时在场景上弹出提示，点击定位到对象。
 * 拖动时间轴（跳跃）时不补发跳过的事件；高倍速下同一批只保留最新两条。
 */
export function Toasts() {
  const timeline = useApp((s) => s.timeline);
  const [items, setItems] = useState<Toast[]>([]);
  const cursor = useRef({ t: 0, idx: 0 });

  useEffect(() => {
    if (!timeline) return;
    const list = timeline.notifications;
    cursor.current = { t: clock.time, idx: firstAfter(list, clock.time) };
    const id = window.setInterval(() => {
      const t = clock.time;
      const c = cursor.current;
      if (t < c.t || t - c.t > 1800) {
        cursor.current = { t, idx: firstAfter(list, t) };
        return;
      }
      const fresh: Notification[] = [];
      while (c.idx < list.length && (list[c.idx] as Notification).t <= t) {
        const n = list[c.idx++] as Notification;
        if (n.level === 'alert') fresh.push(n);
      }
      c.t = t;
      if (fresh.length) {
        const now = performance.now();
        setItems((prev) => [...prev, ...fresh.slice(-2).map((n) => ({ id: ++toastSeq, n, born: now }))].slice(-3));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [timeline]);

  useEffect(() => {
    if (!items.length) return;
    const id = window.setInterval(() => {
      const now = performance.now();
      setItems((prev) => (prev.some((i) => now - i.born > LIFETIME_MS) ? prev.filter((i) => now - i.born <= LIFETIME_MS) : prev));
    }, 500);
    return () => window.clearInterval(id);
  }, [items.length]);

  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map(({ id, n }) => (
        <button
          key={id}
          className="toast"
          onClick={() => {
            focusNotification(n);
            setItems((prev) => prev.filter((i) => i.id !== id));
          }}
        >
          <span className="toast-icon" aria-hidden>
            ⚠
          </span>
          <span className="mono toast-time">{clockText(n.t)}</span>
          <span>{translate(n.text)}</span>
        </button>
      ))}
    </div>
  );
}
