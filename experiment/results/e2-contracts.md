# E2 — The contracts where we claim an advantage, measured against agent-browser

2026-08-01 · agent-browser 0.33.1 · same pages for both · no model.
Runner: `experiment/e2-contracts.mjs`.

| Contract | Us | agent-browser | Verdict |
|---|---|---|---|
| **C1 occlusion** | `becameCovered: "Comprar ahora"` in the reading, **before** anything is attempted | The snapshot still lists the button as clickable, with no sign it is covered. The click fails **afterwards**: `✗ Element 'button' is covered by <div>` | **Our advantage, confirmed** |
| **C2a identity, remount** | `n_1r3 → n_1r3`, stable | `e1 → e1`, stable | **Tie — our assumption was false** |
| **C2b identity, reorder** | surface ids change; the report classifies (`moved` with rich names, `possible-replacement` with poor ones) | references change; the diff only shows text churn | Qualified (see below) |
| **C3 single-page navigation** | `navigated:true` plus `baselineUrl` | Its diff shows the content change but **does not signal that the URL moved** | **Our advantage, confirmed** |

## C1 — Occlusion: the advantage holds, with credit to them

This is the cleanest difference in the experiment. We publish the occlusion **in the
reading itself**, before the agent decides. They discover it **on impact**. For an agent
that is the difference between "I picked something else" and "I spent an action and now
have to interpret an error".

Honest credit: **their reactive error is good quality** — it names the element that covers
(`covered by <div>`), it does not fail silently. That is much better than a click that
quietly does nothing. Our advantage is one of timing, not of message quality.

## C2 — Identity: two corrections against us

**a) Remount: a tie. Our claim was false.** Based on their documentation saying references
are not stable, we assumed a node destroyed and rebuilt identically would break their
identity. **It does not**: `e1 → e1`. Their references survive a clean remount.

**b) Reorder: neither keeps its surface ids**, which is expected — the DOM changed. The
real difference is not the id but **what the report says**: ours classifies the movement,
theirs shows lines going in and out.

**A finding of our own, against us, which only appeared because the page was not one we
designed:** in a list of **3 items with short names** inside `<a>` elements, our comparison
degrades to `possible-replacement` for all three. In a list of **6 items with distinctive
names** it reports `moved` with identity preserved (`n_1r3…n_1r8`). In other words:

> matching identity across a reorder **depends on how rich the names are**. With weak
> signal it declares uncertainty rather than inventing identity.

Declaring the doubt is the designed behaviour — `possible-replacement` beats a false
`content` — but the correct claim becomes *"we classify the movement when there is enough
signal, and declare uncertainty when there is not"*, not *"we track identity across
reorders"*. Our own `list-reordered` fixture forbids `possible-replacement`, and it uses 8
items with long names, which is the easy case.

## C3 — Single-page navigation: advantage confirmed

After a `pushState` that changes the URL and replaces the content, we mark
`navigated:true` with the `baselineUrl`, so the caller knows the comparison spans two
pages. Their diff shows the new content with no sign the URL moved: an agent reading it
can believe it is still on the same view.

## Balance

- **2 advantages confirmed** (occlusion reported in advance, soft-navigation signal).
- **1 of our assumptions disproved** (their references do survive a remount).
- **1 limit of our own discovered** (matching depends on how rich the names are).

Neither correction would have shown up by reading their documentation. That is the
argument for running a comparable tool instead of filing notes about it.
