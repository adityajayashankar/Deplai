import mysql from 'mysql2/promise';
import { loadAdminEnv } from '@/lib/load-env';

type GlobalMysql = typeof globalThis & {
  __deplaiAdminMysqlPool?: mysql.Pool;
};

const globalForMysql = globalThis as GlobalMysql;

function createPool() {
  loadAdminEnv();
  const dbHost = process.env.DB_HOST || 'localhost';
  const dbPort = Number(process.env.DB_PORT || 3306);
  const connectionLimit = Math.max(1, Number(process.env.DB_POOL_SIZE || 5));

  return mysql.createPool({
    host: dbHost,
    port: Number.isFinite(dbPort) ? dbPort : 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'deplai',
    waitForConnections: true,
    connectionLimit,
    maxIdle: Math.min(2, connectionLimit),
    idleTimeout: 20_000,
    queueLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
}

function getPool(): mysql.Pool {
  if (!globalForMysql.__deplaiAdminMysqlPool) {
    globalForMysql.__deplaiAdminMysqlPool = createPool();
  }
  return globalForMysql.__deplaiAdminMysqlPool;
}

export async function resetDbPool(): Promise<void> {
  await globalForMysql.__deplaiAdminMysqlPool?.end().catch(() => undefined);
  globalForMysql.__deplaiAdminMysqlPool = undefined;
}

export async function query<T = unknown>(
  sql: string,
  params?: unknown[] | Record<string, unknown>,
): Promise<T> {
  const [results] = await getPool().execute(sql, params as never);
  return results as T;
}

export type SqlExecutor = typeof query;

export async function withTransaction<T>(work: (exec: SqlExecutor) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  const exec: SqlExecutor = async <R = unknown>(sql: string, params?: unknown[] | Record<string, unknown>) => {
    const [results] = await conn.execute(sql, params as never);
    return results as R;
  };

  await conn.beginTransaction();
  try {
    const result = await work(exec);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function withNamedLock<T>(
  name: string,
  timeoutSeconds: number,
  work: () => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection();
  const lockName = name.slice(0, 64);
  try {
    const [rows] = await conn.execute(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [lockName, timeoutSeconds],
    ) as [Array<{ acquired: number | string | null }>, unknown];
    if (Number(rows?.[0]?.acquired) !== 1) {
      throw new Error(`Could not acquire lock ${lockName}`);
    }
    try {
      return await work();
    } finally {
      await conn.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]).catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}
