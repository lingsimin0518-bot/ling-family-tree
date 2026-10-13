import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyProductionTables, inspectProductionSchema } from '../../lib/production-schema.ts';
import { MIGRATIONS_0010, MIGRATIONS_0006 } from './profiles.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function check(condition, label) {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

function bindingFrom(sqlite) {
  return {
    prepare(sql) {
      return { all: async () => ({ results: sqlite.prepare(sql).all() }) };
    },
  };
}

const partial = classifyProductionTables(['users', 'user_identities']);
check(partial.profileVersion === '0010' && partial.missingTables.includes('sms_verifications'), '部分认证升级不能归类为 0006');

const sqlite = new DatabaseSync(':memory:');
try {
  for (const migration of MIGRATIONS_0006) {
    sqlite.exec(await readFile(join(root, 'drizzle', migration), 'utf8'));
  }
  sqlite.exec(await readFile(join(root, 'scripts/backup/fixtures/local-test-data.sql'), 'utf8'));
  sqlite.exec('CREATE TABLE __appgarden_migrations(id INTEGER PRIMARY KEY, opaque_record TEXT)');
  const binding = bindingFrom(sqlite);
  let inspected = await inspectProductionSchema(binding);
  check(inspected.matchesExpected0006 && !inspected.matchesExpected0010, '0006/16 表可按结构推断');

  for (const migration of MIGRATIONS_0010.slice(MIGRATIONS_0006.length, -1)) {
    sqlite.exec(await readFile(join(root, 'drizzle', migration), 'utf8'));
  }
  inspected = await inspectProductionSchema(binding);
  check(inspected.schemaVersion === '0009' && !inspected.matchesExpected0010, '19 表无可读迁移记录时不能推断 0010');

  sqlite.exec(await readFile(join(root, 'drizzle/0010_security_s0_containment.sql'), 'utf8'));
  sqlite.exec('DROP TABLE __appgarden_migrations');
  sqlite.exec('CREATE TABLE __appgarden_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  for (const [index, migration] of MIGRATIONS_0010.entries()) {
    sqlite.prepare('INSERT INTO __appgarden_migrations(id,name) VALUES(?,?)').run(index + 1, migration);
  }
  inspected = await inspectProductionSchema(binding);
  check(inspected.matchesExpected0010 && inspected.schemaRecognitionMethod === 'sites_migration_record', '0010/19 表需 Sites 迁移记录且邀请码已轮换');

  sqlite.exec("UPDATE families SET join_code='LINGSHI' WHERE id='f-legacy'");
  inspected = await inspectProductionSchema(binding);
  check(!inspected.matchesExpected0010, '记录为 0010 但旧邀请码未轮换时拒绝备份');
  sqlite.exec("UPDATE families SET join_code='LEGACY-DISABLED-0123456789abcdef0123456789abcdef' WHERE id='f-legacy'");
  sqlite.exec('CREATE TABLE unexpected_table(id TEXT PRIMARY KEY)');
  inspected = await inspectProductionSchema(binding);
  check(!inspected.matchesExpected0010 && inspected.unknownTables.includes('unexpected_table'), '未知额外表令 0010 备份 fail closed');
} finally {
  sqlite.close();
}
