# Controlled multisite verification pilot

Status: directional authored-verifier pilot; not confirmatory evidence  
Run: 2026-08-12T14:50:34.269Z to 2026-08-12T14:54:00.191Z  
Cases: 12 across four versioned site-family replicas; arm trials: 480

## Outcome

| Arm | Correct | False green | False negative | UNKNOWN | OP_ERROR | Verify ms PASS/FAIL | Evidence JSON B PASS/FAIL |
|---|---:|---:|---:|---:|---:|---:|---:|
| snapdom-authored | 230/240 | 0 | 0 | 10 | 0 | 2.6/2.8 | 3607.5/3686.5 |
| playwright-authored | 240/240 | 0 | 0 | 0 | 0 | 4.6/913.7 | 720/1538 |

## Paired direction

Both correct: 230; SnapDOM only: 0; Playwright only: 10; neither: 0; discordant: 10.

Pilot decision: **PLAYWRIGHT_FAVORED / EVENT_STARVED / IDENTITY_REDACTED_DIAGNOSIS_THEN_HELPER_ONLY**.

## Objective diagnostic localization

| Arm | Violated-conjunct recall | Precision | Exact sets |
|---|---:|---:|---:|
| snapdom-authored | 1 | 1 | 120/120 |
| playwright-authored | 1 | 1 | 120/120 |

## Interpretation boundary

The truth variants were committed before browser startup and hidden behind opaque run IDs. The two arms received the same neutral action and postcondition in fresh contexts. A separate server-side application model was calibrated against primitive DOM state for every case and variant before arm trials.

These are self-authored, versioned replicas with deliberately balanced faults. Repetitions measure stability, not independent case or site coverage. This run can expose false-green direction and produce identity-redacted diagnostic packets; their structure can still reveal the arm, so reviewers record an arm guess. It cannot establish general accuracy, safety, non-inferiority, superiority, model task success, or live-web performance.

Timing is descriptive only: failed Playwright assertions consume bounded retry time, while SnapDOM reads one post-action snapshot. Evidence sizes are UTF-8 JSON bytes, not token or information-quality measurements.

All browsers used headless isolated Playwright Chromium contexts. No personal Chrome profile, tab, cookie, session, history, password, or extension was accessed.
