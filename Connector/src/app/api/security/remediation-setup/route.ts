import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { userModelSetup } from '@/lib/ai-platform/model-setup';

export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  return NextResponse.json(await userModelSetup(user.id));
}
