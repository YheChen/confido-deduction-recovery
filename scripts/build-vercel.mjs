/**
 * Builds a Vercel deployment with the Build Output API
 * (https://vercel.com/docs/build-output-api):
 *
 *   .vercel/output/static/            the React app (Vite build), served from the CDN
 *   .vercel/output/functions/api.func  the Express API bundled into one file, plus data/*.json
 *   .vercel/output/config.json         routing: /api/* → the function, cached assets, SPA fallback
 *
 * Vercel uses .vercel/output when the build command creates it, so this is the
 * project's build command on Vercel (see vercel.json).
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.vercel', 'output');
const fn = join(output, 'functions', 'api.func');

rmSync(output, { recursive: true, force: true });

// 1. Front end
execSync('npm run build -w web', { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'web', 'dist'), join(output, 'static'), { recursive: true });

// 2. API: one ESM file with every dependency inlined, plus the raw export it loads at startup
await build({
  entryPoints: [join(root, 'server', 'src', 'serverless.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Express and its dependencies are CommonJS and require() Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // One session-signing key per deployment, shared by all of its instances.
  define: { 'process.env.BUILD_SESSION_SECRET': JSON.stringify(randomBytes(32).toString('hex')) },
  logLevel: 'info',
});
cpSync(join(root, 'data'), join(fn, 'data'), { recursive: true });
writeFileSync(
  join(fn, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 30 }, null, 2),
);

// 3. Routing
writeFileSync(
  join(output, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/api/(.*)$', dest: '/api?__pathname=/api/$1' },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

console.log(`\nVercel output written to ${output}`);
