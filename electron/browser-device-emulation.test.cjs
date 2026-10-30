const assert = require("node:assert/strict");
const { test } = require("node:test");
const { deviceMetricsFor, deviceProfileFor, networkConditionsFor, normalizeLocale, normalizeNetworkProfile, normalizeReducedMotion, syncDeviceEmulation } = require("./browser-device-emulation.cjs");

test("maps fixed desktop and mobile presets to Chromium device metrics", () => {
  assert.deepEqual(deviceMetricsFor({ width: 393, height: 852, screenPosition: "mobile", deviceScaleFactor: 3 }), {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 393,
    screenHeight: 852,
    positionX: 0,
    positionY: 0,
  });
  assert.deepEqual(deviceMetricsFor({ width: 1280, height: 800, screenPosition: "desktop", deviceScaleFactor: 1 }), {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1280,
    screenHeight: 800,
    positionX: 0,
    positionY: 0,
  });
});

test("enables mobile viewport and touch emulation on one attached debugger session", async () => {
  const calls = [];
  const tab = {};
  let attached = false;
  let detachCount = 0;
  const debuggerClient = {
    isAttached: () => attached,
    attach: (version) => { calls.push(["attach", version]); attached = true; },
    detach: () => { calls.push(["detach"]); attached = false; detachCount += 1; },
    sendCommand: async (...args) => { calls.push(args); },
  };

  await syncDeviceEmulation(debuggerClient, tab, { width: 393, height: 852, screenPosition: "mobile", deviceScaleFactor: 3 });
  await syncDeviceEmulation(debuggerClient, tab, { width: 412, height: 915, screenPosition: "mobile", deviceScaleFactor: 3 });

  assert.equal(tab.deviceMetricsActive, true);
  assert.equal(tab.deviceMetricsDebuggerOwned, true);
  assert.equal(calls.filter(([method]) => method === "attach").length, 1);
  assert.deepEqual(calls.filter(([method]) => method === "Emulation.setTouchEmulationEnabled").map(([, params]) => params), [
    { enabled: true, maxTouchPoints: 5 },
    { enabled: true, maxTouchPoints: 5 },
  ]);
  assert.equal(detachCount, 0);
});

test("clears mobile overrides and releases only a debugger session it attached", async () => {
  const calls = [];
  let attached = false;
  const debuggerClient = {
    isAttached: () => attached,
    attach: () => { calls.push(["attach"]); attached = true; },
    detach: () => { calls.push(["detach"]); attached = false; },
    sendCommand: async (...args) => { calls.push(args); },
  };
  const tab = {};

  await syncDeviceEmulation(debuggerClient, tab, { width: 393, height: 852, screenPosition: "mobile", deviceScaleFactor: 3 });
  await syncDeviceEmulation(debuggerClient, tab, null);

  assert.deepEqual(calls.slice(-4), [
    ["Emulation.clearDeviceMetricsOverride"],
    ["Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 }],
    ["Emulation.setUserAgentOverride", { userAgent: "", platform: "", acceptLanguage: "" }],
    ["detach"],
  ]);
  assert.equal(tab.deviceMetricsActive, false);
  assert.equal(tab.deviceMetricsDebuggerOwned, false);
  assert.equal(attached, false);
});

test("maps device presets to their browser identities and client hints", () => {
  const pixel = deviceProfileFor("pixel-7", "130.0.6723.58");
  assert.match(pixel.userAgent, /Android 14; Pixel 7/);
  assert.match(pixel.userAgent, /Chrome\/130\.0\.0\.0/);
  assert.deepEqual(pixel.userAgentMetadata, {
    brands: [{ brand: "Chromium", version: "130" }, { brand: "Google Chrome", version: "130" }],
    fullVersionList: [{ brand: "Chromium", version: "130.0.6723.58" }, { brand: "Google Chrome", version: "130.0.6723.58" }],
    platform: "Android",
    platformVersion: "14.0.0",
    architecture: "arm",
    model: "Pixel 7",
    mobile: true,
    bitness: "64",
    wow64: false,
  });
  assert.equal(deviceProfileFor("iphone-15").platform, "iPhone");
  assert.equal(deviceProfileFor("ipad-mini").platform, "iPad");
  assert.equal(deviceProfileFor("responsive"), null);
});

test("validates locale and network conditions", () => {
  assert.equal(normalizeLocale("en-au"), "en-AU");
  assert.equal(normalizeLocale("system"), "");
  assert.throws(() => normalizeLocale("not a locale"), /valid browser locale/);
  assert.equal(normalizeNetworkProfile("slow-3g"), "slow-3g");
  assert.throws(() => normalizeNetworkProfile("dial-up"), /supported network condition/);
  assert.equal(normalizeReducedMotion("reduce"), "reduce");
  assert.equal(normalizeReducedMotion("system"), "system");
  assert.throws(() => normalizeReducedMotion("sometimes"), /supported reduced-motion preference/);
  assert.deepEqual(networkConditionsFor("offline"), {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none",
  });
});

test("applies and resets browser identity, locale and network overrides", async () => {
  const calls = [];
  let attached = false;
  const debuggerClient = {
    isAttached: () => attached,
    attach: () => { calls.push(["attach"]); attached = true; },
    detach: () => { calls.push(["detach"]); attached = false; },
    sendCommand: async (...args) => { calls.push(args); },
  };
  const tab = { defaultUserAgent: "Tribe Chromium" };
  const profile = deviceProfileFor("pixel-7", "130.0.6723.58");

  await syncDeviceEmulation(debuggerClient, tab,
    { width: 412, height: 915, screenPosition: "mobile", deviceScaleFactor: 3 },
    { deviceProfile: profile, locale: "en-AU", network: "slow-3g", reducedMotion: "reduce", defaultUserAgent: tab.defaultUserAgent });

  assert.equal(tab.deviceMetricsActive, true);
  assert.equal(tab.deviceUserAgentActive, true);
  assert.equal(tab.browserLocaleActive, true);
  assert.equal(tab.browserNetworkActive, true);
  assert.equal(tab.browserReducedMotionActive, true);
  assert.deepEqual(calls.find(([method]) => method === "Emulation.setUserAgentOverride")[1], {
    userAgent: profile.userAgent,
    platform: profile.platform,
    acceptLanguage: "en-AU",
    userAgentMetadata: profile.userAgentMetadata,
  });
  assert.deepEqual(calls.find(([method]) => method === "Emulation.setLocaleOverride")[1], { locale: "en_AU" });
  assert.deepEqual(calls.find(([method]) => method === "Network.emulateNetworkConditionsByRule")[1], {
    matchedNetworkConditions: [{ urlPattern: "", ...networkConditionsFor("slow-3g") }],
  });
  assert.deepEqual(calls.find(([method]) => method === "Network.overrideNetworkState")[1], networkConditionsFor("slow-3g"));
  assert.deepEqual(calls.find(([method]) => method === "Emulation.setEmulatedMedia")[1], {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

  await syncDeviceEmulation(debuggerClient, tab, null,
    { locale: "", network: "unthrottled", reducedMotion: "system", defaultUserAgent: tab.defaultUserAgent });

  assert.equal(tab.deviceMetricsActive, false);
  assert.equal(tab.deviceUserAgentActive, false);
  assert.equal(tab.browserLocaleActive, false);
  assert.equal(tab.browserNetworkActive, false);
  assert.equal(tab.browserReducedMotionActive, false);
  assert.deepEqual(calls.findLast(([method]) => method === "Emulation.setLocaleOverride")[1], {});
  assert.deepEqual(calls.findLast(([method]) => method === "Emulation.setUserAgentOverride")[1], {
    userAgent: "Tribe Chromium",
    platform: "",
    acceptLanguage: "",
  });
  assert.deepEqual(calls.findLast(([method]) => method === "Network.emulateNetworkConditionsByRule")[1], {
    matchedNetworkConditions: [],
  });
  assert.deepEqual(calls.findLast(([method]) => method === "Network.overrideNetworkState")[1], networkConditionsFor("unthrottled"));
  assert.deepEqual(calls.findLast(([method]) => method === "Emulation.setEmulatedMedia")[1], {
    features: [{ name: "prefers-reduced-motion", value: "" }],
  });
  assert.equal(debuggerClient.isAttached(), false);
});
