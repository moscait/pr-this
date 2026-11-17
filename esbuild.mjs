import * as esbuild from 'esbuild';

const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');

if (args.includes('--tests')) {
  await esbuild.build({
    entryPoints: ['src/test/*.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outdir: 'dist-test',
    external: ['vscode'],
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
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
