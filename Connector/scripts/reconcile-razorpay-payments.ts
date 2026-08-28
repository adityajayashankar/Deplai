/**
 * Diff captured Razorpay payments against local billing_invoices.
 *
 * Usage:
 *   npx tsx scripts/reconcile-razorpay-payments.ts --from 2026-07-01 --to 2026-08-27
 *   npx tsx scripts/reconcile-razorpay-payments.ts --from 2026-07-01 --to 2026-08-27 --out orphans.json
 *
 * Requires RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and Connector DB env.
 * Does not mutate data. Review orphans with:
 *   POST /api/admin/fulfillments/:paymentId/retry
 *   POST /api/admin/refunds/:paymentId
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import mysql from 'mysql2/promise';

loadEnvConfig(path.resolve(__dirname, '..'));

type Payment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  order_id?: string | null;
  email?: string | null;
  captured?: boolean;
};

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] || null;
}

function toUnix(date: string, endOfDay: boolean): number {
  const parsed = new Date(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date ${date}; use YYYY-MM-DD`);
  }
  return Math.floor(parsed.getTime() / 1000);
}

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() || '';
  const secret = process.env.RAZORPAY_KEY_SECRET?.trim() || '';
  if (!keyId || !secret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required');
  }
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
}

async function listCaptured(fromUnix: number, toUnix: number): Promise<Payment[]> {
  const collected: Payment[] = [];
  let skip = 0;
  const count = 100;
  for (;;) {
    const response = await fetch(
      `https://api.razorpay.com/v1/payments?from=${fromUnix}&to=${toUnix}&count=${count}&skip=${skip}`,
      { headers: { Authorization: authHeader() } },
    );
    const payload = await response.json() as { items?: Payment[]; error?: { description?: string } };
    if (!response.ok) {
      throw new Error(payload.error?.description || `Razorpay list failed (${response.status})`);
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      if (item?.id && (item.status === 'captured' || item.captured)) collected.push(item);
    }
    if (items.length < count) break;
    skip += count;
    if (skip > 10000) break;
  }
  return collected;
}

async function main() {
  const from = argValue('--from');
  const to = argValue('--to');
  const out = argValue('--out');
  if (!from || !to) {
    console.error('Usage: npx tsx scripts/reconcile-razorpay-payments.ts --from YYYY-MM-DD --to YYYY-MM-DD [--out orphans.json]');
    process.exit(1);
  }

  const payments = await listCaptured(toUnix(from, false), toUnix(to, true));
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'deplai',
  });

  try {
    const [rows] = await connection.query(
      `SELECT razorpay_payment_id AS id FROM billing_invoices WHERE razorpay_payment_id IS NOT NULL`,
    ) as [Array<{ id: string }>, unknown];
    const local = new Set(rows.map((row) => row.id));
    const orphans = payments.filter((payment) => !local.has(payment.id)).map((payment) => ({
      razorpay_payment_id: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      order_id: payment.order_id || null,
      email: payment.email || null,
    }));

    const report = {
      from,
      to,
      razorpay_captured: payments.length,
      local_invoices: local.size,
      orphans: orphans.length,
      payments: orphans,
    };
    const encoded = `${JSON.stringify(report, null, 2)}\n`;
    if (out) {
      fs.writeFileSync(path.resolve(out), encoded);
      console.error(`Wrote ${orphans.length} orphan(s) to ${out}`);
    }
    process.stdout.write(encoded);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
