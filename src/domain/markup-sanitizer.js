import { parse, parseFragment, serialize } from "parse5";

const BLOCKED_ELEMENTS = new Set(["base", "embed", "foreignobject", "frame", "iframe", "object"]);
const NAVIGATION_ATTRIBUTES = new Set(["action", "formaction", "href", "ping", "target", "xlink:href", "srcdoc"]);
const RESOURCE_ATTRIBUTES = new Set(["background", "poster", "srcset"]);

export function parseHtmlDocument(source) {
  return parse(String(source ?? ""));
}

export function parseHtmlFragment(source) {
  return parseFragment(String(source ?? ""));
}

export function findMarkupElements(root, tagName) {
  const found = [];
  const expected = tagName.toLowerCase();
  const visit = (node) => {
    if (node.tagName?.toLowerCase() === expected) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}

export function getMarkupAttribute(node, name) {
  return node.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export function setMarkupAttribute(node, name, value) {
  const existing = node.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = String(value);
  else (node.attrs ??= []).push({ name, value: String(value) });
}

export function removeMarkupElement(node) {
  if (!node.parentNode) return;
  node.parentNode.childNodes = node.parentNode.childNodes.filter((child) => child !== node);
  node.parentNode = null;
}

export function markupTextContent(node) {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(markupTextContent).join("");
}

export function sanitizeMarkupTree(root, {
  removeScripts = false,
  removeStyles = false,
  removeLinks = false,
  removeNavigation = false,
  removeSources = false,
} = {}) {
  const cleanAttributes = (node) => {
    if (!node.attrs) return;
    node.attrs = node.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) return false;
      if (removeNavigation && NAVIGATION_ATTRIBUTES.has(name)) return false;
      if (removeSources && RESOURCE_ATTRIBUTES.has(name)) return false;
      if (removeSources && name === "src" && !value.startsWith("data:image/")) return false;
      if (name === "style" && /url\s*\(|expression\s*\(|@import/i.test(value)) return false;
      if ((name === "href" || name === "xlink:href") && value && !value.startsWith("#")) return false;
      return true;
    });
  };
  const visit = (node) => {
    cleanAttributes(node);
    const kept = [];
    for (const child of node.childNodes ?? []) {
      const tag = child.tagName?.toLowerCase() ?? "";
      const httpEquiv = getMarkupAttribute(child, "http-equiv").toLowerCase();
      if (BLOCKED_ELEMENTS.has(tag)
        || (removeScripts && tag === "script")
        || (removeStyles && tag === "style")
        || (removeLinks && tag === "link")
        || (tag === "meta" && ["refresh", "content-security-policy"].includes(httpEquiv))) {
        child.parentNode = null;
        continue;
      }

      child.parentNode = node;
      visit(child);
      kept.push(child);
    }
    node.childNodes = kept;
  };
  visit(root);
  return root;
}

export function prependTrustedHeadMarkup(document, markup) {
  const head = findMarkupElements(document, "head")[0];
  const trustedDocument = parseHtmlDocument(`<!doctype html><html><head>${markup}</head><body></body></html>`);
  const trustedHead = findMarkupElements(trustedDocument, "head")[0];
  const children = trustedHead.childNodes ?? [];
  for (const child of children) child.parentNode = head;
  head.childNodes = [...children, ...(head.childNodes ?? [])];
}

export function serializeMarkup(node) {
  return serialize(node);
}

export function serializeMarkupChildren(node) {
  return serialize({ nodeName: "#document-fragment", childNodes: node?.childNodes ?? [] });
}

export function replaceMarkupText(node, value) {
  node.childNodes = [{ nodeName: "#text", value: String(value), parentNode: node }];
}
