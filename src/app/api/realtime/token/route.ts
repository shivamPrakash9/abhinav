import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { hashWithSecret } from '@/lib/ratelimit';
import { ok, toErrorResponse } from '@/lib/errors';

/**
 * GET /api/realtime/token?room=ABC123 — short-lived channel token.
 * Returns a deterministic join key; Supabase RLS policies verify it.
 * Falls back to anonymous access when Supabase is not configured (dev).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const room = (url.searchParams.get('room') ?? '').toUpperCase().slice(0, 12);
    if (!/^[A-HJ-NP-Z2-9]{4,12}$/.test(room)) {
      return NextResponse.json(
        { data: null, error: { code: 'VALIDATION', message: 'Invalid room code.' } },
        { status: 422 },
      );
    }
    const user = await getCurrentUser();
    const key = await hashWithSecret(`room:${room}:${user?.id ?? 'anon'}`);
    return NextResponse.json(ok({ room, key, userId: user?.id ?? null, expiresInSeconds: 300 }));
  } catch (error) {
    return toErrorResponse(error, 'GET /api/realtime/token');
  }
}
