import type { AnyOpsEvent } from '@storewright/ops';

/**
 * 存储接口：事件日志、元数据（验证码哈希的盐）、会话、AI 模型仓库。
 * 服务端用 SQL 实现（PGlite / PostgreSQL，见 eventStore.ts 与 sqlStorage.ts），
 * 浏览器内演示模式用内存实现（memoryStorage）。这个文件不能引用 Node 专有的模块。
 */

export class ConflictError extends Error {
  constructor() {
    super('event sequence conflict');
  }
}

export interface EventLog {
  load(storeId: string, after?: number): Promise<AnyOpsEvent[]>;
  /** 追加一批事件（原子），连同命令的结果（幂等用）；序号冲突时抛出 ConflictError */
  append(storeId: string, events: readonly AnyOpsEvent[], command?: { id: string; result: unknown; at: number }): Promise<void>;
  commandResult(storeId: string, commandId: string): Promise<unknown | undefined>;
  reset(storeId: string): Promise<void>;
}

export type SessionRole = 'associate' | 'console' | 'viewer';

export interface SessionRow {
  actor: string;
  role: SessionRole;
  storeId: string;
}

export interface HubStorage {
  readonly kind: string;
  readonly events: EventLog;
  /** 读取元数据；不存在时写入 value，返回最终保存的值（多个进程同时写入时以先写入的为准） */
  metaOrInit(key: string, value: string): Promise<string>;
  addSession(token: string, s: SessionRow, at: number): Promise<void>;
  findSession(token: string): Promise<SessionRow | undefined>;
  loadAiState(storeId: string): Promise<unknown | undefined>;
  saveAiState(storeId: string, data: unknown, at: number): Promise<void>;
}

/** 内存存储的初始内容（浏览器内演示从 IndexedDB 恢复时使用） */
export interface MemorySeed {
  events?: Record<string, AnyOpsEvent[]>;
  meta?: Record<string, string>;
  sessions?: Record<string, SessionRow>;
  ai?: Record<string, unknown>;
}

/** 内存存储（浏览器内演示模式、测试）：关闭后数据消失；可以带初始内容 */
export function memoryStorage(seed: MemorySeed = {}): HubStorage {
  const events = new Map<string, AnyOpsEvent[]>(Object.entries(seed.events ?? {}).map(([k, v]) => [k, [...v].sort((a, b) => a.seq - b.seq)]));
  const commands = new Map<string, unknown>();
  const meta = new Map<string, string>(Object.entries(seed.meta ?? {}));
  const sessions = new Map<string, SessionRow>(Object.entries(seed.sessions ?? {}));
  const ai = new Map<string, unknown>(Object.entries(seed.ai ?? {}));
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const log: EventLog = {
    async load(storeId, after = 0) {
      return (events.get(storeId) ?? []).filter((e) => e.seq > after).map(clone);
    },
    async append(storeId, batch, command) {
      const list = events.get(storeId) ?? [];
      let last = list.at(-1)?.seq ?? 0;
      for (const e of batch) {
        if (e.seq !== last + 1) throw new ConflictError();
        last = e.seq;
      }
      list.push(...batch.map(clone));
      events.set(storeId, list);
      if (command && !commands.has(`${storeId}:${command.id}`)) commands.set(`${storeId}:${command.id}`, clone(command.result));
    },
    async commandResult(storeId, commandId) {
      const v = commands.get(`${storeId}:${commandId}`);
      return v === undefined ? undefined : clone(v);
    },
    async reset(storeId) {
      events.delete(storeId);
      for (const k of [...commands.keys()]) if (k.startsWith(`${storeId}:`)) commands.delete(k);
    },
  };
  return {
    kind: 'memory',
    events: log,
    async metaOrInit(key, value) {
      if (!meta.has(key)) meta.set(key, value);
      return meta.get(key) as string;
    },
    async addSession(token, s) {
      sessions.set(token, { ...s });
    },
    async findSession(token) {
      const s = sessions.get(token);
      return s ? { ...s } : undefined;
    },
    async loadAiState(storeId) {
      const v = ai.get(storeId);
      return v === undefined ? undefined : clone(v);
    },
    async saveAiState(storeId, data) {
      ai.set(storeId, clone(data));
    },
  };
}
