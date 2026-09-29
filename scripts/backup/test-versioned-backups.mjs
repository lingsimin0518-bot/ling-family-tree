import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message) {
  throw new Error(message);
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) fail(`命令失败：node ${args.join(' ')}`);
  return result.stdout ?? '';
}

for (const schemaVersion of ['0006', '0010']) {
  const output = runNode([
    '--experimental-strip-types',
    join(projectRoot, 'scripts', 'backup', 'create-local-test-backup.mjs'),
    '--schema',
    schemaVersion,
  ]);
  const zipPath = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith('.zip'));
  if (!zipPath) fail(`未找到 schema ${schemaVersion} 测试备份路径`);
  runNode([join(projectRoot, 'scripts', 'backup', 'verify-and-restore.mjs'), zipPath]);
}

console.log('PASS：0006/16表与0010/19表备份、校验和、恢复、行数及外键检查全部通过。');
