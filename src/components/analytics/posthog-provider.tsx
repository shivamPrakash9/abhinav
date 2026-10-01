'use client';

import posthog from 'posthog-js';
import { PostHogProvider as Base } from 'posthog-js/react';
import * as React from 'react';

/** Client analytics. No-op unless NEXT_PUBLIC_POSTHOG_KEY is set. */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  React.useEffect(() => {
    if (!key || typeof window === 'undefined') return;
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: true,
    });
  }, [key]);
  if (!key) return <>{children}</>;
  return <Base client={posthog}>{children}</Base>;
}
