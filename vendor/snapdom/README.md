# Vendored SnapDOM runtime

This directory pins the browser engine and capture plugins used by the agent. A clean
clone needs no sibling checkout at runtime. `manifest.json` records the exact source
commit, source version and SHA-256 of every artifact.

- Source: https://github.com/zumerlab/snapdom
- Version: `3.0.0-beta.0`; source revision is in `manifest.json`.
- License: MIT (see `LICENSE`).
- Runtime: an ESM bundle built from the pinned source, with the experimental native
  canvas engine disabled, matching the normal upstream distribution.
- SnapSurf's build wrapper adds the read-only `__snapdomIsInternalNode` export from
  that renderer instance's private ownership WeakSet. The observer uses it to omit
  renderer-created helper nodes. No ownership writer is exported; author-supplied
  `data-snapdom-internal` or sandbox markers do not hide page content.
- Plugins: GIF/video exporters, their frame helper, and redactInputs with its clone
  sanitizer and per-capture privacy policy. The only source rewrite redirects the
  published SnapDOM import to this vendored runtime.

Refresh all artifacts together from a clean source revision:

```sh
node tools/update-snapdom-vendor.mjs /path/to/snapdom
node packages/sensor/build.mjs
node browser-sdk/build.mjs
node companion/build.mjs
```

Run the repository gates before using the refreshed runtime. Updating the vendor does
not update a machine-global installation; that is a separate explicit action.
