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

The source trees may have additional copyright headers; those remain in the
corresponding files.

`sandbox-platform` and the Agent Client are original components of this
product, covered by the repository's top-level `LICENSE`; they do not need a
separate component license inside this distribution. Their own repositories
keep their standalone LICENSE files for separate distribution.

## Third-party license texts

`*.txt` files are the standard texts for special or common licenses:

- `Apache-2.0.txt` — Apache-2.0 packages
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

## Next image optimizer (sharp) is intentionally stubbed

`next.config.ts` sets `images.unoptimized=true`, so Next's optional image
optimizer is never used. `package.json` replaces the optional `sharp`
dependency with the local no-op package in `../vendor/sharp-stub`; npm must not
install the real native image stack. Keep this override unless image
optimization is explicitly enabled and a new license review is completed.

## Packaging rules

- Do not strip `LICENSE*`, `NOTICE*`, `COPYING*`, or this directory from the
  release package.
- Do not add the real `sharp` package back while `images.unoptimized=true`.
- `slim-package.sh` removes any stale `sharp`/`@img/sharp-*` directories from
  build artifacts as a defense-in-depth check.
- If a slimming step removes a package's license file, copy it into
  `LICENSES/third-party/<package>/` before shipping.
- If you add an extension, add its component license and regenerate
  `THIRD_PARTY_NOTICES.md` from the new production dependency tree.
- If you use a dual-licensed package under a different branch than the one
  listed in `THIRD_PARTY_NOTICES.md`, update the notice and include that text.

This document is a compliance checklist, not legal advice.
