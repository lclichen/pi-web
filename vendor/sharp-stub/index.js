"use strict";

/**
 * Intentional replacement for Next's optional `sharp` dependency.
 *
 * pi-web sets `images.unoptimized = true` in next.config.ts, so the image
 * optimizer is never used. Installing the stub instead of the real package
 * keeps the native image stack out of this repository and its distributions.
 */
function sharpStub() {
  throw new Error(
    "sharp is intentionally stubbed in this repository: Next image optimization is disabled (images.unoptimized = true).",
  );
}

module.exports = sharpStub;
