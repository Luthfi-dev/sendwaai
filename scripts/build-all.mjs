import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Sequential low-thread build runner for CloudLinux / cPanel shared hosting.
 * Native Rust/Go/libuv pools (Rolldown, Tailwind v4 Oxide, LightningCSS) panic with
 * `ThreadPoolBuildError (Resource temporarily unavailable / EAGAIN)` when host CPU
 * count exceeds CloudLinux LVE NPROC limits unless thread pools are capped.
 */
function buildLowThreadEnv() {
  return {
    ...process.env,
    RAYON_NUM_THREADS: process.env.RAYON_NUM_THREADS || '1',
    TOKIO_WORKER_THREADS: process.env.TOKIO_WORKER_THREADS || '1',
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '1',
    GOMAXPROCS: process.env.GOMAXPROCS || '1',
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
    OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS || '1',
    MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || '2'
  };
}

function resolveViteCli() {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'),
    path.resolve(process.cwd(), 'node_modules', '.bin', 'vite')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Vite CLI tidak ditemukan di node_modules. Jalankan "npm install" terlebih dahulu.');
}

function runNodeScript(scriptPath, args = [], env) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env
  });
}

function main() {
  const env = buildLowThreadEnv();
  const viteCli = resolveViteCli();
  const serverBuildScript = path.resolve(process.cwd(), 'scripts', 'build-server.mjs');

  console.log('[Build] Memulai build frontend Vite (mode hemat thread cPanel/CloudLinux)...');
  runNodeScript(viteCli, ['build'], env);

  console.log('[Build] Memulai build server backend...');
  runNodeScript(serverBuildScript, [], env);

  console.log('✓ Seluruh build frontend dan backend selesai.');
}

try {
  main();
} catch (err) {
  console.error('[Build Error]', err?.message || err);
  process.exit(1);
}
