import assert from "node:assert/strict";
import test from "node:test";
import { applyFaviconBadge, resetFaviconBadgeForTests } from "./favicon-badge.ts";

function fakeDocument() {
  const links = [
    { href: "http://host/icon-192.png", isConnected: true },
    { href: "http://host/favicon.ico", isConnected: true },
  ];
  const context = {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    fillText() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: () => "data:image/png;base64,badge",
  };
  return {
    links,
    querySelectorAll: () => links,
    createElement: () => canvas,
  };
}

test("draws an unread badge and restores the original icon hrefs", () => {
  resetFaviconBadgeForTests();
  const doc = fakeDocument();

  applyFaviconBadge({ unread: 3, running: 1 }, doc);
  assert.equal(doc.links[0].href, "data:image/png;base64,badge");
  assert.equal(doc.links[1].href, "data:image/png;base64,badge");

  applyFaviconBadge({ unread: 0, running: 0 }, doc);
  assert.equal(doc.links[0].href, "http://host/icon-192.png");
  assert.equal(doc.links[1].href, "http://host/favicon.ico");
});

test("uses the running count when nothing is unread", () => {
  resetFaviconBadgeForTests();
  const doc = fakeDocument();

  applyFaviconBadge({ unread: 0, running: 2 }, doc);
  assert.equal(doc.links[0].href, "data:image/png;base64,badge");
});
