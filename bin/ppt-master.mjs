#!/usr/bin/env node
/**
 * Cross-platform CLI for the vendored PPT Master skill.
 *
 * Every skill script is launched through this CLI with an absolute interpreter, UTF-8 stdio,
 * an explicit working directory, and the writable working copy of the skill tree.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  CLI_PATH,
  DATA_DIR,
  EXTERNAL_BINARIES,
  HOST_JSON,
  PACKAGE_ROOT,
  REPO_ROOT,
  SKILL_DIR,
  SKILL_MD,
  VENV_DIR,
  VENV_DIR as ISOLATED_DIR,
  ensureWorkingCopy,
  findBinary,
  readHostState,
  requirementNamesFrom,
  resolvePython,
  venvPython,
} from '../lib/host.js'
import { treeDigest, treeStats } from '../lib/vendor.js'

const USAGE = `dsh-ppt-master — DeepSeek Harness wrapper for the PPT Master skill

Usage: node "${CLI_PATH}" <command> [options]

  doctor [--json]     Materialize the working copy, verify the integrity gate, the
                     interpreter, the requirements, and the optional external tools
  install-deps [--optional]
                     Create the isolated environment and install requirements.txt;
                     --optional adds rapidocr + onnxruntime for OCR
  run <script> [args...]
                     Run a skill script (relative paths resolve inside the skill)
  materialize         Refresh the writable working copy after an upgrade
  where [--json]      Print every path and the selected interpreter
  digest [--write]    Print or refresh the vendored tree digest
  version             Print the wrapper and upstream versions

Environment:
  PPT_MASTER_PYTHON           interpreter override for every command
  PPT_MASTER_SKILL_DIR        use this skill directory instead of the working copy
  PPT_MASTER_DATA             writable data root (default: $DSH_HOME/ppt-master)
  PPT_MASTER_VENV             isolated environment path (default: <data>/venv)

Start every command from the session working directory: project directories are created
under \`projects/\` there.
`

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const REQUIREMENTS = () => join(SKILL_DIR, 'requirements.txt')

function mergeState(patch) {
  const previous = readHostState() ?? {}
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(HOST_JSON, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
  return next
}

const DEPENDENCY_SCRIPT = [
  'import json, sys',
  'import importlib.metadata as metadata',
  'out = {}',
  'for name in sys.argv[1:]:',
  '    try:',
  '        out[name] = metadata.version(name)',
  '    except Exception:',
  '        out[name] = None',
  'print(json.dumps(out))',
].join('\n')

/** Ask one interpreter which requirements are importable. */
function dependencyStatus(python) {
  const manifest = REQUIREMENTS()
  const names = existsSync(manifest) ? requirementNamesFrom(manifest) : []
  if (python === undefined || python.missing === true) {
    return { total: names.length, installed: [], missing: names, versions: {}, error: 'no interpreter' }
  }
  const result = spawnSync(python.command, [...python.prefixArgs, '-c', DEPENDENCY_SCRIPT, ...names], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    return { total: names.length, installed: [], missing: names, versions: {}, error: String(result.stderr ?? result.error?.message ?? '').trim() }
  }
  let versions = {}
  try {
    versions = JSON.parse(String(result.stdout ?? '').trim())
  } catch {
    versions = {}
  }
  const installed = names.filter((name) => typeof versions[name] === 'string')
  const missing = names.filter((name) => typeof versions[name] !== 'string')
  return { total: names.length, installed, missing, versions }
}

/** Run the upstream fail-closed integrity gate from the working copy. */
function integrityStatus(python) {
  const guard = join(SKILL_DIR, 'scripts', 'attribution_guard.py')
  if (!existsSync(guard)) return { path: guard, status: null, stderr: 'missing script' }
  if (python === undefined || python.missing === true) return { path: guard, status: null, stderr: 'no interpreter' }
  const result = spawnSync(python.command, [...python.prefixArgs, guard], { encoding: 'utf8', timeout: 180000, windowsHide: true })
  return {
    path: guard,
    status: result.status,
    stderr: String(result.stderr ?? '').trim(),
    error: result.error === undefined ? undefined : String(result.error.message),
  }
}

function describePython(python) {
  if (python.missing === true) return { found: false, attempts: python.attempts }
  return {
    found: true,
    command: python.command,
    prefixArgs: python.prefixArgs,
    executable: python.executable,
    version: python.version,
    source: python.label,
    isolated: python.venv === true,
  }
}

function collectFacts() {
  const python = resolvePython()
  const isolated = venvPython()
  const tools = {}
  for (const name of EXTERNAL_BINARIES) tools[name] = findBinary(name)
  return {
    packageRoot: PACKAGE_ROOT,
    dataDir: DATA_DIR,
    repoRoot: REPO_ROOT,
    skillDir: SKILL_DIR,
    venvDir: VENV_DIR,
    venvPython: isolated,
    requirements: REQUIREMENTS(),
    python: describePython(python),
    state: readHostState(),
    projectsRoot: join(process.cwd(), 'projects'),
    platform: process.platform,
    node: process.version,
    tools,
  }
}

function commandWhere(args) {
  const facts = collectFacts()
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(facts, undefined, 2)}\n`)
    return facts.python.found ? 0 : 3
  }
  const lines = [
    `skill            ${facts.skillDir}`,
    `requirements     ${facts.requirements}`,
    `package payload  ${join(PACKAGE_ROOT, 'skills', 'ppt-master')}`,
    `data             ${facts.dataDir}`,
    `venv             ${facts.venvPython ?? `${facts.venvDir} (not created)`}`,
    `python           ${facts.python.found ? `${facts.python.executable} (Python ${facts.python.version}, ${facts.python.source})` : 'not found'}`,
    `projects         ${facts.projectsRoot}`,
    `platform         ${facts.platform} · node ${facts.node}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return facts.python.found ? 0 : 3
}

function commandDoctor(args) {
  let working
  try {
    working = ensureWorkingCopy({ quiet: args.includes('--json') })
  } catch (error) {
    fail(`Could not materialize the skill: ${error instanceof Error ? error.message : String(error)}`, 2)
  }
  const facts = collectFacts()
  const python = resolvePython()
  const integrity = integrityStatus(python)
  const dependencies = dependencyStatus(python)
  const missingTools = Object.entries(facts.tools)
    .filter(([, path]) => path === undefined)
    .map(([name]) => name)
  const ok = facts.python.found && integrity.status === 0
  mergeState({
    workingCopy: { ...(readHostState()?.workingCopy ?? {}), skillDir: SKILL_DIR, source: working.source },
    python: facts.python,
    dependencies: { total: dependencies.total, installed: dependencies.installed, missing: dependencies.missing },
    installed: dependencies.installed,
    integrityExit: integrity.status,
    doctorAt: new Date().toISOString(),
  })
  const report = { ok, workingCopy: working, ...facts, integrity, dependencies, missingTools }
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`)
    return ok ? 0 : 1
  }
  const mark = (value) => (value ? 'ok  ' : 'FAIL')
  const lines = [
    `${mark(facts.python.found)}  python          ${facts.python.found ? `${facts.python.executable} (Python ${facts.python.version}, ${facts.python.source})` : 'not found — run install-deps'}`,
    `${mark(facts.python.found && facts.python.isolated)}  isolated env    ${facts.venvPython ?? 'not created — run install-deps'}`,
    `${mark(integrity.status === 0)}  integrity gate  ${integrity.status === 0 ? 'exit 0' : `exit ${String(integrity.status)} ${integrity.stderr}`.trim()}`,
    `${dependencies.missing.length === 0 ? 'ok  ' : 'warn'}  dependencies    ${String(dependencies.installed.length)}/${String(dependencies.total)} installed${dependencies.missing.length > 0 ? ` (missing: ${dependencies.missing.join(', ')})` : ''}`,
    `${missingTools.length === 0 ? 'ok  ' : 'warn'}  external tools  ${missingTools.length === 0 ? 'all present' : `missing: ${missingTools.join(', ')}`}`,
    `      skill           ${facts.skillDir}`,
    `      projects        ${facts.projectsRoot}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (!ok) process.stdout.write('\nRun `install-deps`, then rerun `doctor`.\n')
  return ok ? 0 : 1
}

function commandInstallDeps(args) {
  ensureWorkingCopy({ quiet: true })
  const optional = args.includes('--optional')
  const base = resolvePython({ useVenv: false })
  if (base.missing === true) {
    fail(`No Python interpreter found. Tried: ${(base.attempts ?? []).join(', ')}. Install Python 3.9+ or set PPT_MASTER_PYTHON.`, 3)
  }
  mkdirSync(DATA_DIR, { recursive: true })
  let python = venvPython()
  if (python === undefined) {
    process.stdout.write(`Creating isolated environment: ${ISOLATED_DIR}\nUsing ${base.executable} (Python ${base.version})\n`)
    const created = spawnSync(base.command, [...base.prefixArgs, '-m', 'venv', ISOLATED_DIR], { stdio: 'inherit' })
    if (created.status !== 0) fail(`Could not create the isolated environment (exit ${String(created.status)}). Install the venv module or a full CPython build.`, 1)
    python = venvPython()
    if (python === undefined) fail(`Virtual environment created but no interpreter found under ${ISOLATED_DIR}`, 1)
  }
  process.stdout.write(`Installing ${REQUIREMENTS()}\n`)
  const installed = spawnSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', REQUIREMENTS()], {
    stdio: 'inherit',
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
  })
  let optionalStatus = 'skipped'
  if (optional) {
    process.stdout.write('Installing optional OCR dependencies: rapidocr onnxruntime\n')
    const extra = spawnSync(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'rapidocr', 'onnxruntime'], {
      stdio: 'inherit',
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    })
    optionalStatus = extra.status === 0 ? 'installed' : 'failed'
  }
  const pythonFacts = { missing: false, command: python, prefixArgs: [] }
  const dependencies = dependencyStatus(pythonFacts)
  const integrity = integrityStatus(pythonFacts)
  const payload = mergeState({
    schemaVersion: 1,
    platform: process.platform,
    node: process.version,
    basePython: { executable: base.executable, version: base.version },
    venvPython: python,
    requirements: REQUIREMENTS(),
    total: dependencies.total,
    installed: dependencies.installed,
    missing: dependencies.missing,
    optional: optionalStatus,
    pipExitCode: installed.status,
    integrityExit: integrity.status,
    ok: installed.status === 0 && dependencies.missing.length === 0,
  })
  process.stdout.write(`\n${payload.ok ? 'ok' : 'incomplete'}: ${String(dependencies.installed.length)}/${String(dependencies.total)} requirements installed\n`)
  if (!payload.ok) {
    process.stdout.write(`Installed packages are incomplete. Retry with: node "${CLI_PATH}" install-deps\n`)
    return 1
  }
  process.stdout.write(`Integrity gate: exit ${String(integrity.status)}\nNext: node "${CLI_PATH}" doctor\n`)
  return 0
}

function commandRun(args) {
  const script = args[0]
  if (script === undefined) fail('run needs a script path, for example: run scripts/project_manager.py init deck', 2)
  ensureWorkingCopy({ quiet: true })
  const target = isAbsolute(script) ? resolve(script) : resolve(SKILL_DIR, script)
  const inside = relative(SKILL_DIR, target)
  if (inside.startsWith('..') || isAbsolute(inside)) fail(`Refusing to run a script outside the skill directory: ${target}`, 2)
  if (!existsSync(target)) fail(`Script not found: ${target}`, 2)
  const python = resolvePython()
  if (python.missing === true) fail(`No Python interpreter found (tried ${(python.attempts ?? []).join(', ')}). Run install-deps first.`, 3)
  const result = spawnSync(python.command, [...python.prefixArgs, target, ...args.slice(1)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONLEGACYWINDOWSSTDIO: '0' },
  })
  if (result.error !== undefined) fail(`Could not start ${python.executable}: ${result.error.message}`, 3)
  return result.status ?? 1
}

function commandMaterialize() {
  const working = ensureWorkingCopy()
  process.stdout.write(`${working.fresh ? 'materialized' : 'up to date'}: ${working.skillDir}\n`)
  return 0
}

function commandDigest(args) {
  const stats = treeStats(SKILL_DIR)
  const digest = treeDigest(SKILL_DIR)
  const payload = { treeDigest: digest, ...stats }
  if (args.includes('--write')) {
    const manifestPath = join(PACKAGE_ROOT, 'VENDOR.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...stats, treeDigest: digest }, undefined, 2)}\n`, 'utf8')
    process.stdout.write(`Updated ${manifestPath}\n`)
  }
  process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`)
  return 0
}

function commandVersion() {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const vendor = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'VENDOR.json'), 'utf8'))
  const python = resolvePython()
  process.stdout.write(`dsh-ppt-master ${manifest.version}\n`)
  process.stdout.write(`ppt-master ${vendor.upstream.version} (${String(vendor.upstream.commit).slice(0, 12)}, ${String(vendor.upstream.ref)})\n`)
  process.stdout.write(`node ${process.version} · ${process.platform} · python ${python.missing === true ? 'not found' : String(python.version)}\n`)
  return 0
}

function main(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case 'where':
      return commandWhere(rest)
    case 'doctor':
      return commandDoctor(rest)
    case 'install-deps':
    case 'install':
      return commandInstallDeps(rest)
    case 'run':
      return commandRun(rest)
    case 'materialize':
      return commandMaterialize()
    case 'digest':
      return commandDigest(rest)
    case 'version':
    case '--version':
      return commandVersion()
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`)
      process.stdout.write(USAGE)
      return 2
  }
}

process.exitCode = main(process.argv.slice(2))
