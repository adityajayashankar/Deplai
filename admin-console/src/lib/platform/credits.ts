import { randomUUID } from 'node:crypto';
import { query, withTransaction, type SqlExecutor } from '@/lib/db';
import {
  CREDIT_CATALOG_VERSION,
  CREDIT_VALUE_PAISE,
  creditsToUnits,
  unitsToCredits,
} from '@/lib/platform/credit-catalog';

export type OrganizationCreditBalance = {
  organizationId: string;
  availableUnits: bigint;
  reservedUnits: bigint;
  balanceUnits: bigint;
  lifetimeGrantedUnits: bigint;
  lifetimeConsumedUnits: bigint;
  lifetimeRefundedUnits: bigint;
  debtUnits: bigint;
  status: 'ACTIVE' | 'DEBT' | 'FROZEN';
};

type WalletRow = {
  organization_id: string;
  balance_units: string | number;
  reserved_units: string | number;
  lifetime_granted_units: string | number;
  lifetime_consumed_units: string | number;
  lifetime_refunded_units: string | number;
  debt_units: string | number;
  status: OrganizationCreditBalance['status'];
};

function toBigInt(value: bigint | number | string | null | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (value == null || value === '') return 0n;
  return BigInt(String(value));
}

function mapWallet(row: WalletRow): OrganizationCreditBalance {
  const balanceUnits = toBigInt(row.balance_units);
  const reservedUnits = toBigInt(row.reserved_units);
  return {
    organizationId: row.organization_id,
    balanceUnits,
    reservedUnits,
    availableUnits: balanceUnits - reservedUnits,
    lifetimeGrantedUnits: toBigInt(row.lifetime_granted_units),
    lifetimeConsumedUnits: toBigInt(row.lifetime_consumed_units),
    lifetimeRefundedUnits: toBigInt(row.lifetime_refunded_units),
    debtUnits: toBigInt(row.debt_units),
    status: row.status,
  };
}

async function ensureWallet(exec: SqlExecutor, organizationId: string) {
  await exec(`INSERT IGNORE INTO organization_credit_wallets (organization_id) VALUES (?)`, [organizationId]);
}

async function consumeGrantLots(exec: SqlExecutor, organizationId: string, units: bigint) {
  let remaining = units;
  const lots = await exec<Array<{ id: string; remaining_units: string | number }>>(
    `SELECT id, remaining_units FROM organization_credit_grants
     WHERE organization_id = ? AND remaining_units > 0
     ORDER BY created_at ASC FOR UPDATE`,
    [organizationId],
  );
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const lotRemaining = toBigInt(lot.remaining_units);
    const take = lotRemaining < remaining ? lotRemaining : remaining;
    await exec(
      `UPDATE organization_credit_grants SET remaining_units = remaining_units - ? WHERE id = ?`,
      [take.toString(), lot.id],
    );
    remaining -= take;
  }
}

export async function getOrganizationCreditBalance(organizationId: string): Promise<OrganizationCreditBalance> {
  await ensureWallet(query, organizationId);
  const rows = await query<WalletRow[]>(
    `SELECT organization_id, balance_units, reserved_units, lifetime_granted_units,
            lifetime_consumed_units, lifetime_refunded_units, debt_units, status
     FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
    [organizationId],
  );
  if (!rows[0]) throw new Error('Organization credit wallet is unavailable');
  return mapWallet(rows[0]);
}

export async function grantOrganizationCredits(input: {
  organizationId: string;
  userId?: string | null;
  credits: number;
  sourceType: 'admin' | 'promotion';
  sourceId?: string | null;
  idempotencyKey: string;
}): Promise<{ grantId: string; balance: OrganizationCreditBalance }> {
  const units = creditsToUnits(input.credits);
  if (units <= 0n) throw new Error('Credit grant must be positive');
  const grantId = randomUUID();

  return withTransaction(async (exec) => {
    await ensureWallet(exec, input.organizationId);
    const duplicate = await exec<Array<{ id: string }>>(
      `SELECT id FROM organization_credit_grants WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.organizationId, input.idempotencyKey],
    );
    if (duplicate[0]) {
      const wallet = await exec<WalletRow[]>(
        `SELECT * FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
        [input.organizationId],
      );
      return { grantId: duplicate[0].id, balance: mapWallet(wallet[0]) };
    }

    await exec(
      `INSERT INTO organization_credit_grants (
         id, organization_id, granted_to_user_id, source_type, source_id, idempotency_key,
         catalog_version, granted_units, remaining_units, provider_budget_paise, sandbox, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      [
        grantId,
        input.organizationId,
        input.userId || null,
        input.sourceType,
        input.sourceId || null,
        input.idempotencyKey,
        CREDIT_CATALOG_VERSION,
        units.toString(),
        units.toString(),
        Math.round(input.credits * CREDIT_VALUE_PAISE),
      ],
    );
    await exec(
      `UPDATE organization_credit_wallets
       SET balance_units = balance_units + ?, lifetime_granted_units = lifetime_granted_units + ?,
           debt_units = GREATEST(0, debt_units - ?),
           status = CASE WHEN debt_units <= ? AND balance_units + ? >= 0 AND status = 'DEBT' THEN 'ACTIVE' ELSE status END,
           version = version + 1
       WHERE organization_id = ?`,
      [units.toString(), units.toString(), units.toString(), units.toString(), units.toString(), input.organizationId],
    );
    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, grant_id, type, amount_units, balance_after_units,
         reserved_after_units, idempotency_key, source, metadata_json
       ) VALUES (?, ?, ?, ?, 'GRANT', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.organizationId,
        input.userId || null,
        grantId,
        units.toString(),
        wallet.balanceUnits.toString(),
        wallet.reservedUnits.toString(),
        `grant:${input.idempotencyKey}`,
        input.sourceType,
        JSON.stringify({ sourceId: input.sourceId || null, credits: input.credits, adminConsole: true }),
      ],
    );
    return { grantId, balance: wallet };
  });
}

export async function debitOrganizationCredits(input: {
  organizationId: string;
  userId?: string | null;
  credits: number;
  source: string;
  idempotencyKey: string;
}): Promise<{ available: number; debited: number }> {
  const units = creditsToUnits(input.credits);
  if (units <= 0n) throw new Error('Debit must be positive');

  return withTransaction(async (exec) => {
    const duplicate = await exec<Array<{ id: string }>>(
      `SELECT id FROM organization_credit_transactions
       WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.organizationId, input.idempotencyKey],
    );
    if (duplicate[0]) {
      const wallet = await exec<WalletRow[]>(
        `SELECT * FROM organization_credit_wallets WHERE organization_id = ? LIMIT 1`,
        [input.organizationId],
      );
      return {
        available: unitsToCredits(mapWallet(wallet[0]).availableUnits),
        debited: unitsToCredits(units),
      };
    }

    await ensureWallet(exec, input.organizationId);
    const walletRows = await exec<WalletRow[]>(
      `SELECT * FROM organization_credit_wallets WHERE organization_id = ? FOR UPDATE`,
      [input.organizationId],
    );
    const wallet = mapWallet(walletRows[0]);
    if (wallet.availableUnits < units) {
      throw new Error(`Insufficient credits: available ${unitsToCredits(wallet.availableUnits)}, requested ${input.credits}`);
    }

    await exec(
      `UPDATE organization_credit_wallets
       SET balance_units = balance_units - ?, lifetime_consumed_units = lifetime_consumed_units + ?,
           status = CASE WHEN balance_units - ? < 0 THEN 'DEBT' ELSE status END,
           version = version + 1
       WHERE organization_id = ?`,
      [units.toString(), units.toString(), units.toString(), input.organizationId],
    );
    await consumeGrantLots(exec, input.organizationId, units);

    const balanceAfter = wallet.balanceUnits - units;
    await exec(
      `INSERT INTO organization_credit_transactions (
         id, organization_id, actor_user_id, type, amount_units, balance_after_units,
         reserved_after_units, idempotency_key, source, metadata_json
       ) VALUES (?, ?, ?, 'CONSUMPTION', ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.organizationId,
        input.userId || null,
        (-units).toString(),
        balanceAfter.toString(),
        wallet.reservedUnits.toString(),
        input.idempotencyKey,
        input.source,
        JSON.stringify({ credits: input.credits, adminConsole: true }),
      ],
    );

    return {
      available: unitsToCredits(balanceAfter - wallet.reservedUnits),
      debited: unitsToCredits(units),
    };
  });
}

export async function setOrganizationWalletStatus(
  organizationId: string,
  status: 'ACTIVE' | 'FROZEN',
): Promise<OrganizationCreditBalance> {
  await query(`UPDATE organization_credit_wallets SET status = ? WHERE organization_id = ?`, [status, organizationId]);
  return getOrganizationCreditBalance(organizationId);
}
