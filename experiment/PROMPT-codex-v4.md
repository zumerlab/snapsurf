# Review round 4 — TIMINGS — copy and paste

Fourth round, one focus: **time**. Your v3 findings are already applied in the harness, the
same day: denials now log `ok:false` (your serious bug), `find` logs the complete matches
`{id, role, name, href}` with the pathname first rather than the tracking tail,
`look`/`open` log a summary (map total, changed, number of changes), and URLs in the log
are truncated to origin plus pathname. The v2 ranking in `find` also buries the page-wide
wrappers that concatenate the whole page. The `snap` bug with a non-zero scroll, which you
validated in passing, is closed in the core with a regression test.

Your mission: repeat the SAME 5 tasks (same criteria, cap of 15 actions) measuring
duration systematically, and produce the timing table your previous rounds lacked.

Measurement method — follow it so the numbers are comparable:

1. **Wall time per task**: time it from the instant before the task's first command to the
   instant after its last. For example, run the whole chain of commands for the task in a
   single invocation under `time`, or take timestamps before and after. Pure harness
   execution, without your own reasoning time in the middle — if you cannot chain them,
   record both numbers separately (pure and end-to-end) and say which is which.
2. **Per command**: take `durationMs` from the session's JSONL
   (`packages/agent/logs/<session>.jsonl`) — the sum per task, and the median and maximum
   for `open`, `find`, `look` and `click`.
3. Reference for contrast (my run today, pure chained execution): 5/5 · 20 commands ·
   21.2 s of wall time; opens 1.0–5.6 s; finds 1–8 ms; looks 94–413 ms; the whole eBay
   task 12.1 s. If your numbers differ a lot, investigate why (one command at a time? the
   network? a different page?) instead of averaging it away.

Deliverable in `packages/agent/experiment/results/codex-self-v4.md`:

- A per-task table: success · actions · v4 wall time, with your v1/v2/v3 action counts
  beside it for history (timings only exist from v3 onward, approximately).
- A per-command table: median and maximum for open, find, look, click and enter, plus the
  full breakdown of the slowest task.
- Command-line overhead: compare the sum of `durationMs` from the JSONL against your wall
  time per task. The difference is the per-command invocation cost (about 70–90 ms per
  command in my run). Say whether in your judgement that justifies a batch mode
  (`browse.mjs run 'open X' 'find Y' 'click Z'`) or not.
- A two-minute spot check of the audit fixes: force a denial with a `--readonly` daemon and
  confirm `ok:false` in the JSONL; run a `find` and confirm the matches carry role, name
  and href. Report anything still wrong.
- New friction if any appears. Unsweetened, as always.

Operational notes: run the daemon with `node packages/agent/tools/browse.mjs serve` in the
background; ids expire per reading (`obs #N`); `snap`, `shot`, `text` and `find` do not
re-read the page; no clicking by coordinate to guess (use `parent` and `map`). When you
finish, stop every daemon you started.
