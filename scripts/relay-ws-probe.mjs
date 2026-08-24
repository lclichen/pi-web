// Raw relay probe: connect a WebSocket to the relay WITHOUT sending the hello
// frame, hold it open, and report whether the server keeps the connection.
// Usage: node relay-ws-probe.mjs <ws-url> <hold-ms>
import WebSocket from "ws";

const url = process.argv[2];
const holdMs = Number(process.argv[3] ?? 12500);

const ws = new WebSocket(url);
let openedAt = 0;
ws.once("open", () => {
  openedAt = Date.now();
  console.log(`[probe] open (no hello sent) ${new Date().toISOString()}`);
  setTimeout(() => {
    const state = ws.readyState;
    console.log(`[probe] after ${holdMs}ms readyState=${state} (1=OPEN 3=CLOSED)`);
    if (state !== WebSocket.OPEN) {
      console.error("FAIL: connection dropped without hello");
      process.exit(1);
    }
    console.log("PASS: non-hello connection persists");
    ws.close();
    process.exit(0);
  }, holdMs);
});
ws.once("close", (code) => {
  if (!openedAt) {
    console.error(`[probe] closed before open, code=${code}`);
    process.exit(2);
  }
});
ws.on("error", (e) => {
  console.error(`[probe] error: ${e.message}`);
  process.exit(3);
});
