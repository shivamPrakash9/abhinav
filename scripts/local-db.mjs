/**
 * Local development Postgres, no installer / no admin rights / no Docker.
 *
 * Boots an embedded PostgreSQL cluster (the `embedded-postgres` binary) on the
 * port taken from DATABASE_URL in .env, using the SAME user, password and
 * database name already in that file — so nothing in .env has to change and
 * `prisma migrate`, `prisma db seed` and `next dev` all just work.
 *
 *   npm run db:local            # keeps running until Ctrl+C
 *   npm run db:local -- --fresh # wipe the data directory first
 *
 * The data directory deliberately lives OUTSIDE the project folder: this repo
 * sits in OneDrive, and letting the sync client touch PostgreSQL's files can
 * corrupt the cluster. Override with QUIZLY_PGDATA.
 */
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let EmbeddedPostgres;
try {
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
} catch {
  console.error(
    'embedded-postgres is not installed (it is an optionalDependency, so a ' +
    'production install skips it). Run: npm install --include=optional',
  );
  process.exit(1);
}

const quiet = process.argv.includes('--quiet');
const log = (...args) => { if (!quiet) console.log(...args); };

function readEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '').replace(/'$/g, '').replace(/^'/, '');
  }
  return out;
}

const envFile = path.resolve(process.cwd(), '.env');
if (!existsSync(envFile)) {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(1);
}
const env = readEnvFile(envFile);
const raw = (env.DIRECT_URL || env.DATABASE_URL || '').replace(/^postgresql\+prisma:\/\//, 'postgresql://');
if (!raw) {
  console.error('DATABASE_URL / DIRECT_URL missing from .env');
  process.exit(1);
}

const url = new URL(raw);
const user = decodeURIComponent(url.username) || 'postgres';
const password = decodeURIComponent(url.password) || 'postgres';
const database = url.pathname.replace(/^\//, '').split('?')[0] || 'postgres';
const port = Number(url.port || 5432);

const databaseDir = process.env.QUIZLY_PGDATA || path.join(os.homedir(), '.quizly-pgdata');
if (process.argv.includes('--fresh')) {
  log(`Wiping ${databaseDir}`);
  rmSync(databaseDir, { recursive: true, force: true });
}
mkdirSync(databaseDir, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  // Pin UTF-8 explicitly. On Windows, initdb otherwise inherits the machine's
  // ANSI codepage (e.g. WIN1252), while every hosted provider runs UTF-8 —
  // and UTF-8 migration files then fail to apply with error 22P05.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (m) => log(`[postgres] ${m}`),
  onError: (m) => console.error(`[postgres] ${typeof m === 'string' ? m : (m?.message ?? m) ?? 'error'}`),
});

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function waitReady(seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    if (await portIsOpen()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const alreadyInitialised = existsSync(path.join(databaseDir, 'PG_VERSION'));
const portBusy = await portIsOpen();

if (portBusy) {
  console.log(`QDB_READY port=${port} (a server is already listening; nothing started)`);
  process.exit(0);
}

if (!alreadyInitialised) {
  log(`Initialising PostgreSQL in ${databaseDir} (one time, ~10s)`);
  await pg.initialise();
}

await pg.start();
if (!(await waitReady())) {
  console.error('PostgreSQL did not open its port in time.');
  await pg.stop().catch(() => {});
  process.exit(1);
}

// The cluster's superuser is the .env user, but the target database may not
// exist yet on a fresh cluster.
if (database !== 'postgres') {
  const client = pg.getPgClient('postgres');
  await client.connect();
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '')}" OWNER "${user.replace(/"/g, '')}"`);
    log(`Created database ${database}`);
  }
  await client.end();
}

console.log(`QDB_READY port=${port} user=${user} database=${database} dir=${databaseDir}`);
log('Press Ctrl+C to stop.');

const shutdown = async (signal) => {
  log(`\n${signal} received — stopping PostgreSQL`);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);
  await pg.stop().catch(() => {});
  process.exit(0);
};
const onSigint = () => void shutdown('SIGINT');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigint);

// Heartbeat keeps the process alive; the cluster itself is a child process.
setInterval(() => {}, 1 << 30);
