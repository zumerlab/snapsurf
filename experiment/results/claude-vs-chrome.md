# snapDOM Agent (browse.mjs) against Claude-in-Chrome — on real sites

2026-07-31 · Run by: Claude (Fable 5) driving BOTH arms in the same session.
Tool harness: after commits 49ded32 / 0fa6b43 / 129616a (adaptive settle, in-page retry,
fenced output, scoped reading). Chrome: the claude-in-chrome extension on the user's real
Chrome. Cap: 15 actions per task. The same 5 tasks as `FIELD.md` and the earlier review
rounds.

## Table

| Task | This tool | Chrome | Result |
|---|---|---|---|
| T1 HN top story and comments | ✓ 2 commands (~1.5 s) | ✓ 2 calls | both fine (different front pages, minutes apart — both valid) |
| T2 GitHub open/closed issues | ✓ 4 commands¹ | ✓ 2 calls | 0 open / 338 closed (identical) |
| T3 Wikipedia Argentina → Mar del Plata link | ✓ 4 commands | ✗ FAILED (13 calls) | this tool: full-page search plus a click that auto-scrolled to 73,687 px |
| T4 npm preact weekly downloads | ✓ 3 commands | ✓ 2 calls | 22,921,763 (identical) |
| T5 eBay search, open the first result | ✗ FAILED (14 commands) | ✓ 8 calls | Chrome: Rolling Stones Dirty Work, /itm/198526021172 |
| **Total** | **4/5 · 27 commands** | **4/5 · 27 calls** | a tie, with COMPLEMENTARY failures |

¹ one repeated search, caused by my own parsing mistake (a `sed` picked up the fence line),
not by the harness.

## The two failures, in detail

**T3, where Chrome failed:** the Argentina article breaks all of the native tooling.

- Its internal search: `prompt is too long: 299206 tokens > 200000` — dies outright.
- `read_page filter=interactive`: truncated at 50k characters, so the link at 73k px never
  appears.
- Browser find-in-page: no reliable feedback (the bar is browser UI, invisible to a
  screenshot, and focus is lost between calls). 13 calls burned, and the only remaining
  route was a `read_page max_chars=300000`, about 75k tokens of context for ONE task.

This tool did it in 4 commands and about 3.5 s of page opening: in-page search is free and
proportional to the page, and clicking by id scrolls by itself. This is the business case.

**T5, where this tool failed:** on eBay's results page.

- Searching for "vinyl" returned the related-search CHIPS, not the listings — substring
  matching with no notion of "this is a result".
- I found the `generic "Pre-Owned"` INSIDE the first card, but there was no verb to climb
  to the container or its sibling title (`parent` did not exist yet).
- The map showed the first 40 clickable things with no paging, and the listing titles fell
  outside.
- Two blind clicks by coordinate failed — exactly the anti-pattern that the role and name
  echo on click-by-id exists to prevent.

Chrome's search ("first product listing title link in search results") solved it in ONE
call with its internal model. Intent versus substring.

## Validation of that week's fixes (a bonus)

- **The post-enter race on eBay did NOT reproduce**: `enter` followed immediately by a
  reading worked (obs #7, 586 clickable things). The in-page retry plus the adaptive
  settle cured the top operational regression from the previous round, on the real site
  where it happened.
- Adaptive settle in real use: HN 1.1 s · GitHub 1.7 s · npm 2.7 s · Argentina (19k nodes)
  3.5 s. The old ceiling was the FLOOR (a fixed 3.5 s).
- Fenced page output present everywhere, with zero operational interference.

## Token economics (approximate, by reading the outputs)

- This tool: outputs of 0.2–3 KB per command; the initial outline trimmed to 12 KB maximum.
- Chrome: `get_page_text` on HN about 4 KB (clean, ideal for extraction); `read_page` 50 KB,
  truncated and useless on T3; 4 screenshots at roughly 1.3k tokens each; the failed search
  on T3 burned a whole call and returned nothing.
- On T3, Chrome spent over 60 KB of context and failed; this tool spent about 6 KB and
  solved it.
- On T5, this tool spent about 8 KB and failed; Chrome about 10 KB and solved it.

## Verdict

They are **complementary, not competing** — the same result as the paid experiments:

- This tool wins where the page is larger than the context: in-page search that costs
  almost nothing in tokens, click by id with auto-scroll, small change reports, speed.
- Chrome wins where the page has to be UNDERSTOOD: search by intent, clean page text,
  robust references, popups and tabs handled.
- The combination would have gone 5/5 comfortably: Chrome for "what is this", this tool for
  "where is it, what changed, and operate cheaply".

## Concrete improvements taken from the T5 friction

1. Ranked search: prefer links with a detail href (/itm/, /wiki/, /package/), by box size
   and by region (main against navigation), not raw DOM order.
2. A `parent <id>` verb: climb to the clickable card.
3. `map <offset>`: page through the clickable things beyond the first 40.
4. (Already designed) scoped reading by region: `look <id>` exists; scoping by coordinates
   or a heuristic "results area" is still missing.

## Addendum, same day: T5 re-run after the harness fixes

The 3 improvements that came out of the failure, committed on `agent-lab`:

1. RANKED search (link and button roles, detail hrefs, name length, navigation and chips
   penalized, box size) with the href tail visible in the output.
2. `parent <id>`: climbs to the card (2 or more clickable things) around a node and reads
   it.
3. `map <offset>`: pages through the clickable things beyond the first 40.

Result: T5 solved in about 10 commands with no blind clicks:
open → find search → click → type → enter → look → find (listings now beat the chips, with
hrefs) → map 0 (the first listing's title) → click → look → `/itm/175450749165` with the
full title echoed back.

That puts 5/5 within reach on all five tasks.

## Full re-run of the tool arm (after the ranking fixes)

| Task | Morning | Re-run | Detail |
|---|---|---|---|
| T1 HN | ✓ 2 | ✓ 2 | "The AI Aesthetic", 45 comments (new front page); open 1.1 s |
| T2 GitHub | ✓ 4 | ✓ 3 | "Open0 (0)" now ranks first (the "Open Source" button used to win) |
| T3 Wikipedia | ✓ 4 | ✓ 4 | search shows the href /wiki/Mar_del_Plata BEFORE the click |
| T4 npm | ✓ 3 | ✓ 3 | 22,921,763 |
| T5 eBay | ✗ 14 | ✓ 9 | search "Opens in a new window" → titles ranked by position → /itm/316020676801 |
| **Total** | 4/5 · 27 | **5/5 · 21** | against Chrome's 4/5 · 27 calls |

An adjustment after T1: the first ranking favoured page-wide wrappers, whose accessible
name concatenates everything and therefore matches everything. Fix: penalize container
roles (generic, table, row, cell) and areas above 600k px², bonus for cards bounded to
8k–600k, and deduplicate nested chains sharing a name (keeping the most specific box).
eBay confirmed that cards (listitem, about 250k px²) still win where they should.

---

# Round 2 (2026-07-31): the full comparison WITH TIMINGS on both arms

Timing method: for this tool, wall time of the complete chain per task (Bash `time`, pure
harness execution with no model turnaround) plus `durationMs` per command from the JSONL.
For Chrome, wall timestamps before and after each task, which INCLUDE the model turnaround
between calls — inherent to its one-call-per-action interface. This tool can chain commands
in a single turn; Chrome cannot.

| Task | This tool: success · commands · wall | Chrome: success · calls · wall | Result |
|---|---|---|---|
| T1 HN top story | ✓ · 2 · **1.1 s** | ⛔ environment DNF · 2 · 21.4 s | Chrome hit the user's own HN rate limit (blocked 126 min); this tool, logged out: "The AI Aesthetic", 57 comments |
| T2 GitHub issues | ✓ · 3 · **1.9 s** | ✓ · 2 · 14.3 s | 0/338, identical |
| T3 Wikipedia link at 73k px | ✓ · 4 · **4.5 s** | ✓ · 6 · 42.3 s | Chrome managed it this time with a programmatic locate and click; its click by coordinate failed once. This tool: search plus click by id |
| T4 npm downloads | ✓ · 3 · **1.6 s** | ✓ · 2 · 16.4 s | 22,921,763, identical |
| T5 eBay first result | ✓ · 8 · **12.1 s** | ✗ FAILED · 15 (the cap) · 124.7 s | This tool: /itm/125682802912. Chrome: typing never reached the box (focus), its search returned a HOME carousel item as "the first result" twice, and the final click on a reference did not navigate |
| **Total** | **5/5 · 20 commands · 21.2 s** | **2/4 useful (+1 DNF) · 27 calls · 219 s** | |

Breakdown for this tool (JSONL: 19.7 s of daemon time inside 21.2 s of wall time, so about
1.5 s of command-line overhead):

- opens: HN 0.96 s · GitHub 1.63 s · Wikipedia 3.49 s · npm 1.39 s · eBay 5.59 s
- searches: 1–8 ms · readings: 94–413 ms · clicks that navigate: 0.3–1.5 s · enter: 2.0 s

Honesty notes:

- The timing asymmetry is real but informative. The command-line harness chains within one
  model turn (20 commands in about 6 turns); Chrome forces about one turn per action, and
  that turnaround IS part of operating through that interface.
- T1 in Chrome is not a tooling failure. It is the cost of operating IN the user's own
  browser, with their sessions, logins and account limits. The isolated daemon does not
  have that problem — a point that cuts both ways in the "this cannot be a random browser
  watching people's logins" discussion.
- T5 in Chrome failed this round where round 1 solved it in 8 calls: eBay's combobox focus
  is fragile, and its search presented a homepage carousel item as "the first search
  result" TWICE, confidently and wrongly. This tool failed round 1 and solved it in 8
  commands here. **Neither arm is deterministic on eBay.** The difference is that the
  harness now leaves the reason auditable in the JSONL.
- What T5 taught us about this tool: its ids are deterministic for the SAME DOM
  (same-environment repeatability). eBay's search box resolved identically across sessions,
  and the role and name echo confirmed it before acting.

Timing verdict: in pure execution this tool runs 5–25× faster per task than Chrome's
end-to-end flow, and its worst case (eBay, 12 s) matches Chrome's BEST end-to-end case
(14 s). The qualitative conclusion from round 1 does not change — they are complementary,
Chrome understands and this tool operates cheaply — but the operational margin is larger
than the untimed round showed.
