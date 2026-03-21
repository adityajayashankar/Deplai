import mysql from 'mysql2/promise';

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = Number(process.env.DB_PORT || 3306);

const pool = mysql.createPool({
  host: dbHost,
  port: Number.isFinite(dbPort) ? dbPort : 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'deplai',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function query<T = unknown>(
  sql: string,
  params?: unknown[] | Record<string, unknown>
): Promise<T> {
  try {
    const [results] = await pool.execute(sql, params as never);
    return results as T;
  } catch (error: unknown) {
    const dbError = error as {
      code?: string;
      errno?: number;
      sql?: string;
      sqlState?: string;
      sqlMessage?: string;
    };
    // Add host/port context so ECONNREFUSED diagnostics are actionable.
    if (dbError?.code) {
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
      throw wrapped;
    }
    throw error;
  }
}

export default pool;
