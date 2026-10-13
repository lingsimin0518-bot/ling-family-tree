import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROFILES } from './profiles.mjs';

function fail(message) {
  throw new Error(message);
}

function unzipStored(bytes) {
  const files = new Map();
  const decoder = new TextDecoder();
  let offset = 0;
  let foundDirectory = false;
  while (offset + 4 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const signature = view.getUint32(0, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      foundDirectory = true;
      break;
    }
    if (signature !== 0x04034b50 || offset + 30 > bytes.byteLength) fail('ZIP 结构无效');
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      fail('备份 ZIP 必须使用 STORE 格式且不含数据描述符');
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) fail('ZIP 文件被截断');
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (!name || name.startsWith('/') || name.includes('..') || files.has(name)) {
      fail('ZIP 中存在不安全或重复路径');
    }
    files.set(name, bytes.slice(dataStart, dataEnd));
    offset = dataEnd;
  }
  if (!foundDirectory) fail('ZIP 缺少中央目录');
  return files;
}

function parseJson(files, path) {
  const bytes = files.get(path);
  if (!bytes) fail(`缺少备份文件：${path}`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`备份 JSON 无法解析：${path}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readBackupArchive(input) {
  const files = unzipStored(new Uint8Array(await readFile(resolve(input))));
  const manifest = parseJson(files, 'manifest.json');
  const profile = PROFILES[manifest?.schema_version];
  if (
    !profile || manifest.backup_format_version !== 1
    || manifest.project_id !== 'appgprj_6a9b746cbba88191bd63914f864ffb5e'
    || manifest.binding !== 'DB'
    || !profile.recognitionMethods.includes(manifest.schema_recognition_method)
    || !Array.isArray(manifest.tables)
  ) {
    fail('manifest 不是受支持的 0006/16 或 0010/19 表备份');
  }
  if (
    manifest.tables.length !== profile.tables.length
    || profile.tables.some((table, index) => {
      const entry = manifest.tables[index];
      return entry?.table_name !== table
        || entry.file !== `tables/${table}.json`
        || !Number.isSafeInteger(entry.row_count) || entry.row_count < 0
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256);
    })
  ) {
    fail('manifest 的表、路径、行数或校验值不完整');
  }

  const requiredFiles = new Set([
    'manifest.json', 'checksums.json', 'schema/schema.json', 'schema/README.md',
    ...profile.tables.map((table) => `tables/${table}.json`),
  ]);
  if (files.size !== requiredFiles.size || [...requiredFiles].some((path) => !files.has(path))) {
    fail('ZIP 文件集合与 manifest 不一致');
  }
  const requiredChecksums = [...requiredFiles].filter((path) => path !== 'manifest.json' && path !== 'checksums.json');
  const checksums = parseJson(files, 'checksums.json');
  if (
    !checksums || typeof checksums !== 'object' || Array.isArray(checksums)
    || Object.keys(checksums).length !== requiredChecksums.length
    || requiredChecksums.some((path) => typeof checksums[path] !== 'string' || !/^[a-f0-9]{64}$/.test(checksums[path]))
  ) {
    fail('校验和清单不完整');
  }
  for (const path of requiredChecksums) {
    if (sha256(files.get(path)) !== checksums[path]) fail(`SHA-256 校验失败：${path}`);
  }
  for (const entry of manifest.tables) {
    if (sha256(files.get(entry.file)) !== entry.sha256) fail(`表校验失败：${entry.table_name}`);
  }

  const schema = parseJson(files, 'schema/schema.json');
  if (
    schema?.schema_version !== manifest.schema_version
    || schema.schema_recognition_method !== manifest.schema_recognition_method
    || !schema.tables || typeof schema.tables !== 'object' || Array.isArray(schema.tables)
    || Object.keys(schema.tables).length !== profile.tables.length
    || profile.tables.some((table) => !Object.hasOwn(schema.tables, table) || !Array.isArray(schema.tables[table]))
    || !Array.isArray(schema.sqlite_schema)
    || schema.sqlite_schema.some((entry) => !profile.tables.includes(entry.table_name) && !profile.tables.includes(entry.name))
  ) {
    fail('schema 文件与备份版本或业务表不一致');
  }

  const tablePayloads = new Map();
  for (const entry of manifest.tables) {
    const payload = parseJson(files, entry.file);
    if (
      payload?.table_name !== entry.table_name
      || !Array.isArray(payload.columns) || !Array.isArray(payload.rows)
      || payload.rows.length !== entry.row_count
      || payload.columns.some((column) => typeof column?.name !== 'string' || !column.name)
      || payload.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    ) {
      fail(`表文件格式或行数无效：${entry.table_name}`);
    }
    tablePayloads.set(entry.table_name, payload);
  }
  return { profile, manifest, schema, tablePayloads };
}
