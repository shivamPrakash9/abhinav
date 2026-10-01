'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as React from 'react';
import { parseRoomEvent, type RoomEvent } from '@/lib/game/events';

/**
 * Subscribes to a live room's public broadcast channel.
 * Payloads are Zod-validated before they touch state — a malformed broadcast
 * is ignored, never rendered. Presence (who is in the lobby) is tracked via
 * a separate presence channel.
 */
export function useLiveSession(opts: {
  url: string; anonKey: string; roomChannel: string; presenceChannel: string;
}) {
  const [status, setStatus] = React.useState<string>('LOBBY');
  const [question, setQuestion] = React.useState<Record<string, unknown> | null>(null);
  const [scoreboard, setScoreboard] = React.useState<unknown>(null);
  const [count, setCount] = React.useState(0);
  const clientRef = React.useRef<SupabaseClient | null>(null);

  React.useEffect(() => {
    if (!opts.url || !opts.anonKey) return;
    const client = createClient(opts.url, opts.anonKey);
    clientRef.current = client;
    const room = client.channel(opts.roomChannel);
    const onEvent = (event: RoomEvent) => (payload: unknown) => {
      const data = parseRoomEvent(event, (payload as { payload?: unknown })?.payload ?? payload);
      if (!data) return;
      if (event === 'question_started') { setQuestion(data as Record<string, unknown>); setStatus('QUESTION_ACTIVE'); }
      else if (event === 'reveal') setStatus('REVEAL');
      else if (event === 'scoreboard') { setScoreboard(data); setStatus('SCOREBOARD'); }
      else if (event === 'start') setStatus('QUESTION_ACTIVE');
      else if (event === 'end' || event === 'cancelled') setStatus('FINISHED');
      else if (event === 'lobby_update') setCount((data as { participantCount: number }).participantCount);
    };
    room
      .on('broadcast', { event: 'lobby_update' }, onEvent('lobby_update'))
      .on('broadcast', { event: 'start' }, onEvent('start'))
      .on('broadcast', { event: 'question_started' }, onEvent('question_started'))
      .on('broadcast', { event: 'reveal' }, onEvent('reveal'))
      .on('broadcast', { event: 'scoreboard' }, onEvent('scoreboard'))
      .on('broadcast', { event: 'end' }, onEvent('end'))
      .on('broadcast', { event: 'cancelled' }, onEvent('cancelled'))
      .subscribe();
    const presence = client.channel(opts.presenceChannel);
    presence.subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        await presence.track({ online_at: new Date().toISOString() });
        setCount(1);
      }
    });
    return () => { void client.removeChannel(room); void client.removeChannel(presence); };
  }, [opts.url, opts.anonKey, opts.roomChannel, opts.presenceChannel]);

  return { status, question, scoreboard, count };
}
