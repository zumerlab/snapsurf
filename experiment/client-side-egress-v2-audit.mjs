#!/usr/bin/env node
/** Recompute directional contract evidence from the immutable v2 raw-body archive. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RESULT = join(ROOT, 'experiment', 'results', 'client-side-egress-v2.json')
const ARCHIVE = join(ROOT, 'experiment', 'results', 'client-side-egress-v2.artifacts.json.gz')
const OUTPUT = join(ROOT, 'experiment', 'results', 'client-side-egress-v2.directional-audit.json')
const CHECK = process.argv.includes('--check')

const resultBytes = await readFile(RESULT)
const archiveBytes = await readFile(ARCHIVE)
const result = JSON.parse(resultBytes)
const archive = JSON.parse(gunzipSync(archiveBytes))
const bodies = new Map(archive.bodies.map((entry) => [entry.id, entry]))

const trials = result.primary.trials.map((trial) => {
  const prefix = `rows-${trial.rowCount}-rep-${trial.rep}`
  const ariaPre = body(`${prefix}:aria:pre`)
  const ariaPost = body(`${prefix}:aria:post`)
  const snapPre = JSON.parse(body(`${prefix}:snapdom:pre`))
  const snapPost = JSON.parse(body(`${prefix}:snapdom:post`))
  const aria = ariaContract(ariaPre, ariaPost)
  const snapdom = snapdomContract(snapPre, snapPost)
  return { id: trial.id, rowCount: trial.rowCount, rep: trial.rep, aria, snapdom }
})

const integrity = {
  sourceResultSha256: sha256(resultBytes),
  sourceArchiveSha256: sha256(archiveBytes),
  sourceArchiveMatchesResult: sha256(archiveBytes) === result.artifactArchive.sha256,
  trials: trials.length,
  expectedTrials: result.primary.rowScales.length * result.primary.repetitions,
  allAriaDirectionalContractsExact: trials.every((trial) => trial.aria.exactPrePost),
  allSnapdomDirectionalContractsExact: trials.every((trial) => trial.snapdom.exactPrePost),
}
if (integrity.trials !== integrity.expectedTrials ||
    !integrity.sourceArchiveMatchesResult ||
    !integrity.allAriaDirectionalContractsExact ||
    !integrity.allSnapdomDirectionalContractsExact) {
  throw new Error(`directional audit failed: ${JSON.stringify(integrity)}`)
}

const output = {
  schema: 1,
  classification: 'read-only directional audit of retained client-side-egress-v2 evidence bodies',
  question: 'Do the retained pre/post bodies prove the authored state transition in the correct direction, rather than merely containing all four strings?',
  exactContract: result.exactContract,
  trials,
  integrity,
  caveats: [
    'This audit strengthens the fixture-level evidence check; it does not make ARIA and SnapDOM equivalent evidence formats.',
    'The fixture and expected fields remain self-authored and synthetic.',
  ],
}
const outputBytes = `${JSON.stringify(output, null, 2)}\n`
if (CHECK) {
  const existing = await readFile(OUTPUT, 'utf8')
  if (existing !== outputBytes) throw new Error('directional audit result is stale')
} else {
  await writeFile(OUTPUT, outputBytes, { flag: 'wx', mode: 0o600 })
}
process.stdout.write(`${JSON.stringify({ output: OUTPUT, mode: CHECK ? 'check' : 'write', integrity }, null, 2)}\n`)

function body(id) {
  const entry = bodies.get(id)
  if (!entry) throw new Error(`missing archived body ${id}`)
  if (Buffer.byteLength(entry.body, 'utf8') !== entry.byteLength || sha256(entry.body) !== entry.sha256) {
    throw new Error(`archived body integrity failed for ${id}`)
  }
  return entry.body
}

function ariaContract(pre, post) {
  const checks = {
    preBanner: /^- banner "Cart 0 \| Ready":$/m.test(pre),
    preCart: /^ {2}- button "Cart 0"$/m.test(pre),
    preStatus: /^ {2}- status: Ready$/m.test(pre),
    postBanner: /^- banner "Cart 1 \| Added Item 0":$/m.test(post),
    postCart: /^ {2}- button "Cart 1"$/m.test(post),
    postStatus: /^ {2}- status: Added Item 0$/m.test(post),
    preHasNoPostState: !/^ {2}- button "Cart 1"$|^ {2}- status: Added Item 0$/m.test(pre),
    postHasNoPreState: !/^ {2}- button "Cart 0"$|^ {2}- status: Ready$/m.test(post),
  }
  return { checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function snapdomContract(preReply, postReply) {
  const pre = preReply.result || {}
  const post = postReply.result || {}
  const mark = (value, name) => (value.digest?.marks || []).some((entry) => entry.role === 'banner' && entry.name === name)
  const cart = (value, name) => (value.digest?.top || []).some((entry) => entry.selector === '#cart' && entry.role === 'button' && entry.name === name)
  const transition = (role, beforeName, name) => (post.changes || []).some((change) =>
    change.role === role && change.beforeName === beforeName && change.name === name)
  const checks = {
    preIsBaseline: pre.changed === undefined,
    preBanner: mark(pre, 'Cart 0 | Ready'),
    preCart: cart(pre, 'Cart 0'),
    postChanged: post.changed === true,
    postBanner: mark(post, 'Cart 1 | Added Item 0'),
    postCart: cart(post, 'Cart 1'),
    bannerDirection: transition('banner', 'Cart 0 | Ready', 'Cart 1 | Added Item 0'),
    badgeDirection: transition('generic', '0', '1'),
    statusDirection: transition('status', 'Ready', 'Added Item 0'),
  }
  return { checks, exactPrePost: Object.values(checks).every(Boolean) }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
