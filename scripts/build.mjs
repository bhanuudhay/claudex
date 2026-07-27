#!/usr/bin/env node
/**
 * Transpile-only build: src/**\/*.ts -> dist/**\/*.js (ESM, no bundling).
 *
 * We deliberately do NOT bundle. Node's ESM loader handles this module graph in
 * a couple of milliseconds, and keeping the file layout intact lets the test
 * suite import individual modules (dist/detect/error-detector.js) instead of
 * reaching into a bundle.
 */
import { build } from 'esbuild';
import { readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src');
const outDir = join(root, 'dist');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const entryPoints = await walk(srcDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints,
  outdir: outDir,
  outbase: srcDir,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  bundle: false,
  sourcemap: false,
  logLevel: 'warning',
});

// esbuild transpile-only leaves import specifiers untouched, and our sources
// already use explicit .js specifiers, so dist is directly runnable by Node.
await writeFile(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

// The executable entry is additionally bundled into a single file. Resolving
// ~40 ES modules costs real milliseconds on a command that runs before every
// `claude` invocation; one file removes that from the critical path. Tests keep
// importing the unbundled modules above.
await build({
  entryPoints: [join(srcDir, 'cli.ts')],
  outfile: join(outDir, 'cli.bundle.js'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  bundle: true,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

console.log(`built ${entryPoints.length} files + 1 bundle -> ${relative(root, outDir)}/`);
