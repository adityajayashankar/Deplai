-- Migrate paid-plan bonus credits from legacy user ledgers into organization wallets.
USE deplai;

INSERT IGNORE INTO organization_credit_grants
  (id, organization_id, granted_to_user_id, source_type, source_id, idempotency_key, catalog_version,
   granted_units, remaining_units, provider_budget_paise, sandbox, expires_at)
SELECT UUID(), o.id, l.user_id, 'migration', l.id, CONCAT('legacy-bonus:', l.id), 'v2-inr-2026-09',
       l.bonus_credits_remaining * 1000000, l.bonus_credits_remaining * 1000000,
       l.bonus_credits_remaining * 1300, 0, NULL
FROM credit_ledgers l
JOIN organizations o ON o.owner_user_id = l.user_id AND o.slug LIKE 'personal-%'
WHERE l.bonus_credits_remaining > 0
  AND l.plan_id <> 'free'
  AND EXISTS (
    SELECT 1 FROM credit_transactions t
    WHERE t.ledger_id = l.id
      AND t.source NOT LIKE 'free_tier_grant%'
      AND t.source NOT LIKE 'cycle:%free%'
  );

UPDATE organization_credit_wallets w
JOIN (
  SELECT o.id AS organization_id, SUM(l.bonus_credits_remaining) * 1000000 AS bonus_units
  FROM credit_ledgers l
  JOIN organizations o ON o.owner_user_id = l.user_id AND o.slug LIKE 'personal-%'
  WHERE l.bonus_credits_remaining > 0
    AND l.plan_id <> 'free'
    AND EXISTS (
      SELECT 1 FROM credit_transactions t
      WHERE t.ledger_id = l.id
        AND t.source NOT LIKE 'free_tier_grant%'
        AND t.source NOT LIKE 'cycle:%free%'
    )
  GROUP BY o.id
) bonus ON bonus.organization_id = w.organization_id
SET w.balance_units = w.balance_units + bonus.bonus_units,
    w.lifetime_granted_units = w.lifetime_granted_units + bonus.bonus_units;
