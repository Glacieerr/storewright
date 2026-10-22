import { useSyncExternalStore } from 'react';
import { EN } from './en';

/**
 * 界面语言：中文原文就是键，英文界面查 EN 字典；{0}、{1} 为参数。默认按浏览器语言，选择保存在本机。
 */
export type Lang = 'zh' | 'en';

const KEY = 'storewright.associate.lang';

function initial(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'zh' || q === 'en') return q;
    const saved = localStorage.getItem(KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // 忽略
  }
  return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language) ? 'zh' : 'en';
}

let lang: Lang = typeof window === 'undefined' ? 'zh' : initial();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  try {
    localStorage.setItem(KEY, l);
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  } catch {
    // 忽略
  }
  for (const f of listeners) f();
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => lang,
  );
}

export function t(s: string, ...args: Array<string | number>): string {
  const v = lang === 'en' ? (EN[s] ?? s) : s;
  return args.length ? v.replace(/\{(\d+)\}/g, (m, i: string) => String(args[Number(i)] ?? m)) : v;
}

/** 时钟 HH:MM */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 时长 m:ss */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
