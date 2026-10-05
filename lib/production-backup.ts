import { env } from 'cloudflare:workers';
import hostingConfig from '../.openai/hosting.json';
import type { BackupArchiveFile } from './backup-archive';
import {
  inspectProductionSchema,
  PRODUCTION_BACKUP_TABLES,
  type ProductionBackupTable,
  type SchemaRecognitionMethod,
} from './production-schema';

export { PRODUCTION_BACKUP_TABLES } from './production-schema';

type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SchemaObject = {
  type: string;
  name: string;
  table_name: string;
  sql: string | null;
};

type TableManifest = {
  table_name: ProductionBackupTable;
  file: string;
  row_count: number;
  sha256: string;
};

export type ProductionBackupManifest = {
  backup_format_version: 1;
  schema_version: string;
  schema_recognition_method: SchemaRecognitionMethod;
  export_started_at: string;
  export_finished_at: string;
  project_id: string;
  binding: string;
  tables: TableManifest[];
};

const encoder = new TextEncoder();
const MAX_TABLE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 48 * 1024 * 1024;

export class BackupLimitError extends Error {}
export class BackupSchemaMismatchError extends Error {}

function db() {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error('平台数据库尚未绑定');
  return binding;
}

function bytesToBase64(bytes: Uint8Array) {
  let output = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    output += String.fromCharCode(...chunk);
  }
  return btoa(output);
}

function backupValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return { __backup_type: 'blob', base64: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __backup_type: 'blob',
      base64: bytesToBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  }
  return value;
}

function backupRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, backupValue(value)]),
  );
}

function jsonBytes(value: unknown) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function countFrom(result: D1Result<unknown>) {
  const first = result.results[0] as Record<string, unknown> | undefined;
  const value = Number(first?.total ?? Number.NaN);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('数据库返回了无效的行数');
  }
  return value;
}

async function readCounts(binding: D1Database) {
  const results = await binding.batch(
    PRODUCTION_BACKUP_TABLES.map((table) =>
      binding.prepare(`SELECT COUNT(*) AS total FROM "${table}"`),
    ),
  );
  return new Map(
    PRODUCTION_BACKUP_TABLES.map((table, index) => [table, countFrom(results[index])]),
  );
}

export type ProductionBackup = {
  manifest: ProductionBackupManifest;
  files: BackupArchiveFile[];
};

export async function createProductionBackup(): Promise<ProductionBackup> {
  const binding = db();
  const exportStartedAt = new Date().toISOString();
  const schemaResult = await binding
    .prepare(`SELECT type,name,tbl_name AS table_name,sql FROM sqlite_schema
      WHERE type IN ('table','index') ORDER BY type,name`)
    .all<SchemaObject>();
  const inspection = await inspectProductionSchema(binding);
  if (!inspection.matchesExpected0006) {
    throw new BackupSchemaMismatchError(`生产数据库与 0006/16 表备份白名单不一致：缺少 ${inspection.missingTables.join('、') || '无'}；未知额外表 ${inspection.unknownTables.join('、') || '无'}；结构版本 ${inspection.schemaVersion}`);
  }
  const schemaVersion = inspection.schemaVersion;
  const countsBefore = await readCounts(binding);
  const tableFiles: BackupArchiveFile[] = [];
  const tableManifests: TableManifest[] = [];
  const schemaTables: Record<string, ColumnInfo[]> = {};
  let totalJsonBytes = 0;

  for (const table of PRODUCTION_BACKUP_TABLES) {
    const [columnsResult, rowsResult] = await Promise.all([
      binding.prepare(`PRAGMA table_info("${table}")`).all<ColumnInfo>(),
      binding.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>(),
    ]);
    const expectedCount = countsBefore.get(table);
    if (rowsResult.results.length !== expectedCount) {
      throw new Error(`表 ${table} 读取数量不一致，备份已终止`);
    }
    schemaTables[table] = columnsResult.results;
    const path = `tables/${table}.json`;
    const bytes = jsonBytes({
      table_name: table,
      columns: columnsResult.results,
      rows: rowsResult.results.map(backupRow),
    });
    if (bytes.byteLength > MAX_TABLE_JSON_BYTES) {
      throw new BackupLimitError(`表 ${table} 超过单表安全导出上限，未生成备份`);
    }
    totalJsonBytes += bytes.byteLength;
    if (totalJsonBytes > MAX_TOTAL_JSON_BYTES) {
      throw new BackupLimitError('备份数据超过 Worker 安全内存上限，未生成备份');
    }
    tableFiles.push({ path, bytes });
    tableManifests.push({
      table_name: table,
      file: path,
      row_count: rowsResult.results.length,
      sha256: await sha256(bytes),
    });
  }

  const countsAfter = await readCounts(binding);
  for (const table of PRODUCTION_BACKUP_TABLES) {
    if (countsBefore.get(table) !== countsAfter.get(table)) {
      throw new Error(`导出期间表 ${table} 行数发生变化，备份已终止`);
    }
  }
  const inspectionAfter = await inspectProductionSchema(binding);
  if (!inspectionAfter.matchesExpected0006 || inspectionAfter.schemaVersion !== schemaVersion || inspectionAfter.businessTables.join('|') !== inspection.businessTables.join('|')) {
    throw new BackupSchemaMismatchError('导出期间数据库结构发生变化，备份已终止');
  }

  const schemaJson = jsonBytes({
    schema_version: schemaVersion,
    schema_recognition_method: inspection.schemaRecognitionMethod,
    tables: schemaTables,
    sqlite_schema: schemaResult.results.filter(
      (entry) =>
        PRODUCTION_BACKUP_TABLES.includes(entry.table_name as ProductionBackupTable) ||
        PRODUCTION_BACKUP_TABLES.includes(entry.name as ProductionBackupTable),
    ),
  });
  const schemaReadme = encoder.encode(
    `生产 D1 逻辑备份\n\nSchema version: ${schemaVersion}\n` +
      `Tables: ${PRODUCTION_BACKUP_TABLES.length}\n` +
      '此备份包含账号、会话、联系方式、密码哈希及完整族谱资料。请勿公开或提交到 Git。\n',
  );
  const checksums: Record<string, string> = {};
  for (const file of [...tableFiles, { path: 'schema/schema.json', bytes: schemaJson }]) {
    checksums[file.path] = await sha256(file.bytes);
  }
  checksums['schema/README.md'] = await sha256(schemaReadme);

  const manifest: ProductionBackupManifest = {
    backup_format_version: 1,
    schema_version: schemaVersion,
    schema_recognition_method: inspection.schemaRecognitionMethod,
    export_started_at: exportStartedAt,
    export_finished_at: new Date().toISOString(),
    project_id: hostingConfig.project_id,
    binding: hostingConfig.d1 ?? 'DB',
    tables: tableManifests,
  };
  const manifestBytes = jsonBytes(manifest);
  const checksumBytes = jsonBytes(checksums);

  return {
    manifest,
    files: [
      { path: 'manifest.json', bytes: manifestBytes },
      { path: 'checksums.json', bytes: checksumBytes },
      { path: 'schema/schema.json', bytes: schemaJson },
      { path: 'schema/README.md', bytes: schemaReadme },
      ...tableFiles,
    ],
  };
}
