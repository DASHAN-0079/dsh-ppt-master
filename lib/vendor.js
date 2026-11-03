/** Deterministic digest of the vendored skill tree, independent of the host line endings. */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Normalize text line endings the way the upstream integrity gate does, while staying
 * byte-safe for binary assets.
 * @param buffer - raw file bytes.
 */
export function normalizeBytes(buffer) {
  const text = buffer.toString('latin1')
  if (!text.includes('\r')) return buffer
  return Buffer.from(text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n'), 'latin1')
}

/**
 * List every file under a directory, ordered by portable relative path.
 * @param root - absolute directory.
 */
export function listTree(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(root)
  return files
    .map((file) => ({ file, path: relative(root, file).split(sep).join('/') }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * Hash every relative path with the hash of its normalized content.
 * @param root - absolute directory.
 */
export function treeDigest(root) {
  const digest = createHash('sha256')
  for (const entry of listTree(root)) {
    const contentHash = createHash('sha256').update(normalizeBytes(readFileSync(entry.file))).digest('hex')
    digest.update(`${entry.path}\n${contentHash}\n`)
  }
  return `sha256:${digest.digest('hex')}`
}

/**
 * Count files and bytes in a tree.
 * @param root - absolute directory.
 */
export function treeStats(root) {
  const entries = listTree(root)
  let totalBytes = 0
  for (const entry of entries) totalBytes += readFileSync(entry.file).length
  return { fileCount: entries.length, totalBytes }
}
