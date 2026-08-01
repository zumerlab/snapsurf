# E1 — `vercel-labs/agent-browser` as a fourth arm, no model involved

2026-08-01 · agent-browser **0.33.1** (`npm install -g agent-browser`) · the same 19 cases
with hand-written truth used in `bench-qa.md` · no model, fully deterministic.

The first time we actually ran the most comparable public tool. Until now we only had it
described in `docs/LANDSCAPE.md`. Reading a README is not measuring.

## Result

| Method | Right | False alarms (noise) | Missed changes |
|---|---:|---:|---:|
| **This tool (browser_verify)** | **19/19** | **0/8** | **0/11** |
| agent-browser, references normalized away | 17/19 | 1/8 | 1/11 |
| Accessibility tree (Playwright) | 16/19 | 2/8 | 1/11 |
| Pixel difference (pixelmatch class) | 13/19 | 5/8 | 1/11 |
| **agent-browser `diff snapshot` as it ships** | **11/19** | **8/8** | 0/11 |

## Why there are two numbers for agent-browser

**As it ships (11/19, 8 false alarms out of 8):** its `@eN` references **are renumbered on
every snapshot**, and its diff is textual over the serialized tree, so reference noise
swamps everything. Measured in isolation: a **completely static page**, diffed against
itself, reports `3 additions, 3 removals`. The consequence is that **every noise case
reads as a change**. For QA work, as it ships, it is not usable.

**With references normalized away (17/19):** stripping ` ref=eN` from both sides before
comparing — a post-processing step any reasonable user would write — makes it **the
strongest comparison in the corpus**, above Playwright's accessibility tree and well above
the pixel comparison. Its two errors:

- **`live-timestamp` (false alarm)**: the clock changes the text, and a textual diff
  cannot know that is not application state. This is exactly the case our raw-text hash
  and causal suppression handle.
- **`font-swap-late` (missed)**: a font finishing loading has no textual representation in
  the accessibility tree. Invisible to that channel.

### Alternatives were exhausted before accepting the as-shipped number

So that we do not win by configuring it badly (a rule in `TESTPLAN.md`), we tried:

- an in-session flow with no `-b` → worse (`4 additions, 0 unchanged` on a static page);
- `--compact` → references are still renumbered;
- there is no flag that omits references from the snapshot.

There is no documented configuration in which a static page diffs clean.

## Honest reading

1. **The core claim holds, with a smaller margin than we believed.** Against a
   well-normalized agent-browser the distance is 19/19 to 17/19 — not 19/19 to 13/19 as it
   is against a pixel comparison. The real advantage is concentrated in two classes:
   **textual noise** (clocks, timestamps) and **changes with no textual representation**
   (fonts, and by extension anything visual without structure).
2. **One of our assumptions was false and has to be corrected.** We assumed a text diff of
   the accessibility tree would miss the `disabled` flip. **It does not**: `[disabled]`
   travels in the serialization, so it is detected. What breaks its comparison is
   identity, not the representation of state.
3. **The identity problem we documented is real and measurable**: its references do not
   survive a re-snapshot, which turns every reading into "everything changed". Our
   content-derived ids exist precisely for that.
4. **For the pitch**: against this tool, "we detect more" is not enough. The defensible
   statement is *"your comparison needs you to write the normalization yourself, and even
   then it eats clocks and cannot see what has no text."*

## Reproducing

```bash
npm install -g agent-browser
node packages/agent/experiment/e1-agent-browser.mjs
```

Raw per-case data: `results/e1-agent-browser.json`.
