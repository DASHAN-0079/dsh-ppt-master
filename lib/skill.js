/** The skill provider that publishes the vendored PPT Master skill. */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { PAYLOAD_DIR, PAYLOAD_SKILL_MD, adapterMarkdown, ensureWorkingCopy, inspectEnvironment, stripFrontmatter } from './host.js'

/**
 * Rank reserved for skills shipped inside a bundle (`BUNDLED_SKILL_RANK` in
 * `@deepseek-ai/dsh-skill`). Kept local so the package has no runtime dependency.
 */
const BUNDLED_SKILL_RANK = 600

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u

const FALLBACK_DESCRIPTION =
  'Generate natively editable PowerPoint decks from documents, PDFs, and web pages, or beautify, template, and edit existing PPTX files.'

/** Unquote a plain frontmatter scalar value. */
function scalar(value) {
  const trimmed = value.trim()
  if (trimmed.length > 1) {
    const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    if (quoted) return trimmed.slice(1, -1).replace(/\s+/gu, ' ').trim()
  }
  return trimmed.replace(/\s+/gu, ' ').trim()
}

/** Convert a host path into the portable form the skill registry stores. */
export function portablePath(path) {
  return path.split(sep).join('/')
}

/**
 * Read `name` and `description` out of YAML frontmatter without a YAML dependency.
 * Handles plain scalars and `|` / `>` block scalars; ignores every other key.
 * @param markdown - the raw SKILL.md text.
 */
export function readFrontmatter(markdown) {
  const match = FRONTMATTER.exec(markdown)
  if (match?.[1] === undefined) return {}
  const lines = match[1].split(/\r?\n/u)
  const result = {}
  for (let index = 0; index < lines.length; index += 1) {
    const keyMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/u.exec(lines[index] ?? '')
    const key = keyMatch?.[1]
    if (key === undefined) continue
    if (key !== 'name' && key !== 'description') continue
    const inlineValue = (keyMatch?.[2] ?? '').trim()
    if (/^[|>][-+]?$/u.test(inlineValue)) {
      const block = []
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? ''
        if (line.trim().length === 0) {
          block.push('')
          continue
        }
        if (!/^[ \t]/u.test(line)) break
        block.push(line.trim())
      }
      result[key] = block.join(' ').replace(/\s+/gu, ' ').trim()
      continue
    }
    if (inlineValue.length > 0) result[key] = scalar(inlineValue)
  }
  return result
}

/**
 * Create the provider for the vendored skill.
 * @param options - `name`, `description`, and an optional `debug` logger.
 */
export function definePptMasterSkill(options = {}) {
  const skillName = options.name ?? 'ppt-master'
  const fallbackDescription = options.description ?? FALLBACK_DESCRIPTION
  const debug = options.debug

  /** Catalog metadata is read from the immutable payload, so listing never copies files. */
  const catalogEntry = () => {
    if (!existsSync(PAYLOAD_SKILL_MD)) {
      debug?.(`vendored skill payload is missing: ${PAYLOAD_SKILL_MD}`)
      return undefined
    }
    const frontmatter = readFrontmatter(readFileSync(PAYLOAD_SKILL_MD, 'utf8'))
    return {
      name: skillName,
      description: frontmatter.description ?? fallbackDescription,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'bundled',
      provider: 'dsh-ppt-master',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: portablePath(PAYLOAD_DIR) },
      locator: portablePath(join(PAYLOAD_DIR, 'SKILL.md')),
    }
  }

  return {
    name: 'dsh-ppt-master',
    list() {
      const candidate = catalogEntry()
      return Promise.resolve(candidate === undefined ? [] : [candidate])
    },
    async get(candidate, registrationOptions = {}) {
      if (candidate.name !== skillName) return undefined
      const { rank: _rank, locator: _locator, ...summary } = candidate
      let working
      const notices = []
      try {
        working = ensureWorkingCopy({ quiet: true })
      } catch (error) {
        working = undefined
        const reason = error instanceof Error ? error.message : String(error)
        debug?.(`working copy failed: ${reason}`)
        notices.push(
          `> Wrapper warning: the writable working copy could not be created (${reason}). The skill still loads from the installed payload, but template-library registration will fail until the data directory is writable.`,
          '',
        )
      }
      const base = working?.skillDir
      const file = base !== undefined && existsSync(join(base, 'SKILL.md')) ? join(base, 'SKILL.md') : PAYLOAD_SKILL_MD
      const markdown = await readFile(file, registrationOptions.signal === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', signal: registrationOptions.signal })
      return {
        ...summary,
        description: readFrontmatter(markdown).description ?? summary.description,
        content: `${stripFrontmatter(markdown).trimEnd()}\n\n${notices.join('\n')}${adapterMarkdown(inspectEnvironment(), base ?? PAYLOAD_DIR)}`,
        resourceBase: { kind: 'directory', path: portablePath(base ?? PAYLOAD_DIR) },
        provider: 'dsh-ppt-master',
      }
    },
  }
}
