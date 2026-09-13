-- Pricing v4: align the live INR catalog with the Rs. 499 Starter, Rs. 999 Pro,
-- and Rs. 399 25-credit top-up pricing. Annual totals preserve the advertised
-- roughly 10% saving relative to twelve monthly payments.
USE deplai;

UPDATE billing_plans
SET price_cents = 499, yearly_price_cents = 5399
WHERE id = 'starter_20';

UPDATE billing_plans
SET price_cents = 999, yearly_price_cents = 10799
WHERE id = 'pro_50';

UPDATE credit_packs
SET name = '25 credit top-up', credit_amount = 25, price_cents = 399, paid_tiers_only = 1
WHERE id = 'topup_100_v2';
