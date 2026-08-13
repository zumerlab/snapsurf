# PLAN — prove the SnapDOM Sensor plugin first

Status updated 2026-08-12.

## Current directive

Freeze feature expansion and test one narrower product: a stateful semantic plugin for
hosts already using SnapDOM in an authenticated tab or webview. The host may be
Playwright, another agent runtime, an extension, an Electron preload, page code, or a
human. One plugin instance keeps scoped prior state locally across normal SnapDOM captures
and adds a bounded `toSensor()` effect report without becoming another controller or
requiring a predetermined action/postcondition.
The effect is only a comparison of capture endpoints: causality remains
`NOT_ESTABLISHED`, and task success remains `NOT_ASSESSED`.

Playwright remains the default browser-control and authored-test baseline. Existing-tab
access is not a SnapDOM-exclusive capability. The candidate value is the combination of
an embeddable observer, typed transition evidence, local redaction, and selective output
without requiring a second browser, CDP, or `debugger` in the product path. There is no
current claim that SnapDOM is generally superior to Playwright.

## Active work

1. **Close reliability blockers.** Treat a false green, privacy leak, stale element
   resolution, or silently unreadable region as a blocker. Add an effect-based regression
   for every fix.
2. **Dogfood the packaged artifact.** Exercise public workflows from a clean package,
   using only isolated temporary Chromium contexts and OS-assigned ports. Never attach to
   a personal Chrome profile, session, tab, cookie store, history, password store, or
   extension.
3. **Separate the product from the laboratory.** Ship-proof a browser ESM plugin with
   SnapDOM as its declared peer and no Node process, browser download, daemon, CDP, or
   `debugger`. Keep MCP/Playwright as development and reference adapters.
4. **Measure incremental value fairly.** Compare a strong host alone with that same host
   plus SnapDOM. Preserve the same action, wait, postcondition, fallback, and independent
   truth. For host/compatibility verification, measure false greens, false reds, and
   `UNKNOWN`; for the sensor plugin, measure `INDETERMINATE`, exact diagnosis, evidence
   bytes, rounds, and authoring burden. Never weaken the host to manufacture a win.
5. **Test scoped attention honestly.** Pass the smallest useful root to `snapdom()`, keep
   the prior-state graph private, retain auditable effect reports, and stress blind
   regions. Each endpoint is still a full SnapDOM SVG capture; do not reuse performance
   claims from the abandoned standalone `mark/read` prototype.
6. **Prove the shipped paths.** Re-run the repository, package, isolated regression,
   companion, and cold-install checks after the fixes. Record commands and artifacts,
   without copying mutable pass counts into this plan.
7. **Respect both the negative and positive results.** Predetermined receipts did not
   improve a strong host and lost telemetry on two legitimate schema changes. The new
   standard plugin has passed mechanical package/integration tests but has no commercial
   value result yet. Keep features frozen and test this exact plugin in a real host flow.

## Evidence rules

- The old `0 versus 6` false-green result is an internal comparison of a case-specific
  postcondition with generic change signals. It is not an equal-intent Playwright result
  and is withdrawn as a competitive headline.
- The aligned six-effect focal is descriptive: both implementations verified all 30
  authored successful effects across five immediate repetitions, but different evidence
  and retry surfaces, no controlled near misses, and no independent hidden oracle mean it
  does not establish accuracy, speed, or cost superiority.
- Self-authored fixtures can find regressions; they cannot by themselves establish a
  market or competitive advantage.
- “Runs in the real authenticated tab” is a deployment property, not a unique claim;
  current Playwright tooling also supports existing-browser sessions.
- “Resident scoped attention” means the private graph never crosses the boundary and the
  consumer receives a capped descriptive projection. In the v2 probe, a fixed 54-element
  scope produced a constant 2,507 B report and 76,660 B (~74.9 KiB) diagnostic
  retained-heap p50 while exterior labels grew 100×. The sensor still performs two scoped
  walks; it is not
  a mutation-only engine, a hard byte ceiling, or proof over arbitrary pages.
- Treat every report as temporal correlation, not action attribution: the public contract
  fixes `causality.status` at `NOT_ESTABLISHED`.
- Report exact bytes, calls, and latency boundaries. Report false green/false red/`UNKNOWN`
  only for verifier paths; report `INDETERMINATE` for the descriptive sensor. Always state
  the independent oracle. Do not turn byte counts into token or model-cost claims without
  a specified tokenizer and billing model.

## Out of scope until the sensor decision

- Customer-specific integrations, sales automation, and pricing claims.
- Publishing to npm, a browser store, or a public repository.
- Claims of replacing Playwright or of being broadly better than current browser tools.
- Building a generic browser controller, replay platform, or visual-regression suite.
- Adding settle, crops, identity, tracing, or other features merely because competitors
  have them; each new feature requires evidence that it changes the sensor decision.
- Use of the owner's existing Chrome state or confidential browser information.
