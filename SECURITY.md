# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, the steps to reproduce it, and the version or image tag you tested.

You can expect an acknowledgement within a few days. We will keep you posted while we confirm and fix the problem, and we will credit you in the changelog if you want that.

## Supported versions

Security fixes go into the latest release. Until 1.0, that is the `latest` image built from `main`.

## Testing your own install

Test only on a copy you own, with made-up data. Do not test against anyone else's studio. The [security documentation](security/) describes the threat model and how to run the automated checks against a local container.

## Good practice for your studio

- Keep the image up to date.
- Turn on two-step sign-in once it is available in your version.
- Reach the app through a Cloudflare Tunnel or another HTTPS front end, never plain HTTP over the internet.
- Back up the `/config` folder; it holds your database and settings.
