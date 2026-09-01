-- Pricing v3: reduce checkout totals and new credit grants by approximately 75%,
-- then round plan prices to simple customer-facing amounts.
-- Exact authoritative totals remain in credit-catalog.ts (INR paise); these
-- legacy integer display fields are rounded to whole rupees.
USE deplai;

UPDATE billing_plans
SET price_cents = 599, yearly_price_cents = 6499
WHERE id = 'starter_20';

UPDATE billing_plans
SET price_cents = 1399, yearly_price_cents = 15199
WHERE id = 'pro_50';

UPDATE credit_packs
SET name = '25 credit top-up', credit_amount = 25, price_cents = 562, paid_tiers_only = 1
WHERE id = 'topup_100_v2';
