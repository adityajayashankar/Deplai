import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConvertPpkBody {
  private_key_pem?: string;
  key_name?: string | null;
  project_name?: string | null;
}

function toSafeStem(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
  return normalized || 'deplai-ec2-key';
}

function puttygenCandidates(): string[] {
  const envPath = String(process.env.PUTTYGEN_PATH || '').trim();
  const candidates = [
    envPath,
    'puttygen',
    'puttygen.exe',
    'C:\\Program Files\\PuTTY\\puttygen.exe',
    'C:\\Program Files (x86)\\PuTTY\\puttygen.exe',
  ];
  return candidates.filter(Boolean);
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  let tempDir = '';
  try {
    const body = (await req.json()) as ConvertPpkBody;
    const privateKeyPem = String(body.private_key_pem || '');
    if (!privateKeyPem.trim()) {
      return NextResponse.json(
        { success: false, error: 'private_key_pem is required.' },
        { status: 400 },
      );
    }
    if (!privateKeyPem.includes('BEGIN') || !privateKeyPem.includes('PRIVATE KEY')) {
      return NextResponse.json(
        { success: false, error: 'Invalid private_key_pem payload.' },
        { status: 400 },
      );
    }

    const stemSource = String(body.key_name || body.project_name || 'deplai-ec2-key');
    const fileStem = toSafeStem(stemSource);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deplai-ppk-'));
    const pemPath = path.join(tempDir, `${fileStem}.pem`);
    const ppkPath = path.join(tempDir, `${fileStem}.ppk`);
    fs.writeFileSync(pemPath, privateKeyPem.endsWith('\n') ? privateKeyPem : `${privateKeyPem}\n`, { encoding: 'utf-8' });

    const failures: string[] = [];
    for (const candidate of puttygenCandidates()) {
      const result = spawnSync(
        candidate,
        [pemPath, '-O', 'private', '-o', ppkPath],
        {
          encoding: 'utf-8',
          timeout: 20_000,
          windowsHide: true,
        },
      );

      if (result.error) {
        failures.push(`${candidate}: ${result.error.message}`);
        continue;
      }

      if (result.status === 0 && fs.existsSync(ppkPath)) {
        const content = fs.readFileSync(ppkPath);
        return NextResponse.json({
          success: true,
          file_name: `${fileStem}.ppk`,
          content_base64: content.toString('base64'),
        });
      }

      const stderr = String(result.stderr || '').trim();
      const stdout = String(result.stdout || '').trim();
      failures.push(`${candidate}: ${stderr || stdout || `exit ${String(result.status ?? 'unknown')}`}`);
    }

    return NextResponse.json(
      {
        success: false,
        error: 'PuTTYgen was not available for .ppk conversion in this runtime.',
        hint: 'Download the .pem key and convert it locally with PuTTYgen (Load -> Save private key).',
        details: failures.slice(-3),
      },
      { status: 501 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to convert PEM to PPK.';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // no-op
      }
    }
  }
}

