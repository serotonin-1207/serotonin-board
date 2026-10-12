// Builds the browser extension into dist-extension/ and packs serotonin-board-extension-<version>.zip (the file the web stores want).
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { build } from 'esbuild';
import { publicConfig } from './public-config.mjs';

const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
const config = await publicConfig();
if (!config.publishableKey) throw new Error('The extension needs the publishable key (see scripts/public-config.mjs).');
const origin = new URL(config.supabaseUrl).origin;
// Public project address and publishable key only; the extension never holds secret keys or access codes.
const injected = { url: origin, key: config.publishableKey, boardUrl: 'https://serotonin-1207.github.io/serotonin-board/' };

const out = path.resolve('dist-extension');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, 'icons'), { recursive: true });

for (const entry of ['background', 'popup']) {
  await build({
    entryPoints: ['extension/src/' + entry + '.js'],
    bundle: true,
    format: 'iife',
    target: ['chrome110'],
    outfile: path.join(out, entry + '.js'),
    define: { __CONFIG__: JSON.stringify(injected) },
    legalComments: 'none',
    logLevel: 'warning',
  });
}
await fs.copyFile('extension/popup.html', path.join(out, 'popup.html'));
await fs.copyFile('extension/popup.css', path.join(out, 'popup.css'));
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2).replace('__SUPABASE_ORIGIN__', origin) + '\n');

// ---- icons: a dark rounded square with three list lines and the accent dot (same look as the board's favicon) ----
function crc(buffer) {
  return zlib.crc32(buffer);
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}
function png(size) {
  const px = new Uint8Array(size * size * 4);
  const radius = size * 0.28;
  const inside = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r),
      cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const SS = 3; // supersampling for smooth edges
  const bars = [0.3, 0.5, 0.7].map(t => [size * 0.2, size * (t - 0.04), size * 0.62, size * (t + 0.04)]);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS,
            fy = y + (sy + 0.5) / SS;
          if (!inside(fx, fy, 0, 0, size, size, radius)) continue;
          let color = [36, 40, 36];
          if (bars.some(([x0, y0, x1, y1]) => inside(fx, fy, x0, y0, x1, y1, (y1 - y0) / 2))) color = [243, 240, 233];
          if ((fx - size * 0.76) ** 2 + (fy - size * 0.7) ** 2 <= (size * 0.09) ** 2) color = [238, 121, 86];
          a++;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      const i = (y * size + x) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const size of [16, 32, 48, 128]) await fs.writeFile(path.join(out, 'icons', 'icon' + size + '.png'), png(size));

// ---- zip (store-ready; forward slashes, fixed timestamps so the same sources give the same file) ----
async function files(dir, base = '') {
  const list = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) list.push(...(await files(path.join(dir, entry.name), rel)));
    else list.push(rel);
  }
  return list.sort();
}
const locals = [],
  central = [];
let offset = 0;
for (const name of await files(out)) {
  const data = await fs.readFile(path.join(out, name));
  const packed = zlib.deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const sum = crc(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12); // 1980-01-01
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const entry = Buffer.concat([local, nameBytes, packed]);
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(0x0800, 8);
  head.writeUInt16LE(8, 10);
  head.writeUInt16LE(0, 12);
  head.writeUInt16LE(0x21, 14);
  head.writeUInt32LE(sum, 16);
  head.writeUInt32LE(packed.length, 20);
  head.writeUInt32LE(data.length, 24);
  head.writeUInt16LE(nameBytes.length, 28);
  head.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([head, nameBytes]));
  locals.push(entry);
  offset += entry.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zipName = 'serotonin-board-extension-' + manifest.version + '.zip';
await fs.writeFile(zipName, Buffer.concat([...locals, directory, end]));
console.log('Built dist-extension/ and ' + zipName + ' (extension v' + manifest.version + ')');
