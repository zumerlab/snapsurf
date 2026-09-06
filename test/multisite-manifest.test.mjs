import test from 'node:test'
import assert from 'node:assert/strict'
import { CASES, VARIANTS, expectedState, oracleChecks, oracleVerdict, renderFixture } from '../experiment/multisite/cases.mjs'
import { buildProtocol, canonicalJson, sha256, validateProtocol } from '../experiment/multisite/protocol.mjs'

const TEST_TRUTH_SALT = '42'.repeat(32)

test('multisite pilot manifest is complete, opaque and deterministic', async (t) => {
  await t.test('contains twelve cases across four frozen site families', () => {
    assert.equal(CASES.length, 12)
    assert.deepEqual([...new Set(CASES.map((entry) => entry.siteId))].sort(), [
      'bootstrap', 'saucedemo', 'the-internet', 'todomvc',
    ])
    assert.equal(new Set(CASES.map((entry) => entry.id)).size, 12)
    for (const entry of CASES) {
      assert.ok(entry.action)
      assert.ok(entry.conjuncts.length >= 2)
      assert.equal(new Set(entry.conjuncts.map((item) => item.id)).size, entry.conjuncts.length)
    }
  })

  await t.test('every intended state passes and every planted fault fails', () => {
    for (const entry of CASES) {
      assert.equal(oracleVerdict(entry.id, expectedState(entry.id, 'intended')), 'PASS', entry.id)
      assert.equal(oracleVerdict(entry.id, expectedState(entry.id, 'fault')), 'FAIL', entry.id)
      const failed = Object.entries(oracleChecks(entry.id, expectedState(entry.id, 'fault')))
        .filter(([, pass]) => !pass).map(([id]) => id)
      assert.ok(failed.length > 0, entry.id)
    }
  })

  await t.test('fixture bytes expose neither truth label and have no external resources', () => {
    for (const entry of CASES) {
      const html = renderFixture(entry.id)
      assert.doesNotMatch(html, /near-miss|near miss|\bcorrect\b|\bintended\b|\bfault\b/i, entry.id)
      assert.doesNotMatch(html, /https?:\/\//i, entry.id)
      assert.match(html, /location\.pathname/)
      assert.doesNotMatch(html, /case=|variant=|truth=/i)
    }
  })

  await t.test('ten-repetition schedule is paired, balanced and committed', () => {
    const first = buildProtocol({ repetitions: 10, seed: 'fixed-pilot-seed', truthSalt: TEST_TRUTH_SALT })
    const second = buildProtocol({ repetitions: 10, seed: 'fixed-pilot-seed', truthSalt: TEST_TRUTH_SALT })
    const differentSecret = buildProtocol({ repetitions: 10, seed: 'fixed-pilot-seed', truthSalt: '43'.repeat(32) })
    assert.deepEqual(first, second)
    assert.notDeepEqual(
      first.publicProtocol.schedule.map(({ caseId, repetition }) => ({ caseId, repetition })),
      differentSecret.publicProtocol.schedule.map(({ caseId, repetition }) => ({ caseId, repetition })),
      'the public seed alone must not reproduce sealed schedule positions',
    )
    assert.deepEqual(validateProtocol(first), { pass: true, problems: [] })
    assert.equal(first.sealed.pairs.length, 240)
    assert.equal(first.publicProtocol.schedule.length, 240)
    assert.doesNotMatch(canonicalJson(first.publicProtocol), /near-miss|near miss|\bcorrect\b|\bintended\b|\bfault\b|expectedTruth|opaqueVariantTruth/i)
    for (const entry of CASES) {
      for (const variant of VARIANTS) {
        const block = first.sealed.pairs.filter((pair) => pair.caseId === entry.id && pair.variant === variant)
        assert.equal(block.length, 10)
        assert.equal(block.filter((pair) => pair.order[0] === 'snapdom-authored').length, 5)
        assert.equal(block.filter((pair) => pair.order[0] === 'playwright-authored').length, 5)
      }
    }
    assert.doesNotMatch(canonicalJson(first.publicProtocol), new RegExp(TEST_TRUTH_SALT, 'i'))
    for (const entry of CASES) {
      const publicIds = new Set(first.publicProtocol.schedule
        .filter((pair) => pair.caseId === entry.id).map((pair) => pair.opaqueVariantId))
      for (const variant of VARIANTS) {
        const oldGuess = sha256(`fixed-pilot-seed\0${entry.id}\0${variant}\0variant`).slice(0, 24)
        assert.equal(publicIds.has(oldGuess), false, `${entry.id}/${variant} must resist the former public-seed attack`)
      }
    }
  })

  await t.test('the corrected cart fault removes the wrong product without changing the badge cue', () => {
    assert.deepEqual(expectedState('S3', 'intended'), { cartItems: ['Bike Light'], badge: 1 })
    assert.deepEqual(expectedState('S3', 'fault'), { cartItems: ['Backpack'], badge: 1 })
  })
})
