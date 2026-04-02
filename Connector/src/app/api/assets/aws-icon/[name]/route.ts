import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getLegacyAwsIconsDir } from '@/lib/legacy-assets';

const AWS_ICON_DIR = getLegacyAwsIconsDir();

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function tryReadIcon(fileName: string): Promise<Buffer | null> {
  const fullPath = path.join(AWS_ICON_DIR, fileName);
  try {
    return await fs.readFile(fullPath);
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const resolved = await params;
  const requested = sanitizeName(resolved?.name || '');
  const candidates = [
    `${requested}.png`,
    `amazon${requested}.png`,
    `aws${requested}.png`,
    'default.png',
  ];

  let content: Buffer | null = null;
  for (const candidate of candidates) {
    if (!candidate || candidate === '.png') continue;
    content = await tryReadIcon(candidate);
    if (content) break;
  }

  if (!content) {
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect x="2" y="2" width="60" height="60" rx="12" fill="#0f172a" stroke="#334155" stroke-width="2"/>
      <path d="M18 40L28 24L36 34L44 24L46 40Z" fill="#06b6d4"/>
      <circle cx="22" cy="18" r="3" fill="#22d3ee"/>
    </svg>`;
    return new NextResponse(fallbackSvg, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  return new NextResponse(new Uint8Array(content), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
