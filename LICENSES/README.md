# License texts and distribution notes

This directory is part of the distribution package. Keep it together with
`LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`.

## Component licenses

`components/` contains the exact upstream/fork license texts for the components
we distribute:

- pi-web (MIT)
- @tintinweb/pi-subagents (MIT)
- pi-mcp-adapter (MIT)
- pi-codex-goal (MIT)
- pi-smart-compact (MIT; optional)
- @juicesharp/rpiv-ask-user-question (MIT; vendored)
- sandbox-platform (MIT)

The source trees may have additional copyright headers; those remain in the
corresponding files.

## Third-party license texts

`*.txt` files are the standard texts for special or common licenses:

- `Apache-2.0.txt` — sharp / @img/sharp-linux-* and other Apache-2.0 packages
- `LGPL-3.0-or-later.txt` + `GPL-3.0-only.txt` — libvips
- `LGPL-SOURCE-OFFER.md` — libvips Corresponding Source offer/pointer
- `MPL-2.0.txt` — web-push, optional resvg
- `CC-BY-4.0.txt` — caniuse-lite
- `BlueOak-1.0.0.txt` — lru-cache/minimatch/glob/path-scurry/minipass
- `Python-2.0.txt` — argparse
- `Unlicense.txt` — fast-sha256/tweetnacl
- `0BSD.txt` — tslib
- `BSD-2-Clause.txt` / `BSD-3-Clause.txt` / `ISC.txt` — corresponding packages
- `WTFPL` is not used; expand-template is distributed under MIT.

For other MIT/BSD/ISC packages, the exact license and copyright notice is
shipped in each package's `node_modules/<package>/LICENSE*` file. The complete
package/license/source inventory is in `../THIRD_PARTY_NOTICES.md`.

## libvips / LGPL (conditionally distributed)

The standard Linux package removes Next's optional `sharp`/`@img/sharp-*`
dependencies because `next.config.ts` sets `images.unoptimized=true`. These
texts remain for variants that enable Next image optimization or otherwise
install sharp.

`@img/sharp-libvips-linux-x64` (and the musl variant when used) contains
`libvips-cpp.so`, loaded dynamically by sharp. The npm package does not carry a
LICENSE file, so the LGPL/GPL texts are included here.

Before commercial redistribution, the distributor must either:

1. include the Corresponding Source for the exact libvips build, or
2. provide a valid written offer to supply it, and

allow users to replace/relink the LGPL library. Upstream source and version
metadata:

- https://github.com/lovell/sharp-libvips
- `node_modules/@img/sharp-libvips-linux-x64/versions.json`

## Packaging rules

- Do not strip `LICENSE*`, `NOTICE*`, `COPYING*`, or this directory from the
  release package.
- `slim-package.sh` removes sharp/libvips when `images.unoptimized=true`; do not
  re-add LGPL obligations by installing sharp unless image optimization is
  actually enabled.
- If a slimming step removes a package's license file, copy it into
  `LICENSES/third-party/<package>/` before shipping.
- If you add an extension, add its component license and regenerate
  `THIRD_PARTY_NOTICES.md` from the new production dependency tree.
- If you use a dual-licensed package under a different branch than the one
  listed in `THIRD_PARTY_NOTICES.md`, update the notice and include that text.

This document is a compliance checklist, not legal advice.
