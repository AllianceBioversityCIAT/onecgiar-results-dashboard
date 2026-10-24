// Runs `node scripts/build.mjs` in a child process into its own temporary folder (Y-3: tests never
// build into the shared dist/). Returns the child's result plus the paths of the build.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const created = [];

export function tempDir(prefix = 'rd-build-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Call from after(): removes every temporary folder this process created.
export function cleanupTemp() {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true });
}

export function runBuild({ srcDir, outDirOverride, env = {} } = {}) {
  const base = tempDir();
  const outDir = outDirOverride || join(base, 'dist');
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, BUILD_OUT_DIR: outDir, ...(srcDir ? { BUILD_SRC_DIR: srcDir } : {}), ...env },
  });
  return {
    ...result,
    base,
    outDir,
    artifacts: join(base, 'artifacts'),
    manifest: () => JSON.parse(readFileSync(join(base, 'artifacts', 'dist-manifest.json'), 'utf8')),
  };
}
