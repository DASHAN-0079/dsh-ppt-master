#!/usr/bin/env node
/**
 * Refresh VENDOR.json from a payload directory.
 *
 * Usage: node scripts/build-vendor.mjs [payloadDir]
 *   payloadDir defaults to <package>/skills/ppt-master and must contain SKILL.md.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGE_ROOT, PAYLOAD_DIR } from '../lib/host.js'
import { treeDigest, treeStats } from '../lib/vendor.js'

const source = resolve(process.argv[2] ?? PAYLOAD_DIR)
const skillMd = join(source, 'SKILL.md')
if (!existsSync(skillMd)) {
  process.stderr.write(`No SKILL.md under ${source}\n`)
  process.exit(2)
}

/** Pull `metadata.version` out of the SKILL.md frontmatter. */
function skillVersion(markdown) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1] ?? ''
  return /^\s+version:\s*["']?([^"'\s]+)/mu.exec(frontmatter)?.[1]
}

function gitValue(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

const upstreamRoot = resolve(source, '..', '..')
const stats = treeStats(source)
const digest = treeDigest(source)
const previous = existsSync(join(PACKAGE_ROOT, 'VENDOR.json')) ? JSON.parse(readFileSync(join(PACKAGE_ROOT, 'VENDOR.json'), 'utf8')) : {}

const manifest = {
  schemaVersion: 1,
  upstream: {
    repository: previous.upstream?.repository ?? 'https://github.com/hugohe3/ppt-master',
    ref: gitValue(['rev-parse', '--abbrev-ref', 'HEAD'], upstreamRoot) ?? previous.upstream?.ref ?? 'main',
    commit: gitValue(['rev-parse', 'HEAD'], upstreamRoot) ?? previous.upstream?.commit,
    version: skillVersion(readFileSync(skillMd, 'utf8')) ?? previous.upstream?.version,
    license: 'MIT',
    copyright: 'Copyright (c) 2025-2026 Hugo He',
  },
  vendoredAt: new Date().toISOString(),
  skillPath: 'skills/ppt-master',
  ...stats,
  treeDigest: digest,
}

writeFileSync(join(PACKAGE_ROOT, 'VENDOR.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
process.stdout.write(`VENDOR.json written: ${String(stats.fileCount)} files, ${(stats.totalBytes / 1048576).toFixed(1)} MiB, ${digest}\n`)
process.stdout.write(`upstream ${String(manifest.upstream.version)} @ ${String(manifest.upstream.commit).slice(0, 12)}\n`)
