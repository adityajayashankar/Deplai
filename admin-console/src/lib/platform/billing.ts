import { query } from '@/lib/db';

export type DashboardMetrics = {
  totalUsers: number;
  newUsers7d: number;
  totalOrganizations: number;
  totalProjects: number;
  activeSubscriptions: number;
  capturedPayments30d: number;
  refunds30d: number;
  recentSignups: Array<{ id: string; email: string; createdAt: string }>;
  recentPayments: Array<{ id: string; amountPaise: number; status: string; createdAt: string }>;
  recentAudit: Array<{ id: string; action: string; createdAt: string }>;
};

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const [
    userCount,
    newUsers,
    orgCount,
    projectCount,
    activeSubs,
    payments30d,
    refunds30d,
    recentSignups,
    recentPayments,
    recentAudit,
  ] = await Promise.all([
    query<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM users`),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    ),
    query<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM organizations WHERE status = 'ACTIVE'`),
    query<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM projects`),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM billing_subscriptions WHERE status IN ('active', 'authenticated', 'trialing')`,
    ),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM billing_checkout_intents
       WHERE status IN ('captured', 'paid', 'refunded', 'partially_refunded')
         AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    ),
    query<Array<{ count: number }>>(
      `SELECT COUNT(*) AS count FROM billing_refunds
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status <> 'failed'`,
    ),
    query<Array<{ id: string; email: string; created_at: Date | string }>>(
      `SELECT id, email, created_at FROM users ORDER BY created_at DESC LIMIT 8`,
    ),
    query<Array<{ id: string; total_paise: number; status: string; created_at: Date | string }>>(
      `SELECT id, total_paise, status, created_at
       FROM billing_checkout_intents
       WHERE status IN ('captured', 'paid', 'refunded', 'partially_refunded')
       ORDER BY created_at DESC LIMIT 8`,
    ),
    query<Array<{ id: string; action: string; created_at: Date | string }>>(
      `SELECT id, action, created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT 8`,
    ),
  ]);

  return {
    totalUsers: Number(userCount[0]?.count || 0),
    newUsers7d: Number(newUsers[0]?.count || 0),
    totalOrganizations: Number(orgCount[0]?.count || 0),
    totalProjects: Number(projectCount[0]?.count || 0),
    activeSubscriptions: Number(activeSubs[0]?.count || 0),
    capturedPayments30d: Number(payments30d[0]?.count || 0),
    refunds30d: Number(refunds30d[0]?.count || 0),
    recentSignups: recentSignups.map((row) => ({
      id: row.id,
      email: row.email,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    recentPayments: recentPayments.map((row) => ({
      id: row.id,
      amountPaise: Number(row.total_paise || 0),
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    recentAudit: recentAudit.map((row) => ({
      id: row.id,
      action: row.action,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export type PaymentListItem = {
  id: string;
  userEmail: string;
  organizationName: string | null;
  totalPaise: number;
  status: string;
  paymentMode: string;
  razorpayPaymentId: string | null;
  createdAt: string;
};

export async function listPayments(input: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ payments: PaymentListItem[]; total: number }> {
  const limit = Math.min(Math.max(input.limit || 50, 1), 100);
  const offset = Math.max(input.offset || 0, 0);
  const search = input.search?.trim().toLowerCase() || '';
  const params: unknown[] = [];
  let where = `ci.status IN ('captured', 'paid', 'refunded', 'partially_refunded', 'refund_pending')`;
  if (search) {
    where += ' AND (ci.id LIKE ? OR ci.razorpay_payment_id LIKE ? OR LOWER(u.email) LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const countRows = await query<Array<{ total: number }>>(
    `SELECT COUNT(*) AS total
     FROM billing_checkout_intents ci
     JOIN users u ON u.id = ci.user_id
     WHERE ${where}`,
    params,
  );

  const rows = await query<Array<{
    id: string;
    user_email: string;
    organization_name: string | null;
    total_paise: number;
    status: string;
    payment_mode: string;
    razorpay_payment_id: string | null;
    created_at: Date | string;
  }>>(
    `SELECT ci.id, u.email AS user_email, o.name AS organization_name, ci.total_paise, ci.status,
            ci.payment_mode, ci.razorpay_payment_id, ci.created_at
     FROM billing_checkout_intents ci
     JOIN users u ON u.id = ci.user_id
     LEFT JOIN organizations o ON o.id = ci.organization_id
     WHERE ${where}
     ORDER BY ci.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total: Number(countRows[0]?.total || 0),
    payments: rows.map((row) => ({
      id: row.id,
      userEmail: row.user_email,
      organizationName: row.organization_name,
      totalPaise: Number(row.total_paise || 0),
      status: row.status,
      paymentMode: row.payment_mode,
      razorpayPaymentId: row.razorpay_payment_id,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function getPaymentDetail(paymentId: string) {
  const rows = await query<Array<{
    id: string;
    user_email: string;
    total_paise: number;
    status: string;
    payment_mode: string;
    razorpay_payment_id: string | null;
    created_at: Date | string;
    kind: string;
  }>>(
    `SELECT ci.id, u.email AS user_email, ci.total_paise, ci.status, ci.payment_mode,
            ci.razorpay_payment_id, ci.created_at, ci.kind
     FROM billing_checkout_intents ci
     JOIN users u ON u.id = ci.user_id
     WHERE ci.id = ?
     LIMIT 1`,
    [paymentId],
  );
  const row = rows[0];
  if (!row) return null;

  const refundedRows = await query<Array<{ total: number }>>(
    `SELECT COALESCE(SUM(amount_paise), 0) AS total
     FROM billing_refunds WHERE checkout_intent_id = ? AND status <> 'failed'`,
    [paymentId],
  );

  return {
    id: row.id,
    userEmail: row.user_email,
    totalPaise: Number(row.total_paise || 0),
    refundedPaise: Number(refundedRows[0]?.total || 0),
    status: row.status,
    paymentMode: row.payment_mode,
    razorpayPaymentId: row.razorpay_payment_id,
    kind: row.kind,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
