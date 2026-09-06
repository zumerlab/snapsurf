/**
 * Deterministic, dependency-free string hashing (FNV-1a, two seeds → 64-bit hex).
 * Same-environment repeatability only — never claim cross-browser determinism.
 * @module agent/hash
 */

/**
 * @param {...(string|number|boolean|null|undefined)} parts
 * @returns {string} 16-hex-char hash
 *
 * Both halves accumulate in ONE pass, and the parts are consumed as they arrive instead
 * of being joined first. Every part is length-framed before hashing: hashing the raw
 * concatenation makes distinct tuples collide by construction (`['1', '23']` and
 * `['12', '3']` both become `123`). Geometry uses one part per coordinate, so that was
 * enough for two genuinely different boxes to share a signature and disappear from the
 * diff. Framing keeps the public 16-hex shape while making argument boundaries real.
 *
 * The walk computes about ten of these per node, so the implementation still streams
 * each payload directly into both accumulators and avoids a joined intermediate string.
 *
 * The public output contract remains a fixed 16-character hex string. Values necessarily
 * change now that argument boundaries participate in the digest; callers must not treat
 * this internal, non-cryptographic signature as a stable external identifier.
 */
export function hash(...parts) {
  let a = 0x811c9dc5 >>> 0
  let b = 0x9747b28c >>> 0
  const add = (ch) => {
    a = Math.imul(a ^ ch, 0x01000193) >>> 0
    b = Math.imul(b ^ ch, 0x01000193) >>> 0
  }
  for (const part of parts) {
    const s = part === null || part === undefined ? '' : String(part)
    const length = String(s.length)
    for (let i = 0; i < length.length; i++) add(length.charCodeAt(i))
    add(0x3a) // ':' separates the decimal length from the payload
    for (let i = 0; i < s.length; i++) add(s.charCodeAt(i))
    add(0x3b) // ';' terminates even an empty part
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}
