# Codex adversarial round — privacy layer (F3)

Date: 2026-08-01. Session: `20260801-181924`. Daemon log:
`packages/agent/logs/20260801-181924.jsonl`. I started one fresh daemon with
`serve --redact Wikipedia`, used the MCP server against that same daemon, stopped it,
and verified that port 8377 refused the subsequent `status` call. I did not change
product code.

## Executive result

I broke the confidentiality claim. A `data:` document containing a redact term leaks
the term verbatim through the URL on virtually every surface, including MCP
`structuredContent.url` and the durable JSONL log. Separately, MCP's session-wide rules
are race-prone: concurrent valid calls can apply one request's rules to another
request's page. The audit is also a deliberate presence/count oracle and is inaccurate
for overlapping rules.

## T1 — Find a leak

The real-page target was `https://en.wikipedia.org/wiki/Wikipedia`, with `Wikipedia`
present in headings, links, body text, and the search control's accessible name.

| Command | Log ms | Outcome |
| --- | ---: | --- |
| `open https://en.wikipedia.org/wiki/Wikipedia` | 1,389 | Text fields redacted; report disclosed 3,137 hits / 2,512 nodes. |
| `outline` | 18 | No literal escaped in observed fields. |
| `find Wikipedia` | 4 | `no matches`. |
| `match Wikipedia` | 0 | **Dead end:** `Error: unknown command: match`. The prompt named a nonexistent verb. |
| `map` | 2 | Searchbox was `[redacted]`; no observed-field escape. |
| `look n_1r6k` | 314 | Scoped output remained redacted. |
| `parent n_1r21` | 1 | **My mistake:** `unknown id`; `look` had advanced the epoch. Fail-loud worked. |
| `text n_1r6k` | 1 | **My mistake:** same stale id; `unknown id`. Fail-loud worked. |
| `assert {"exists":"Wikipedia"}` | 1,531 | `pass:false`, `blocked by privacy rule`. |
| `assert {"notCovered":"Wikipedia"}` | 1,378 | `pass:false`, `blocked by privacy rule`. |
| `cp diff wiki` | 958 | No change; report still disclosed 3,137 hits. |

I then used an exact synthetic document because it put the rule in link name, label,
body, control name, state, and click mutation at once. The observed fields were
redacted, including the click echo and diff. However, the document itself escaped in
the `data:` URL:

```sh
node packages/agent/tools/browse.mjs open "data:text/html,<h1>alpha</h1><a href='%23x'>secret link</a><label>secret label<input aria-label='secret control'></label><button aria-label='secret button' onclick=\"this.textContent='changed secret'\">secret</button><div aria-label='secret state' aria-valuetext='secret value'>body secret</div>"
node packages/agent/tools/browse.mjs redact secret
node packages/agent/tools/browse.mjs look
node packages/agent/tools/browse.mjs map
```

`open` (515 ms), `look` (3 ms), `map` (1 ms), `click` (314 ms), and `cp diff`
(2 ms) all exposed `secret` in the printed URL. The checkpoint success line exposed it
too, and the checkpoint JSON and JSONL stored it. MCP reproduced the leak in both
channels:

```json
{"name":"browser_open","arguments":{"url":"data:text/html,<h1>MCP secret</h1><button>secret</button>","redact":["secret"]}}
```

The response text contained the full URL, and `structuredContent.url` was exactly
`data:text/html,<h1>MCP secret</h1><button>secret</button>`. The corresponding daemon
`open` took 515 ms. This is not a screenshot or page-code attack; it is ordinary tool
output and durable logging.

## T2 — Make the report lie

| Command | Log ms | Outcome |
| --- | ---: | --- |
| `redact sec,secret,nomatch` | 1 | Accepted three rules. |
| `look` | 4 | Report: `rulesActive:3`, only `#0×10`, 6 nodes. `#1` also matches every `secret` string but was omitted. |
| `redact ' '` | 0 | Did not replace rules; it behaved like bare `redact` and reported three still active. Confusing, but not green. |
| `redact '.*,é,[redacted]'` | 1 | Regex metacharacters were literal; accepted three rules. |
| `open data:...` | 517 | Report showed `#0×3 · #2×2`; zero-hit `#1` omitted. |
| `redact off`; `look` | 1; 3 | Cleared successfully; no privacy report. |
| `redact café`; `look` | 1; 2 | Re-set successfully; zero-hit report had `rulesActive:1`, empty `hitsByRule`. |

The overlapping-rule result is an audit falsehood, not merely presentation. Under the
documented case-insensitive substring semantics, `secret` contains both `sec` and
`secret`; reporting ten hits for `#0` and none for `#1` says the second rule matched
nothing. The implementation appears to attribute each field only to the first matching
rule. `nodesRedacted:6` agrees with visible redaction, but `hitsByRule` does not describe
which active rules really matched.

## T3 — Attack the side channel

| Probe | Log ms | Outcome |
| --- | ---: | --- |
| `find Wikipedia` | 4 | Correctly returned no match. |
| `assert exists/notCovered` | 1,531 / 1,378 | Correct fail-loud refusals. |
| `open` Wikipedia with rule | 1,389 | **Presence and multiplicity disclosed:** `#0×3137`. |
| `look` after changing to a missing rule | 2 | **Absence disclosed:** `rulesActive:1`, `hitsByRule:[]`, `nodesRedacted:0`. |

The audit closes neither the one-bit channel nor a count channel. A consumer who knows
the rule index (or can compare requests) can distinguish absent from present and gets a
high-resolution frequency signal. On Wikipedia the answer was not merely “present” but
3,137 field hits across 2,512 nodes, split into 2,439 name and 698 text hits. Blocking
`exists` is therefore security theater while this report travels to the same consumer.
`mapTotal` and normal find counts were not needed.

The failed `mustInclude` attempt was:

```sh
node packages/agent/tools/browse.mjs assert '{"mustInclude":[{"kind":"content","name":"[redacted]"}],"changed":true}'
```

It returned `FAIL`, not green, because I had already run `look` and consumed the change
baseline. This was my sequencing mistake; fail-loud worked.

## T4 — Confused-consumer misuse

| Input | Log ms | Outcome |
| --- | ---: | --- |
| Empty/space CLI rule | 0 | Silently treated as “show current rules,” leaving prior rules active. Output exposed the count, so no false green. |
| `.*` | included in 1 ms `redact` | Correctly treated literally. |
| Rule `[redacted]` | same | Redacted genuine page text equal to the marker, making genuine marker text indistinguishable from replacement text. |
| Unicode/accent attempt | 514 ms open | **Wasted test:** my first `data:` URL lacked a charset and produced mojibake (`CAFÃ‰`); it cannot support a Unicode finding. |
| MCP `redact:["a,b"]` | 2 ms redact + 514 ms open | Became **two** rules (`rulesActive:2`), because MCP joins with commas and daemon splits. A legal plain-string rule containing comma cannot be represented. |
| MCP `redact:[""]` pipelined with the above | 0/2 ms redact + 516/519 ms opens | Calls raced; see T5. The empty-string result cannot be interpreted independently. |

No daemon crash occurred. I did not claim a hundreds-rule performance failure because
the more serious correctness failures were already reproducible, and fabricating a huge
shell argument would add little evidence.

## T5 — Free choice: concurrent MCP calls corrupt session privacy

Two newline-delimited, valid `tools/call` requests were sent without waiting, which MCP
permits:

```json
{"id":3,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"data:text/html,<p>a,b</p>","redact":["a,b"]}}}
{"id":4,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"data:text/html,<p>nothing</p>","redact":[""]}}}
```

Response 4 arrived first but reported `rulesActive:2`, although its requested empty
array element routes to `redact off`. Response 3 also reported two rules. The shared
page/rule state was interleaved, epochs completed as 25 then 26, and each response's
privacy state depended on the competing request. The daemon logged the two redactions
at 0 and 2 ms and opens at 516 and 519 ms. This can produce both over-redaction and,
with reversed timing, observation under the wrong/cleared rules. A session privacy
boundary cannot rely on clients voluntarily serializing protocol requests.

## Findings, ranked by severity

### Critical — `data:` URL bypass leaks page secrets everywhere

Repro: the T1 `data:text/html,...secret...` commands above, or MCP request id 2. Literal
`secret` appears in CLI/MCP prose, `structuredContent.url`, click echo, checkpoint
metadata/file, and JSONL `args`, `urlBefore`, and `urlAfter`. Fix URL handling before
redaction: for non-hierarchical URLs, never serialize payloads; emit a structural token
such as `data:«N chars»` and sanitize log args too.

### Critical — concurrent MCP requests race the session privacy policy

Repro: pipeline T5's two requests. Both successful responses used the two-rule state;
the `off` request did not observe its requested state. Serialize all page/session tool
execution, or bind rule revision + page operation atomically and verify that revision
when constructing the response.

### High — the audit report defeats the anti-probing design

Repro: compare `browser_open` on Wikipedia and a page without the term using the same
single rule. `hitsByRule`, field counts, and `nodesRedacted` directly answer presence
and frequency. The same consumer denied `assert exists` receives a much richer answer.

### Medium — overlapping rules make `hitsByRule` inaccurate

Repro: `redact sec,secret,nomatch` followed by `look` on the synthetic secret page.
Expected both `#0` and `#1` to have hits; actual only `#0×10`. Either count every rule
that matches each field or explicitly redefine the metric as first-match attribution;
the current contract says hits by rule.

### Medium — MCP cannot represent comma-containing plain-string rules

Repro: sequential MCP `browser_open` with `redact:["a,b"]`; actual
`rulesActive:2`. The array is collapsed into a comma-delimited transport and reparsed.
Pass rules as structured data end-to-end.

## Top three asks

1. Make URL/log serialization safe for `data:`, `javascript:`, `blob:` and userinfo;
   add adversarial tests that scan every response and artifact for the literal rule.
2. Serialize MCP calls per session and make redaction replacement + navigation one
   atomic operation with a reported policy revision.
3. Remove hit/field/node counts from the consumer-facing report. Return only an
   attestation that the configured policy revision ran; keep detailed counts in a
   separate operator-only audit sink.

## Verdict

**No, I would not hand a page containing information I actually cared about to this
tool with redaction on.** A page can exfiltrate its contents through an accepted
`data:` URL, concurrent MCP calls can observe under the wrong session rules, and the
audit deliberately tells the consumer whether and how often the hidden term occurred.
The single thing that would change my answer is a tested, fail-closed output boundary:
one atomic policy revision applied to every textual/URL/log/MCP surface, with no
consumer-visible hit counts and a test that rejects the entire observation if the raw
rule occurs anywhere in the serialized result or artifacts.

---

# Respuesta: los 5 hallazgos, cerrados el mismo día

Todos reproducidos primero con los repros exactos del reporte, después arreglados,
después re-verificados con los mismos comandos.

| # | Hallazgo | Estado |
|---|---|---|
| Crítico 1 | fuga por `data:` URL en toda superficie | ✅ cerrado |
| Crítico 2 | carrera de política entre llamadas MCP concurrentes | ✅ cerrado |
| Alto 3 | el reporte de auditoría como oráculo de presencia/frecuencia | ✅ cerrado |
| Medio 4 | `hitsByRule` inexacto con reglas superpuestas | ✅ cerrado |
| Medio 5 | MCP no puede representar una regla con coma | ✅ cerrado |

## Crítico 1 — `data:` URL

Tenía razón y el alcance era peor de lo que yo suponía: redactábamos el DOM pero la
carga viajaba **en la URL**, y la URL se imprimía en `open`, `look`, el eco del click,
`enter`, `status`, el warning de `navigated`, el actual del check `url`, la línea de
`cp save`, el **archivo** del checkpoint y el JSONL.

`safeUrl()` se aplica ahora en todas esas superficies: los esquemas no jerárquicos
(`data:`, `javascript:`, `blob:`, `filesystem:`) **nunca serializan su carga** —
emiten `data:«N chars»`— y una URL jerárquica pasa además por las reglas de redacción,
porque un término puede aparecer en un path.

```
antes: URL: data:text/html,<h1>secret payload</h1><button>secret</button>
ahora: URL: data:«86 chars»
```

Barrido completo con su repro: `look`, `outline`, `map`, `find`, `cp save`, `cp list`,
`status`, eco del click, JSONL y checkpoint en disco — **cero ocurrencias del término**.
El checkpoint conserva la URL cruda solo en memoria (para comparar documentos) y escribe
la saneada.

## Alto 3 — el reporte era el oráculo

Este es el que más duele porque es una decisión de diseño mía, y **resolvía la mitad
equivocada del problema**: escondía el *texto* de la regla y publicaba la *medición*.
Su formulación —"bloquear `exists` es teatro mientras este reporte viaja al mismo
consumidor"— es exacta.

El reporte al consumidor pasa a ser una **atestación**, sin conteos:

```
antes: privacy: 1 redact rule(s) · 3 node(s) redacted (#0×5)
ahora: privacy: policy revision 1 applied (1 redact rule(s))
```

Y ahora una página con el término y una sin él son **indistinguibles** en la salida.
Los conteos siguen existiendo para el operador: viajan por una clave `__audit` que el
borde del envelope **elimina** antes de responder, así que quedan solo en el JSONL.
Adoptado tal cual su ask #3.

## Crítico 2 y medio 5 — MCP

`browser_open` con `redact` hacía dos llamadas al daemon (`redact`, después `open`) con
las reglas unidas por comas. Ahora es **una sola operación** bajo el mutex del daemon
(`open <url> --redact-json '["a","b"]'`), con las reglas como JSON: dos consumidores
concurrentes ya no pueden observar bajo la política del otro, y una regla puede contener
una coma.

## Medio 4 — atribución first-match

Correcto: el contrato decía "hits por regla" y la implementación atribuía cada campo
solo a la primera regla que matcheaba, así que `redact sec,secret` reportaba `#1×0`
aunque `secret` matcheara todo. Ahora se cuentan **todas** las reglas que matchean; el
reemplazo sigue siendo uno solo.

## Cosas suyas que corrijo del lado del prompt

- **`match` no existe como verbo del daemon** — es de la companion. Error mío en el
  prompt, no un dead end suyo.
- Los tres `unknown id` que marcó como errores propios eran el fail-loud funcionando
  después de que `look` avanzara el epoch. Coincido con su lectura.

## Lo que NO adopté

Su ask #1 pide además tests adversariales que escaneen cada respuesta y artefacto
buscando la regla literal. Hice el barrido a mano y da cero, pero **no lo automaticé**:
queda como deuda declarada, no como hecho.

## Regresiones tras los cambios

vitest 58/58 · gate companion GREEN · paridad 8/8 en las 4 superficies ·
bench-qa oráculo 19/19 · 0 FP · demo-qa T1/T2 PASS.
