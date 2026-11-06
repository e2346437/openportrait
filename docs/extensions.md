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
  // api.crewPanel(route)      a "Photographers" panel on each shoot (see Crew panel below)
  // api.createCameraLogin / resetCameraLogin / setCameraLoginDisabled   camera upload logins
  // api.onClose(fn)           cleanup when the server stops
  // api.z                     the app's copy of zod, for validating input
}
```

A page is a description, not UI code. Its `slug` must be lowercase letters, digits and dashes, and the app draws it at `/studio/x/<extension>/<slug>` from the data you give, with the records supplied by the extension's own routes. A route can answer `{ "locked": "message" }` to show a message in place of the records.

Capability groups let an extension supply tools that stay hidden until it grants them. Use `lockCapability` to mark a group as provided by an extension, and `grantCapability` or `revokeCapability` to switch it on or off as a whole. The built-in tool groups, including invoicing, are part of OpenPortrait itself and are never locked.

## Card layout

A settings card is a description that the app draws. Besides the chip, rows, stats, lists and switches, a card can use these parts (all optional, and the field names are in `SettingsCard` in `apps/server/src/extensions.ts`):

- `summary`: the key of a one-line string in the status JSON. On Settings > Extensions, a card that has one folds down to that line while its chip is healthy. A card whose chip is `warn` or `bad` opens by itself. The owner's choice is remembered in that browser. Cards without a summary stay open.
- `facts`: a strip of headline values, each with a smaller line under it.
- `features`: a list of what is switched on, with locked items shown as such. An item can link to another card of the same extension.
- `steps`: setup steps for a service that must be connected. The status JSON supplies each step's label, an optional detail and whether it is done, current or still to come.
- `details`: rows tucked into a "Technical details" disclosure.
- `links`: plain buttons that open another site.
- Rows with `format: "copy"` get a Copy button, for an address the owner must paste somewhere else. An action with `danger: true` is drawn as a quiet red button.

## Crew panel

`api.crewPanel("/crew")` replaces the "second shooters" pointer on each shoot with a panel the app draws: add a person (creating them on the spot), choose or create their camera login, and see whether each camera has connected. The extension answers these routes, all under its own owner-only prefix and `/crew/shoots/<shootId>`:

- `GET /` returns `{ enabled, message?, people, directory, cameras, roles, canSignin }`. `people` are on this shoot (`id`, `name`, `roleLabel`, `detail?`, `camera: { state: "none" | "waiting" | "ok" | "off", detail? }`); `directory` are people not on it yet; `cameras` are unassigned camera logins.
- `POST /people` adds someone. Body: `personId` or `name`, `role`, `fee?`, `camera: { mode: "new" | "existing" | "none", label?, existingId? }`, `expireAfterShoot?`, `signinEmail?`. Answers `{ ok, camera?: { id, label, username, folder, password }, signin?: { email, password } }`. Do it in one database transaction so a failure leaves nothing behind.
- `POST /people/<id>/camera` with `{ action: "new" | "reset" | "attach" | "disable" | "enable" }`.
- `DELETE /people/<id>` removes them from the shoot only.

The same panel is drawn on Settings > Extensions with everyone you work with, and no role or fee. For that the extension also answers, under the crew route itself (no `/shoots/<id>`): `GET /people` (same shape as above, with every person in `people`), `POST /people` (as above, without a shoot), `POST /people/<id>/camera`, `POST /people/<id>/signin` with `{ email }` answering `{ signin: { email, password } }`, and `DELETE /people/<id>`, which removes the person everywhere.

Passwords come from `api.createCameraLogin({ label })` and `api.resetCameraLogin(id)`, are returned once, and are never stored in readable form or written to Activity. `api.setCameraLoginDisabled(id, true)` stops new sign-ins for a login.

## Pointers to add-on features

Where a feature that an optional add-on provides would appear (QuickBooks Online, Microsoft 365, S3 and B2 bucket storage, second shooters), the owner sees one quiet line saying the add-on provides it, with a link. It shows only to the owner, disappears once the add-on is installed, and can be dismissed for good.

For the full design, see the Extensions section of [the product spec](SPEC.md#extensions).

## Sending email through an outside mailbox

An extension can call `api.mailSender({ label, ready, send })` to offer a mailbox, for example a hosted account that signs in with OAuth instead of a password. While `ready()` is true, all of the studio's email goes through `send`, and Settings > Email says so. When it is not ready, the SMTP settings are used as before.
