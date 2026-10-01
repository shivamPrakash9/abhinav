export async function register(): Promise<void> {
  // Runs once at server boot (both `next dev` and `next start`).
  // Fails fast in production when required env vars are missing.
  if (typeof window !== 'undefined') return;
  const { assertRequiredEnv } = await import('./lib/env');
  try {
    const missing = assertRequiredEnv();
    if (missing.length > 0) {
      console.warn(`[boot] missing optional env in development: ${missing.join(', ')}`);
    }
  } catch (error) {
    console.error('[boot]', error instanceof Error ? error.message : error);
    throw error;
  }
}
