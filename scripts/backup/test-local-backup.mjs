import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const create = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/backup/create-local-test-backup.mjs')], { cwd: root, env: process.env, encoding: 'utf8' });
if (create.status !== 0) throw new Error(create.stderr || create.stdout || '本地备份夹具创建失败');
const zipPath = create.stdout.trim().split(/\r?\n/).find((line) => line.endsWith('.zip'));
if (!zipPath) throw new Error('未找到本地测试备份 ZIP');
const verify = spawnSync(process.execPath, [join(root, 'scripts/backup/verify-and-restore.mjs'), zipPath], { cwd: root, env: process.env, encoding: 'utf8' });
process.stdout.write(verify.stdout || '');
if (verify.status !== 0) throw new Error(verify.stderr || '16表本地恢复验证失败');
