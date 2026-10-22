import type { AnyOpsEvent } from '@storewright/ops';
import { isUniqueViolation, type Db } from './db';
import { ConflictError, type EventLog, type HubStorage, type SessionRole, type SessionRow } from './storage';

export { ConflictError };

/**
 * 事件存储：按门店追加写入，序号连续。按「期望版本」写入：主键冲突说明有别的写入者抢先，调用方重新读取后重试（乐观并发）。
 */

interface Row {
  seq: number;
  at: string | number;
  type: string;
  actor: string;
  payload: unknown;
}

const toEvent = (r: Row): AnyOpsEvent => ({ seq: Number(r.seq), at: Number(r.at), type: r.type, actor: r.actor, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }) as AnyOpsEvent;

export class EventStore implements EventLog {
  constructor(private readonly db: Db) {}

  async load(storeId: string, after = 0): Promise<AnyOpsEvent[]> {
    const r = await this.db.query<Row>('SELECT seq, at, type, actor, payload FROM events WHERE store_id = $1 AND seq > $2 ORDER BY seq', [storeId, after]);
    return r.rows.map(toEvent);
  }

  /**
   * 追加一批事件（同一个事务），连同命令的结果（用于幂等：同一个命令 ID 重复提交时直接返回上次的结果）。
   */
  async append(storeId: string, events: readonly AnyOpsEvent[], command?: { id: string; result: unknown; at: number }): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        for (const e of events) {
          await tx.query('INSERT INTO events (store_id, seq, at, type, actor, payload) VALUES ($1, $2, $3, $4, $5, $6)', [storeId, e.seq, e.at, e.type, e.actor, JSON.stringify(e.payload)]);
        }
        if (command) await tx.query('INSERT INTO commands (store_id, command_id, at, result) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [storeId, command.id, command.at, JSON.stringify(command.result)]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictError();
      throw e;
    }
  }

  async commandResult(storeId: string, commandId: string): Promise<unknown | undefined> {
    const r = await this.db.query<{ result: unknown }>('SELECT result FROM commands WHERE store_id = $1 AND command_id = $2', [storeId, commandId]);
    const v = r.rows[0]?.result;
    return typeof v === 'string' ? JSON.parse(v) : v;
  }

  /** 演示用：清空一个门店的全部事件 */
  async reset(storeId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM events WHERE store_id = $1', [storeId]);
      await tx.query('DELETE FROM commands WHERE store_id = $1', [storeId]);
    });
  }
}

/** SQL 存储（PGlite / PostgreSQL）：事件、元数据、会话、AI 模型仓库 */
export function sqlStorage(db: Db): HubStorage {
  return {
    kind: db.kind,
    events: new EventStore(db),
    async metaOrInit(key, value) {
      await db.query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
      return (await db.query<{ value: string }>('SELECT value FROM meta WHERE key = $1', [key])).rows[0]?.value ?? value;
    },
    async addSession(token, s, at) {
      await db.query('INSERT INTO sessions (token, store_id, actor, role, created_at) VALUES ($1, $2, $3, $4, $5)', [token, s.storeId, s.actor, s.role, at]);
    },
    async findSession(token): Promise<SessionRow | undefined> {
      const row = (await db.query<{ actor: string; role: SessionRole; store_id: string }>('SELECT actor, role, store_id FROM sessions WHERE token = $1', [token])).rows[0];
      return row ? { actor: row.actor, role: row.role, storeId: row.store_id } : undefined;
    },
    async loadAiState(storeId) {
      const raw = (await db.query<{ data: unknown }>('SELECT data FROM ai_state WHERE store_id = $1', [storeId])).rows[0]?.data;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async saveAiState(storeId, data, at) {
      await db.query('INSERT INTO ai_state (store_id, data, updated_at) VALUES ($1, $2, $3) ON CONFLICT (store_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at', [storeId, JSON.stringify(data), at]);
    },
  };
}

