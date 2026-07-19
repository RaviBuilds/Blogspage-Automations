import { ValidationError } from '@/core/errors.js';

/** Image metadata derived from binary headers without decoding full pixel data. */
export interface ImageMetadata {
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_SIGNATURES = ['GIF87a', 'GIF89a'];

/**
 * Reads image format and dimensions from PNG, JPEG, GIF, or WebP binary data.
 * It validates only headers — it does not decode pixels or make any I/O call.
 *
 * @throws {ValidationError} When the input is empty, truncated, unsupported,
 * malformed, or reports impossible dimensions.
 */
export function readImageMetadata(data: Uint8Array): ImageMetadata {
  if (data.byteLength === 0) {
    throw new ValidationError('image-helpers', ['Image data must be non-empty.']);
  }

  const png = tryReadPng(data);
  if (png !== undefined) return png;
  const gif = tryReadGif(data);
  if (gif !== undefined) return gif;
  const webp = tryReadWebp(data);
  if (webp !== undefined) return webp;
  const jpeg = tryReadJpeg(data);
  if (jpeg !== undefined) return jpeg;

  throw new ValidationError('image-helpers', ['Unsupported or malformed image data.']);
}

/** Verifies a buffer is a supported image and returns its metadata. */
export function assertSupportedImage(data: Uint8Array): ImageMetadata {
  return readImageMetadata(data);
}

function tryReadPng(data: Uint8Array): ImageMetadata | undefined {
  if (!matchesBytes(data, PNG_SIGNATURE)) return undefined;
  if (data.byteLength < 24 || readAscii(data, 12, 4) !== 'IHDR') {
    throw new ValidationError('image-helpers', [
      'PNG data is truncated or missing its IHDR header.',
    ]);
  }
  return dimensions('image/png', readUInt32BE(data, 16), readUInt32BE(data, 20));
}

function tryReadGif(data: Uint8Array): ImageMetadata | undefined {
  if (data.byteLength < 6 || !GIF_SIGNATURES.includes(readAscii(data, 0, 6))) return undefined;
  if (data.byteLength < 10) throw new ValidationError('image-helpers', ['GIF data is truncated.']);
  return dimensions(
    'image/gif',
    (data[6] ?? 0) | ((data[7] ?? 0) << 8),
    (data[8] ?? 0) | ((data[9] ?? 0) << 8),
  );
}

function tryReadWebp(data: Uint8Array): ImageMetadata | undefined {
  if (data.byteLength < 16 || readAscii(data, 0, 4) !== 'RIFF' || readAscii(data, 8, 4) !== 'WEBP')
    return undefined;
  const chunk = readAscii(data, 12, 4);
  if (chunk === 'VP8X') {
    if (data.byteLength < 30)
      throw new ValidationError('image-helpers', ['WebP VP8X data is truncated.']);
    return dimensions('image/webp', readUInt24LE(data, 24) + 1, readUInt24LE(data, 27) + 1);
  }
  if (chunk === 'VP8 ') {
    if (data.byteLength < 30 || data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) {
      throw new ValidationError('image-helpers', ['WebP VP8 data is malformed.']);
    }
    return dimensions(
      'image/webp',
      ((data[26] ?? 0) | ((data[27] ?? 0) << 8)) & 0x3fff,
      ((data[28] ?? 0) | ((data[29] ?? 0) << 8)) & 0x3fff,
    );
  }
  throw new ValidationError('image-helpers', [`Unsupported WebP chunk type: ${chunk}.`]);
}

function tryReadJpeg(data: Uint8Array): ImageMetadata | undefined {
  if (data.byteLength < 2 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < data.byteLength) {
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    const length = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
    if (length < 2 || offset + length > data.byteLength)
      throw new ValidationError('image-helpers', ['JPEG segment is truncated.']);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return dimensions(
        'image/jpeg',
        ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0),
        ((data[offset + 3] ?? 0) << 8) | (data[offset + 4] ?? 0),
      );
    }
    offset += length;
  }
  throw new ValidationError('image-helpers', [
    'JPEG does not contain a supported baseline dimensions segment.',
  ]);
}

function dimensions(
  contentType: ImageMetadata['contentType'],
  width: number,
  height: number,
): ImageMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ValidationError('image-helpers', ['Image dimensions must be positive integers.']);
  }
  return { contentType, width, height };
}

function matchesBytes(data: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => data[index] === value);
}
function readAscii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.slice(start, start + length));
}
function readUInt32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) * 2 ** 24 +
    ((data[offset + 1] ?? 0) << 16) +
    ((data[offset + 2] ?? 0) << 8) +
    (data[offset + 3] ?? 0)
  );
}
function readUInt24LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
}
