// Verifica a sintaxe de todos os módulos JavaScript do projeto (servidor, compartilhado e cliente).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dirs = ['server', 'shared', 'public/js', 'test', 'e2e', 'scripts'];
let failed = 0;
for (const dir of dirs) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    continue;
  }
  for (const f of entries.filter((n) => /\.m?js$/.test(n))) {
    const file = join(dir, f);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed++;
      console.error(`✗ ${file}\n${err.stderr}`);
    }
  }
}
if (failed) process.exit(1);
console.log('Sintaxe OK');
