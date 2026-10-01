import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from '../env';
import { channels, type HostEvent, type RoomEvent } from './events';

/**
 * Server-side realtime publishing.
 *
 * Only the SERVER may publish gameplay events. Clients can publish presence
 * ("I am here") but never state, so a compromised client cannot fabricate a
 * question, change its own score, or skip ahead.
 *
 * ⚠️ CONNECTION-LEAK GUARD — read this before editing:
 * Every `supabase.channel(...)` call opens a WebSocket. In a serverless function
 * those sockets are NOT reused between invocations, so forgetting to remove a
 * channel leaks a connection per request and exhausts the Supabase Realtime
 * connection quota within minutes. `removeChannel` is therefore awaited in a
 * `finally` block on every path below.
 */

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  const { url, serviceRoleKey } = env.supabase;
  if (!url || !serviceRoleKey) return null;

  cachedClient ??= createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
      // Server publishes on transitions only; a low ceiling bounds runaway costs.
      params: { eventsPerSecond: 10 },
    },
  });

  return cachedClient;
}

export function isRealtimeConfigured(): boolean {
  return Boolean(env.supabase.url && env.supabase.serviceRoleKey);
}

export type BroadcastResult = { ok: boolean; skipped?: boolean; error?: string };

/**
 * Publishes one broadcast message and immediately tears the channel down.
 * Returns a result instead of throwing: a live quiz should degrade (players fall
 * back to polling) rather than crash if realtime is briefly unavailable.
 */
export async function broadcast<T extends Record<string, unknown>>(
  channelName: string,
  event: RoomEvent | HostEvent | string,
  payload: T,
): Promise<BroadcastResult> {
  const client = getClient();
  if (!client) {
    if (env.nodeEnv === 'development') {
      console.info(`[realtime] skipped "${event}" → ${channelName} (Supabase not configured)`);
    }
    return { ok: false, skipped: true };
  }

  let channel: ReturnType<SupabaseClient['channel']> | null = null;
  try {
    channel = client.channel(channelName);
    await channel.send({ type: 'broadcast', event, payload });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[realtime] failed to broadcast "${event}" to ${channelName}:`, message);
    return { ok: false, error: message };
  } finally {
    // ALWAYS release the socket, including on the error path above.
    if (channel) {
      try {
        await client.removeChannel(channel);
      } catch (removalError) {
        console.error('[realtime] failed to release channel:', removalError);
      }
    }
  }
}

export function broadcastToRoom<T extends Record<string, unknown>>(
  roomCode: string,
  event: RoomEvent,
  payload: T,
): Promise<BroadcastResult> {
  return broadcast(channels.room(roomCode), event, payload);
}

export function broadcastToHost<T extends Record<string, unknown>>(
  roomCode: string,
  event: HostEvent,
  payload: T,
): Promise<BroadcastResult> {
  return broadcast(channels.host(roomCode), event, payload);
}
