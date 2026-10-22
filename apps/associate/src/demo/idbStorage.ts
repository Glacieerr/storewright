import { memoryStorage, type HubStorage, type MemorySeed } from '@storewright/server/storage';
import type { AnyOpsEvent } from '@storewright/ops';

/**
 * 浏览器内演示的持久化：内存里读写（快），同时按顺序写入 IndexedDB；中枢启动时从 IndexedDB 恢复。
 * 刷新或关闭所有页面后再打开，门店还在。超过 EXPIRE_MS 没有写入时清空作业事件（保留 AI 模型和验证码的盐），
 * 避免打开一家「订单都过期了」的店。只在 SharedWorker 里使用（几个专用 Worker 同时写会互相覆盖）。
 */

const DB = 'storewright-demo';
const VERSION = 1;
export const EXPIRE_MS = 12 * 3_600_000;

interface EventRow {
  storeId: string;
  seq: number;
  e: AnyOpsEvent;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: ['storeId', 'seq'] });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function persistentStorage(now = Date.now()): Promise<{ storage: HubStorage; restored: boolean }> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return { storage: memoryStorage(), restored: false };
  }
  const kvRows = (await req(db.transaction('kv').objectStore('kv').getAll())) as Array<{ k: string; v: unknown }>;
  const kv = new Map(kvRows.map((r) => [r.k, r.v]));
  const savedAt = Number(kv.get('meta:savedAt') ?? 0);
  const expired = savedAt > 0 && now - savedAt > EXPIRE_MS;
  if (expired) await req(db.transaction('events', 'readwrite').objectStore('events').clear());
  const rows = expired ? [] : ((await req(db.transaction('events').objectStore('events').getAll())) as EventRow[]);
  const seed: MemorySeed = { events: {}, meta: {}, sessions: {}, ai: {} };
  for (const r of rows) (seed.events![r.storeId] ??= []).push(r.e);
  for (const [k, v] of kv) {
    if (k.startsWith('meta:') && k !== 'meta:savedAt') seed.meta![k.slice(5)] = String(v);
    else if (k.startsWith('session:')) seed.sessions![k.slice(8)] = v as never;
    else if (k.startsWith('ai:')) seed.ai![k.slice(3)] = v;
  }
  const mem = memoryStorage(seed);

  // 写入按顺序排队；失败时只在控制台提示（演示照常运行）
  let chain: Promise<unknown> = Promise.resolve();
  const write = (stores: Array<'events' | 'kv'>, fn: (tx: IDBTransaction) => void) => {
    chain = chain
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction([...stores, 'kv'], 'readwrite');
            fn(tx);
            tx.objectStore('kv').put({ k: 'meta:savedAt', v: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          }),
      )
      .catch((err: unknown) => console.warn('demo storage', err));
  };

  const storage: HubStorage = {
    kind: 'indexeddb',
    events: {
      load: (storeId, after) => mem.events.load(storeId, after),
      commandResult: (storeId, id) => mem.events.commandResult(storeId, id),
      async append(storeId, batch, command) {
        await mem.events.append(storeId, batch, command);
        write(['events'], (tx) => {
          const os = tx.objectStore('events');
          for (const e of batch) os.put({ storeId, seq: e.seq, e } satisfies EventRow);
        });
      },
      async reset(storeId) {
        await mem.events.reset(storeId);
        write(['events'], (tx) => tx.objectStore('events').delete(IDBKeyRange.bound([storeId, 0], [storeId, Number.MAX_SAFE_INTEGER])));
      },
    },
    async metaOrInit(key, value) {
      const v = await mem.metaOrInit(key, value);
      write([], (tx) => tx.objectStore('kv').put({ k: `meta:${key}`, v }));
      return v;
    },
    async addSession(token, s, at) {
      await mem.addSession(token, s, at);
      write([], (tx) => tx.objectStore('kv').put({ k: `session:${token}`, v: s }));
    },
    findSession: (token) => mem.findSession(token),
    loadAiState: (storeId) => mem.loadAiState(storeId),
    async saveAiState(storeId, data, at) {
      await mem.saveAiState(storeId, data, at);
      write([], (tx) => tx.objectStore('kv').put({ k: `ai:${storeId}`, v: JSON.parse(JSON.stringify(data)) }));
    },
  };
  return { storage, restored: rows.length > 0 };
}

/** 清空浏览器里保存的演示数据（作业事件、会话、AI 模型），下次打开是一家新店 */
export async function clearDemoStorage(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['events', 'kv'], 'readwrite');
    tx.objectStore('events').clear();
    tx.objectStore('kv').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
