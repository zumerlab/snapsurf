# Releasing SnapSurf

SnapSurf is published as `@zumer/snapsurf` under the MIT license. The version lives in
`package.json` and is mirrored in `server.json`, the manifest for the official MCP
Registry; `npm run test:pack` fails when the two disagree or when `mcpName` is missing.
`packages/sensor` and `browser-sdk` remain private development packages and are not
included in this npm release.

## Version and build workflow

SnapSurf uses the same script names and versioning tools as SnapDOM:

| Command | Purpose |
| --- | --- |
| `npm run bump:dry` | Preview the version bump with `@zumerbox/bump`. |
| `npm run bump` | Run `@zumerbox/bump`, then `@zumerbox/changelog`. |
| `npm run compile` | Rebuild the companion, sensor and browser SDK bundles. |
| `npm run build` | Compile and create `zumer-snapsurf-<version>.tgz` with `npm pack`. |
| `npm run release:push` | Stage the changelog, commit it as `Bumped version`, then push with tags. |

Use `bump` when preparing a new version; skip it when the intended version is already
set. Update `server.json` to the same version. When the plugin changed, bump its version
in `plugins/snapsurf/.claude-plugin/plugin.json`, `plugins/snapsurf/.codex-plugin/plugin.json`
and `.claude-plugin/marketplace.json` (the Claude validator requires plugin and marketplace
to agree) and run `claude plugin validate plugins/snapsurf --strict` and
`claude plugin validate . --strict`.
`build` only creates a local archive.
`release:push` sends Git changes; npm publication is a separate maintainer action.

## Validate the release candidate

Use Node.js 22 or newer. From a checkout with the release files saved:

```sh
npm ci
npx playwright install chromium
npm run test:gates
npm run test:cold
```

`test:gates` runs the browser regression suite, adversarial scenarios, extension
boundary checks and an installation test of the packed npm artifact. `test:cold`
copies only Git-tracked files into an empty directory, installs dependencies and
Chromium in a separate cache, and checks that the project works without the
developer's local setup. Add new release files to Git before running it.

Review the package contents and metadata:

```sh
npm run build
git diff --check
git status --short
```

The package should include its runtime, vendor license, MIT license and linked user
documentation. Local logs, test fixtures, credentials and research artifacts should
not appear in the npm archive.

## Publish as the maintainer

For GitHub, start from the prepared clean source archive. It excludes historical
`logs/`, `scratchpad/`, scraped third-party bodies in `docs/landscape-data/`, internal
working Markdown listed in `.gitignore`, and `.git/`; runtime and test fixtures are
included. Initialize
a new public repository from that source and keep the development repository private.
The development history contains old browsing traces and captures. Removing those
files in a new commit would still leave earlier copies in that history.

The package metadata points to `zumerlab/SnapSurf`. Use that exact capitalization
for the public repository when uploading the clean source. If you choose another
repository name, update the package metadata and documentation links before repacking.

The release-validation workflow is manual: run the `ci` workflow with
`workflow_dispatch` to run all gates and the cold installation on Node.js 22. It
contains no publishing step.

For npm, use an account with publishing access to the `@zumer` scope:

```sh
npm whoami
npm view @zumer/snapsurf@<version> version
npm publish ./zumer-snapsurf-<version>.tgz --access public
```

The `npm view` check should report that this version does not exist. If it already
exists, choose a new version and update the package, lockfile and changelog before
publishing. npm authentication and any required one-time password are supplied by
the maintainer at publication time.

Publishing the `.tgz` uses the exact bytes that were built and reviewed. After the
release changes have been reviewed, `npm run release:push` sends the changelog commit
and local tags to the configured Git remote, following the SnapDOM workflow.

After publication, verify installation from the registry in a new directory and
create the `v<version>` Git tag in the public source repository and release notes from
[the changelog](../CHANGELOG.md).

Then publish the same version to the official MCP Registry. It only stores metadata and
verifies that the npm package carries the matching `mcpName`, so the npm publication
must come first. Run the `publish-mcp-registry` workflow (Actions → Run workflow): it
authenticates with GitHub Actions OIDC, which grants `io.github.zumerlab/*` to this
repository, checks that the npm version named in `server.json` exists, and publishes.

The interactive `mcp-publisher login github` grants the organization namespace only when
GitHub reports the zumerlab membership (role owner) to the registry's GitHub App. When it
answers "You have permission to publish: io.github.<user>/*" instead, authenticate with
a personal access token that has the `read:org` scope and no repository scopes:

```sh
mcp-publisher login github --token "$GITHUB_TOKEN_WITH_READ_ORG"
mcp-publisher publish             # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.zumerlab/snapsurf"
```

The 0.x versions are experimental; the documented browser and observation limits still
apply.
