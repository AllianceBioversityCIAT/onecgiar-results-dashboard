// Evaluates plain-declaration core files with node:vm in a fresh context and
// returns their top-level functions (design.md section 7.7).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadCore(...files) {
  const context = vm.createContext({});
  const names = [];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(root, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
    for (const m of source.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  }
  const out = {};
  for (const n of names) out[n] = context[n];
  return out;
}
