CREATE DATABASE deplai;
USE deplai;

-- Users table
CREATE TABLE users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- GitHub installations
CREATE TABLE github_installations (
    id VARCHAR(36) PRIMARY KEY,
    installation_id BIGINT NOT NULL UNIQUE,
    account_login VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    user_id VARCHAR(36) NULL,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    suspended_at TIMESTAMP NULL,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_account_login (account_login),
    INDEX idx_user_id (user_id)
);

-- GitHub repositories
CREATE TABLE github_repositories (
    id VARCHAR(36) PRIMARY KEY,
    installation_id VARCHAR(36) NOT NULL,
    github_repo_id BIGINT NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    default_branch VARCHAR(255) DEFAULT 'main',
    is_private BOOLEAN NOT NULL,
    languages JSON,
    webhook_id BIGINT,
    last_synced_at TIMESTAMP NULL,
    metadata JSON,
    needs_refresh BOOLEAN DEFAULT true,
    user_hidden BOOLEAN DEFAULT false,
    last_cloned_at TIMESTAMP NULL,
    last_commit_sha VARCHAR(40) NULL,
    last_push_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (installation_id) REFERENCES github_installations(id) ON DELETE CASCADE,
    UNIQUE KEY unique_repo (installation_id, github_repo_id),
    INDEX idx_full_name (full_name),
    INDEX idx_needs_refresh (needs_refresh)
);

-- Projects
CREATE TABLE projects (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    project_type VARCHAR(20) NOT NULL DEFAULT 'github',
    repository_id VARCHAR(36) NULL,
    local_path VARCHAR(500) NULL,
    file_count INT NULL,
    size_bytes BIGINT NULL,
    user_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repository_id) REFERENCES github_repositories(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_project_type (project_type),
    INDEX idx_user_type (user_id, project_type)
);
-- ------------------------------------------------------------------------------
-- Chat sessions (agent chat history stored per user)
-- Limits: max 50 sessions per user, max 200 messages per session (enforced in API)
-- ------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT 'New chat',
    message_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_chat_sessions_user (user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
    INDEX idx_chat_messages_session (session_id, created_at)
);
