import { inflateSync } from 'node:zlib';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_DIMENSION = 4096;

export type ValidatedPng = { bytes: Buffer; width: number; height: number };

/** Validates PNG signature and decoded IHDR dimensions before any storage write. */
export function validatePngBase64(dataBase64: string): ValidatedPng {
  let bytes: Buffer;
  try { bytes = Buffer.from(dataBase64, 'base64'); } catch { throw new Error('Logo must be valid base64 PNG data.'); }
  if (!bytes.length || bytes.byteLength > MAX_LOGO_BYTES) throw new Error(`Logo must be no larger than ${MAX_LOGO_BYTES} bytes.`);
  const signature = '89504e470d0a1a0a';
  if (bytes.byteLength < 45 || bytes.subarray(0, 8).toString('hex') !== signature) throw new Error('Logo must be a PNG image.');
  let offset = 8; let width = 0; let height = 0; let sawHeader = false; let sawImageData = false; let sawEnd = false;
  const imageData: Buffer[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error('Logo must be a complete PNG image.');
    const length = bytes.readUInt32BE(offset); const type = bytes.subarray(offset + 4, offset + 8); const dataStart = offset + 8; const dataEnd = dataStart + length; const crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > bytes.byteLength) throw new Error('Logo must be a complete PNG image.');
    if (crc32(Buffer.concat([type, bytes.subarray(dataStart, dataEnd)])) !== bytes.readUInt32BE(dataEnd)) throw new Error('Logo PNG checksum is invalid.');
    const name = type.toString('ascii');
    if (!sawHeader && name !== 'IHDR') throw new Error('Logo PNG header is invalid.');
    if (name === 'IHDR') { if (sawHeader || length !== 13) throw new Error('Logo PNG header is invalid.'); width = bytes.readUInt32BE(dataStart); height = bytes.readUInt32BE(dataStart + 4); sawHeader = true; }
    else if (name === 'IDAT') { if (!sawHeader || sawEnd) throw new Error('Logo PNG data is invalid.'); sawImageData = true; imageData.push(bytes.subarray(dataStart, dataEnd)); }
    else if (name === 'IEND') { if (length !== 0 || !sawImageData || crcEnd !== bytes.byteLength) throw new Error('Logo PNG ending is invalid.'); sawEnd = true; }
    offset = crcEnd;
  }
  if (!sawHeader || !sawImageData || !sawEnd) throw new Error('Logo must be a complete PNG image.');
  if (!width || !height || width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) throw new Error('Logo dimensions are invalid.');
  try { inflateSync(Buffer.concat(imageData), { maxOutputLength: 64 * 1024 * 1024 }); } catch { throw new Error('Logo PNG data cannot be decoded.'); }
  return { bytes, width, height };
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
