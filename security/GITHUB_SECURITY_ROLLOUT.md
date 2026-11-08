# GitHub security rollout

The image workflow builds an OCI archive once and scans and tests both platform variants. The promotion job checks the archive hash, publishes it with digest preservation and checks the published manifest hash. Promotion is an explicit dispatch input. A standard pull request verifies the release path without publishing. Main still supplies the latest and edge tags when manually promoted. Version tags must point to commits reachable from main.

Before authorizing a production image promotion, configure the image-promotion environment with required reviewers and explicit release ref restrictions. Protect main with required review and checks and protect the v* tag namespace against unauthorized writes. Require Actions to use full commit SHAs. Confirm package write access is limited to the promotion workflow and check that old publishing workflows cannot be dispatched from a legacy ref. Test failure of the candidate gate on a disposable repository or package and test digest preservation there before using the production package.

For an external reverse proxy, set TRUSTED_PROXIES to its socket address or narrow CIDR, overwrite X-Forwarded-Proto with the verified scheme, and prevent direct access through a trusted proxy address. Loopback is trusted for the built-in tunnel.

Remaining supply-chain and runtime work includes scanner image digest pinning, locking the Python scanner dependency, verifying managed extension bundles and deployment isolation, and retesting session idle timeout, second-factor enrollment and recovery against a disposable deployment.
