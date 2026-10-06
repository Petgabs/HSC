import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'assets/vendor');
await mkdir(vendor, { recursive: true });

const copies = [
  ['node_modules/alpinejs/dist/module.esm.min.js', 'assets/vendor/alpine.esm.js'],
  ['node_modules/lucide/dist/umd/lucide.min.js', 'assets/vendor/lucide.min.js'],
  ['node_modules/libsodium/dist/modules-esm/libsodium.mjs', 'assets/vendor/libsodium.mjs']
];
for (const [source, destination] of copies) {
  const sourcePath = resolve(root, source);
  const destinationPath = resolve(root, destination);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

// The ESM wrapper normally imports the bare package name `libsodium`, which a
// static GitHub Pages site cannot resolve. Keep the reviewed upstream wrapper
// unchanged apart from pointing it at the adjacent, vendored sodium module.
const sodiumWrapperSource = resolve(root, 'node_modules/libsodium-wrappers/dist/modules-esm/libsodium-wrappers.mjs');
const sodiumWrapper = await readFile(sodiumWrapperSource, 'utf8');
const rewrittenWrapper = sodiumWrapper.replace('from"libsodium"', 'from"./libsodium.mjs"');
if (rewrittenWrapper === sodiumWrapper) throw new Error('Could not locate the libsodium import in its ESM wrapper.');
await writeFile(resolve(vendor, 'libsodium-wrappers.mjs'), rewrittenWrapper);

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const versions = Object.fromEntries(['alpinejs', 'lucide', 'tailwindcss', 'libsodium', 'libsodium-wrappers'].map(name => {
  const key = `node_modules/${name}`;
  return [name, lock.packages?.[key]?.version || 'unknown'];
}));
await writeFile(resolve(vendor, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
console.log(`Vendored Alpine ${versions.alpinejs}, Lucide ${versions.lucide}, and libsodium ${versions.libsodium}.`);
