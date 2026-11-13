import assert from "node:assert/strict";
import test from "node:test";
import { RelayStatusStore } from "./useRelayAgent.ts";

class FakeEventSource {
  static CLOSED = 2;
  static instances = [];
  readyState = 0;
  onmessage = null;
  onerror = null;
  constructor(url) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
const originalFetch = globalThis.fetch;

function installBrowser() {
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, "EventSource", {
    value: FakeEventSource,
    configurable: true,
    writable: true,
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ online: true, relayPort: 30142, advertiseUrl: null, publicBaseUrl: null }),
    };
  };
  return { fetchCalls: () => fetchCalls };
}

function restoreBrowser() {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
  if (originalEventSource) Object.defineProperty(globalThis, "EventSource", originalEventSource);
  else delete globalThis.EventSource;
  globalThis.fetch = originalFetch;
}

test("many relay-status consumers share one EventSource per page", async () => {
  const { fetchCalls } = installBrowser();
  try {
    const store = new RelayStatusStore();
    let first = 0;
    let second = 0;
    const offFirst = store.subscribe(() => void (first += 1));
    const offSecond = store.subscribe(() => void (second += 1));
    await Promise.resolve();

    assert.equal(FakeEventSource.instances.length, 1, "only one SSE connection may be opened");
    assert.equal(fetchCalls(), 1, "the seed snapshot is fetched once");

    FakeEventSource.instances[0].emit({ online: true, relayPort: 40000 });
    assert.equal(store.getSnapshot().online, true);
    assert.equal(store.getSnapshot().relayPort, 40000);
    assert.equal(store.isReady(), true);
    assert.deepEqual([first, second], [1, 1], "every subscriber receives the update");

    store.refresh();
    await Promise.resolve();
    assert.equal(fetchCalls(), 2);

    offFirst();
    offSecond();
    assert.equal(FakeEventSource.instances.length, 1, "unsubscribing must not open another source");
  } finally {
    restoreBrowser();
  }
});
