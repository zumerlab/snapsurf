# snapDOM Agent (working name)

**PRIVATE. PROPRIETARY. NEVER PUBLISHED.** Not covered by the repository's MIT license;
`private: true`, excluded from every publish/release path, and this whole package lives on
a local-only branch. See `LICENSE`.

A post-layout **change oracle** for AI agents that live *inside* someone else's page —
browser extensions (MV3, no `chrome.debugger`), embedded SaaS copilots, Electron webviews.
No CDP, no browser launching: in-page JavaScript is all they have.

It answers ***what* changed**, not "did anything change".

```js
import { agent } from '@zumer/snapdom-agent'

const before = await agent.inspect(root)
const checkpoint = before.checkpoint()

await doSomething()                                  // the agent acts

const ui = await agent.inspect(root, { previous: checkpoint, noise: 'agent' })
ui.changed              // true
ui.changes              // [{ id, kind: 'state', before: {disabled:true}, after: {disabled:false}, match: 'exact' }, …]
ui.actionabilityDelta   // { becameCovered: ['n_11','n_12'], becameVisible: [] }
ui.context              // indented outline, LLM-shaped
ui.agentMap             // Set-of-Mark data (numbered actionables + bboxes + state)
ui.capabilities         // { inlineStyles, dataUrls, blobUrls, crossOriginFonts }

ui.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Save' })
agent.resolve(match)    // → live Element | null  (the ONLY bridge; actions are out of scope)
await ui.rasterize()    // optional render visitor on the same walk
```

## Layout

```
src/          snapshot (the semantic visitor) · aria · noise · match · diff · checkpoint · query
corpus/       18 mutation fixtures: page.html + mutate.js + expected.json (hand-written truth)
test/         corpus runner · API acceptance · benchmarks
experiment/   Phase 5: signal.test.js (model-free) + harness.mjs (model in the loop)
docs/adr/     architecture decisions; deviations require an ADR + review
EXPERIMENT.md the gate's results
```

## Run it

```bash
npx vitest run packages/agent/test --browser.headless            # corpus + API + bench
npx vitest run packages/agent/experiment/signal.test.js --browser.headless
node packages/agent/experiment/harness.mjs --reps 5               # needs ANTHROPIC_API_KEY
```

## Settled architecture (see the master prompt + ADRs)

1. **Three hashes per node.** `contentHash` (identity + text + interaction state + visual
   style subset — **no geometry**), `subtreeHash` (Merkle, propagates), `geometryHash`
   (relative to the nearest positioned/scrolling ancestor, tolerance-rounded, **never**
   propagates). Signatures read the live computed DOM — never the clone, SVG or raster.
2. **Identity is probabilistic; the API exposes classes, never floats**: `exact | strong |
   ambiguous | new` (+ `removed`), with `matchedBy`. Candidates bucket by `role+tag`.
3. **Kinds derive from which signature component moved**: `added | removed | content |
   state | style | moved | resized | possible-replacement`.
4. **Actionability delta is first-class** — occlusion's *consequence*, not just occlusion.
5. **Noise suppression works unconfigured** under `noise: 'agent'`.
6. **Queries mirror Playwright** (distribution, not convenience) and are **snapshot-scoped,
   not live locators**.
7. **Checkpoints** are compact, versioned, image-free, DOM-free; `excludeText: true` drops
   every readable string (identity rides name fingerprints) — safe to store.
8. **One walk, two outputs**: the raster is an optional visitor on the same pass, so pixels
   and structure share one instant. `inspect()` alone never builds a clone.
9. **Canvas/WebGL honesty**: `sourceType: 'canvas'`, `semanticsAvailable: false`,
   `rasterAvailable: true`. The core never pretends to understand pixels.
10. **Same-environment repeatability only.** No cross-browser determinism claims, anywhere.

## Notes on the byte-equality legacy contract

`ARCHITECTURE.md` (public) documents hashing `result.url` to detect UI change. That
contract is weaker than it looks: the clone pipeline can inject randomness (placeholder
class names) and restructure nodes (the Firefox checkbox replacement), so two captures of
an unchanged page can differ. Computed-value signatures are strictly more stable. Keep
`result.url` hashing as legacy compatibility only.
