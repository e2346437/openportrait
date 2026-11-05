# Protected proofing: design notes

Status: built (first version). Companion to [GALLERIES.md](GALLERIES.md).

## What it is and is not

Client previews are made smaller and carry an irregular, textured watermark baked into the pixels on the server. It deters casual copying and lowers the quality and fidelity of anything copied. It does **not** prevent screenshots, determined reproduction or AI recreation, and the app never says it does. The label in the UI is "Protected proofing".

## What the audit found (code, not docs)

- Media is served by one route, `/media/:photo/:version/:variant` (`routes/client-gallery.ts`). Staff thumbnails use the same route.
- Before this work the watermark applied only while downloads were payment-locked, at full preview size (2048 px) in an even diagonal grid. Unlocked galleries served clean 2048 px previews.
- The flavor (clean or marked) was named in the signed URL, so a clean URL issued before a lock stayed valid for up to 12 hours. The doc said previews are public and immutable; the code was already `private`.
- Website portfolio images (`routes/site.ts`) and staff views use clean thumbnails on purpose. No other client surface (emails, share images) carries gallery photos today.

## Policy

`{ mode: light | balanced | strong, apply: locked | always | off, maxLongEdge: 600..2048 | null }`.

- Studio default in the `galleries.proofing` setting. A gallery stores only what it overrides (`gallery.proofing`, migration 0027). `resolveProofing` merges them and validates each side separately.
- `apply` is separate from the download lock. `locked` is the previous behavior and the default, so nothing changes for a studio on update, apart from the look of marks on locked galleries (smaller, irregular).
- Presets are starting points to tune with real photos, not validated thresholds.

## Rendering

`galleries/proofing.ts`. From the clean cached preview or thumbnail: resize to the long edge, convert to sRGB, draw a seeded layout, encode WebP with no metadata.

- Seed is `HMAC(server secret, galleryId:photoId:rendererVersion)`, so a photo looks the same on every visit, the same photo in two galleries differs, and a layout can't be reproduced without the server's secret.
- Text marks vary rotation, scale, spacing, row offset, opacity and tone, have fine hatching inside the letters, and three versions of the wording with per-letter baseline and spacing wobble. Logos and custom images get the same treatment with rotated, scaled copies.
- A single-position watermark (not tiled) still works and is drawn the classic way, after resizing.
- File name: `<photo>-v<version>-<variant>-pf-<fingerprint>.webp`. The fingerprint covers preset, size, the watermark's own look and the renderer version, not `apply`. Older looks are deleted once a gallery renders under a new one.
- Renders of one file share a job and at most three run at once. They happen on demand, then are cached.

## Entitlement

The route decides what a visitor gets from the gallery's state **now**, never from the flavor in the URL:

| Visitor | URL asks for | Gets |
|---|---|---|
| anyone not signed in, previews protected | clean or protected | protected, `private, no-store` |
| anyone not signed in, previews clean | clean or protected | clean, `private, max-age` up to URL expiry |
| signed-in staff | clean | clean (admin grid) |
| signed-in staff | protected | protected |

URLs are still signed, expire in 6 to 12 hours, and stop working when the gallery is unpublished, expired or the photo hidden. A browser that already holds a clean copy keeps it; that can't be undone.

## Rollback

`apply: off` at the studio default restores clean previews everywhere without touching locks. Reverting the code leaves `gallery.proofing` unused and old `-pf-` files are rebuilt or ignored; `/cache` is always safe to delete.

## Test matrix

`apps/server/test/proofing.test.ts`: policy defaults and layering; fingerprint changes; determinism, size caps, no metadata, density by preset; clean URL after a lock gets the protected copy with `no-store`; unlock gives clean; `apply` independent of the lock; policy change gives new URLs and prunes files; tampered flavor is refused. `galleries.test.ts` covers the earlier lock behavior.

## Not built yet (research tickets)

Manual protection rectangles and selective detail concealment; pseudonymous forensic marks with a server-held mapping; adversarial perturbations. Each needs benchmarks against removal and reconstruction pipelines on a photographer-owned corpus before it ships. Pre-rendering through the job queue after a policy change is also not done: renders happen on first view.
