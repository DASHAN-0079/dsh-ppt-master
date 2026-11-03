/** Contract tests for the vendored skill provider. Run with `node --test test/`. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  CLI_PATH,
  PACKAGE_ROOT,
  PAYLOAD_DIR,
  adapterMarkdown,
  ensureWorkingCopy,
  inspectEnvironment,
  resolvePython,
  stripFrontmatter,
} from '../lib/host.js'
import { apply } from '../lib/index.js'
import { definePptMasterSkill, portablePath, readFrontmatter } from '../lib/skill.js'
import { treeDigest } from '../lib/vendor.js'

const vendor = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'VENDOR.json'), 'utf8'))
const skillMarkdown = readFileSync(join(PAYLOAD_DIR, 'SKILL.md'), 'utf8')

test('payload is byte-identical to VENDOR.json', () => {
  assert.equal(treeDigest(PAYLOAD_DIR), vendor.treeDigest)
  assert.ok(existsSync(join(PAYLOAD_DIR, 'scripts', 'attribution_guard.py')))
  assert.ok(existsSync(join(PAYLOAD_DIR, 'workflows', 'routing.md')))
})

test('frontmatter parser reads the real skill header', () => {
  const frontmatter = readFrontmatter(skillMarkdown)
  assert.equal(frontmatter.name, 'ppt-master')
  assert.ok((frontmatter.description ?? '').length > 100)
  assert.equal(readFrontmatter('---\nname: block\ndescription: >\n  one\n  two\n---\nbody').description, 'one two')
  assert.equal(readFrontmatter('no frontmatter').name, undefined)
  assert.equal(stripFrontmatter(skillMarkdown).startsWith('---'), false)
})

test('provider lists exactly one bundled candidate', async () => {
  const provider = definePptMasterSkill()
  assert.equal(provider.name, 'dsh-ppt-master')
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const [candidate] = candidates
  assert.equal(candidate.name, 'ppt-master')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, 600)
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  assert.ok(candidate.description.length > 80)
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.ok(existsSync(candidate.resourceBase.path))
})

test('provider loads the full body plus the adapter note', async () => {
  const provider = definePptMasterSkill()
  const [candidate] = await provider.list({})
  const definition = await provider.get(candidate, {})
  assert.ok(definition !== undefined)
  assert.equal(definition.content.startsWith('---'), false)
  assert.match(definition.content, /Role Switch/u)
  assert.match(definition.content, /attribution_guard\.py/u)
  assert.match(definition.content, /## Runtime adapter \(installed by the DeepSeek Harness plugin\)/u)
  assert.ok(definition.content.includes(CLI_PATH))
  assert.ok(existsSync(join(definition.resourceBase.path, 'workflows', 'routing.md')))
  assert.equal(await provider.get({ ...candidate, name: 'other' }, {}), undefined)
})

test('working copy exists and passes the upstream integrity gate', (context) => {
  const working = ensureWorkingCopy({ quiet: true })
  assert.ok(existsSync(join(working.skillDir, 'SKILL.md')))
  const python = resolvePython()
  if (python.missing === true) {
    context.diagnostic('no python interpreter; gate not exercised')
    return
  }
  const guard = join(working.skillDir, 'scripts', 'attribution_guard.py')
  const result = spawnSync(python.command, [...python.prefixArgs, guard], { encoding: 'utf8', timeout: 180000 })
  assert.equal(result.status, 0, String(result.stderr))
})

test('adapter note reports the live environment', () => {
  const note = adapterMarkdown(inspectEnvironment(), PAYLOAD_DIR)
  assert.match(note, /Skill base directory/u)
  assert.ok(note.includes(PAYLOAD_DIR))
  assert.match(note, /doctor/u)
})

test('apply() registers the provider through ctx.effect and disposes it', async () => {
  const disposers = []
  const created = { provider: undefined }
  const context = {
    effect(create) {
      const disposer = create()
      disposers.push(disposer)
      return disposer
    },
    skills: {
      registerProvider(createProvider) {
        created.provider = createProvider({ signal: new AbortController().signal, invalidate() {} })
        return () => {
          created.provider = undefined
        }
      },
    },
  }
  apply(context, {})
  assert.equal(created.provider.name, 'dsh-ppt-master')
  assert.equal((await created.provider.list({})).length, 1)
  for (const disposer of disposers) disposer()
  assert.equal(created.provider, undefined)
})
