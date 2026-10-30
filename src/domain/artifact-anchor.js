export function imagePointAnchor(clientX, clientY, rect) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)
      || rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { type: "image_point", x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

export function isImagePointAnchor(anchor) {
  return anchor?.type === "image_point"
    && Number.isFinite(anchor.x) && anchor.x >= 0 && anchor.x <= 1
    && Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1;
}

export function isTextQuoteAnchor(anchor) {
  return anchor?.type === "text_quote" && typeof anchor.quote === "string" && Boolean(anchor.quote.trim());
}

function normalizedText(value) {
  let text = "";
  const offsets = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (text && !text.endsWith(" ")) { text += " "; offsets.push(index); }
    } else {
      text += character;
      offsets.push(index);
    }
  }
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return { text: trimmed, offsets: offsets.slice(leading, leading + trimmed.length) };
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function offsetBefore(root, nodes, node, offset) {
  let total = 0;
  for (const textNode of nodes) {
    if (textNode === node) return total + offset;
    total += textNode.textContent.length;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function textSelectionOffsets(root, range) {
  if (!root || !range || !root.contains(range.commonAncestorContainer)) return null;
  const nodes = textNodes(root);
  return {
    startOffset: offsetBefore(root, nodes, range.startContainer, range.startOffset),
    endOffset: offsetBefore(root, nodes, range.endContainer, range.endOffset),
  };
}

export function rangeAtTextOffsets(root, start, end) {
  if (!root || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
  return rangeFromOffsets(root, textNodes(root), start, end);
}

function rangeFromOffsets(root, nodes, start, end) {
  const range = document.createRange();
  let cursor = 0;
  let startPoint = null;
  let endPoint = null;
  for (const node of nodes) {
    const next = cursor + node.textContent.length;
    if (!startPoint && start <= next) startPoint = [node, Math.max(0, start - cursor)];
    if (end <= next) { endPoint = [node, Math.max(0, end - cursor)]; break; }
    cursor = next;
  }
  if (!startPoint && nodes.length) startPoint = [nodes.at(-1), nodes.at(-1).textContent.length];
  if (!endPoint && nodes.length) endPoint = [nodes.at(-1), nodes.at(-1).textContent.length];
  if (!startPoint || !endPoint) return null;
  range.setStart(startPoint[0], startPoint[1]);
  range.setEnd(endPoint[0], endPoint[1]);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

export function textQuoteAnchor(root, selection, maxQuoteLength = 300) {
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!root || !range || range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const nodes = textNodes(root);
  const rawText = nodes.map((node) => node.textContent).join("");
  const start = offsetBefore(root, nodes, range.startContainer, range.startOffset);
  const end = offsetBefore(root, nodes, range.endContainer, range.endOffset);
  const quote = normalizedText(rawText.slice(start, end)).text;
  if (!quote || quote.length > maxQuoteLength) return null;
  const prefix = normalizedText(rawText.slice(Math.max(0, start - 100), start)).text.slice(-24);
  const suffix = normalizedText(rawText.slice(end, end + 100)).text.slice(0, 24);
  return { type: "text_quote", quote, prefix, suffix };
}

export function findTextQuoteRange(root, anchor) {
  if (!root || !isTextQuoteAnchor(anchor)) return null;
  const nodes = textNodes(root);
  const rawText = nodes.map((node) => node.textContent).join("");
  const normalized = normalizedText(rawText);
  let index = normalized.text.indexOf(anchor.quote);
  let bestIndex = -1;
  let bestScore = -1;
  while (index >= 0) {
    const before = normalized.text.slice(Math.max(0, index - (anchor.prefix?.length ?? 0)), index);
    const after = normalized.text.slice(index + anchor.quote.length, index + anchor.quote.length + (anchor.suffix?.length ?? 0));
    const score = (anchor.prefix && before.endsWith(anchor.prefix) ? 1 : 0) + (anchor.suffix && after.startsWith(anchor.suffix) ? 1 : 0);
    if (score > bestScore) { bestIndex = index; bestScore = score; }
    if (score === 2) break;
    index = normalized.text.indexOf(anchor.quote, index + 1);
  }
  if (bestIndex < 0) return null;
  const start = normalized.offsets[bestIndex];
  const last = normalized.offsets[bestIndex + anchor.quote.length - 1];
  return rangeFromOffsets(root, nodes, start, last + 1);
}
