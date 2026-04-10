import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { verifyWebhookSignature } from '@/lib/crypto';
import { v4 as uuidv4 } from 'uuid';
import { requireEnv } from '@/lib/env';

function candidateWebhookSecrets(): string[] {
  const primary = requireEnv('GITHUB_WEBHOOK_SECRET').trim();
  const optional = [
    process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS,
    process.env.GITHUB_WEBHOOK_SECRET_LEGACY,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return Array.from(new Set([primary, ...optional]));
}

export async function POST(request: NextRequest) {
  try {
    const signature = request.headers.get('x-hub-signature-256')?.trim();
    const event = request.headers.get('x-github-event');
    const deliveryId = request.headers.get('x-github-delivery')?.trim() || 'unknown';
    
    if (!signature || !event) {
      return NextResponse.json(
        { error: 'Missing headers' },
        { status: 400 }
      );
    }

    const body = await request.text();
    const secrets = candidateWebhookSecrets();
    const isValid = secrets.some((secret) => verifyWebhookSignature(body, signature, secret));
    const allowInsecureWebhook =
      process.env.NODE_ENV !== 'production'
      && String(process.env.ALLOW_INSECURE_GITHUB_WEBHOOK || '').toLowerCase() === 'true';

    if (!isValid) {
      if (allowInsecureWebhook) {
        console.warn('Bypassing invalid GitHub webhook signature in development mode.', {
          delivery_id: deliveryId,
          event,
        });
      } else {
      const shouldLogInvalidSignature =
        process.env.NODE_ENV === 'production' ||
        String(process.env.LOG_INVALID_WEBHOOK_SIGNATURES || '').toLowerCase() === 'true';
      if (shouldLogInvalidSignature) {
        console.warn('Invalid webhook signature', {
          delivery_id: deliveryId,
          event,
          accepted_secret_count: secrets.length,
        });
      }
      return NextResponse.json(
        {
          error: 'Invalid signature',
          hint: 'Ensure GitHub App webhook secret matches GITHUB_WEBHOOK_SECRET (or set GITHUB_WEBHOOK_SECRET_PREVIOUS during secret rotation).',
        },
        { status: 401 }
      );
      }
    }

    const payload = JSON.parse(body);

    switch (event) {
      case 'installation':
        await handleInstallation(payload);
        break;
      
      case 'installation_repositories':
        await handleInstallationRepositories(payload);
        break;
      
      case 'push':
        await handlePush(payload);
        break;
      
      case 'pull_request':
        await handlePullRequest(payload);
        break;
      
      default:
        console.log(`Unhandled event: ${event}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

async function handleInstallation(payload: any) {
  const { action, installation, repositories } = payload;

  if (action === 'created') {
    const installationId = uuidv4();

    await query(
      `INSERT INTO github_installations 
       (id, installation_id, account_login, account_type, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [
        installationId,
        installation.id,
        installation.account.login,
        installation.account.type,
        JSON.stringify({ installation }),
      ]
    );

    if (repositories) {
      for (const repo of repositories) {
        await storeRepository(installationId, repo);
      }
    }
  } else if (action === 'suspend') {
    await query(
      `UPDATE github_installations SET suspended_at = NOW() WHERE installation_id = ?`,
      [installation.id]
    );
    console.log(`Installation ${installation.id} suspended`);

  } else if (action === 'unsuspend') {
    await query(
      `UPDATE github_installations SET suspended_at = NULL WHERE installation_id = ?`,
      [installation.id]
    );
    console.log(`Installation ${installation.id} unsuspended`);

  } else if (action === 'deleted') {
    const [inst] = await query<any[]>(
      'SELECT id FROM github_installations WHERE installation_id = ?',
      [installation.id]
    );

    if (inst) {
      await query(
        'DELETE FROM github_repositories WHERE installation_id = ?',
        [inst.id]
      );
    }

    await query(
      'DELETE FROM github_installations WHERE installation_id = ?',
      [installation.id]
    );
  }
}

async function handleInstallationRepositories(payload: any) {
  const { action, installation, repositories_added, repositories_removed } = payload;

  const [inst] = await query<any[]>(
    'SELECT id FROM github_installations WHERE installation_id = ?',
    [installation.id]
  );

  if (!inst) return;

  if (action === 'added') {
    for (const repo of repositories_added) {
      await storeRepository(inst.id, repo);
    }
  } else if (action === 'removed') {
    for (const repo of repositories_removed) {
      await query(
        'DELETE FROM github_repositories WHERE installation_id = ? AND github_repo_id = ?',
        [inst.id, repo.id]
      );
    }
  }
}

async function handlePush(payload: any) {
  const { repository, ref } = payload;

  await query(
    `UPDATE github_repositories
     SET needs_refresh = true, last_push_at = NOW()
     WHERE github_repo_id = ?`,
    [repository.id]
  );

  console.log(`Push to ${ref} in ${repository.full_name}, marked as stale`);
}

async function handlePullRequest(payload: any) {
  const { action, pull_request, repository } = payload;

  if (action !== 'opened' && action !== 'synchronize') {
    return;
  }

  await query(
    `UPDATE github_repositories
     SET needs_refresh = true
     WHERE github_repo_id = ?`,
    [repository.id]
  );

  console.log(`PR #${pull_request.number} in ${repository.full_name} marked as stale`);
}

async function storeRepository(installationId: string, repo: any) {
  await query(
    `INSERT INTO github_repositories 
     (id, installation_id, github_repo_id, full_name, is_private, default_branch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE 
     full_name = VALUES(full_name),
     default_branch = VALUES(default_branch)`,
    [
      uuidv4(),
      installationId,
      repo.id,
      repo.full_name,
      repo.private,
      repo.default_branch || 'main'
    ]
  );
}