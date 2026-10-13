import { readBackupArchive } from './archive-reader.mjs';
import { TABLES_0006 } from './profiles.mjs';

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function sameRows(left, right) {
  const sorted = (rows) => rows.map((row) => JSON.stringify(canonical(row))).sort();
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function sameIds(left, right) {
  const ids = (rows) => rows.map((row) => {
    if (typeof row.id !== 'string' || !row.id) fail('关键表缺少 ID');
    return row.id;
  }).sort();
  return JSON.stringify(ids(left)) === JSON.stringify(ids(right));
}

function normalizeRow(table, row, afterUpgrade) {
  const normalized = { ...row };
  if (table === 'families' && normalized.source_type === 'LEGACY_STATIC') {
    if (
      afterUpgrade
      && (typeof normalized.join_code !== 'string'
        || !/^LEGACY-DISABLED-[a-f0-9]{32}$/.test(normalized.join_code))
    ) {
      fail('0010 备份中仍有未轮换的旧族谱邀请码');
    }
    delete normalized.join_code;
  }
  if (table === 'user_sessions') delete normalized.last_seen_at;
  return normalized;
}

function roleMap(users, familyUsers) {
  const systemRoles = users.map((row) => [row.id, row.system_role]).sort(([a], [b]) => a.localeCompare(b));
  const familyRoles = familyUsers.map((row) => [row.family_id, row.user_id, row.role])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ systemRoles, familyRoles });
}

function ownerMap(familyUsers) {
  return JSON.stringify(
    familyUsers.filter((row) => row.role === 'OWNER')
      .map((row) => [row.family_id, row.user_id])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

async function main() {
  const paths = process.argv.slice(2).filter((argument) => argument !== '--');
  if (paths.length !== 2) {
    fail('用法：node scripts/backup/compare-versions.mjs "<0006.zip>" "<0010.zip>"');
  }
  const before = await readBackupArchive(paths[0]);
  const after = await readBackupArchive(paths[1]);
  if (before.profile.version !== '0006' || after.profile.version !== '0010') {
    fail('比较工具要求先 0006/16 表备份，再 0010/19 表备份');
  }
  const rows = (archive, table) => archive.tablePayloads.get(table).rows;

  for (const table of ['users', 'persons', 'relationships']) {
    if (!sameIds(rows(before, table), rows(after, table))) fail(`${table} 的 ID 集合已变化`);
    console.log(`PASS ${table} ID 集合保持一致`);
  }
  if (!sameIds(rows(before, 'user_sessions'), rows(after, 'user_sessions'))) {
    fail('会话 ID 集合已变化');
  }
  console.log('PASS 会话 ID 集合保持一致（未输出 ID）');
  if (roleMap(rows(before, 'users'), rows(before, 'family_users'))
      !== roleMap(rows(after, 'users'), rows(after, 'family_users'))) {
    fail('系统或族谱成员角色已变化');
  }
  if (ownerMap(rows(before, 'family_users')) !== ownerMap(rows(after, 'family_users'))) {
    fail('OWNER 归属已变化');
  }
  console.log('PASS 系统角色、族谱成员角色与 OWNER 归属保持一致');

  for (const table of TABLES_0006) {
    const oldRows = rows(before, table);
    const newRows = rows(after, table);
    if (oldRows.length !== newRows.length) fail(`${table} 的行数已变化`);
    if (!sameRows(
      oldRows.map((row) => normalizeRow(table, row, false)),
      newRows.map((row) => normalizeRow(table, row, true)),
    )) {
      fail(`${table} 存在超出允许范围的数据差异`);
    }
    console.log(`PASS ${table}: ${oldRows.length} -> ${newRows.length}`);
  }
  for (const table of ['phone_change_challenges', 'sms_verifications', 'user_identities']) {
    console.log(`NEW ${table}: ${rows(after, table).length}`);
  }
  console.log('PASS：原有 16 表仅允许旧族谱邀请码轮换和会话 last_seen_at 变化；未输出个人数据、会话 ID 或邀请码。');
}

main().catch((error) => {
  console.error(`FAIL：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
