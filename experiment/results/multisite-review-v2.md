# Multisite diagnostic review

Decision: **HELPER_ONLY**  
Integrity: VALID; 192 reviews across 96 packets.

| Arm | Diagnosis accuracy | Fault specificity (0-3) | Exact violation set | Mode accuracy |
|---|---:|---:|---:|---:|
| playwright-authored | 1 | 3 | 1 | 0.875 |
| snapdom-authored | 0.9583 | 3 | 1 | 0.8125 |

SnapDOM minus Playwright specificity: 0; frozen material threshold: 0.5.

Agreement — verdict: 1; violated set: 1; failure mode: 0.9271.

The controlled pilot found no detection gain and the frozen diagnostic material-gain gate was not met; keep SnapDOM as an optional Playwright helper.

This is a tuned, self-authored directional review. It is not holdout or confirmatory evidence. Packet structure may reveal the arm; arm guesses were recorded.
