import { createHash, createHmac } from 'node:crypto'
import { CASES, FIXTURE_VERSION, VARIANTS } from './cases.mjs'

export const PROTOCOL_VERSION = 1
export const ARMS = Object.freeze(['playwright-authored', 'snapdom-authored'])
export const DEFAULT_SEED = 'snapdom-multisite-pilot-v1-2026-08-12'

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const sha256 = (value) => createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalJson(value))
  .digest('hex')

const opaque = (truthSalt, ...parts) => createHmac('sha256', truthSalt)
  .update(parts.join('\0'))
  .digest('hex')
  .slice(0, 24)

const publicCase = (entry) => ({
  schemaVersion: 1,
  caseId: entry.id,
  siteId: entry.siteId,
  title: entry.title,
  fixture: { version: FIXTURE_VERSION, viewport: [1280, 720], locale: 'en-US', timezone: 'UTC' },
  preconditions: entry.preconditions,
  action: entry.action,
  postcondition: { deadlineMs: 2_000, conjuncts: entry.conjuncts },
})

const keyedOrder = (values, truthSalt, seed, domain, identify) => values
  .map((value) => ({
    value,
    rank: createHmac('sha256', truthSalt)
      .update(`${domain}\0${seed}\0${identify(value)}`)
      .digest('hex'),
  }))
  .sort((a, b) => a.rank.localeCompare(b.rank))
  .map(({ value }) => value)

export function buildProtocol({ repetitions = 10, seed = DEFAULT_SEED, truthSalt } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error('repetitions must be an integer from 1 to 20')
  }
  if (!/^[a-f0-9]{64}$/i.test(truthSalt || '')) {
    throw new Error('truthSalt must be a secret 32-byte hex value')
  }
  const sealedPairs = []
  for (const testCase of CASES) {
    for (const variant of VARIANTS) {
      const startWithSnapdom = Number.parseInt(opaque(truthSalt, seed, testCase.id, variant, 'order').slice(0, 2), 16) % 2 === 0
      const opaqueVariantId = opaque(truthSalt, seed, testCase.id, variant, 'variant')
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const snapdomFirst = (repetition % 2 === 0) === startWithSnapdom
        const order = snapdomFirst ? [ARMS[1], ARMS[0]] : [ARMS[0], ARMS[1]]
        const pairId = opaque(truthSalt, seed, testCase.id, opaqueVariantId, repetition, 'pair')
        sealedPairs.push({
          pairId,
          caseId: testCase.id,
          siteId: testCase.siteId,
          opaqueVariantId,
          variant,
          expectedTruth: variant === 'intended' ? 'PASS' : 'FAIL',
          violatedConjuncts: variant === 'intended' ? [] : testCase.conjuncts.map((entry) => entry.id)
            .filter((id) => {
              const byCase = {
                T1: ['target-added', 'count-plus-one', 'no-draft-only'], T2: ['target-completed', 'neighbor-stable'],
                T3: ['completed-absent'], T4: ['target-removed', 'neighbor-present'],
                S1: ['inventory-visible', 'login-absent', 'error-absent'], S2: ['target-button-transition', 'neighbor-stable'],
                S3: ['target-removed', 'neighbor-present'], I1: ['checkbox-absent'], I2: ['textbox-enabled'],
                I3: ['hello-visible'], B1: ['close-actionable'], B2: ['backdrop-absent', 'launcher-actionable'],
              }
              return byCase[testCase.id].includes(id)
            }),
          repetition,
          order,
          runIds: Object.fromEntries(ARMS.map((arm) => [arm, opaque(truthSalt, seed, pairId, arm, 'run')])),
        })
      }
    }
  }
  const shuffled = keyedOrder(sealedPairs, truthSalt, seed, 'schedule', (entry) => entry.pairId)
  const sealed = {
    schemaVersion: PROTOCOL_VERSION,
    seed,
    truthSalt,
    repetitions,
    cases: CASES.map((entry) => ({ ...publicCase(entry), fault: entry.fault })),
    pairs: shuffled,
  }
  const publicSchedule = shuffled.map((entry) => ({
    pairId: entry.pairId,
    caseId: entry.caseId,
    siteId: entry.siteId,
    opaqueVariantId: entry.opaqueVariantId,
    repetition: entry.repetition,
    order: entry.order,
    runIds: entry.runIds,
  }))
  const publicProtocol = {
    schemaVersion: PROTOCOL_VERSION,
    classification: 'controlled four-family authored-verifier pilot; not confirmatory evidence',
    unit: 'paired arm trial on one opaque fixture run, one frozen action, and one neutral postcondition',
    truth: 'server-side sealed application model calibrated against primitive DOM state before arm trials',
    arms: ARMS,
    variantsPerCase: 2,
    repetitions,
    seed,
    cases: CASES.map(publicCase),
    schedule: publicSchedule,
    scoring: {
      verdicts: ['PASS', 'FAIL', 'UNKNOWN', 'OP_ERROR'],
      falseGreen: 'verifier PASS when sealed oracle FAIL',
      falseNegative: 'verifier FAIL when sealed oracle PASS',
      unknownIsCorrect: false,
      primaryDenominator: 'all scheduled ordinary determinate trials, including UNKNOWN and OP_ERROR',
    },
    decisionRules: {
      integrity: 'truth leak, oracle disagreement, source mutation, external request, incomplete schedule, or failed cleanup invalidates the run',
      safety: 'any SnapDOM PASS on an oracle FAIL is a safety alarm and requires repair before further value claims',
      directionUnit: 'case-level paired direction; repetitions assess stability and never count as independent cases',
      confirmatoryBoundary: 'this pilot never establishes superiority or non-inferiority; independent cases and a powered preregistration are required',
      helperDefault: 'without a material diagnostic or case-level detection gain, retain SnapDOM only as an optional Playwright helper',
    },
    diagnosticReview: {
      selection: 'repetitions 0 and 1 for every case and truth after results close',
      packetIdentity: 'tool and arm names redacted; structural arm inference remains possible and arm guess must be recorded',
      pairedExposure: 'one reviewer must not receive both arms of the same pair',
      rubric: [
        'verdict', 'violatedConjuncts', 'targetIdentified', 'wrongTargetIdentified',
        'coverageDiagnosed', 'uncertaintyDiagnosed', 'confidence', 'armGuess',
      ],
    },
    caveats: [
      'versioned local replicas of four site families, not live-site population evidence',
      'self-authored cases and intentionally balanced truth variants',
      'repetitions measure flake and are not independent sites or cases',
      'Playwright failure assertions use bounded retry time; latency is descriptive and not a speed comparison',
      'evidence size means UTF-8 bytes of JSON serialization, not tokens or information quality',
      'the verifier translations were tuned on these same fixtures during smoke development; the 10x run is stability validation, not holdout accuracy',
      'some neutral conjuncts use authored fixture-specific selectors or scoped semantic proxies and are not general web predicates',
      'pilot describes local direction and event diversity; it cannot validate confirmatory power or establish superiority',
    ],
  }
  return {
    publicProtocol,
    sealed,
    commitment: sha256(sealed),
    publicHash: sha256(publicProtocol),
  }
}

export function validateProtocol(protocol) {
  const problems = []
  const { publicProtocol, sealed, commitment, publicHash } = protocol
  if (sha256(sealed) !== commitment) problems.push('sealed commitment mismatch')
  if (sha256(publicProtocol) !== publicHash) problems.push('public protocol hash mismatch')
  const expectedPairs = CASES.length * VARIANTS.length * sealed.repetitions
  if (sealed.pairs.length !== expectedPairs || publicProtocol.schedule.length !== expectedPairs) problems.push('schedule count mismatch')
  const pairIds = new Set(sealed.pairs.map((entry) => entry.pairId))
  if (pairIds.size !== expectedPairs) problems.push('duplicate pair id')
  const runIds = sealed.pairs.flatMap((entry) => Object.values(entry.runIds))
  if (new Set(runIds).size !== runIds.length) problems.push('duplicate run id')
  const publicWire = canonicalJson(publicProtocol)
  if (/near-miss|near miss|\bcorrect\b|\bintended\b|\bfault\b|expectedTruth|opaqueVariantTruth/i.test(publicWire)) {
    problems.push('truth leaked into public protocol')
  }
  for (const testCase of CASES) {
    for (const variant of VARIANTS) {
      const block = sealed.pairs.filter((entry) => entry.caseId === testCase.id && entry.variant === variant)
      const snapFirst = block.filter((entry) => entry.order[0] === 'snapdom-authored').length
      const pwFirst = block.length - snapFirst
      if (Math.abs(snapFirst - pwFirst) > 1) problems.push(`arm order imbalance ${testCase.id}/${variant}`)
    }
  }
  return { pass: problems.length === 0, problems }
}

export function preregistration(protocol, implementation) {
  const integrity = validateProtocol(protocol)
  if (!integrity.pass) throw new Error(`invalid preregistration: ${integrity.problems.join('; ')}`)
  return {
    schemaVersion: 1,
    status: 'FROZEN_BEFORE_BROWSER_START',
    frozenAt: new Date().toISOString(),
    sealedTruthCommitmentSha256: protocol.commitment,
    publicProtocolSha256: protocol.publicHash,
    implementation,
    protocol: protocol.publicProtocol,
  }
}
