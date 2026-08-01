/**
 * Free-tier rate limits are a normal condition in this benchmark, not an error: a 25-task
 * run on the AI Studio free tier hits 429 constantly and must ride it out. Backs off on
 * 429/5xx and on network faults; anything else fails loudly, so a malformed request is
 * never mistaken for a hard task.
 *
 * Shared by the actor (run.mjs) and the judge (judge.mjs) so a fix applies to both.
 *
 * NOT FOR PUBLICATION — part of the private packages/agent workspace.
 * @module agent/experiment/webvoyager/retry
 */
export async function withRetry(call, label, tries = 6) {
  let wait = 5000
  for (let i = 1; ; i++) {
    let res
    try {
      res = await call()
    } catch (e) {
      if (i >= tries) throw e
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 90000)
      continue
    }
    if (res.ok) return res
    const body = (await res.text()).slice(0, 300)
    if (i >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`${label} ${res.status}: ${body}`)
    const retryAfter = Number(res.headers.get('retry-after')) * 1000
    await new Promise((r) => setTimeout(r, retryAfter > 0 ? retryAfter : wait))
    wait = Math.min(wait * 2, 90000)
  }
}
