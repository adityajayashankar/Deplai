# Billing (Razorpay + credits)

Live checkout is **Razorpay**. Stripe tables/columns and `Connector/src/lib/billing/stripe.ts` remain in the tree but are unused. UI prices are **USD**; charges are **INR** at `RAZORPAY_USD_TO_INR` (default 83) plus GST (`BILLING_GST_RATE`, default 18). SAC `998314`. Invoice prefix `DPL`.

Seller snapshot: `BILLING_LEGAL_NAME`, `BILLING_GSTIN`, `BILLING_ADDRESS`, `BILLING_STATE_NAME` / `BILLING_STATE_CODE`. Buyer GSTIN on `billing_profiles`. Do not commit a real GSTIN.

## Plans (`FALLBACK_PLANS` / `billing_plans` seed)

| Id | Display | USD / mo | Yearly | Paid credits | Bonus | Paid rollover |
| --- | --- | --- | --- | --- | --- | --- |
| `free` | Free | $0 | — | 5 | none | 0 months |
| `starter_20` | Starter | $20 | $192 | 20 | 25% after paid hits 0 | 1 month |
| `pro_50` | Pro | $50 | $480 | 50 | 40% after paid hits 0 | 2 months |
| `enterprise` | Enterprise | custom | — | contract | contract | contract |

Packs (`paidTiersOnly: true`, Free excluded): 10 / $12, 25 / $32, 50 / $70.

## Ledger rules (`credits-policy.ts`)

- Consume **paid first**, then bonus.
- Bonus **unlocks** when paid remaining hits 0 (not on Free). Expires **UTC calendar month-end**. Never rolls over.
- Paid rollover is capped: `min(unusedPaid, monthlyPaid * rolloverMonthsCap)`.
- Upgrade mid-cycle uses `proratePaidDelta`.
- Types: `grant_paid`, `grant_bonus`, `consume`, `expire`, `rollover`, `refund`.

`POST /api/billing/credits/consume` implements the organization ledger and returns 402 when empty. Product outcomes settle through the internal service-key route `POST /api/billing/product-usage/settle`; every debit is idempotent by run, or by project and UTC day for deployments.

- A successful non-DAST security scan consumes 0.50 credit. Failed scans consume 0.
- A successful DAST run consumes 1.00 credit. A DAST-only request does not also incur the base scan rate.
- Successful remediation and verified UI/UX runs consume token-based usage at `DEPLAI_DYNAMIC_CREDITS_PER_MILLION_TOKENS` (default 1 credit per reported million tokens, rounded up to 0.01). Failed remediation consumes 0.50 credit; failed UI/UX consumes 0.
- A verified deployment consumes 3.00 credits once per project per UTC day. Terraform completion without bootstrap and endpoint verification is not billable.

The AI gateway continues to store token/USD spend in `ai_usage` / `ai_costs`; product-usage settlement is the organization credit ledger for these workflows.

`POST /api/billing/credits/expire` is service-key (cron-style). `POST /api/billing/credits/admin-grant` is admin.

## HTTP (Connector)

| Route | Role |
| --- | --- |
| `/api/billing/plans` | Catalog |
| `/api/billing/checkout`, `/api/create-order` | Razorpay order |
| `/api/billing/verify-payment`, `/api/verify-payment` | Client verify |
| `/api/webhooks/razorpay` (and `src/app/webhooks/razorpay`) | Webhook |
| `/api/billing/credits/balance` | Ledger snapshot |
| `/api/billing/credits/topup`, `/api/billing/auto-topup` | Packs / auto top-up |
| `/api/billing/promo/redeem` | Promo codes |
| `/api/billing/invoices`, `/api/billing/invoices/[id]/pdf` | GST invoices |
| `/api/webhooks/stripe` | Leftover — unused |

## Auto top-up units

Profile fields `auto_topup_threshold_usd` / `auto_topup_add_usd` are **USD**, not credit counts. UI: “when your balance falls below $N”.

Related: [AI platform](ai-platform.md) · [Data model](data-model.md) · [Known gaps](known-gaps.md)
