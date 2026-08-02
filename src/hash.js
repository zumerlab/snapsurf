/**
 * Deterministic, dependency-free string hashing (FNV-1a, two seeds → 64-bit hex).
 * Same-environment repeatability only — never claim cross-browser determinism.
 * @module agent/hash
 */

/** @param {string} str @param {number} seed @returns {number} */
function fnv1a(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** @param {...(string|number|boolean|null|undefined)} parts @returns {string} 16-hex-char hash */
export function hash(...parts) {
  const s = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('')
  return (fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0') +
          fnv1a(s, 0x9747b28c).toString(16).padStart(8, '0'))
}
