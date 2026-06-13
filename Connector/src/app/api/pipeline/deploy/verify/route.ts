import { NextRequest, NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';

interface VerifyBody {
  cloudfront_url?: string;
  app_url?: string;
  health_check_url?: string;
  public_ip?: string;
}

async function probeUrl(label: string, rawUrl: string): Promise<{ label: string; url: string; ok: boolean; status: number | null; detail: string }> {
  const url = String(rawUrl || '').trim();
  if (!url) {
    return { label, url: '', ok: false, status: null, detail: 'No endpoint provided.' };
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text().catch(() => '');
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      label,
      url,
      ok: response.ok,
      status: response.status,
      detail: snippet || `HTTP ${response.status}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Request failed';
    return { label, url, ok: false, status: null, detail };
  }
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth();
  if (error) return error;

  const body = await req.json().catch(() => ({})) as VerifyBody;
  const cloudfrontUrl = String(body.cloudfront_url || '').trim();
  const appUrl = String(body.app_url || '').trim();
  const healthCheckUrl = String(body.health_check_url || '').trim();
  const publicIp = String(body.public_ip || '').trim();

  const targets = [
    { label: 'cloudfront', url: cloudfrontUrl },
    { label: 'health', url: healthCheckUrl },
    { label: 'app', url: appUrl },
    { label: 'instance', url: publicIp ? `http://${publicIp}` : '' },
  ].filter((target, index, list) => (
    target.url && list.findIndex((candidate) => candidate.url === target.url) === index
  ));

  const checks = targets.length > 0
    ? await Promise.all(targets.map((target) => probeUrl(target.label, target.url)))
    : [
        await probeUrl('cloudfront', ''),
        await probeUrl('instance', ''),
      ];

  return NextResponse.json({
    success: true,
    verified_at: new Date().toISOString(),
    checks,
  });
}
