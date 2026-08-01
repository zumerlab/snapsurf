# Phase B — What the model picks when nothing tells it to

2026-08-01 · `claude-opus-5`, effort `high` · 6 long missions · 3 arms ·
`experiment/formal/b-preference.mjs` · total cost **$10.61**

**The question**: does the model itself prefer this tool over its usual ones? The design
removes the bias: **the `agent-browse` skill is off** (it tells Claude to use this tool),
there is no instruction to prefer either, and both channels are described in the same
register — nothing is marked "recommended" or "cheaper". Both channels drive **the same
real browser**, so either one can solve the task.

## Answer: yes, by a wide margin

**Given a free choice, the model picked this tool in 63 of 81 channel-using steps (78%),
in all six tasks without exception.**

| Arm | Steps | Pixels | This tool | Tokens in | Cost |
|---|---:|---:|---:|---:|---:|
| **Free choice** | 93 | 18 | **63** | 537k | $3.09 |
| Pixels only (forced) | 98 | 78 | — | 1,078k | $6.02 |
| This tool only (forced) | 80 | — | 71 | 216k | **$1.50** |

## Choice per task (free arm)

| Task | Kind | Pixels | This tool |
|---|---|---:|---:|
| m1 | accumulated extraction (5 HN stories) | 2 | 17 |
| m2 | form plus a silent validation failure | 5 | 9 |
| m3 | deep navigation below the fold | 0 | 4 |
| m4 | ambient noise / verifying a no-op | 3 | 8 |
| m5 | half-hydrated single-page app | 2 | 8 |
| m6 | recovering from a blocked action | 6 | 17 |

Not one task where pixels were the majority. The qualitative pattern: it uses a screenshot
to **orient itself** at the start, then switches to this tool to **operate and verify**.

## The token crossover (an old debt, now measured)

Comparing the two forced arms on the same task:

| Task | This tool | Pixels | Factor |
|---|---:|---:|---:|
| m3 deep navigation | 13.7k | 199.3k | **14.5×** |
| m5 half-hydrated single-page app | 27.3k | **447.6k** | **16.4×** |
| m6 recovery | 56.9k | 166.2k | 2.9× |
| m2 form | 39.4k | 103.9k | 2.6× |
| m1 extraction | 50.1k | 115.6k | 2.3× |
| m4 ambient noise | 28.6k | 45.2k | 1.6× |
| **total** | **216k** | **1,078k** | **5.0×** |

**The crossover is not at a fixed turn number: it depends on the kind of task.** Where the
target is outside the viewport (m3) or the page changes with no clear visual difference
(m5), the pixel channel does not converge — m5 with pixels **hit the 30-step ceiling** and
spent 447k tokens where this tool finished in 11 steps and 27k. On simple visual tasks
(m4) the factor drops to 1.6×, which is the honest number to quote as a floor.

## What this does NOT prove

- **n=1 per cell.** Six tasks, one run per arm. It sizes the effect; it does not establish
  it. The plan asked for 3 or more repetitions and that is still owed.
- **One model** (`claude-opus-5`). Another model could choose differently.
- **I wrote the tasks**, same as in the formal benchmark. Phase D corrects that with
  third-party tasks.
- The free arm **did not measure answer quality against a judge**: it measured choice,
  steps and tokens. The answers were read by hand and all six were correct, including
  spotting the silent failure in m2 ("No, the subscription was NOT added to the list").

## The falsification stated in advance — it did not happen

The plan said: *"if in the free arm the model picks its native tools for most steps and
the tasks still complete, then the perceived value is not there"*. It picked this tool for
78% of the steps, so the hypothesis survives. But the nuance is worth stating: **it also
used pixels in 18 steps**. It did not abandon them, it used them to orient itself. The
result supports the hybrid framing in `docs/LANDSCAPE.md`, not a replacement.

## Reproducing

```bash
export ANTHROPIC_API_KEY=...
node packages/agent/experiment/formal/b-preference.mjs --arm free    # or pixels | oracle
```

Raw data: `results/b-preference-{free,pixels,oracle}.json`, including the sequence of
tools per step and the tokens per turn.
