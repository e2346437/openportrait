<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/openportrait-logo-dark.svg">
    <img src="docs/brand/openportrait-logo.svg" alt="OpenPortrait" height="72">
  </picture>
</p>

<p align="center">An open-source, self-hosted studio CRM for photographers. Runs as a Docker container and an Unraid app.</p>

<p align="center"><a href="https://openportrait.app">openportrait.app</a></p>

---

Brand assets (logo, icons, colors) live in [`docs/brand`](docs/brand/README.md).

## Status

Early development. The foundation is in place: first-run setup, sign-in, studio settings, the built-in Cloudflare Tunnel with a guided setup, nightly database backups, and the Docker image and Unraid template. Leads, shoots, calendar, booking, orders, contracts and galleries come next. See the [product spec and roadmap](docs/SPEC.md).

## Install

- [Docker, Docker Compose and Unraid](docs/install-docker.md)
- [Reaching it from the internet with Cloudflare Tunnel](docs/cloudflare-tunnel.md)

```sh
docker run -d --name openportrait -p 8080:8080 \
  -v ./appdata:/config -v ./galleries:/galleries -v ./incoming:/incoming \
  ghcr.io/e2346437/openportrait:latest
```

Then open `http://localhost:8080` and follow the setup screen.

## Development

You need Node 22 and pnpm 10 (`corepack enable` sets up pnpm).

```sh
pnpm install
pnpm build          # shared packages first, then the server and the web app
pnpm dev            # server on :8080 and the web app on :5173 with hot reload
pnpm test           # unit and API tests
pnpm typecheck
```

`pnpm dev` keeps its data in `./data`. Delete that folder to start over from the setup screen.

| Folder | What's in it |
|---|---|
| `apps/server` | Fastify API, background jobs, the cloudflared supervisor, and the `openportrait` maintenance CLI |
| `apps/web` | The React app (staff pages live under `/studio`) |
| `packages/db` | Drizzle schema (`src/schema/<area>.ts`) and SQL migrations |
| `packages/jobs` | The SQLite-backed job queue (`defineJob`, `enqueue`) |
| `packages/config` | Environment variables and folder paths |
| `packages/ui` | Design tokens, base styles and shared components |
| `docker`, `Dockerfile` | The image: entrypoint (PUID/PGID/UMASK) and bundled cloudflared |
| `unraid` | The Unraid Community Applications template |

After changing the schema, run `pnpm db:generate` to write a new migration.

## License

OpenPortrait is free software under the [GNU AGPL-3.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.
