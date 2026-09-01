# Plans, credits, and billing

DeplAI charges a **subscription** (Free / Starter / Pro / Enterprise) and grants **credits** each calendar month (UTC). Extra packs and plan upgrades checkout through **Razorpay** in **INR**, including **18% GST** on the taxable amount.

All billing UI is unified under **Account → Billing** (`/dashboard/billing`). Legacy routes `/dashboard/subscription` and `/dashboard/payment` redirect here.

## Billing page layout

| Tab | URL | Purpose |
| --- | --- | --- |
| **Plans** | `/dashboard/billing` | Compare plans, monthly/yearly toggle, Razorpay checkout. |
| **Credit packs** | `/dashboard/billing?view=credits` | One-time credit top-ups (paid plans). |

Related account pages:

| Page | Path | Notes |
| --- | --- | --- |
| **Invoices** | `/dashboard/invoices` | PDF downloads after successful payment. |
| **Credits** | `/dashboard/credits` | Standalone credit balance view; packs also on Billing tab. |
| **Your Profile** | `/profile` | Balance, promo codes, auto top-up, routing. |

## Checkout and pricing

Catalog prices are authoritative in **INR paise** and already include **18% GST**. The Razorpay modal and invoice use the same server-calculated INR total; the USD market comparison is marketing context only.

| Display | Meaning |
| --- | --- |
| INR on plan cards | GST-inclusive catalog price and new-credit grant. |
| INR at checkout | The same server-calculated amount Razorpay charges. |
| Invoice PDF | Authoritative record of what was paid, including tax split (CGST/SGST or IGST). |

**Enterprise** is contract-only—email `founders@deplai.tech`; it does not use self-serve checkout.

### Test mode

When the workspace runs Razorpay in test configuration, checkout may charge a **₹1** test amount while still displaying the real catalog price. A banner on **Billing** indicates test mode. Production workspaces charge the quoted INR total.

After payment, credits and plan status update when Razorpay verification completes. A success message links to **Invoices**.

## Plans

| Plan | GST-inclusive list price (INR) | Managed credits | Bonus | Expiry |
| --- | --- | --- | --- | --- |
| **Free** | ₹0 | 0 | None | — |
| **Starter** | ₹599/mo or ₹6,499/yr | 25/month; 300/yr, released monthly | None | Never |
| **Pro** | ₹1,399/mo or ₹15,199/yr | 62.5/month; 750/yr, released monthly | None | Never |
| **Enterprise** | Contract | From contract | Contract | Contract |

Yearly billing shows a **Save ~10%** badge versus twelve monthly payments.

### Plan features (marketing summary)

| Plan | Included highlights |
| --- | --- |
| Free | 1 project, repo analysis, basic security scan, community support |
| Starter | Unlimited projects, security scanning, Terraform generation, email support |
| Pro | Everything in Starter, frontend customizations, vulnerability fixes, traffic-based cost estimation, priority support |
| Enterprise | Everything in Pro, custom contracts, pooled credits, dedicated support, SLA |

**Platform models:** Free may use **Best fast** and **Best cost**. Starter and above unlock the full platform catalog (**Best coding**, **Best reasoning**, …). BYOK keys are not limited by that list—see [Security and data](security-and-data.md).

If **Billing** shows different numbers than this guide, the in-app values from your database win.

## What a credit is

Credits belong to the active organization, are shared by authorized members, and never expire. A displayed credit represents **₹13 of actual managed-LLM provider usage**. Credits use fractional internal units so each call is charged from recorded provider pricing and FX, rounded up only at the internal-unit boundary.

| Source | Credits | Provider-usage value |
| --- | --- | --- |
| Starter monthly grant | 25 | ₹325 |
| Pro monthly grant | 62.5 | ₹812.50 |
| Credit top-up | 25 | ₹325 |

Empty balance blocks managed platform-model calls until you upgrade or buy a pack. BYOK calls use your provider account and consume no DeplAI credits.

There are no bonus credits or rollover rules in this catalog because all paid credits already remain available until consumed. Yearly plans release their grant monthly.

## Credit packs

Available on **Billing → Credit packs** (paid plans only):

| Pack | GST-inclusive INR price | Credits added |
| --- | --- | --- |
| 25 credit top-up | ₹562.25 | 25 |

Packs add never-expiring organization credits. Checkout uses the same Razorpay INR + GST flow as subscriptions.

**Your Profile** also supports promo codes and **auto top-up** when balance falls below a USD threshold.

## Credits vs BYOK vs AWS

| Meter | Where | What it measures |
| --- | --- | --- |
| Credits | **Billing**, **Profile**, model picker | Platform model entitlement and consumption against plan/packs. |
| BYOK usage | **BYOK → Usage** | LLM tokens and requests, platform vs your keys. |
| AWS | Your AWS bill | EC2, RDS, S3, etc. from **Deploy**—not DeplAI credits. |

## Invoices and refunds

**Invoices** lists subscription and pack payments. Download PDFs for accounting.

Refund requests for eligible payments may be handled by admins; organization **Billing Admin** role has `billing.refund` where enabled. Contact `support@deplai.tech` if a payment succeeded but credits did not appear after several minutes.

## Organization billing

Organization **Billing & usage** shows plan summary for the active org. Checkout remains on the member’s **Billing** page unless your enterprise contract specifies pooled billing. See [Organizations](organizations.md).

Related: [Profile, usage, and invoices](profile-usage-and-invoices.md) · [BYOK](security-and-data.md) · [Core concepts](concepts.md)
