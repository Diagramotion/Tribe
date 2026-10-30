function deviceMetricsFor(config) {
  if (!config) return null;
  return {
    width: config.width,
    height: config.height,
    deviceScaleFactor: config.deviceScaleFactor,
    mobile: config.screenPosition === "mobile",
    screenWidth: config.width,
    screenHeight: config.height,
    positionX: 0,
    positionY: 0,
  };
}

const NETWORK_PROFILES = Object.freeze({
  unthrottled: Object.freeze({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "none" }),
  "slow-3g": Object.freeze({ offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000, connectionType: "cellular3g" }),
  "fast-3g": Object.freeze({ offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750, connectionType: "cellular3g" }),
  "4g": Object.freeze({ offline: false, latency: 20, downloadThroughput: 2_500_000, uploadThroughput: 1_250_000, connectionType: "cellular4g" }),
  offline: Object.freeze({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" }),
});

function normalizeLocale(value) {
  if (value == null || value === "" || value === "system") return "";
  if (typeof value !== "string" || value.length > 40) throw new Error("Choose a valid browser locale.");
  try {
    return Intl.getCanonicalLocales(value)[0] || "";
  } catch {
    throw new Error("Choose a valid browser locale.");
  }
}

function normalizeNetworkProfile(value) {
  const profile = value == null || value === "" ? "unthrottled" : String(value);
  if (!Object.hasOwn(NETWORK_PROFILES, profile)) throw new Error("Choose a supported network condition.");
  return profile;
}

function normalizeReducedMotion(value) {
  const preference = value == null || value === "" ? "system" : String(value);
  if (!["system", "reduce", "no-preference"].includes(preference)) throw new Error("Choose a supported reduced-motion preference.");
  return preference;
}

function deviceProfileFor(viewport, chromeVersion = "140.0.0.0") {
  const fullVersion = String(chromeVersion || "140.0.0.0");
  const major = fullVersion.split(".")[0] || "140";
  const chromeToken = `Chrome/${major}.0.0.0`;
  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
  ];
  const fullVersionList = [
    { brand: "Chromium", version: fullVersion },
    { brand: "Google Chrome", version: fullVersion },
  ];
  if (viewport === "pixel-7") return {
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ${chromeToken} Mobile Safari/537.36`,
    platform: "Linux armv8l",
    userAgentMetadata: { brands, fullVersionList, platform: "Android", platformVersion: "14.0.0", architecture: "arm", model: "Pixel 7", mobile: true, bitness: "64", wow64: false },
  };
  if (viewport === "iphone-15") return {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
  };
  if (viewport === "ipad-mini") return {
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    platform: "iPad",
  };
  return null;
}

function networkConditionsFor(value) {
  return NETWORK_PROFILES[normalizeNetworkProfile(value)];
}

async function syncDeviceEmulation(debuggerClient, tab, config, settings = {}) {
  const metrics = deviceMetricsFor(config);
  const locale = normalizeLocale(settings.locale);
  const network = normalizeNetworkProfile(settings.network);
  const reducedMotion = normalizeReducedMotion(settings.reducedMotion);
  const deviceProfile = settings.deviceProfile || null;
  const hasOverrides = Boolean(metrics || deviceProfile || locale || network !== "unthrottled" || reducedMotion !== "system");
  const hadOverrides = Boolean(tab.deviceMetricsActive || tab.browserLocaleActive || tab.browserNetworkActive || tab.deviceUserAgentActive || tab.browserReducedMotionActive);
  if (!hasOverrides && !hadOverrides) {
    return;
  }

  const attachedHere = !debuggerClient.isAttached();
  if (attachedHere) debuggerClient.attach("1.3");
  try {
    if (!debuggerClient.isAttached()) throw new Error("The browser emulation session is unavailable.");
    if (metrics) {
      await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", metrics);
      await debuggerClient.sendCommand("Emulation.setTouchEmulationEnabled", {
        enabled: metrics.mobile,
        maxTouchPoints: metrics.mobile ? 5 : 1,
      });
    } else if (tab.deviceMetricsActive) {
      await debuggerClient.sendCommand("Emulation.clearDeviceMetricsOverride");
      await debuggerClient.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    }
    const defaultUserAgent = settings.defaultUserAgent || tab.defaultUserAgent || "";
    const userAgent = deviceProfile?.userAgent || defaultUserAgent;
    const userAgentParams = {
      userAgent,
      platform: deviceProfile?.platform || settings.defaultPlatform || "",
      acceptLanguage: locale || settings.defaultLocale || "",
    };
    if (deviceProfile?.userAgentMetadata) userAgentParams.userAgentMetadata = deviceProfile.userAgentMetadata;
    await debuggerClient.sendCommand("Emulation.setUserAgentOverride", userAgentParams);
    if (locale) await debuggerClient.sendCommand("Emulation.setLocaleOverride", { locale: locale.replaceAll("-", "_") });
    else if (tab.browserLocaleActive) await debuggerClient.sendCommand("Emulation.setLocaleOverride", {});
    if (reducedMotion !== "system" || tab.browserReducedMotionActive) {
      await debuggerClient.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: reducedMotion === "system" ? "" : reducedMotion }],
      });
    }
    const networkConditions = networkConditionsFor(network);
    if (network !== "unthrottled" || tab.browserNetworkActive) {
      await debuggerClient.sendCommand("Network.enable");
      const { connectionType, ...state } = networkConditions;
      await debuggerClient.sendCommand("Network.emulateNetworkConditionsByRule", {
        matchedNetworkConditions: network === "unthrottled" ? [] : [{ urlPattern: "", ...networkConditions }],
      });
      await debuggerClient.sendCommand("Network.overrideNetworkState", { ...state, connectionType });
    }
    tab.deviceMetricsActive = Boolean(metrics);
    tab.deviceUserAgentActive = Boolean(deviceProfile);
    tab.browserLocaleActive = Boolean(locale);
    tab.browserNetworkActive = network !== "unthrottled";
    tab.browserReducedMotionActive = reducedMotion !== "system";
    if (hasOverrides) tab.deviceMetricsDebuggerOwned ||= attachedHere;
    else if (tab.deviceMetricsDebuggerOwned && debuggerClient.isAttached()) {
      debuggerClient.detach();
      tab.deviceMetricsDebuggerOwned = false;
    }
  } catch (error) {
    if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach();
    throw error;
  }
}

module.exports = { deviceMetricsFor, deviceProfileFor, networkConditionsFor, normalizeLocale, normalizeNetworkProfile, normalizeReducedMotion, syncDeviceEmulation };
