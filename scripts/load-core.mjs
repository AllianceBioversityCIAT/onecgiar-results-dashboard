// Evaluates plain-declaration core files with node:vm in a fresh context and
// returns their top-level functions (design.md section 7.7).
// An optional first argument that is an object (not a string) supplies globals
// injected into the context before the files run (e.g. { RD_DATA: ... }).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadCore(...args) {
  const globals = args.length > 0 && typeof args[0] === 'object' ? args.shift() : {};
  const files = args;
  const context = vm.createContext({ ...globals });
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
