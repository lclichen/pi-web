import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "./clipboard.ts";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function restoreGlobals() {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete globalThis.navigator;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
}

function installFallbackDom(execResult) {
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    select() {},
    remove() {},
  };
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", {
    value: {
      createElement: () => textarea,
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => execResult,
    },
    configurable: true,
    writable: true,
  });
  return textarea;
}

test("prefers the Clipboard API when it is available", async () => {
  let written = null;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => void (written = text) } },
    configurable: true,
    writable: true,
  });
  try {
    await copyText("hello");
    assert.equal(written, "hello");
  } finally {
    restoreGlobals();
  }
});

test("falls back to execCommand and resolves when it succeeds", async () => {
  const textarea = installFallbackDom(true);
  try {
    await copyText("fallback text");
    assert.equal(textarea.value, "fallback text");
  } finally {
    restoreGlobals();
  }
});

test("rejects when the fallback copy is refused", async () => {
  installFallbackDom(false);
  try {
    await assert.rejects(copyText("nope"));
  } finally {
    restoreGlobals();
  }
});
