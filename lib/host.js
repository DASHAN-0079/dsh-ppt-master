/** Host facts for the vendored skill: paths, the writable working copy, and interpreter discovery. */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute package root (…/node_modules/dsh-ppt-master). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Immutable payload shipped in the package. */
export const PAYLOAD_DIR = join(PACKAGE_ROOT, 'skills', 'ppt-master')
export const PAYLOAD_SKILL_MD = join(PAYLOAD_DIR, 'SKILL.md')
export const VENDOR_JSON = join(PACKAGE_ROOT, 'VENDOR.json')
export const CLI_PATH = join(PACKAGE_ROOT, 'bin', 'ppt-master.mjs')
export const IS_WINDOWS = process.platform === 'win32'

/** Writable data root: never inside the immutable bundle, never inside a skill root. */
export function resolveDataDir() {
  const configured = process.env.PPT_MASTER_DATA
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  const home = process.env.DSH_HOME
  if (home !== undefined && home.trim().length > 0) return join(resolve(home), 'ppt-master')
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(resolve(userHome), '.dsh', 'ppt-master')
}

export const DATA_DIR = resolveDataDir()
/** Writable repository-shaped working root: `skills/ppt-master` lives two levels down. */
export const REPO_ROOT = join(DATA_DIR, 'repo')
export const SKILL_DIR = join(REPO_ROOT, 'skills', 'ppt-master')
export const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
export const VENV_DIR = resolve(process.env.PPT_MASTER_VENV ?? join(DATA_DIR, 'venv'))
export const HOST_JSON = join(DATA_DIR, 'host.json')

function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Aggregate vendor facts written at package time. */
export function readVendorManifest() {
  return readJson(VENDOR_JSON)
}

/** Interpreter inside the isolated environment, when it exists. */
export function venvPython() {
  const candidates = IS_WINDOWS ? [join(VENV_DIR, 'Scripts', 'python.exe')] : [join(VENV_DIR, 'bin', 'python3'), join(VENV_DIR, 'bin', 'python')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

/**
 * Materialize (or refresh) the writable working copy.
 *
 * The npm payload is hardlinked into the pnpm store, so writing template indexes inside it
 * would corrupt the store entry; every route therefore runs against this copy instead.
 * @param options - `quiet` suppresses progress output.
 */
export function ensureWorkingCopy(options = {}) {
  const override = process.env.PPT_MASTER_SKILL_DIR
  if (override !== undefined && override.trim().length > 0) {
    return { skillDir: resolve(override), source: 'override', fresh: false }
  }
  const vendor = readVendorManifest()
  const state = readJson(HOST_JSON)
  const expected = vendor?.treeDigest
  const recorded = state?.workingCopy?.payloadDigest
  if (existsSync(SKILL_MD) && typeof expected === 'string' && recorded === expected) {
    return { skillDir: SKILL_DIR, source: 'copy', fresh: false }
  }
  if (!existsSync(PAYLOAD_SKILL_MD)) {
    if (existsSync(SKILL_MD)) return { skillDir: SKILL_DIR, source: 'copy', fresh: false }
    throw new Error(`Vendored skill payload is missing: ${PAYLOAD_DIR}`)
  }
  const staging = `${SKILL_DIR}.staging-${String(process.pid)}`
  if (!options.quiet) process.stderr.write(`[dsh-ppt-master] Materializing a writable skill copy at ${SKILL_DIR}\n`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(dirname(SKILL_DIR), { recursive: true })
  cpSync(PAYLOAD_DIR, staging, { recursive: true, dereference: true })
  rmSync(SKILL_DIR, { recursive: true, force: true })
  renameSync(staging, SKILL_DIR)
  const nextState = {
    ...(state ?? {}),
    workingCopy: {
      payloadDigest: expected ?? 'unknown',
      source: PAYLOAD_DIR,
      version: vendor?.upstream?.version,
      copiedAt: new Date().toISOString(),
    },
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(HOST_JSON, `${JSON.stringify(nextState, undefined, 2)}\n`, 'utf8')
  return { skillDir: SKILL_DIR, source: 'copy', fresh: true }
}

function spawnEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONLEGACYWINDOWSSTDIO: '0' }
}

const PROBE = 'import json,sys;print(json.dumps({"executable":sys.executable,"version":"%d.%d.%d"%sys.version_info[:3]}))'

/** Windows ships a `python3` App Execution Alias that exits 9009 instead of running Python. */
function isWindowsStoreStub(command) {
  return IS_WINDOWS && /[\\/]windowsapps[\\/]python3?\.exe$/iu.test(command)
}

/**
 * Verify one interpreter candidate by asking it for its own executable and version.
 * @param command - executable name or absolute path.
 * @param prefixArgs - launcher arguments, for example `['-3']` for `py`.
 */
export function probePython(command, prefixArgs = []) {
  if (isWindowsStoreStub(command)) return { missing: true, reason: 'windows-store-stub', command }
  const result = spawnSync(command, [...prefixArgs, '-c', PROBE], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: spawnEnv() })
  if (result.error !== undefined) return { missing: true, reason: String(result.error.message), command }
  if (result.status !== 0) return { missing: true, reason: `exit ${String(result.status)}`, command }
  try {
    const payload = JSON.parse(String(result.stdout ?? '').trim())
    if (typeof payload.executable !== 'string' || typeof payload.version !== 'string') return { missing: true, reason: 'unexpected probe output', command }
    return { missing: false, command, prefixArgs, executable: payload.executable, version: payload.version }
  } catch {
    return { missing: true, reason: 'unparseable probe output', command }
  }
}

const CANDIDATES = IS_WINDOWS
  ? [
      { command: 'py', prefixArgs: ['-3'], label: 'py -3' },
      { command: 'py', prefixArgs: [], label: 'py' },
      { command: 'python3', prefixArgs: [], label: 'python3' },
      { command: 'python', prefixArgs: [], label: 'python' },
    ]
  : [
      { command: 'python3', prefixArgs: [], label: 'python3' },
      { command: 'python', prefixArgs: [], label: 'python' },
    ]

const cache = {}

/**
 * Resolve the interpreter the wrapper should use.
 * Order: explicit override, isolated environment, then the platform launchers.
 * @param options - `useVenv: false` skips the isolated environment (used to create it).
 */
export function resolvePython(options = {}) {
  const useVenv = options.useVenv !== false
  const key = useVenv ? 'venv' : 'base'
  if (cache[key] !== undefined) return cache[key]
  const attempts = []
  const override = process.env.PPT_MASTER_PYTHON
  if (override !== undefined && override.trim().length > 0) {
    const trimmed = override.trim()
    const probe = probePython(trimmed, [])
    if (probe.missing !== true) {
      cache[key] = { ...probe, label: 'PPT_MASTER_PYTHON' }
      return cache[key]
    }
    process.stderr.write(`[dsh-ppt-master] PPT_MASTER_PYTHON is not usable: ${String(probe.reason)}\n`)
    attempts.push(`PPT_MASTER_PYTHON=${trimmed}: ${String(probe.reason)}`)
  }
  if (useVenv) {
    const isolated = venvPython()
    if (isolated !== undefined) {
      const probe = probePython(isolated, [])
      if (probe.missing !== true) {
        cache[key] = { ...probe, label: 'isolated', venv: true }
        return cache[key]
      }
      attempts.push(`${isolated}: ${String(probe.reason)}`)
    }
  }
  for (const candidate of CANDIDATES) {
    const probe = probePython(candidate.command, candidate.prefixArgs)
    if (probe.missing !== true) {
      cache[key] = { ...probe, label: candidate.label }
      return cache[key]
    }
    attempts.push(`${candidate.label}: ${String(probe.reason)}`)
  }
  cache[key] = { missing: true, attempts }
  return cache[key]
}

/** Locate one external executable without spawning a shell. */
export function findBinary(name) {
  const exts = IS_WINDOWS ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of exts) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`)
      if (existsSync(candidate)) return candidate
      const upper = join(directory, `${name}${extension.toUpperCase()}`)
      if (existsSync(upper)) return upper
    }
  }
  return undefined
}

/** The external tools some routes optionally call. */
export const EXTERNAL_BINARIES = ['ffmpeg', 'ffprobe', 'pandoc', 'git', 'magick', 'soffice']

/** Recorded result of the last successful `install-deps` run, when present. */
export function readHostState() {
  return readJson(HOST_JSON)
}

/** Read the skill's declared dependency names. */
export function requirementNamesFrom(file) {
  const names = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const trimmed = (line.split('#')[0] ?? '').split(';')[0]?.trim() ?? ''
    if (trimmed.length === 0) continue
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(trimmed)
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return names
}

/** Drop a leading YAML frontmatter block. */
export function stripFrontmatter(markdown) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(markdown)
  return match === null ? markdown : markdown.slice(match[0].length)
}

/** Collect the cheap environment facts the adapter note and the CLI report need. */
export function inspectEnvironment() {
  const python = resolvePython()
  const state = readHostState()
  const requirements = existsSync(join(SKILL_DIR, 'requirements.txt')) ? requirementNamesFrom(join(SKILL_DIR, 'requirements.txt')) : []
  const installed = Array.isArray(state?.installed) ? state.installed.length : 0
  const tools = {}
  for (const name of EXTERNAL_BINARIES) tools[name] = findBinary(name)
  return {
    projectsRoot: join(process.cwd(), 'projects'),
    python: python.missing === true ? undefined : { version: python.version, executable: python.executable, label: python.label },
    isolated: python.missing !== true && python.venv === true,
    dependenciesTotal: requirements.length,
    dependenciesInstalled: installed,
    dependenciesReady: requirements.length > 0 && installed >= requirements.length,
    integrityExit: state?.integrityExit,
    tools,
  }
}

/**
 * Build the host note appended to the skill instructions.
 * @param environment - the environment facts from `inspectEnvironment`.
 * @param baseDir - the directory the skill instructions must resolve relative paths against.
 */
export function adapterMarkdown(environment, baseDir = SKILL_DIR) {
  const tools = environment.tools ?? {}
  const missingTools = Object.entries(tools)
    .filter(([, path]) => path === undefined)
    .map(([name]) => name)
  const lines = [
    '## Runtime adapter (installed by the DeepSeek Harness plugin)',
    '',
    'This installation is a DeepSeek Harness plugin, not a repository checkout and not a Claude Code skill directory.',
    '',
    `- Skill base directory (working copy, writable): \`${baseDir}\``,
    `- For every instruction that writes \`skills/ppt-master/...\`, resolve it as \`${baseDir}/...\`. Never \`cd\`, never treat the current working directory as the skill directory.`,
    `- The installed payload is integrity-gated: never edit \`SKILL.md\`, \`LICENSE\`, \`SPONSORS.md\`, \`SPONSORS_CN.md\`, or the script files inside the skill directory.`,
    `- Project directories default to \`projects/\` under the session working directory (${environment.projectsRoot}). Start every skill script from the session working directory.`,
    `- User secrets belong in \`~/.ppt-master/.env\`; never write automatic keys into the skill directory.`,
    '',
    'Interpreter and command form:',
    '',
    `- Selected interpreter: ${environment.python === undefined ? 'none found' : `Python ${environment.python.version} (${environment.python.executable}, from ${environment.python.label})`}.`,
    `- Dependency environment: ${environment.dependenciesReady ? `ready (${String(environment.dependenciesInstalled)}/${String(environment.dependenciesTotal)} requirements installed)` : 'not installed yet'}.`,
    `- Integrity gate: ${environment.integrityExit === 0 ? 'passing' : 'not executed yet'}.`,
    '',
    'Never call `python3`, `python`, or `pip` directly: the interpreter name differs per platform, the Windows `python3` alias is frequently an App Execution Alias that exits 9009, and every child process needs UTF-8 stdio. Translate each documented command from this skill into the wrapper form below; the wrapper selects the interpreter, sets `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8`, and keeps your working directory.',
    '',
    'Preflight once per session, then run every skill script through the wrapper:',
    '',
    '```bash',
    `node "${CLI_PATH}" doctor`,
    `node "${CLI_PATH}" run scripts/project_manager.py init <project_name>`,
    '```',
    '',
    'If `doctor` reports missing requirements, install them once and rerun it:',
    '',
    '```bash',
    `node "${CLI_PATH}" install-deps`,
    '```',
    '',
    `- \`node "${CLI_PATH}" where\` prints the paths and the selected interpreter without changing anything.`,
    '',
    'Platform substitutions inside this skill\'s prose (translate them, do not run them literally):',
    '',
    `- \`python3 -m pip ...\` / \`pip install ...\` → ask the user, or run \`node "${CLI_PATH}" install-deps --optional\` when the package is a declared requirement.`,
    '- `/tmp/...` paths → `%TEMP%` on Windows, `$TMPDIR` on macOS.',
    '- POSIX `\\` line continuations, `&&`, `$VAR`, and `~/` are not portable to PowerShell or cmd.',
    '- `powershell.exe` + PowerPoint COM (the narrated-video route) exists only on Windows with desktop PowerPoint installed.',
    '',
  ]
  if (missingTools.length > 0) {
    lines.push(
      `Optional external tools not found on this host: ${missingTools.join(', ')}. Routes that need them must stop and tell the user instead of failing mid-run.`,
      '',
    )
  }
  if (!environment.dependenciesReady) {
    lines.push(
      'Until `install-deps` succeeds, report the packages `doctor` lists as missing instead of guessing. Only the SVG finalizer and the PPTX exporter need `python-pptx`, `skia-pathops`, `uharfbuzz`, and `XlsxWriter`.',
      '',
    )
  }
  return lines.join('\n')
}
