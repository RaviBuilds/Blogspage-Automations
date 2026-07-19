import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

import { ValidationError } from '@/core/errors.js';

/**
 * Ensures `filename` is one plain basename, rejecting traversal and separators
 * across Windows and POSIX path conventions.
 *
 * @throws {ValidationError} When the filename is unsafe.
 */
export function assertSafeBasename(filename: string): string {
  if (filename.length === 0 || filename === '.' || filename === '..') {
    throw new ValidationError('file-helpers', ['filename must be a non-empty basename.']);
  }
  if (filename.includes('/') || filename.includes('\\') || basename(filename) !== filename) {
    throw new ValidationError('file-helpers', [`Unsafe filename: "${filename}".`]);
  }
  return filename;
}

/**
 * Resolves a filename under `directory`, rejecting any value that could escape
 * the directory through Windows or POSIX traversal syntax.
 */
export function resolveSafePath(directory: string, filename: string): string {
  const safeFilename = assertSafeBasename(filename);
  const root = resolve(directory);
  const target = resolve(root, safeFilename);
  if (target !== `${root}${sep}${safeFilename}`) {
    throw new ValidationError('file-helpers', [`Resolved path escapes directory: "${filename}".`]);
  }
  return target;
}

/**
 * Asynchronously writes a buffer to a validated path, creating its parent
 * directory as needed. No synchronous filesystem I/O is used.
 */
export async function writeFileSafely(path: string, data: Uint8Array): Promise<void> {
  if (data.byteLength === 0) {
    throw new ValidationError('file-helpers', ['Refusing to write an empty file buffer.']);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** Asynchronously deletes a local scratch file, ignoring an already-absent file. */
export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}
