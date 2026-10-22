/**
 * 数据库：PostgreSQL 方言。默认用嵌入式 PGlite（WebAssembly 版 PostgreSQL，数据存在本地目录，不需要安装数据库）；
 * 设置 DATABASE_URL 时改用真正的 PostgreSQL。两者执行同一份 SQL。
 */

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** 在一个事务里执行；回调抛错时回滚 */
  transaction<T>(fn: (tx: Pick<Db, 'query'>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pglite' | 'postgres';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  store_id text NOT NULL,
  seq integer NOT NULL,
  at bigint NOT NULL,
  type text NOT NULL,
  actor text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (store_id, seq)
);
CREATE TABLE IF NOT EXISTS commands (
  store_id text NOT NULL,
  command_id text NOT NULL,
  at bigint NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (store_id, command_id)
);
CREATE TABLE IF NOT EXISTS ai_state (
  store_id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  store_id text NOT NULL,
  actor text NOT NULL,
  role text NOT NULL,
  created_at bigint NOT NULL
);
`;

export async function openDb(opts: { url?: string; dataDir?: string }): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url) : await openPglite(opts.dataDir);
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      const r = await pg.query<T>(sql, params as never);
      return { rows: r.rows };
    },
    async transaction<T>(fn: (tx: Pick<Db, 'query'>) => Promise<T>) {
      return pg.transaction(async (tx) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            const r = await tx.query<R>(sql, params as never);
            return { rows: r.rows };
          },
        }),
      ) as Promise<T>;
    },
    async close() {
      await pg.close();
    },
  };
}

async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: 'postgres',
    async query<T>(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async transaction<T>(fn: (tx: Pick<Db, 'query'>) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            const r = await client.query(sql, params);
            return { rows: r.rows as R[] };
          },
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** 主键冲突（并发写入同一序号） */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === '23505') return true;
  return /duplicate key|unique constraint/i.test(String((e as Error)?.message ?? e));
}
