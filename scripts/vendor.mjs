import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'assets/vendor');
await mkdir(vendor, { recursive: true });

const copies = [
  ['node_modules/alpinejs/dist/module.esm.min.js', 'assets/vendor/alpine.esm.js'],
  ['node_modules/lucide/dist/umd/lucide.min.js', 'assets/vendor/lucide.min.js']
];
for (const [source, destination] of copies) {
  const sourcePath = resolve(root, source);
  const destinationPath = resolve(root, destination);
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const versions = Object.fromEntries(['alpinejs', 'lucide', 'tailwindcss'].map(name => {
  const key = `node_modules/${name}`;
  return [name, lock.packages?.[key]?.version || 'unknown'];
}));
await writeFile(resolve(vendor, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
console.log(`Vendored Alpine ${versions.alpinejs} and Lucide ${versions.lucide}.`);
