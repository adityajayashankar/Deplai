# Introduction

DeplAI is an application delivery workspace: connect a **GitHub repository** or **ZIP**, run security and dynamic testing, optionally fix findings and restyle the frontend, generate AWS infrastructure as Terraform, and apply only after you confirm the plan.

Those steps usually live in different tools—a scanner, a PR bot, a diagram, and a terminal. Context drops between them. DeplAI keeps work on one **project** (and optionally one **organization**) with explicit human gates before anything mutates source or cloud.

## What you control

| Action | Gate |
| --- | --- |
| Source fixes from Security Agent | **Review** before persist; **GitHub & verify** for pull requests. |
| Frontend changes | UI/UX customizer is frontend-only; business-logic files fail **Functional safety**. |
| Cloud changes | Deploy shows a Terraform **plan**; **no apply** until you confirm. |
| Dynamic testing | DAST runs only against **verified** targets you authorize. |
| Model calls | **Platform** credits or **BYOK** keys you store; routing on **Your Profile**. |

DeplAI is not a managed cloud account. **GitHub** remains the repository of record. **Your AWS account** remains the infrastructure of record. DeplAI orchestrates; you approve.

## Who it is for

- **Developers** shipping features who want scan → fix → PR in one flow.
- **DevOps / platform** teams generating Terraform and operating instances after apply.
- **Security** teams requiring SAST, SCA, secrets, and DAST evidence before production.
- **Admins** governing members, roles, billing, and audit in **Organizations**.

## Where to go next

| Goal | Start here |
| --- | --- |
| First scan in 10 minutes | [Getting started](getting-started.md) |
| Team setup | [Organizations](organizations.md) |
| Plans and Razorpay checkout | [Billing](billing.md) |
| Keys and data handling | [Security and data](security-and-data.md) |

Related: [Core concepts](concepts.md) · [How it works](how-it-works.md)
