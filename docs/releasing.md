# Releasing

Notes for maintainers cutting a version.

1. Finish the [security release checklist](../security/RELEASE_CHECKLIST.md). The gate must pass.
2. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new version heading with the date.
3. Set `version` in the root `package.json` to the release number, and the same number in every workspace `package.json` (`apps/*`, `packages/*`). `scripts/check-version.mjs` runs in CI and fails if any of them differ, or if a release tag does not match the root version.
4. Merge to `main`, then tag the commit `vX.Y.Z`. The image workflow publishes `X.Y.Z` and `X.Y` to GHCR. The workflow runs the version check first, so a tag like `v0.2.0` fails unless `package.json` says `0.2.0`.
5. For the first 1.0 release only: in `.github/workflows/image.yml`, make `latest` follow tags instead of `main`, keep `edge` for `main`, and update the tag note in `docs/SPEC.md`.
6. Create the GitHub release with the changelog entry as its notes.
7. Check that a fresh `docker run` and the Unraid template both start the tagged image.
