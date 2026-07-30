/**
 * Anthropic first-party rates, USD per million tokens: [input, output].
 * Shared by the two spending harnesses so a price edit can't apply to only one.
 * @module agent/experiment/cost
 */
export const PRICES = {
  'claude-opus-5': [5, 25], 'claude-fable-5': [10, 50], 'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5],
}

/** @param {string} model @param {number} inTokens @param {number} outTokens */
export function usd(model, inTokens, outTokens) {
  const [pIn, pOut] = PRICES[model] || [0, 0]
  return +((inTokens / 1e6) * pIn + (outTokens / 1e6) * pOut).toFixed(4)
}
