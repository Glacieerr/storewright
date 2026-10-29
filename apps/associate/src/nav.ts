import { useEffect, useRef, useState } from 'react';

/**
 * 去某一页的某一条（决策记录 0026）：提醒的「去处理」、「下一步」直接打开那个子页、那个任务、那条建议，
 * 不只是跳到底部的标签页。各个页面订阅自己关心的那一项。
 */
export type InventorySection = 'repl' | 'exception' | 'receive' | 'putaway' | 'count' | 'area';
export type AiTab = 'recs' | 'schedule' | 'field' | 'ask' | 'modes' | 'models';

export interface NavIntent {
  inventory?: InventorySection;
  /** 打开这个核对货架任务 */
  checkId?: string;
  aiTab?: AiTab;
  /** 滚到这条建议 */
  recId?: string;
  /** 打开这个订单或行程的交付 */
  sessionKey?: string;
  /** 展开告警条 */
  alert?: true;
}

const pending: NavIntent = {};
const subs = new Set<() => void>();

export function navigate(i: NavIntent): void {
  Object.assign(pending, i);
  for (const f of subs) f();
}

/** 订阅一项：已经有待处理的（页面还没打开时设的）也会马上收到 */
export function useIntent<K extends keyof NavIntent>(key: K, fn: (v: NonNullable<NavIntent[K]>) => void): void {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    const check = () => {
      const v = pending[key];
      if (v === undefined) return;
      delete pending[key];
      cb.current(v as NonNullable<NavIntent[K]>);
    };
    check();
    subs.add(check);
    return () => {
      subs.delete(check);
    };
  }, [key]);
}

/**
 * 记在这台设备的这次会话里的状态（决策记录 0026）：切到别的页面再回来，做到一半的步骤（已扫的箱子、已到货位）还在。
 * 存不了时照常使用（只是切页会丢）。
 */
export function useSessionState<T>(key: string, initial: T): [T, (v: T | ((x: T) => T)) => void] {
  const full = `sw-progress:${key}`;
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(full);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T | ((x: T) => T)) =>
    setV((cur) => {
      const val = typeof next === 'function' ? (next as (x: T) => T)(cur) : next;
      try {
        sessionStorage.setItem(full, JSON.stringify(val));
      } catch {
        // 存不了时只在内存里
      }
      return val;
    });
  return [v, set];
}

/** 记住的子页（库存、扩展）：切到别的标签页再回来时还在原来的子页 */
const remembered: Record<string, string> = {};
export function rememberSub(screen: string, sub: string): void {
  remembered[screen] = sub;
  try {
    sessionStorage.setItem(`sw-sub:${screen}`, sub);
  } catch {
    // 忽略
  }
}
export function rememberedSub(screen: string): string | undefined {
  if (remembered[screen]) return remembered[screen];
  try {
    return sessionStorage.getItem(`sw-sub:${screen}`) ?? undefined;
  } catch {
    return undefined;
  }
}
