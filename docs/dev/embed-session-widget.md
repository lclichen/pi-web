# Embedded session widget

`/embed/<token>` is a session-only chat surface for another product. It has no
project sidebar, environment menu, or settings; a token is bound to one project
(or host directory) and one product profile.

## Create a link

1. Admin: Settings → **Embed** → add a product.
   - **Allowed commands**: comma-separated names without the leading slash,
     e.g. `compact, name, copy, skill:deploy`. `*` allows every command.
   - **Allowed parent origins**: comma-separated origins, e.g.
     `https://app.example.com`. Empty allows any parent (the URL token is still
     required). The page emits `Content-Security-Policy: frame-ancestors …`.
2. Any user: project menu → **Create embed link**. Choose the product and TTL
   (1 / 7 / 30 days), then copy the URL. The URL is shown once.
3. Revoke links in Settings → **Embed**. Revocation invalidates the token
   immediately and removes its dedicated platform key.

Set Settings → Global config → **Public base URL** when the link must be opened
from another machine; otherwise the URL uses the request host.

## Embed

```html
<iframe
  src="https://pi.example.com/embed/emb_…"
  title="Agent"
  style="width: 380px; height: 720px; border: 0"
  allow="clipboard-write"
></iframe>
```

Do not use `sandbox` without `allow-same-origin`: the iframe's API requests are
same-origin to pi-web, and an opaque origin would make them cross-origin (and
break localStorage drafts).

Suggested container sizes:

| Form factor | Size | Layout |
|---|---|---|
| Side rail | `≥280×600` | mobile chat layout, icon header, full-width session popover |
| Bottom bar | `≥600×220` | compact header, hidden status capsule, scrollable transcript, tucked controls |
| Mini card | `≥280×180` | one-line header, compact composer, scrollable transcript |
| Full page | `≥480×480` | comfortable header and transcript |

Below roughly `280×180` the input remains usable, but long conversations are not
practical. Density is measured from the iframe viewport with a `ResizeObserver`
(`comfortable` / `compact` / `mini`), so the same URL adapts to all of them.

## Scope and identity

- A token exposes the bound project's **session list** and lets the holder
  create/switch sessions inside that project. It cannot switch projects.
- The token is the credential: anyone with the URL acts as its creator within
  that project until expiry or revocation. Create one token per product/user
  when separate identities are required.
- API access is default-deny: session list/read, agent commands/events, model
  list, file read/upload/search inside the workspace. Project management,
  admin routes, session rename/delete/takeover, and Git status are closed.
- Commands are filtered in the menu, blocked when typed, and re-checked on the
  server against the session's registered commands.
- Tokens are stored hashed (`embed-tokens.json`, mode 0600); the raw URL is not
  persisted. The token's platform key is stored server-side for BFF calls and
  deleted on revoke.
- The page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
  Avoid logging iframe URLs because the path contains the token.
