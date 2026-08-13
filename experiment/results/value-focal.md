# Direct Playwright Test vs SnapDOM assertion envelope — focal observations

Date: 2026-08-12. This report preserves the historical schema-1 observation and five
post-fix schema-2 observations over the same six public-page effects. Schema 1 recorded
one action-to-verdict observation per effect and arm. Schema 2 recorded five immediate
sequential repetitions per effect and arm. Both arms passed 6/6 in schema 1 and 30/30 in
schema 2. The predicates were authored for this focal; there was no independent hidden
oracle.

These are **not throughput benchmarks**. Schema 2 now has repeated timing observations,
but no randomized arm order, controlled near misses, or independent cases beyond the six
effects. The arms target the same declared visible effects, but use different observation
surfaces and retry boundaries. Raw latency and byte totals are descriptive measurements,
not causal rankings or speed claims.

## Schema 2 — aligned observation

Schema 2 puts setup, baseline, and precondition work outside both timers. Timed work
includes target lookup, action, and the aligned postconditions. Evidence serialization
and the controlled failure probe are outside the timer, except that SnapDOM's successful
assertion evidence is inherently part of its authenticated response.

Both arms used Playwright 1.55.1 and Chromium 140.0.7339.186. Direct Playwright launched a
fresh context without a user-data directory; SnapDOM launched its product daemon and
fresh contexts. The daemon used an OS-assigned port other than 8377. Cleanup closed the
contexts and processes and removed the temporary root.

| Effect | Playwright | SnapDOM | PW setup ms | SD setup ms | PW action-to-verdict ms | SD action-to-verdict ms |
|---|---|---|---:|---:|---:|---:|
| remove | pass | pass | 11.6 | 6.3 | 3,925.2 | 3,123.4 |
| add | pass | pass | 2.6 | 2.0 | 3,895.8 | 3,056.0 |
| state-enable | pass | pass | 3.7 | 2.4 | 3,884.5 | 3,043.1 |
| modal | pass | pass | 9.4 | 8.4 | 417.5 | 450.7 |
| delayed | pass | pass | 7.6 | 4.7 | 5,906.7 | 5,028.3 |
| no-op | pass | pass | 6.1 | 0.0 | 306.3 | 316.9 |
| **Total** | **6/6** | **6/6** | **41.0** | **23.8** | **18,336.0** | **15,018.4** |

Playwright `expect()` serialized 0 bytes of semantic success evidence automatically. An
additional explicit ARIA evidence read totaled 1,380 B. SnapDOM's six successful full
authenticated envelopes totaled 17,986 B, of which 15,632 B were the structured
assertion payloads. The six controlled failure diagnostics totaled 10,508 B for
Playwright and 3,324 B for SnapDOM.

Those byte totals do not describe equivalent artifacts: Playwright's success measure is
a scoped, explicitly requested ARIA snapshot, while SnapDOM returns checks, baseline
metadata, and bounded typed diff evidence. Retry work also differs. Playwright locators
and sequential `expect()` calls auto-retry within their own boundaries. SnapDOM used one
assertion request per case and internally observed `[25, 25, 25, 1, 42, 1]` attempts.
Action settling and polling therefore cannot be inferred from caller-visible call counts.
The no-op surfaces differ too: Playwright compared body ARIA; SnapDOM observed its
supported semantic, state, style, and layout signals.

The first schema-2 attempt exposed a real product bug rather than producing a claimed
comparison result. A disabled textbox became enabled and a state change existed, but the
exact matcher `to: { disabled: false }` could not match because snapshots encode
`disabled` only when true. The diff evidence was fixed to materialize the missing
opposite-side `false` only for the presence-encoded `disabled` and `hasValue` states; ARIA
states such as `expanded` remain three-way and are not coerced. The complete exact rerun
then passed 6/6 in both arms. The failed-attempt raw file remains under the local `work/`
directory for diagnosis and is not published or counted here.

Raw schema-2 data, exact APIs, versions, checks, attempts, and per-case caveats:
[`value-focal-v2.json`](value-focal-v2.json). Four immediate exact repetitions are
preserved as [`rep2`](value-focal-v2-rep2.json),
[`rep3`](value-focal-v2-rep3.json), [`rep4`](value-focal-v2-rep4.json), and
[`rep5`](value-focal-v2-rep5.json).

### Schema-2 repetition stability

Across those five schema-2 observations, each arm passed all 30 authored successful
effects. The median six-effect action-to-verdict sum was 18,344.9 ms for Playwright and
15,022.3 ms for SnapDOM. The observed run ranges were 18,336.0–18,363.1 ms and
14,991.2–15,618.9 ms respectively. Median setup sums were 40.1 ms and 21.4 ms.

| Effect | PW median ms | SD median ms | PW observed range ms | SD observed range ms |
|---|---:|---:|---:|---:|
| remove | 3,914.7 | 3,047.7 | 3,907.0–3,925.2 | 3,027.5–3,123.4 |
| add | 3,899.3 | 3,056.0 | 3,895.8–3,903.1 | 3,041.9–3,085.0 |
| state-enable | 3,894.9 | 3,049.4 | 3,884.5–3,904.6 | 3,036.3–3,090.1 |
| modal | 419.0 | 451.4 | 408.7–428.2 | 445.4–964.2 |
| delayed | 5,911.9 | 5,099.6 | 5,906.7–5,919.1 | 5,028.3–5,127.1 |
| no-op | 308.2 | 316.3 | 305.8–309.4 | 314.1–316.9 |

Evidence sizes were effectively deterministic across repetitions: Playwright explicit
ARIA success evidence was 1,380 B in every run; median SnapDOM full/structured success
evidence was 17,986/15,632 B; controlled-failure evidence was 10,508 B for Playwright and
3,324 B for SnapDOM in every run. The median raw SnapDOM time sum was 18.1% lower, but
the unequal retry and observation surfaces still prevent a speed claim. The repetitions
show that the initial pass and payload shapes were stable in this narrow fixture; they do
not measure false greens or general web performance.

## Schema 1 — historical observation

Schema 1 is retained unchanged as historical evidence. Its timers and some outcome
conjuncts were asymmetric: Playwright timing included precondition assertions, while
SnapDOM timing began after `find`; Playwright `add` checked `It's back!`, while SnapDOM
checked the checkbox's accessible name. Its raw totals therefore must not be compared as
a speed result. The 15,035.8 ms SnapDOM total being below the 16,155.4 ms Playwright total
in this one run is not evidence of a speed advantage.

| Effect | Truth | Playwright Test | SnapDOM | PW ms | SD ms | PW calls | SD calls | PW explicit success evidence | SD success envelope |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| remove | checkbox removed; `It's gone!` | pass | pass | 3,558.8 | 3,035.9 | 3 locators + 3 assertions + 1 evidence call | 1 find + 1 assert / 3 checks | 52 B | 3,309 B |
| add | checkbox added back | pass | pass | 3,359.5 | 3,094.9 | 3 + 3 + 1 | 1 + 1 / 3 | 87 B | 3,461 B |
| state-enable | input enabled; `It's enabled!` | pass | pass | 3,325.2 | 3,083.3 | 3 + 3 + 1 | 1 + 1 / 3 | 101 B | 4,238 B |
| modal | dialog and clear Woo-hoo paragraph | pass | pass | 225.7 | 451.7 | 3 + 4 + 1, plus `elementFromPoint` | 1 + 1 / 4 | 212 B | 4,266 B |
| delayed | `Hello World!` appears | pass | pass | 5,375.1 | 5,055.1 | 2 + 3 + 1 | 1 + 1 / 3 | 47 B | 2,086 B |
| no-op | no semantic change over 300 ms | pass | pass | 311.1 | 314.9 | 1 + 1 + 1 | 0 + 1 / 1 | 881 B | 526 B |

Playwright's six explicit success snapshots totaled 1,380 B. A controlled failing
assertion produced 9,697 B of matcher diagnostics. SnapDOM's successful authenticated
envelopes totaled 17,886 B, including 15,560 B for the structured assertions; its six
controlled failure envelopes totaled 3,324 B.

Versions: direct Playwright Test 1.62.1 with Chrome for Testing 151.0.7922.34 in a
throwaway installation; SnapDOM Agent 0.1.0 with pinned Playwright 1.55.1. Raw schema-1
data and exact caveats: [`value-focal.json`](value-focal.json).

## Reproduce safely

```sh
node experiment/value-focal.mjs --dry
node experiment/value-focal.mjs --network
```

The current runner emits schema 2 and uses the repository-pinned direct Playwright by
default. Public-site latency and content can drift. Store subsequent runs as new
observations rather than replacing either historical file.
