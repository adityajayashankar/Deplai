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
    return NextResponse.json({ error: 'Icon not found' }, { status: 404 });
  }

  return new NextResponse(content, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
