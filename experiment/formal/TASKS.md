# Formal benchmark — task suite (v1)

10 tasks, fixed order, **cap: 15 actions per task**. Same missions for every arm.
Answer formats are part of the task: a correct result reported in the wrong format
may be judged fail — that is deliberate (agents must follow output contracts).

The judge for each task is in `tasks.mjs` (same ids). Judges are external to every
arm under test: plain HTTP fetches and constants, no oracle, no extension, no Codex.

| # | id | type | start | mission | answer format |
|---|---|---|---|---|---|
| T1 | `hn-top` | extraction | https://news.ycombinator.com | Report the title of the current #1 story and its comment count. | `<title> \| <comments>` |
| T2 | `gh-version` | nav + extraction | https://github.com/zumerlab/snapdom | Find the `version` field of `package.json` on the default branch. | the exact version string |
| T3 | `wiki-deeplink` | deep navigation | https://es.wikipedia.org/wiki/Argentina | Following a link inside the article body, open the article about Mar del Plata. | final URL (also set `finalUrl`) |
| T4 | `npm-downloads` | extraction | https://www.npmjs.com/package/preact | Report the weekly downloads number shown on the page. | the number |
| T5 | `ebay-first` | search + select | https://www.ebay.com | Search for `vinyl records`, open the first organic result (a listing — not a nav chip, related-search or carousel item). | item title; `finalUrl` = the `/itm/` URL |
| T6 | `pydocs-lru` | deep navigation | https://docs.python.org/3/ | Navigate to the `functools` module reference; report the default value of `lru_cache`'s `maxsize`. | the number; `finalUrl` = the functools page |
| T7 | `wiki-partido` | extraction | https://es.wikipedia.org/wiki/Mar_del_Plata | Per the article, report the *partido* (administrative subdivision) the city belongs to. | the partido name |
| T8 | `demoqa-add` | form + effect | demo-qa app (see README) | Add an item `Buy milk` using the form; report the full grocery list afterwards, in DOM order. | comma-separated items |
| T9 | `demoqa-noop` | verification | same page, same session | Click the `Refresh` button; report whether the app state semantically changed (the clock and spinner are ambient noise, not app state). | exactly `changed` or `no-change` |
| T10 | `wiki-search` | search | https://es.wikipedia.org | Use the site's own search to reach the article about the Obelisco de Buenos Aires. | final URL (also set `finalUrl`) |

Notes:
- T5 is non-deterministic by design (no arm is deterministic on eBay — documented in
  `../results/claude-vs-chrome.md`); the judge only requires a real `/itm/` landing.
- T9 is the false-green probe: the ground truth is `no-change` while pixels DO churn.
- T1 and T4 are judged against live APIs with tolerance (front page and download
  counters move); run the judge right after finishing a rep.
