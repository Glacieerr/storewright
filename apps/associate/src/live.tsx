import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LiveClient } from '@storewright/ops/client';
import type { OpsCommand, Rejection } from '@storewright/ops';
import { rejectText } from './rejects';
import { t } from './i18n';
import { feedback } from './feedback';
import { toast } from './ui/Toasts';
import { DEMO, link } from './demo/transport';

/** 登录信息（保存在本机） */
export interface Auth {
  storeId: string;
  token: string;
  actor: string;
  role: 'associate' | 'console' | 'viewer';
}

const AUTH_KEY = 'storewright.associate.auth';

/**
 * 每个标签页有自己的身份（sessionStorage），这样一台电脑可以同时打开几个身份做演示；
 * 新开的页面沿用上一次登录的身份（localStorage），手机上重新打开应用不用再选。
 */
export function loadAuth(): Auth | undefined {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY) ?? localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as Auth) : undefined;
  } catch {
    return undefined;
  }
}

export function saveAuth(a: Auth | undefined): void {
  try {
    if (a) {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify(a));
      localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    } else {
      sessionStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(AUTH_KEY);
    }
  } catch {
    // 忽略
  }
}

interface LiveValue {
  client: LiveClient;
  auth: Auth;
  /** 提交命令：成功时轻震，被拒绝时提示原因；返回是否成功 */
  run(cmd: OpsCommand, opts?: { quiet?: boolean }): Promise<boolean>;
  nameOf(id: string | undefined): string;
}

const Ctx = createContext<LiveValue | null>(null);

export function LiveProvider({ auth, children, onAuthError }: { auth: Auth; children: ReactNode; onAuthError?: () => void }) {
  const client = useMemo(
    () =>
      new LiveClient({
        baseUrl: '',
        storeId: auth.storeId,
        token: auth.token,
        storage: window.localStorage,
        onRejected: (_cmd, r) => toast(rejectText(r, (id) => id), 'error'),
        onAuthError: () => onAuthError?.(),
        // 浏览器内演示模式：实时连接和请求都经过浏览器里的门店中枢
        ...(DEMO ? { WebSocketImpl: link.WebSocket as unknown as typeof WebSocket, fetchImpl: link.fetch as unknown as typeof fetch } : {}),
      }),
    [auth.storeId, auth.token],
  );
  useEffect(() => {
    client.connect();
    // 地址栏加 ?debug 时暴露客户端，便于检查和自动化测试
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __swa: LiveClient }).__swa = client;
    return () => client.close();
  }, [client]);
  const value = useMemo<LiveValue>(() => {
    const nameOf = (id: string | undefined) => {
      if (!id) return '';
      // 演示门店的虚拟补货员（不在员工名单里）
      if (id === 'auto-restock') return t('自动补货');
      return client.statics?.roster.find((a) => a.id === id)?.name ?? id;
    };
    return {
      client,
      auth,
      nameOf,
      async run(cmd, opts) {
        const r = await client.send(cmd);
        if (!r.ok) {
          feedback('error');
          toast(rejectText(r.reject as Rejection, nameOf), 'error');
          return false;
        }
        // 验证码错误也是一条事件（记录尝试次数），但对员工来说是失败
        if (r.events.some((e) => e.type === 'CodeFailed')) {
          feedback('error');
          return false;
        }
        if (!opts?.quiet) feedback('ok');
        return true;
      },
    };
  }, [client, auth]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 当前的实时数据；状态变化时重新渲染 */
export function useLive(): LiveValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('LiveProvider missing');
  useSyncExternalStore(v.client.subscribe, () => v.client.version);
  return v;
}

/** 每隔 ms 毫秒刷新一次（等待计时、冷链倒计时） */
export function useNow(ms = 1000): number {
  const { client } = useContext(Ctx) as LiveValue;
  const [now, setNow] = useState(() => client.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(client.now()), ms);
    return () => window.clearInterval(id);
  }, [client, ms]);
  return now;
}
