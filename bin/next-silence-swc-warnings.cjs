"use strict";

/**
 * Next's SWC loader logs each failed native binding attempt even when the wasm
 * fallback succeeds. On glibc 2.28 targets this produces noisy but harmless
 * lines such as:
 *
 *   Attempted to load @next/swc-linux-x64-gnu, but an error occurred:
 *   /lib64/libm.so.6: version `GLIBC_2.29' not found
 *   Attempted to load @next/swc-linux-x64-musl, but it was not installed
 *
 * The actual fatal error is emitted through console.error, so filtering only
 * these known fallback warnings keeps real SWC failures visible.
 *
 * Loaded by bin/pi-web.js via `node --require`. Set
 * PI_WEB_SILENCE_SWC_WARNINGS=0 to restore the raw Next output.
 */
if (process.env.PI_WEB_SILENCE_SWC_WARNINGS !== "0") {
  const originalWarn = console.warn.bind(console);
  const textOf = (value) => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  console.warn = (...args) => {
    const text = args.map(textOf).join(" ");
    const nativeFallback =
      /Attempted to load @next\/swc-/.test(text) &&
      (/GLIBC_2\.\d+/.test(text) || /but it was not installed/.test(text));
    if (nativeFallback) return;
    originalWarn(...args);
  };
}
