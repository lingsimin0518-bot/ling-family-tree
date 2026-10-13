import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('public/family.html');
const source = await readFile(target, 'utf8');
const commentMarker = '// 规范化族谱测试数据。新增人物均为虚构，仅用于验证产品功能。';
const functionMarker = 'async function loadCurrentFamilyTree()';
const comment = source.indexOf(commentMarker);
const functionStart = source.indexOf(functionMarker, comment);
const start = source.lastIndexOf('<script>', comment);
const end = source.lastIndexOf('<script>', functionStart);

if (start < 0 || end < 0 || end <= start) {
  throw new Error('未找到预期的旧静态族谱数据块；为避免误删，已停止。');
}

const replacement = `<script>\r
// S0 containment: real genealogy data must never ship in a public static asset.
window.NORMALIZED_FAMILY_TREE = null;\r
\r
</script>\r

`;
const sanitized = source.slice(0, start) + replacement + source.slice(end);
await writeFile(target, sanitized, 'utf8');
console.log(`Removed ${end - start} bytes of embedded genealogy data from public/family.html.`);
