# Releasing

Maintainer notes. The release tooling relies on these steps: `npm run release:check` ([scripts/release-check.mjs](../scripts/release-check.mjs)) checks versions and runs the checks before tagging, and the [release-assets workflow](../.github/workflows/release-assets.yml) attaches build assets when a GitHub Release is published. The project is complete (v1.0), so releases are rare.

## What gets a tag

Each part has its own version, tag and GitHub Release. A tag names exactly one part.

| What | Version | Changelog | Tag | Release title |
|---|---|---|---|---|
| The repository (part 1, Storewright) | `version` in [`CITATION.cff`](../CITATION.cff) | the release notes | `v1.0.0` | Storewright v1.0.0 |
| StoreX (part 2) | `version` in `StoreX/package.json` | [`StoreX/CHANGELOG.md`](../StoreX/CHANGELOG.md) | `storex-v0.2.0` | StoreX 0.2.0 |
| StoreX Chain (part 3) | `version` in `StoreX-Chain/package.json` | [`StoreX-Chain/CHANGELOG.md`](../StoreX-Chain/CHANGELOG.md) | `storex-chain-v0.2.0` | StoreX Chain 0.2.0 |
| `@storewright/yard` | `version` in `packages/yard/package.json` | [`packages/yard/CHANGELOG.md`](../packages/yard/CHANGELOG.md) | `yard-v0.1.0` | @storewright/yard 0.1.0 |
| `@storewright/overlap-audit` | `version` in `packages/overlap-audit/package.json` | [`packages/overlap-audit/CHANGELOG.md`](../packages/overlap-audit/CHANGELOG.md) | `overlap-audit-v0.1.0` | @storewright/overlap-audit 0.1.0 |

- Versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Before 1.0, a new minor version (0.**x**.0) means new features or incompatible changes, and a new patch version (0.2.**x**) means fixes only.
- Tag names are the part's name in lower case, `-v` and the version (the repository release is plain `v` and the version). Use annotated tags (`git tag -a`).
- Changelogs follow [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): changes go under "Unreleased" as they happen; at release time they move under a new version heading and "Unreleased" is left empty.

## Steps, in order

Before you start, `main` is pushed to GitHub and CI on it has passed.

1. **Version and date.** The `version` in each `package.json` equals the newest version heading in its changelog. Replace the placeholder in that heading ("待发布（首次推送时填写日期）" in parts 2 and 3, "Unreleased (date set at the first release)" in the libraries) with the release date (`YYYY-MM-DD`). Check that "Unreleased" is empty and that the compare links at the bottom of the changelog point to the new tag. For the repository release, set `version` in `CITATION.cff` and add `date-released`.
2. **Local check.** From the repository root, run `npm run release:check` (`-- --only chain|storex|libs` checks one part). It compares versions with changelog headings, runs the CI checks for parts 2 and 3 and the libraries in order, and prints a summary table. Do not tag if anything fails. By hand, the same checks are:

   ```bash
   npm ci
   npm run check -w StoreX && npm run lint -w StoreX && npm run build -w StoreX
   npm run check -w StoreX-Chain && npm run lint -w StoreX-Chain && npm run build -w StoreX-Chain && npm run docs:check -w StoreX-Chain
   ```

   `lint` must report no errors; warnings are allowed.
3. **Commit and push** the changes from step 1, and wait until CI on `main` passes. Do not tag before it does.
4. **Tag** the commit that passed, and push the tags:

   ```bash
   git tag -a storex-v0.2.0 -m "StoreX 0.2.0"
   git tag -a storex-chain-v0.2.0 -m "StoreX Chain 0.2.0"
   git push origin storex-v0.2.0 storex-chain-v0.2.0
   ```

5. **Create the GitHub Release.** On the repository page: Releases → Draft a new release → choose the tag, give the title from the table, paste the notes (the version's section of the changelog; Generate release notes groups the merged pull requests by the labels in [`.github/release.yml`](../.github/release.yml)) → Publish release. For a 0.x version you may tick "Set as a pre-release". With the GitHub CLI:

   ```bash
   awk '/^## \[0\.2\.0\]/{f=1;next} /^## \[/{f=0} /^\[[^]]+\]: /{next} f' StoreX/CHANGELOG.md > notes-storex.md
   gh release create storex-v0.2.0 --title "StoreX 0.2.0" --notes-file notes-storex.md
   ```

   **Assets are attached automatically.** When a release is published, the release-assets workflow builds and uploads assets by tag prefix: `storex-chain-v*` and `storex-v*` get the static web build (`<part>-<version>-web.zip`, which works on any static host) and a CycloneDX SBOM of the run-time dependencies; `yard-v*` and `overlap-audit-v*` get the npm tarball (`.tgz`) and an SBOM. Any other tag, such as the repository's `v1.0.0`, gets no assets.

   If the workflow fails, make the SBOM by hand and attach it (do not commit it):

   ```bash
   npm sbom --sbom-format cyclonedx --omit dev -w StoreX > storex-0.2.0.cdx.json
   ```

   `ESBOMPROBLEMS` means the installed dependencies do not match the required versions: find the packages marked `invalid` or `missing` with `npm ls`, fix them and try again.
6. **(Optional) DOI.** For a citable DOI per release, use the Zenodo integration: sign in to Zenodo with GitHub and switch the repository on in Zenodo's GitHub settings **before** publishing; releases published earlier are not archived. Then add the DOI to `CITATION.cff` (`doi:`) and the README.
7. **After the release.** Leave the "Unreleased" sections empty for the next changes. Redeploy the live demo (Actions → Deploy demo site → Run workflow) so `/storex/` and `/storex-chain/` match the released versions.

## The two libraries

`@storewright/yard` and `@storewright/overlap-audit` (in `packages/`) are tagged on their own, with the same steps, except:

- Check them with `npm run release:check -- --only libs` (tests and packing).
- `npm run pack:libs` compiles each library to JavaScript with type declarations and writes an installable `dist-pkg/storewright-<name>-<version>.tgz` (`dist-pkg/` is not committed). Anyone can install it from the release asset's URL with `npm install <url>`, without an npm account.
- **(Optional) Publishing to npm** needs your own npm account and the `@storewright` scope: `npm login`, then `npm publish dist-pkg/storewright-yard-0.1.0.tgz --access public`. This is a public step and your decision; installing from the release works without it.
