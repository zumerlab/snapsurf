# Vendored snapDOM runtime

This directory makes `snapdom-agent` installable and testable from a clean clone. It
contains the browser runtime that the agent was developed against, rather than relying
on an undocumented sibling checkout.

- Source repository: `https://github.com/zumerlab/snapdom-v3`
- Source commit: `8e84c68b7f624c7fd1690c672725095289de3fe1`
- Source version: `3.0.0-beta.0`
- License: MIT (see `LICENSE` in this directory)
- `dist/snapdom.mjs` was produced by the source repository's `npm run compile`.
- The two export plugins are source copies with only their snapDOM import rewritten to
  the vendored runtime.

Do not edit the generated runtime by hand. Update the pinned source, rebuild it, copy
the three artifacts, and record the new commit here.
