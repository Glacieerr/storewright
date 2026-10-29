import type { StoreConfig } from '@storewright/store-config';

/**
 * 「你的商店」的门店项目（决策记录 0013）：访客自己搭的门店，保存在本机浏览器（IndexedDB；不可用时退回 localStorage），
 * 可以导出成文件、再导入。同一个网站的模拟器和展示页共用这些项目。
 */

export interface StoreProject {
  /** 格式版本：以后改格式时据此迁移 */
  v: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  config: StoreConfig;
  /** 日订单量与人员规模（按门店规模推算，可以在运营设置里改） */
  sizing?: { ordersPerDay: number; staffScale: number };
}

const DB = 'storewright-projects';
const STORE = 'projects';
const LS_KEY = 'storewright.projects.v1';

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function lsAll(): StoreProject[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as StoreProject[];
  } catch {
    return [];
  }
}

function lsWrite(list: StoreProject[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // 存储已满或不可用
  }
}

export async function listProjects(): Promise<StoreProject[]> {
  const db = await openDb();
  if (!db) return lsAll().sort((a, b) => b.updatedAt - a.updatedAt);
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as StoreProject[]).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => resolve([]);
  });
}

export async function getProject(id: string): Promise<StoreProject | undefined> {
  const db = await openDb();
  if (!db) return lsAll().find((p) => p.id === id);
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as StoreProject | undefined);
    req.onerror = () => resolve(undefined);
  });
}

export async function saveProject(p: StoreProject): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsWrite([...lsAll().filter((x) => x.id !== p.id), p]);
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.parse(JSON.stringify(p)));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    lsWrite(lsAll().filter((x) => x.id !== id));
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function newProjectId(): string {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 导出文件的内容（带格式标记，导入时检查） */
export function exportProject(p: StoreProject): string {
  return JSON.stringify({ format: 'storewright-store', ...p }, null, 2);
}

export function parseProjectFile(text: string): StoreProject | undefined {
  try {
    const o = JSON.parse(text) as Partial<StoreProject> & { format?: string };
    if (o.format !== 'storewright-store' || !o.config || typeof o.name !== 'string') return undefined;
    const now = Date.now();
    return { v: 1, id: newProjectId(), name: o.name, createdAt: now, updatedAt: now, config: o.config, ...(o.sizing ? { sizing: o.sizing } : {}) };
  } catch {
    return undefined;
  }
}
