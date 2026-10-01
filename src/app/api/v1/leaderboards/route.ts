import { NextResponse } from 'next/server';

import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ok, parseOrThrow, toErrorResponse } from '@/lib/errors';
import { leaderboardQuerySchema, getLeaderboard } from '@/lib/game/leaderboard';
import { applyPolicy, clientKeyFromHeaders, throwIfLimited } from '@/lib/ratelimit';

/** GET /api/v1/leaderboards?scope=GLOBAL&period=ALL_TIME — cached 30s at edge. */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const query = parseOrThrow(leaderboardQuerySchema, Object.fromEntries(url.searchParams));
    throwIfLimited(await applyPolicy('readPublic', await clientKeyFromHeaders(request.headers, 'leaderboard')));
    const user = await getCurrentUser();
    const board = await getLeaderboard(query, user?.id ?? null);
    return NextResponse.json(ok(board), {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    return toErrorResponse(error, 'GET /api/v1/leaderboards');
  }
}
