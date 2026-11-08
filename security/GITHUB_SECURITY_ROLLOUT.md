# GitHub security rollout

The image workflow builds an OCI archive once and scans and tests both platform variants. The promotion job checks the archive hash, publishes it with digest preservation and checks the published manifest hash. Promotion is an explicit dispatch input. A standard pull request verifies the release path without publishing. Main still supplies the latest and edge tags when manually promoted. Version tags must point to commits reachable from main.

Before authorizing a production image promotion, configure the image-promotion environment with required reviewers and explicit release ref restrictions. Protect main with required review and checks and protect the v* tag namespace against unauthorized writes. Require Actions to use full commit SHAs. Confirm package write access is limited to the promotion workflow and check that old publishing workflows cannot be dispatched from a legacy ref. Test failure of the candidate gate on a disposable repository or package and test digest preservation there before using the production package.

For an external reverse proxy, set TRUSTED_PROXIES to its socket address or narrow CIDR, overwrite X-Forwarded-Proto with the verified scheme, and prevent direct access through a trusted proxy address. Loopback is trusted for the built-in tunnel.

Release checks use digest-pinned scanner containers, including Semgrep and its Python dependencies. Review updates against upstream publisher metadata. Semgrep registry rule packs and vulnerability databases are still fetched during the scan. Validate runtime controls on a disposable deployment before rollout.

Sessions now expire after 24 hours of inactivity in addition to the existing absolute lifetime. Existing sessions are evaluated against their stored last-seen time. The security jobs include the MFA enrollment, replay and recovery tests.

For managed instances, set OPENPORTRAIT_EXTENSION_SHA256 to a comma-separated list of SHA-256 digests approved from independently verified release bundles. An explicitly empty list disables all extensions. Mount the extension directory read-only for the studio process, keep it separate from customer upload paths, and verify all bundled code and dependencies before adding a digest. Give each studio separate data volumes, network policy, and credentials. The digest policy assumes that an operator controls the directory and that the directory cannot be modified between verification and import.
