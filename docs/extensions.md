# Extensions

Extensions are optional modules that add to OpenPortrait without changing its code. An extension can add MCP tools, owner-only API routes, settings cards, and pages in the sidebar.

Only install extensions you trust. An extension runs with the same access as the OpenPortrait container.

## Installing one

Put the extension's `name.mjs` file in the `extensions` folder inside your config directory (`/config/extensions` in the container), or in the folder named by `OPENPORTRAIT_EXTENSIONS_DIR`. Restart OpenPortrait. A module that fails to load is skipped and logged, and the app always starts. The loaded modules and their SHA-256 hashes are listed at `GET /api/studio/extensions`.

Keep the folder writable only by the user that runs OpenPortrait.

## Writing one

An extension is an ES module that exports `register(api)`:

```js
export function register(api) {
  // api.id, api.appVersion, api.log, api.ctx
  // api.defineTool(...)       MCP tools for the AI access layer
  // api.routes(plugin)        a Fastify plugin, mounted owner-only under /api/studio/extensions/<name>/
  // api.page({ slug, ... })   a sidebar page described as data (list, filters, tiles, form, CSV export)
  // api.settingsCard({ ... }) a card in Settings > Extensions, with status and actions
  // api.lockCapability(id)    hide a capability group until an extension grants it
  // api.grantCapability(id) / api.revokeCapability(id)
  // api.onClose(fn)           cleanup when the server stops
  // api.z                     the app's copy of zod, for validating input
}
```

A page is a description, not UI code. Its `slug` must be lowercase letters, digits and dashes, and the app draws it at `/studio/x/<extension>/<slug>` from the data you give, with the records supplied by the extension's own routes. A route can answer `{ "locked": "message" }` to show a message in place of the records.

Capability groups let an extension supply tools that stay hidden until it grants them. Use `lockCapability` to mark a group as provided by an extension, and `grantCapability` or `revokeCapability` to switch it on or off as a whole. The built-in tool groups, including invoicing, are part of OpenPortrait itself and are never locked.

## Pointers to add-on features

Where a feature that an optional add-on provides would appear (QuickBooks Online, Microsoft 365, S3 and B2 bucket storage, second shooters), the owner sees one quiet line saying the add-on provides it, with a link. It shows only to the owner, disappears once the add-on is installed, and can be dismissed for good.

For the full design, see the Extensions section of [the product spec](SPEC.md#extensions).

## Sending email through an outside mailbox

An extension can call `api.mailSender({ label, ready, send })` to offer a mailbox, for example a hosted account that signs in with OAuth instead of a password. While `ready()` is true, all of the studio's email goes through `send`, and Settings > Email says so. When it is not ready, the SMTP settings are used as before.
