import { NextRequest } from 'next/server';
import { handleAiRequest } from '@/lib/ai-platform/http';

async function dispatch(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await context.params;
  return handleAiRequest(request, path);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
