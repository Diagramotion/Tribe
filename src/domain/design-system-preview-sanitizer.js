import { findMarkupElements, getMarkupAttribute, markupTextContent, parseHtmlDocument, removeMarkupElement, sanitizeMarkupTree, serializeMarkupChildren, setMarkupAttribute } from "./markup-sanitizer.js";

function safeAttributes(node) {
  return (node?.attrs ?? [])
    .filter(({ name }) => /^(?:class|id|lang|dir|role|title|data-[\w-]+|aria-[\w-]+)$/.test(name.toLowerCase()))
    .map(({ name, value }) => " " + name + "=\"" + String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "\"")
    .join("");
}

export function sanitizePackageSvg(source) {
  const document = parseHtmlDocument(source);
  const root = findMarkupElements(document, "svg")[0];
  if (!root) return "";
  sanitizeMarkupTree(root, { removeScripts: true, removeStyles: true, removeLinks: true, removeNavigation: true, removeSources: true });
  return "<svg" + (root.attrs ?? []).map(({ name, value }) => " " + name + "=\"" + String(value).replaceAll("&", "&amp;").replaceAll("\"", "&quot;") + "\"").join("") + ">" + serializeMarkupChildren(root) + "</svg>";
}

export function preparePackagePreview(source, { fixturePath, resolveStylesheet, resolveImage, theme }) {
  const document = parseHtmlDocument(source);
  for (const root of [...findMarkupElements(document, "html"), ...findMarkupElements(document, "body")]) {
    if (theme?.attribute) setMarkupAttribute(root, theme.attribute, theme.value);
    if (theme?.className && theme.value === "dark") {
      const classes = getMarkupAttribute(root, "class").split(/\s+/).filter(Boolean);
      if (!classes.includes(theme.className)) classes.push(theme.className);
      setMarkupAttribute(root, "class", classes.join(" "));
    }
  }
  const styles = [];
  for (const link of findMarkupElements(document, "link")) {
    const rel = getMarkupAttribute(link, "rel").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet")) {
      const css = resolveStylesheet(getMarkupAttribute(link, "href"));
      if (css) styles.push(css);
    }
    removeMarkupElement(link);
  }
  for (const style of findMarkupElements(document, "style")) {
    styles.push(markupTextContent(style));
    removeMarkupElement(style);
  }
  sanitizeMarkupTree(document, { removeScripts: true, removeLinks: true, removeNavigation: true, removeSources: true });
  for (const image of findMarkupElements(document, "img")) {
    const dataUrl = resolveImage(getMarkupAttribute(image, "src"));
    if (dataUrl) setMarkupAttribute(image, "src", dataUrl);
  }
  const body = findMarkupElements(document, "body")[0];
  const html = findMarkupElements(document, "html")[0];
  return { body: serializeMarkupChildren(body), styles, htmlAttributes: safeAttributes(html), bodyAttributes: safeAttributes(body) };
}
