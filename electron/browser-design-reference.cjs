const DESIGN_REFERENCE_SCRIPT = `(() => {
  const url = new URL(location.href);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const maps = Object.fromEntries([
    "backgrounds", "foregrounds", "links", "controls", "borders", "fonts",
    "fontSizes", "weights", "lineHeights", "spacing", "radii",
  ].map((key) => [key, new Map()]));
  const add = (key, value) => {
    const text = String(value ?? "").trim();
    if (!text || text === "transparent" || /^rgba?\\([^)]*,\\s*0\\s*\\)$/i.test(text)) return;
    const values = maps[key];
    values.set(text, (values.get(text) || 0) + 1);
  };
  const number = (value) => {
    const match = String(value ?? "").trim().match(/^(\\d+(?:\\.\\d+)?)px$/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 96 ? Math.round(parsed) : null;
  };
  const pixels = (value) => {
    const parsed = number(value);
    return parsed == null ? null : String(parsed) + "px";
  };
  const styleSample = (element) => {
    const style = getComputedStyle(element);
    const padding = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
      .map((part) => number(part));
    return {
      color: style.color,
      background: style.backgroundColor,
      border: style.borderTopStyle === "none" ? "" : style.borderTopColor,
      radius: pixels(style.borderTopLeftRadius),
      fontFamily: style.fontFamily,
      fontSize: pixels(style.fontSize),
      fontWeight: style.fontWeight,
      padding: padding.every((part) => part != null) && padding.every((part) => part === padding[0])
        ? String(padding[0]) + "px" : "",
    };
  };
  const nodes = [...document.querySelectorAll(
    "body,main,header,nav,section,article,aside,footer,h1,h2,h3,p,a,button,input,textarea,select,[role=button]",
  )].filter(visible).slice(0, 400);
  const buttons = [];
  const inputs = [];
  for (const element of nodes) {
    const style = getComputedStyle(element);
    add("backgrounds", style.backgroundColor);
    add("foregrounds", style.color);
    add("fonts", style.fontFamily);
    add("fontSizes", pixels(style.fontSize));
    add("weights", style.fontWeight);
    add("lineHeights", pixels(style.lineHeight));
    add("radii", pixels(style.borderTopLeftRadius));
    for (const value of [style.paddingTop, style.paddingRight, style.paddingBottom,
      style.paddingLeft, style.gap, style.rowGap, style.columnGap]) add("spacing", pixels(value));
    if (element.tagName === "A") add("links", style.color);
    if (["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
      add("controls", style.backgroundColor);
      if (element.tagName === "BUTTON" && buttons.length < 8) buttons.push(styleSample(element));
      if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) && inputs.length < 8) inputs.push(styleSample(element));
    }
    if (style.borderTopStyle !== "none" && number(style.borderTopWidth)) add("borders", style.borderTopColor);
  }
  const rank = (key, limit = 10) => [...maps[key].entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
  return {
    backgrounds: rank("backgrounds"), foregrounds: rank("foregrounds"),
    links: rank("links"), controls: rank("controls"), borders: rank("borders"),
    fonts: rank("fonts"), fontSizes: rank("fontSizes"), weights: rank("weights"),
    lineHeights: rank("lineHeights"), spacing: rank("spacing"), radii: rank("radii"),
    buttons, inputs, sampleCount: nodes.length,
  };
})()`;

function safeReferenceUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("Open an HTTP or HTTPS page in Tribe Browser first."); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Open an HTTP or HTTPS page in Tribe Browser first.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.slice(0, 2048);
}

function cleanStyleText(value, limit = 120) {
  return typeof value === "string"
    ? value.replace(/[\x00-\x1f;{}<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function cleanColorList(value, limit = 10) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((item) => {
    if (!item || typeof item.value !== "string" || !/^#[\da-f]{3,8}$|^rgba?\([\d.,%\s]+\)$/i.test(item.value)) return [];
    return [{ value: item.value.slice(0, 48), count: Math.max(0, Number(item.count) || 0) }];
  });
}

function cleanValueList(value, limit = 10, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((item) => {
    const text = cleanStyleText(item?.value, maxLength);
    return text ? [{ value: text, count: Math.max(0, Number(item.count) || 0) }] : [];
  });
}

function cleanSamples(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => ({
    color: cleanColorList([{ value: item?.color }], 1)[0]?.value || "",
    background: cleanColorList([{ value: item?.background }], 1)[0]?.value || "",
    border: cleanColorList([{ value: item?.border }], 1)[0]?.value || "",
    radius: /^\d{1,2}px$/.test(item?.radius) ? item.radius : "",
    fontFamily: cleanStyleText(item?.fontFamily),
    fontSize: /^\d{1,2}px$/.test(item?.fontSize) ? item.fontSize : "",
    fontWeight: /^\d{1,3}$/.test(item?.fontWeight) ? item.fontWeight : "",
    padding: /^\d{1,2}px$/.test(item?.padding) ? item.padding : "",
  }));
}

function cleanReference(raw, url) {
  if (!raw || typeof raw !== "object") throw new Error("This page did not expose usable visual styles.");
  return {
    url,
    backgrounds: cleanColorList(raw.backgrounds), foregrounds: cleanColorList(raw.foregrounds),
    links: cleanColorList(raw.links), controls: cleanColorList(raw.controls), borders: cleanColorList(raw.borders),
    fonts: cleanValueList(raw.fonts), fontSizes: cleanValueList(raw.fontSizes),
    weights: cleanValueList(raw.weights), lineHeights: cleanValueList(raw.lineHeights),
    spacing: cleanValueList(raw.spacing), radii: cleanValueList(raw.radii),
    buttons: cleanSamples(raw.buttons), inputs: cleanSamples(raw.inputs),
    sampleCount: Math.max(0, Math.min(400, Number(raw.sampleCount) || 0)),
  };
}

async function readDesignReference(contents, isCurrentTab = () => true) {
  if (!contents || contents.isDestroyed?.()) throw new Error("The selected browser page is unavailable.");
  const pageUrl = () => {
    const parsed = new URL(contents.getURL());
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  };
  const startingPageUrl = pageUrl();
  const startingUrl = safeReferenceUrl(startingPageUrl);
  const raw = await contents.executeJavaScript(DESIGN_REFERENCE_SCRIPT, true);
  if (contents.isDestroyed?.() || !isCurrentTab() || pageUrl() !== startingPageUrl) {
    throw new Error("The browser page changed during capture. Capture it again.");
  }
  let screenshot;
  if (typeof contents.capturePage === "function") {
    const image = await contents.capturePage();
    if (contents.isDestroyed?.() || !isCurrentTab() || pageUrl() !== startingPageUrl) {
      throw new Error("The browser page changed during capture. Capture it again.");
    }
    if (!image?.isEmpty?.()) {
      const size = image.getSize();
      let quality = 68;
      let bytes = image.toJPEG(quality);
      while (bytes.length > 600_000 && quality > 28) {
        quality -= 10;
        bytes = image.toJPEG(quality);
      }
      if (bytes?.length <= 600_000) {
        screenshot = {
          mimeType: "image/jpeg",
          data: bytes.toString("base64"),
          width: size.width,
          height: size.height,
        };
      }
    }
  }
  return { reference: cleanReference(raw, startingUrl), ...(screenshot ? { screenshot } : {}) };
}

module.exports = { DESIGN_REFERENCE_SCRIPT, readDesignReference, cleanReference, safeReferenceUrl };
