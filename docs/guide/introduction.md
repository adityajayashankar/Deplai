# Introduction

DeplAI is a workspace that takes one application — a GitHub repository you authorize, or a ZIP you upload — through security review, optional source fixes, frontend-only UI changes, and an AWS deploy that does not run until you confirm the Terraform plan.

It exists because those steps usually live in different tools. A scan report sits in one place, a pull request in another, architecture notes in a third, and `terraform apply` in a fourth. Context drops between them. DeplAI keeps the work on one **project**, owned by the GitHub account you signed in with.

You stay in control of anything that mutates source or cloud:

- Security Agent proposes diffs; **Review** is the gate before they persist, and **GitHub & verify** is how a pull request is opened.
- UI/UX customizer edits frontend files only. It identifies business-logic boundaries and fails a run if those files change.
- Deploy generates Terraform, shows a plan, and waits until you confirm before apply.

DeplAI is not a managed cloud account and not the source of record. GitHub remains the repository of record. The AWS account you point Deploy at remains the account of record. LLM calls can use DeplAI platform credentials (gated by your plan) or **BYOK** keys you store under **BYOK → Credentials**.

**Who it is for.** A team that already has an application and wants a repeatable path: connect the repo, scan it, optionally fix what the scanners found, optionally restyle the frontend, then generate and apply AWS infrastructure with a human confirmation in between.

Related: [Core concepts](concepts.md) · [How it works](how-it-works.md) · [Getting started](getting-started.md)
