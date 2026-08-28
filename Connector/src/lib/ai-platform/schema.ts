import { query } from '@/lib/db';
import { PROVIDER_DEFINITIONS } from './providers/definitions';
import { SEED_MODELS } from './catalog/seed';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS ai_providers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    documentation_url VARCHAR(512) NOT NULL,
    api_base_url VARCHAR(512) NOT NULL,
    supports_json JSON NOT NULL,
    authentication_type VARCHAR(32) NOT NULL,
    credential_schema_json JSON NOT NULL,
    env_key_names_json JSON NOT NULL,
    brand_color VARCHAR(16) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ai_models (
    id VARCHAR(191) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    provider_model_id VARCHAR(191) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    family VARCHAR(128) NOT NULL,
    version VARCHAR(64) NOT NULL,
    aliases_json JSON NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    lifecycle VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    release_date DATE NULL,
    deprecation_date DATE NULL,
    retirement_date DATE NULL,
    replacement_model_id VARCHAR(191) NULL,
    context_window INT NOT NULL DEFAULT 0,
    max_output_tokens INT NOT NULL DEFAULT 0,
    capabilities_json JSON NOT NULL,
    latency_profile VARCHAR(32) NOT NULL DEFAULT 'balanced',
    pricing_json JSON NOT NULL,
    region_support_json JSON NOT NULL,
    compliance_tags_json JSON NOT NULL,
    model_owner VARCHAR(128) NULL,
    metadata_json JSON NOT NULL,
    discovered_at DATETIME NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_provider_model (provider_id, provider_model_id),
    INDEX idx_ai_models_provider (provider_id),
    INDEX idx_ai_models_lifecycle (lifecycle)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_credentials (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'BYOK',
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    secret_encrypted TEXT NOT NULL,
    secret_masked VARCHAR(32) NOT NULL,
    environment VARCHAR(32) NOT NULL DEFAULT 'production',
    scope VARCHAR(128) NULL,
    allowed_model_ids_json JSON NULL,
    created_by VARCHAR(36) NOT NULL,
    last_validated_at DATETIME NULL,
    last_used_at DATETIME NULL,
    expires_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ai_creds_user (user_id),
    INDEX idx_ai_creds_user_provider (user_id, provider_id),
    CONSTRAINT fk_ai_creds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_routing_policies (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(128) NOT NULL,
    task_type VARCHAR(64) NOT NULL DEFAULT 'general',
    primary_alias VARCHAR(64) NOT NULL DEFAULT 'best',
    secondary_alias VARCHAR(64) NULL,
    fallback_model_id VARCHAR(191) NULL,
    access_mode VARCHAR(16) NOT NULL DEFAULT 'auto',
    allowed_providers_json JSON NOT NULL,
    weights_json JSON NOT NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ai_routing_user (user_id),
    CONSTRAINT fk_ai_routing_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_organization_policies (
    user_id VARCHAR(36) PRIMARY KEY,
    policy_json JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ai_org_policy_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NOT NULL,
    model_id VARCHAR(191) NOT NULL,
    credential_source VARCHAR(32) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cached_tokens INT NOT NULL DEFAULT 0,
    reasoning_tokens INT NOT NULL DEFAULT 0,
    tool_calls INT NOT NULL DEFAULT 0,
    estimated TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_usage_user_created (user_id, created_at),
    CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_costs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    provider_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    platform_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    customer_charge_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
    billing_source VARCHAR(16) NOT NULL,
    estimated TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_costs_user_created (user_id, created_at),
    CONSTRAINT fk_ai_costs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_request_logs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    trace_id VARCHAR(36) NOT NULL,
    provider_id VARCHAR(64) NULL,
    model_id VARCHAR(191) NULL,
    credential_source VARCHAR(32) NULL,
    routing_policy VARCHAR(128) NULL,
    status VARCHAR(32) NOT NULL,
    error_code VARCHAR(64) NULL,
    latency_ms INT NULL,
    ttft_ms INT NULL,
    retry_count INT NOT NULL DEFAULT 0,
    fallback_count INT NOT NULL DEFAULT 0,
    routing_explanation_json JSON NULL,
    metadata_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_logs_user_created (user_id, created_at),
    CONSTRAINT fk_ai_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_health (
    provider_id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(32) NOT NULL,
    availability DECIMAL(5,4) NOT NULL DEFAULT 0,
    latency_ms INT NULL,
    error_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    rate_limit_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    timeout_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
    detail VARCHAR(512) NULL,
    checked_at DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_model_health (
    model_id VARCHAR(191) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    detail VARCHAR(512) NULL,
    checked_at DATETIME NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_audit_events (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    action VARCHAR(64) NOT NULL,
    resource VARCHAR(191) NOT NULL,
    result VARCHAR(32) NOT NULL,
    metadata_json JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_audit_user_created (user_id, created_at),
    CONSTRAINT fk_ai_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
];

let ready: Promise<void> | null = null;

async function seedCatalog() {
  for (const provider of PROVIDER_DEFINITIONS) {
    await query(
      `INSERT IGNORE INTO ai_providers (
        id, name, display_name, status, documentation_url, api_base_url,
        supports_json, authentication_type, credential_schema_json, env_key_names_json, brand_color
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        provider.id,
        provider.name,
        provider.displayName,
        provider.status,
        provider.documentationUrl,
        provider.apiBaseUrl,
        JSON.stringify({
          platformCredentials: provider.supportsPlatformCredentials,
          byok: provider.supportsByok,
          modelDiscovery: provider.supportsModelDiscovery,
          streaming: provider.supportsStreaming,
          tools: provider.supportsTools,
          vision: provider.supportsVision,
          audio: provider.supportsAudio,
          embeddings: provider.supportsEmbeddings,
          batch: provider.supportsBatch,
          reasoning: provider.supportsReasoning,
          structuredOutput: provider.supportsStructuredOutput,
          openaiCompatibility: provider.supportsOpenaiCompatibility,
        }),
        provider.authenticationType,
        JSON.stringify(provider.credentialSchema),
        JSON.stringify(provider.envKeyNames),
        provider.brandColor,
      ],
    );
  }

  for (const model of SEED_MODELS) {
    await query(
      `INSERT IGNORE INTO ai_models (
        id, provider_id, provider_model_id, display_name, family, version, aliases_json, status, lifecycle,
        release_date, deprecation_date, retirement_date, replacement_model_id, context_window, max_output_tokens,
        capabilities_json, latency_profile, pricing_json, region_support_json, compliance_tags_json, model_owner, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        model.id,
        model.providerId,
        model.providerModelId,
        model.displayName,
        model.family,
        model.version,
        JSON.stringify(model.aliases),
        model.status,
        model.lifecycle,
        model.releaseDate,
        model.deprecationDate,
        model.retirementDate,
        model.replacementModelId,
        model.contextWindow,
        model.maxOutputTokens,
        JSON.stringify(model.capabilities),
        model.latencyProfile,
        JSON.stringify(model.pricing),
        JSON.stringify(model.regionSupport),
        JSON.stringify(model.complianceTags),
        model.modelOwner,
        JSON.stringify(model.metadata),
      ],
    );
  }
}

async function runEnsure() {
  for (const statement of TABLES) {
    await query(statement);
  }
  await seedCatalog();
}

export async function ensureAiPlatformSchema(): Promise<void> {
  if (!ready) {
    ready = runEnsure().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}
