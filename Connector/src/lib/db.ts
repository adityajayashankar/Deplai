import mysql from 'mysql2/promise';

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = Number(process.env.DB_PORT || 3306);
const connectionLimit = Math.max(1, Number(process.env.DB_POOL_SIZE || 5));

type GlobalMysql = typeof globalThis & {
  __deplaiMysqlPool?: mysql.Pool;
};

const globalForMysql = globalThis as GlobalMysql;

function createPool() {
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
  if (!globalForMysql.__deplaiMysqlPool) {
    globalForMysql.__deplaiMysqlPool = createPool();
  }
  return globalForMysql.__deplaiMysqlPool;
}

function isRetryableMysql(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'ER_CON_COUNT_ERROR' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'ECONNRESET';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function query<T = unknown>(
  sql: string,
  params?: unknown[] | Record<string, unknown>
): Promise<T> {
  const [results] = await executeWithRetry(() => getPool().execute(sql, params as never));
  return results as T;
}

export type SqlExecutor = typeof query;

async function getPoolConnection() {
  return executeWithRetry(() => getPool().getConnection());
}

export async function withNamedLock<T>(
  name: string,
  timeoutSeconds: number,
  work: () => Promise<T>,
): Promise<T> {
  const conn = await getPoolConnection();
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

export async function withTransaction<T>(work: (exec: SqlExecutor) => Promise<T>): Promise<T> {
  const conn = await getPoolConnection();
  const exec: SqlExecutor = async <R = unknown>(
    sql: string,
    params?: unknown[] | Record<string, unknown>,
  ) => {
    try {
      const [results] = await conn.execute(sql, params as never);
      return results as R;
    } catch (error: unknown) {
      throw wrapMysqlError(error);
    }
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

async function executeWithRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (!isRetryableMysql(error)) throw wrapMysqlError(error);
    await sleep(200);
    try {
      return await work();
    } catch (retryError: unknown) {
      throw wrapMysqlError(retryError);
    }
  }
}

function wrapMysqlError(error: unknown): Error {
  const dbError = error as {
    code?: string;
    errno?: number;
    sql?: string;
    sqlState?: string;
    sqlMessage?: string;
  };
  if (!dbError?.code) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const wrapped = new Error(
    `MySQL query failed (${dbError.code}) at ${dbHost}:${Number.isFinite(dbPort) ? dbPort : 3306}`
  ) as Error & {
    code?: string;
    errno?: number;
    sql?: string;
    sqlState?: string;
    sqlMessage?: string;
    cause?: unknown;
  };
  wrapped.code = dbError.code;
  wrapped.errno = dbError.errno;
  wrapped.sql = dbError.sql;
  wrapped.sqlState = dbError.sqlState;
  wrapped.sqlMessage = dbError.sqlMessage;
  wrapped.cause = error;
  return wrapped;
}

export default {
  execute: (...args: Parameters<mysql.Pool['execute']>) => getPool().execute(...args),
  getConnection: () => getPool().getConnection(),
  end: () => globalForMysql.__deplaiMysqlPool?.end(),
};
