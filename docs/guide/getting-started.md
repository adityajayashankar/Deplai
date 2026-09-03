# DeplAI in 5 minutes

This quickstart creates a project, establishes repository evidence, and shows where customization, security, and deployment branch from that shared context.

## Before you begin

You need a GitHub account and either a repository you may grant to the DeplAI GitHub App or a ZIP archive you are authorized to upload. Deployment additionally needs an AWS account and suitably scoped credentials. Model-assisted steps need platform access or a valid BYOK credential.

## 1. Sign in

Choose **Continue with GitHub**. GitHub OAuth supplies identity, profile, email, and organization membership. It does not grant repository write access.

If sign-in loops or returns an error, see [Authentication failures](troubleshooting.md#authentication-and-session).

## 2. Connect or upload source

Open the project picker.

- For GitHub, install the DeplAI GitHub App and grant only the repositories you want DeplAI to use.
- For a local project, upload a ZIP. DeplAI extracts it into a user-scoped workspace.

Select the resulting project before starting a service. If a GitHub repository is missing, refresh the installation and confirm the repository grant.

## 3. Establish repository context

Deploy runs repository analysis as part of its planning path. Other services inspect the source they need. Repository analysis looks for languages, dependency manifests, frameworks, services, data stores, build and start commands, containers, CI, health signals, environment-variable names, and existing infrastructure.

Conflicting or low-confidence evidence should be reviewed. The analyzer reports signals; it does not know undeclared operational requirements.

## 4. Choose an outcome

| Goal | Start here | First useful output |
| --- | --- | --- |
| Restyle a frontend | **Services -> UI/UX customizer** | Structured manifest and proposed frontend changes |
| Assess source and dependencies | **Services -> Security Agent** | Normalized findings and scan evidence |
| Test a running application | **Services -> DAST** | Findings from a verified HTTP target |
| Plan AWS infrastructure | **Services -> Deploy** | Repository context, review questions, architecture options, and estimate |
| Review prior work | **Services -> Sessions** | Durable status, stage, metadata, and logs |

These workflows are independent. Run only those relevant to your goal.

## 5. Configure model access when requested

Choose one access mode:

| Mode | Use when |
| --- | --- |
| **Platform** | Your plan includes an appropriate model and you want DeplAI to manage provider credentials. |
| **BYOK** | You want calls billed by your provider account or need a model available through your own key. |
| **Auto** | You want a valid BYOK credential preferred when available, with platform fallback where policy permits. |

Add and validate provider keys under **BYOK -> Keys**. Never paste an AWS key, GitHub token, or database password into a model-key field.

## 6. Review before mutation

Security remediation and customization produce changes for review. Deployment shows architecture, cost, Terraform, and plan stages before apply. Read the output at the boundary where it will change source or cloud state.

For a first run:

1. Use a non-production project or branch.
2. Run the smallest relevant scan or workflow.
3. Inspect skipped modules and warnings, not only failures.
4. Review every proposed diff or Terraform plan.
5. Use staging for the first application deployment.
6. Confirm bootstrap and HTTP health before declaring the application live.

## 7. Inspect the durable record

Open **Sessions** after the run. A `needs_review` session is waiting for a human decision, not failed. A completed infrastructure action may still require application health verification in the deployment surface.

## Quick decision guide

| Question | Answer |
| --- | --- |
| SAST or DAST? | Start with SAST for source evidence; add DAST for an authorized running target. |
| Scan or remediation? | Scan establishes evidence; remediation proposes source changes for selected findings. |
| Retry or restart? | Retry a transient failed stage when context and inputs remain valid. Restart when source, credentials, policy, or architecture decisions changed. |
| BYOK or platform? | BYOK for provider control and direct billing; platform for managed access within plan limits. |
| Development or production? | Validate in development/staging first; production needs tighter permissions, review, backups, and health gates. |

Related: [How it works](how-it-works.md) | [Security Agent](agents/security-agent.md) | [Deploy](agents/deploy.md) | [Troubleshooting](troubleshooting.md)
