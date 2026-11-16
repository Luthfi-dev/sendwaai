import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

async function resolveEsbuild() {
  try {
    return await import('esbuild');
  } catch (directErr) {
    // Fallback lookup in case NODE_PATH or nested node_modules holds esbuild (e.g. cPanel setups)
    const candidates = [
      path.resolve(process.cwd(), 'node_modules', 'esbuild', 'lib', 'main.js'),
      path.resolve(process.cwd(), 'node_modules', 'vite', 'node_modules', 'esbuild', 'lib', 'main.js')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return await import(pathToFileURL(candidate).href);
      }
    }

    console.error(
      '\n[Build Error] Paket "esbuild" tidak ditemukan di node_modules.\n' +
        'Jika Anda build di cPanel (NODE_ENV=production), jalankan "npm install" / klik "Run NPM Install" terlebih dahulu agar dependencies terbaru terpasang, lalu jalankan ulang "npm run build".\n'
    );
    throw directErr;
  }
}

async function main() {
  const entry = path.resolve(process.cwd(), 'server.ts');
  const outfile = path.resolve(process.cwd(), 'dist', 'server.js');

  if (!fs.existsSync(entry)) {
    console.error(`[Build Error] Entry file tidak ditemukan: ${entry}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  const esbuild = await resolveEsbuild();
  await esbuild.build({
    entryPoints: ['server.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    sourcemap: true,
    outfile: 'dist/server.js'
  });

  if (!fs.existsSync(outfile)) {
    console.error(`[Build Error] Output server gagal dibuat: ${outfile}`);
    process.exit(1);
  }

  const sizeKb = (fs.statSync(outfile).size / 1024).toFixed(2);
  console.log(`✓ Server bundle built: dist/server.js (${sizeKb} kB)`);
}

main().catch((err) => {
  console.error('[Build Error] Gagal membuild server:', err?.message || err);
  process.exit(1);
});
