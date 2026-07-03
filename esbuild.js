'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

/** Copy static webview assets into media/. */
function copyAssets() {
  fs.mkdirSync('media', { recursive: true });
  fs.copyFileSync('src/webview/styles.css', 'media/styles.css');
  fs.copyFileSync(
    path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join('media', 'sql-wasm.wasm'),
  );
}

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  // sql.js probes for fs/path at runtime; keep them external (node builtins).
  minify: false,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.js'],
  bundle: true,
  platform: 'browser',
  target: 'es2021',
  format: 'iife',
  outfile: 'media/main.js',
  minify: false,
  logLevel: 'info',
};

async function main() {
  copyAssets();
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    console.log('watching…');
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
