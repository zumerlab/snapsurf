# codex-agent — rep 1

Fresh daemon session `20260801-005733`; all tasks stayed below the 15-action cap.

```text
codex-agent (rep 1) — packages/agent/experiment/formal/results/codex-agent-r1.json
task            claimed  judged  detail
hn-top          true     ✓ pass  matches live top-10 story: "Tailscale didn't stop the Hugging Face intrusion"
gh-version      true     ✓ pass  version 2.23.1 confirmed against raw.githubusercontent
wiki-deeplink   true     ✓ pass  landed on /wiki/Mar_del_Plata
npm-downloads   true     ✓ pass  23467316 within ±25% of live API value 27689392
ebay-first      true     ✓ pass  landed on a listing: /itm/156667373874
pydocs-lru      true     ✓ pass  functools page + maxsize default 128
wiki-partido    true     ✓ pass  partido General Pueyrredón
demoqa-add      true     ✓ pass  list is exactly [Bread, Buy milk] in DOM order
demoqa-noop     true     ✓ pass  correctly reported no semantic change
wiki-search     true     ✓ pass  landed on the Obelisco article

judged pass: 10/10
written: packages/agent/experiment/formal/results/codex-agent-r1.judged.json
```
