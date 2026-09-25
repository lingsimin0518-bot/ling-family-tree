export type BackupArchiveFile = {
  path: string;
  bytes: Uint8Array;
};

const encoder = new TextEncoder();

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const time =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    Math.floor(date.getUTCSeconds() / 2);
  const day =
    ((year - 1980) << 9) |
    ((date.getUTCMonth() + 1) << 5) |
    date.getUTCDate();
  return { time, day };
}

function localHeader(name: Uint8Array, size: number, crc: number, date: Date) {
  const output = new Uint8Array(30 + name.byteLength);
  const view = new DataView(output.buffer);
  const stamp = dosDateTime(date);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.day, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.byteLength, true);
  view.setUint16(28, 0, true);
  output.set(name, 30);
  return output;
}

function centralHeader(
  name: Uint8Array,
  size: number,
  crc: number,
  offset: number,
  date: Date,
) {
  const output = new Uint8Array(46 + name.byteLength);
  const view = new DataView(output.buffer);
  const stamp = dosDateTime(date);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.day, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  output.set(name, 46);
  return output;
}

function endRecord(entries: number, centralSize: number, centralOffset: number) {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return output;
}

export function createStoredZipStream(files: BackupArchiveFile[], timestamp = new Date()) {
  if (files.length > 0xffff) throw new Error('备份文件数量超过 ZIP 格式限制');
  const names = new Set<string>();
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('..')) {
      throw new Error(`备份文件路径不安全：${file.path}`);
    }
    if (names.has(file.path)) throw new Error(`备份文件重复：${file.path}`);
    if (file.bytes.byteLength > 0xffffffff) throw new Error(`备份文件过大：${file.path}`);
    names.add(file.path);
  }

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const header = localHeader(name, file.bytes.byteLength, crc, timestamp);
    central.push(centralHeader(name, file.bytes.byteLength, crc, offset, timestamp));
    chunks.push(header, file.bytes);
    offset += header.byteLength + file.bytes.byteLength;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((total, header) => total + header.byteLength, 0);
  chunks.push(...central, endRecord(files.length, centralSize, centralOffset));

  let nextChunk = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (nextChunk >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[nextChunk]);
      nextChunk += 1;
    },
  });
}
