/**
 * First-party list rates, USD per million tokens: [input, output].
 * Shared by the spending harnesses so a price edit can't apply to only one.
 *
 * The gemini row is the PAID-tier list price, kept so a free-tier run can still report
 * "what this would have cost". A run on the AI Studio free tier spends $0 regardless —
 * re-check the published rate before quoting the number anywhere.
 * @module agent/experiment/cost
 */
export const PRICES = {
  'claude-opus-5': [5, 25], 'claude-fable-5': [10, 50], 'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5],
  'gemini-2.5-flash': [0.3, 2.5],
}

/** @param {string} model @param {number} inTokens @param {number} outTokens */
export function usd(model, inTokens, outTokens) {
  const [pIn, pOut] = PRICES[model] || [0, 0]
  return +((inTokens / 1e6) * pIn + (outTokens / 1e6) * pOut).toFixed(4)
}
