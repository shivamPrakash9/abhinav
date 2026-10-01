import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * Next.js dev mode hot-reloads modules on every edit. Without the global cache
 * each reload would construct a new PrismaClient and therefore a new connection
 * pool, which exhausts Postgres connections within minutes (the classic
 * "too many clients already" error).
 *
 * CONNECTION POOLING IN PRODUCTION (important):
 * Serverless functions scale horizontally; each instance is its own process with
 * its own pool. Point `DATABASE_URL` at Supavisor's transaction pooler on port
 * 6543 and cap the pool per instance:
 *
 *   postgresql://...@...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
 *
 * Prisma Migrate must NOT go through the transaction pooler (it needs advisory
 * locks), which is exactly why `DIRECT_URL` exists in the datasource block.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Postgres unique-constraint violation (`P2002`).
 * Used to convert race conditions ("someone else took this slug") into a clean
 * retry or a 409 instead of a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** Postgres "record not found" for update/delete (`P2025`). */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025'
  );
}
