/**
 * Scoring rules for a single judge/model verdict, shared by `harness.mjs` (model over
 * HTTP) and `score.mjs` (blind judges). One definition so the two layers cannot drift.
 *
 * Each stratum is scored on ITS OWN question, never on a generic changed/unchanged
 * boolean — see EXPERIMENT.md for why that distinction is load-bearing.
 * @module agent/experiment/verdict
 */

/**
 * @param {{userVisibleChange?: boolean, nowUnclickable?: string[], understandable?: boolean}} v
 * @param {{userVisibleChange: boolean, mustReportCovered?: (string|string[])[], onlyPixels?: boolean}} truth
 */
export function scoreVerdict(v, truth) {
  const r = { changeCorrect: v.userVisibleChange === truth.userVisibleChange }
  if (truth.mustReportCovered) {
    // IDENTIFICATION: the verdict must single out the right number of previously
    // clickable elements. Whether it *names* them is a separate usability axis — a
    // bare-id answer is technically correct and operationally useless.
    const said = v.nowUnclickable || []
    const lower = said.join(' ').toLowerCase()
    r.occlusionCorrect = said.length >= truth.mustReportCovered.length
    r.namedThem = truth.mustReportCovered.every((alts) =>
      (Array.isArray(alts) ? alts : [alts]).some((n) => lower.includes(String(n).toLowerCase())))
  }
  // Canvas: DOM signals cannot answer by construction (§9). The scored answer is whether
  // the evidence ADMITS a region is opaque, so the caller knows to rasterize it.
  if (truth.onlyPixels) r.canvasHonest = v.understandable === false
  r.stratumCorrect = r.occlusionCorrect !== undefined ? r.occlusionCorrect
    : r.canvasHonest !== undefined ? r.canvasHonest
      : r.changeCorrect
  return r
}
