import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

// Deliberately small, unauthenticated liveness/readiness endpoint for Docker
// and the reverse proxy. It exposes no credentials or database diagnostics.
export async function GET() {
  try {
    await query('SELECT 1');
    return NextResponse.json({ status: 'healthy', service: 'connector' });
  } catch {
    return NextResponse.json(
      { status: 'down', service: 'connector' },
      { status: 503 },
    );
  }
}
