import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
// Public project address and publishable key only (safe to ship in the page; never put secret or service_role keys here).
const supabasePublic = JSON.parse(await fs.readFile('supabase/public-config.json', 'utf8').catch(() => '{}'));
const output = path.resolve('dist');
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['src/storage.mjs'], bundle: true, format: 'iife', target: ['chrome100', 'safari16'], outfile: 'web/storage.js', minify: true, legalComments: 'eof' });
const assets = ['index.html', 'app.js', 'core.js', 'export.js', 'style.css', 'storage.js', 'favicon.svg', 'privacy.html'];
for (const backend of ['guest', 'supabase']) {
  const folder = path.join(output, backend);
  await fs.mkdir(folder, { recursive: true });
  for (const name of assets) {
    let content = await fs.readFile(path.join('web', name));
    // Cache-busting query strings follow package.json instead of a hard-coded version.
    if (name === 'index.html') content = Buffer.from(content.toString().replace(/\?v=\d+\.\d+\.\d+/g, '?v=' + version));
    await fs.writeFile(path.join(folder, name), content);
  }
  const cfg = { backend: backend === 'guest' ? 'router-guest' : 'supabase', storagePath: '/HDD1/serotonin-board-tests/guest/data', dataUrl: './data/', pollMilliseconds: 15000, maxEvents: backend === 'supabase' ? 20000 : 1000, version, supabaseUrl: backend === 'supabase' ? supabasePublic.supabaseUrl || '' : '', publishableKey: backend === 'supabase' ? supabasePublic.publishableKey || '' : '', ...(backend === 'supabase' && supabasePublic.turnstileSiteKey ? { turnstileSiteKey: supabasePublic.turnstileSiteKey } : {}), ...(backend === 'guest' ? { signing: true, registryUrl: './users.json', routerOrigin: 'http://192.168.0.1' } : {}) };
  await fs.writeFile(path.join(folder, 'config.js'), '// Public configuration only; no passwords or secret keys.\nwindow.BOARD_CONFIG = Object.freeze(' + JSON.stringify(cfg, null, 2) + ');\n');
}
await fs.copyFile('web/comparison.html', path.join(output, 'index.html'));
await fs.copyFile('web/folder-probe.html', path.join(output, 'guest/folder-probe.html'));
await fs.copyFile('supabase/setup.sql', path.join(output, 'supabase/setup.sql'));
console.log('Built dist/index.html, dist/guest/, dist/supabase/ (v' + version + '). Existing deployed board is unchanged.');
