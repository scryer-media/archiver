import { defineConfig } from 'vite';
import { engineVersion } from './scripts/engine-version.mjs';
import { productionHeaders } from './scripts/production-headers.mjs';
import { readFile } from 'node:fs/promises';
import { ENGINE_FILE, acceptsBrotli } from './worker/serve.mjs';
// Preview serves the engine's Brotli copies the way the production Worker does.
const engineBrotli = { name: 'engine-brotli', configurePreviewServer(server: any) { server.middlewares.use(async (req: any, res: any, next: () => void) => {
  const path = (req.url || '').split('?')[0], match = path.match(ENGINE_FILE);
  if (!match || !acceptsBrotli(req.headers['accept-encoding'])) return next();
  let body: Buffer; try { body = await readFile(server.config.build.outDir + path + '.br'); } catch { return next(); }
  for (const [header, value] of Object.entries(productionHeaders())) res.setHeader(header, value as string);
  res.setHeader('Content-Type', match[1] === 'wasm' ? 'application/wasm' : 'text/javascript; charset=utf-8');
  res.setHeader('Content-Encoding', 'br'); res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(body);
}); } };
export default defineConfig({
  plugins: [engineBrotli],
  cacheDir: '.cache/vite',
  define: { 'import.meta.env.VITE_NATIVE_ENGINE_VERSION': JSON.stringify(engineVersion('public/engine')) },
  server: { watch: { ignored: ['**/.worktrees/**', '**/.cache/**', '**/dist/**', '**/dist-*/**', '**/engine/target/**', '**/engine/target-*/**'] }, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: productionHeaders() },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
