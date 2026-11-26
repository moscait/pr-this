import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');

// The parser runtime's ES-module build looks itself up through `import.meta.url`, which a CommonJS bundle doesn't
// have; its CommonJS build works when bundled.
const alias = { 'web-tree-sitter': './node_modules/web-tree-sitter/web-tree-sitter.cjs' };

if (args.includes('--tests')) {
  await esbuild.build({
    entryPoints: ['src/test/*.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outdir: 'dist-test',
    external: ['vscode'],
    alias,
    logLevel: 'warning',
  });
  process.exit(0);
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  alias,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

// The runtime's WebAssembly half ships next to the bundle (language grammars are downloaded on demand instead).
mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/web-tree-sitter.wasm');

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
