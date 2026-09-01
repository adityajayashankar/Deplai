-- Refresh subscription plan marketing copy (descriptions + feature bullets).
-- Starter/Pro runtime copy is sourced from credit-catalog.ts; this keeps DB seeds aligned.

UPDATE billing_plans SET
  description = 'Go from repo connect to approved AWS deploy without stitching scanners, agents, and Terraform yourself',
  bonus_terms_copy = 'Managed-LLM credits never expire. Annual credits are released monthly.',
  features_json = '["Security Agent: SAST, dependency scans, and AI remediation","Terraform generation with plan review before every apply","DeplAI-managed LLMs — no vendor API keys required","Unlimited projects and deployment pipelines","Organization workspace to share with collaborators","Email support when something blocks your release"]'
WHERE id = 'starter_20';

UPDATE billing_plans SET
  description = 'For teams that need design iteration, fix velocity, and deploy confidence in one place',
  bonus_terms_copy = 'Managed-LLM credits never expire. Annual credits are released monthly.',
  features_json = '["Everything in Starter","UI/UX customizer for safe, frontend-only design changes","Guided vulnerability fixes with human review gates","Traffic-aware AWS cost estimates before infrastructure applies","Priority support for production incidents","Organization roles, teams, and shared billing context"]'
WHERE id = 'pro_50';

UPDATE billing_plans SET
  description = 'For organizations that need governance, procurement fit, and predictable capacity at scale',
  bonus_terms_copy = 'Credits and seats are provisioned from your contract. We align allotments to how your teams actually ship.',
  features_json = '["Everything in Pro","Pooled credits across seats and business units","Custom contracts, GST invoicing, and procurement workflows","Security policies, audit logs, and deployment evidence gates","Dedicated support channel with agreed response times","Onboarding and architecture review with the DeplAI team"]'
WHERE id = 'enterprise';
