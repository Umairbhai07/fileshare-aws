// Bundles each Lambda (with @fileshare/core and the AWS SDK) into a single ESM file.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const functions = ['share-api', 'process-upload', 'expiry-stream', 'sweeper'];
await rm('dist', { recursive: true, force: true });
await Promise.all(functions.map((fn) => build({
  entryPoints: [`src/${fn}.js`],
  outfile: `dist/${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
})));
console.log(`Built ${functions.length} Lambdas into lambdas/dist/`);
