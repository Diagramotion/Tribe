const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { estimateDirectoryBytes, forgetSiteOrigin, normaliseSiteOrigin, normaliseSiteOrigins, normaliseSiteStorage, rememberSiteOrigin, shouldTrackSiteOriginResourceType } = require("./browser-storage.cjs");

const temporaryRoots = [];

async function temporaryDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tribe-browser-storage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("estimates files recursively without following symbolic links", async (context) => {
  const root = await temporaryDirectory();
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "root.txt"), "12345");
  await fs.writeFile(path.join(root, "nested", "child.txt"), "1234567");
  const external = await temporaryDirectory();
  await fs.writeFile(path.join(external, "outside.txt"), "must not count");
  try {
    await fs.symlink(external, path.join(root, "linked"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      context.skip("This platform does not allow creating symbolic links in the test environment.");
      return;
    }
    throw error;
  }

  assert.deepEqual(await estimateDirectoryBytes(root), { bytes: 12, complete: true });
});

test("reports unavailable storage without leaking paths", async () => {
  const result = await estimateDirectoryBytes("");
  assert.deepEqual(result, { bytes: 0, complete: false });
});

test("bounds the amount of storage walked", async () => {
  const root = await temporaryDirectory();
  await Promise.all(Array.from({ length: 120 }, (_, index) => fs.writeFile(path.join(root, `file-${index}.txt`), "x")));

  const result = await estimateDirectoryBytes(root, 100);
  assert.equal(result.complete, false);
  assert.ok(result.bytes > 0);
  assert.ok(result.bytes < 120);
});

test("normalises per-site storage without exposing arbitrary CDP values", () => {
  assert.deepEqual(normaliseSiteStorage("https://example.com", {
    usage: 128.9,
    quota: 4096,
    usageBreakdown: [
      { storageType: "indexeddb", usage: 120.8 },
      { storageType: "cache_storage", usage: 8 },
      { storageType: "cookies", usage: 500 },
      { storageType: "unknown", usage: 900 },
    ],
  }), {
    origin: "https://example.com",
    bytes: 128,
    quotaBytes: 4096,
    breakdown: [
      { type: "indexeddb", bytes: 120 },
      { type: "cache_storage", bytes: 8 },
    ],
  });
  assert.throws(() => normaliseSiteStorage("file:///tmp/site"), /valid website origin/);
});

test("keeps a bounded, deduplicated inventory of safe website origins", () => {
  assert.equal(normaliseSiteOrigin("https://example.com"), "https://example.com");
  assert.equal(normaliseSiteOrigin("https://example.com/path"), "");
  assert.equal(normaliseSiteOrigin("file:///tmp/site"), "");
  assert.deepEqual(normaliseSiteOrigins([
    { origin: "https://old.example", lastVisitedAt: 1 },
    { origin: "https://new.example", lastVisitedAt: 5 },
    { origin: "https://old.example", lastVisitedAt: 8 },
    { origin: "https://bad.example/path", lastVisitedAt: 99 },
  ]), [
    { origin: "https://old.example", lastVisitedAt: 8 },
    { origin: "https://new.example", lastVisitedAt: 5 },
  ]);
  assert.equal(normaliseSiteOrigins(Array.from({ length: 600 }, (_, index) => ({
    origin: `https://site-${index}.example`, lastVisitedAt: index,
  }))).length, 500);
  const inventory = rememberSiteOrigin([
    { origin: "https://old.example", lastVisitedAt: 1 },
  ], "https://new.example", 2);
  assert.deepEqual(forgetSiteOrigin(inventory, "https://new.example"), [
    { origin: "https://old.example", lastVisitedAt: 1 },
  ]);
});

test("tracks origins that can own embedded or API-backed site data without recording static assets", () => {
  for (const resourceType of ["mainFrame", "subFrame", "xhr", "eventSource", "webSocket"]) {
    assert.equal(shouldTrackSiteOriginResourceType(resourceType), true);
  }
  for (const resourceType of ["image", "font", "script", "stylesheet"]) {
    assert.equal(shouldTrackSiteOriginResourceType(resourceType), false);
  }
});
