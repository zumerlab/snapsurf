/**
 * install-global.mjs — installs the oracle harness as a MACHINE-GLOBAL tool
 * (~/.claude/snapdom-agent), independent of which branch the repo sits on:
 *
 *   node packages/agent/tools/install-global.mjs      # run from agent-lab
 *
 * Writes:
 *   ~/.claude/snapdom-agent/browse.mjs   copy of the CLI/daemon
 *   ~/.claude/snapdom-agent/sdk.js       prebuilt bundle (oracle + snapdom + plugins)
 *   ~/.claude/snapdom-agent/paths.json   repo path (for node_modules/playwright)
 *   ~/.claude/skills/agent-browse/       USER-level skill (every session)
 *
 * Re-run after changing packages/agent/src or browse.mjs to refresh.
 * NOTHING is published: everything stays in this machine's ~/.claude.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const HOME = process.env.HOME
const DEST = join(HOME, '.claude', 'snapdom-agent')
const SKILLDIR = join(HOME, '.claude', 'skills', 'agent-browse')

// Same bundle definition the daemon builds in dev mode — one source, no drift.
const { buildSdk } = await import(join(HERE, 'sdk-bundle.mjs'))
const SDK = await buildSdk(REPO)

await mkdir(DEST, { recursive: true })
await mkdir(join(DEST, 'logs'), { recursive: true })
await writeFile(join(DEST, 'sdk.js'), SDK)
await copyFile(join(HERE, 'browse.mjs'), join(DEST, 'browse.mjs'))
await writeFile(join(DEST, 'paths.json'), JSON.stringify({ repo: REPO }))

// User-level skill: the repo one, with the global harness paths.
const skill = await readFile(join(REPO, '.claude', 'skills', 'agent-browse', 'SKILL.md'), 'utf8')
await mkdir(SKILLDIR, { recursive: true })
await writeFile(join(SKILLDIR, 'SKILL.md'),
  skill.replaceAll('packages/agent/tools/browse.mjs', join(DEST, 'browse.mjs'))
    .replace('# agent-browse — browse with the oracle instead of screenshots',
      `# agent-browse — browse with the oracle instead of screenshots\n\n> MACHINE-GLOBAL install (~/.claude/snapdom-agent). Refresh after agent-lab changes:\n> \`node ${join(REPO, 'packages/agent/tools/install-global.mjs')}\``))

console.log(`installed:\n  ${join(DEST, 'browse.mjs')} (+ sdk.js ${Math.round(SDK.length / 1024)}KB, paths.json, logs/)\n  ${join(SKILLDIR, 'SKILL.md')} (user-level global skill)`)
