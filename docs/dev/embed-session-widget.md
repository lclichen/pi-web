# Embedded product integration

`/embed/p/<projectId>` is a session-only Agent surface for another product.
A **project id is a stable reference, not a credential**: the product stores it
and authenticates every open with the end-user's platform API key. The page URL
only carries a short-lived access token in its hash.

## Register a product

Settings → **Embed** (admin):

- **Members**: the product user group (platform user ids). An absent list means
  every active user; an empty list means nobody.
- **Agent config bundle**: fixed bundle applied to new product projects.
- **Default project mode**: `local-machine` (default), `sandbox`, or `ssh`.
- **Allowed commands / parent origins** as before.

Changing the group or bundle revokes existing short-lived access tokens, so
pages re-authenticate immediately.

## Product API

All calls use the user's platform API key:

```http
X-Platform-API-Key: sk_...
```

or `Authorization: Bearer sk_...`. Browser products must be listed in
`allowedOrigins`; the endpoints answer CORS preflight. Electron/local clients
can call from their main process instead.

```text
POST /api/embed/products/<productId>/projects
GET  /api/embed/products/<productId>/projects?clientId=...
POST /api/embed/products/<productId>/projects/<projectId>/open
POST /api/embed/products/<productId>/projects/<projectId>/reapply-config
POST /api/embed/products/<productId>/agent/pair-code
GET  /api/embed/products/<productId>/agent/machines
```

Create/reuse:

```json
{
  "clientId": "device-or-install-id",
  "externalRef": "default",
  "mode": "local-machine",
  "machineId": "…",
  "workdir": "/home/user/app-workspace",
  "name": "My product workspace"
}
```

- The default reuse key is `product + user + clientId + externalRef`; pass a
  different `externalRef` for another project and switch by using its
  `project.id`/`embedUrl`.
- `projectId` in the body binds an existing owned project (unbound or same
  product).
- Local-machine creation validates `machineId`/`workdir` against the live
  agent; offline returns `503 {code:"agent_offline"}`.
- The response includes `{project, reused, embedUrl, configUpdateAvailable}`.

Open:

```json
{ "sessionId": "optional-existing-session" }
```

returns `{url, token, expiresAt, project}`. The URL looks like:

```text
https://pi.example.com/embed/p/<projectId>?session=<id>#token=emba_...&expires=...
```

The token is short-lived (12h default, `PI_WEB_EMBED_ACCESS_TTL_MINUTES`). If it
expires, call `open` again; the project and sessions persist.

## Page authentication

- Product with a user API key: call `open`, then use the returned URL. The
  access token is read from the hash, stored in `sessionStorage`, and stripped
  from the address bar.
- No token (manual/direct link): the page asks for the user's API key and
  exchanges it at `/api/embed/auth`. The key stays inside the pi-web iframe and
  is never visible to the parent page; “Remember” stores it locally, and
  “Switch account” clears it.
- `projectId` alone does not grant access; the platform user must own the
  project and belong to the product group.

## Sessions

- New chat, project-scoped session list, session switch.
- Rename, archive/unarchive, delete; “Show archived” toggles the list.
- `?session=<id>` restores an exact session; otherwise the last session opened
  in this project/browser is used, then the most recent.
- Session files persist on the server; closing the iframe or an agent runtime
  eviction does not delete them.

## Local agent bootstrap

The product local client is expected to drive `agent-client`:

1. Call `POST .../agent/pair-code` and run
   `./agent-client pair --code <code> --server <publicBaseUrl>` if the machine
   is not paired yet.
2. Run `./agent-client run` (or reuse the existing connection).
3. Call `GET .../agent/machines` to discover `machineId`; create the project
   with that `machineId` and the desired workspace `workdir`.

Multiple pi-web users on the same OS account need separate `agent-client`
`--config` files (or separate OS users), because one client config holds one
server token/machine id. This is a product-side isolation requirement for now.

## Config bundle updates

A project records the applied bundle version + sha256. `open`/list report
`configUpdateAvailable` when the product bundle changed. Reapply explicitly:

- product API: `POST .../projects/<id>/reapply-config`
- embed page: the refresh button shown when an update is available

Apply is the existing additive-with-overwrite bundle import; it does not
automatically overwrite on page open.

## Embedding

```html
<iframe
  src="https://pi.example.com/embed/p/<projectId>#token=emba_..."
  title="Agent"
  style="width: 380px; height: 720px; border: 0"
  allow="clipboard-write"
></iframe>
```

Do not use `sandbox` without `allow-same-origin`; API calls and local storage
need the pi-web iframe origin. Suggested sizes:

| Form factor | Size | Layout |
|---|---|---|
| Side rail | `≥280×600` | mobile chat layout, icon header, full-width session popover |
| Bottom bar | `≥600×220` | compact header, hidden status capsule, scrollable transcript |
| Mini card | `≥280×180` | one-line header, compact composer |
| Full page | `≥480×480` | comfortable header and transcript |

The page measures the iframe container and switches
`comfortable`/`compact`/`mini` automatically. Pages use
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

## Security notes

- Project ids are public references; never treat them as secrets.
- The platform API key is a long-lived credential. Products holding it can see
  it; use a dedicated key per product/user where possible.
- Access tokens are in-memory server-side, scoped to one project, and expire;
  they cannot manage projects/admin routes.
- Product group membership is checked on every project API call and on page
  exchange. Removing a member revokes their current access tokens.
- Host directory projects are not product projects; use a ProjectRecord mode.
