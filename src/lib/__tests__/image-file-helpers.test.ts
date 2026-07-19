import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/core/errors.js';
import {
  assertSafeBasename,
  removeFileIfExists,
  resolveSafePath,
  writeFileSafely,
} from '@/lib/fileHelpers.js';
import { readImageMetadata } from '@/lib/imageHelpers.js';

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...Buffer.from('GIF89a'),
    width & 0xff,
    (width >>> 8) & 0xff,
    height & 0xff,
    (height >>> 8) & 0xff,
  ]);
}

function webpVp8X(width: number, height: number): Uint8Array {
  const data = new Uint8Array(30);
  data.set(Buffer.from('RIFF'), 0);
  data.set(Buffer.from('WEBP'), 8);
  data.set(Buffer.from('VP8X'), 12);
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  data.set([encodedWidth & 0xff, (encodedWidth >>> 8) & 0xff, (encodedWidth >>> 16) & 0xff], 24);
  data.set([encodedHeight & 0xff, (encodedHeight >>> 8) & 0xff, (encodedHeight >>> 16) & 0xff], 27);
  return data;
}

describe('image helpers', () => {
  it('reads PNG, GIF, and WebP dimensions from headers without decoding pixels', () => {
    expect(readImageMetadata(png(1200, 630))).toEqual({
      contentType: 'image/png',
      width: 1200,
      height: 630,
    });
    expect(readImageMetadata(gif(320, 240))).toEqual({
      contentType: 'image/gif',
      width: 320,
      height: 240,
    });
    expect(readImageMetadata(webpVp8X(800, 600))).toEqual({
      contentType: 'image/webp',
      width: 800,
      height: 600,
    });
  });

  it('rejects empty, truncated, unsupported, and impossible image data', () => {
    expect(() => readImageMetadata(new Uint8Array())).toThrow(ValidationError);
    expect(() => readImageMetadata(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(
      ValidationError,
    );
    expect(() => readImageMetadata(Uint8Array.from([1, 2, 3]))).toThrow(ValidationError);
    expect(() => readImageMetadata(png(0, 1))).toThrow(ValidationError);
  });
});

describe('file helpers', () => {
  it('accepts a plain basename and rejects POSIX/Windows traversal forms', () => {
    expect(assertSafeBasename('image.png')).toBe('image.png');
    for (const filename of [
      '',
      '.',
      '..',
      '../secret.txt',
      '..\\secret.txt',
      'folder/image.png',
      'folder\\image.png',
    ]) {
      expect(() => assertSafeBasename(filename)).toThrow(ValidationError);
    }
  });

  it('resolves paths only underneath the requested directory', () => {
    expect(resolveSafePath('/tmp/scratch', 'image.png')).toMatch(
      /[\\/]tmp[\\/]scratch[\\/]image\.png$/,
    );
    expect(() => resolveSafePath('/tmp/scratch', '../outside.png')).toThrow(ValidationError);
  });

  it('performs async safe write and idempotent cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'blogspage-file-helper-'));
    const path = resolveSafePath(directory, 'asset.bin');

    try {
      await writeFileSafely(path, Uint8Array.from([1, 2, 3]));
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
      await removeFileIfExists(path);
      await removeFileIfExists(path);
      await expect(writeFileSafely(path, new Uint8Array())).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
