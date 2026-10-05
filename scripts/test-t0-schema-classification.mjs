import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProductionSchema } from '../lib/production-schema.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = [
  '0000_multi_family.sql',
  '0001_real_user_auth.sql',
  '0002_wechat_identity.sql',
  '0003_system_admin.sql',
  '0004_unified_person_operations.sql',
  '0005_creation_cooldown.sql',
  '0006_collaboration_persistence.sql',
];

function check(condition, label) {
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}

async function inspectFixture(extraSql) {
  const sqlite = new DatabaseSync(':memory:');
  try {
    for (const migration of migrations) {
      sqlite.exec(await readFile(join(root, 'drizzle', migration), 'utf8'));
    }
    sqlite.exec(extraSql);
    const binding = {
      prepare(sql) {
        return { all: async () => ({ results: sqlite.prepare(sql).all() }) };
      },
    };
    return await inspectProductionSchema(binding);
  } finally {
    sqlite.close();
  }
}

const appgarden = 'CREATE TABLE __appgarden_migrations(id INTEGER PRIMARY KEY, opaque_record TEXT);';
const platform = 'CREATE TABLE "_cf_METADATA"(key TEXT PRIMARY KEY, value TEXT);';
const a = await inspectFixture(appgarden);
check(a.businessTables.length === 16 && a.platformTables.includes('__appgarden_migrations') && a.matchesExpected0006 && a.schemaVersion === '0006' && a.schemaRecognitionMethod === 'structural_inference', 'A：16 表 + Sites 元数据，明确推断 0006 且允许备份');

const b = await inspectFixture(appgarden + platform);
check(b.businessTables.length === 16 && b.platformTables.includes('__appgarden_migrations') && b.platformTables.includes('_cf_METADATA') && b.matchesExpected0006, 'B：两个已知平台表单列，仍为 16 张业务表');

const c = await inspectFixture(appgarden + 'CREATE TABLE unexpected_table(id TEXT PRIMARY KEY);');
check(c.unknownTables.includes('unexpected_table') && !c.matchesExpected0006, 'C：未知额外表必须 fail closed 并报告表名');

const recorded = await inspectFixture(`CREATE TABLE __appgarden_migrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
${migrations.map((name, index) => `INSERT INTO __appgarden_migrations(id,name) VALUES(${index + 1},'${name}');`).join('\n')}`);
check(recorded.schemaVersion === '0006' && recorded.schemaRecognitionMethod === 'sites_migration_record', '可识别的 Sites migration 记录优先于结构推断');
