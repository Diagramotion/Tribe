import assert from "node:assert/strict";
import test from "node:test";

const sources = [];
globalThis.window = {
  __TAURI_INTERNALS__: undefined,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    sources.push(this);
  }
  open() { this.onopen?.(); }
  fail() { this.onerror?.(); }
  send(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closed = true; }
}

globalThis.EventSource = FakeEventSource;
let batches = [];
const requests = [];
let nextFetchGate = null;
globalThis.fetch = async (url) => {
  requests.push(url);
  if (nextFetchGate) {
    const gate = nextFetchGate;
    nextFetchGate = null;
    await gate;
  }
  return new Response(
    JSON.stringify(batches.shift() ?? { events: [], hasMore: false }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const { runtime } = await import("../src/api/runtime.js?test=event-recovery");

function event(sequence) {
  return { id: `e${sequence}`, sequence, missionId: "m1", type: "message.created",
    actorId: "user", payload: { text: `event ${sequence}` }, createdAt: "2026-10-25T10:00:00Z" };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("event recovery did not finish");
}

test("reconnect recovery catches live events up in sequence order", async () => {
  const received = [];
  const statuses = [];
  const unsubscribe = runtime.subscribe("m1", 5, (item) => received.push(item.sequence), (status) => statuses.push(status));
  const source = sources.at(-1);
  try {
    batches.push({ events: [event(6), event(7)], hasMore: true });
    batches.push({ events: [event(8)], hasMore: false });
    source.open();
    source.send(event(8));
    await waitFor(() => received.length === 3);
    assert.deepEqual(received, [6, 7, 8]);

    batches.push({ events: [event(9)], hasMore: false });
    source.fail();
    await waitFor(() => received.length === 4);
    assert.deepEqual(received, [6, 7, 8, 9]);
    assert.equal(statuses.at(-1), "reconnecting");

    batches.push({ events: [event(10)], hasMore: false });
    source.open();
    await waitFor(() => received.length === 5);
    assert.deepEqual(received, [6, 7, 8, 9, 10]);

    source.send(event(15));
    assert.deepEqual(received, [6, 7, 8, 9, 10, 15]);
    assert.ok(requests.some((url) => url.includes("limit=200")));
  } finally {
    unsubscribe();
  }
  assert.equal(source.closed, true);
});

test("recovery catches up from the event log instead of buffering live bursts", async () => {
  const received = [];
  let releaseFetch;
  nextFetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  batches.push({ events: [], hasMore: false });
  const unsubscribe = runtime.subscribe("m1", 5, (item) => received.push(item.sequence), () => {});
  const source = sources.at(-1);
  try {
    source.open();
    for (let sequence = 6; sequence < 10_006; sequence += 1) source.send(event(sequence));
    assert.deepEqual(received, []);
    batches.push({ events: [event(6), event(7)], hasMore: false });
    releaseFetch();
    await waitFor(() => received.length === 2);
    assert.deepEqual(received, [6, 7]);
  } finally {
    unsubscribe();
    nextFetchGate = null;
  }
});
