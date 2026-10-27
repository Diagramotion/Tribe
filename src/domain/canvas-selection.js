export function selectedCanvasText(root, selection = globalThis.window?.getSelection?.()) {
  if (!root || !selection?.anchorNode || !selection?.focusNode
      || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    return "";
  }
  return selection.toString().trim();
}
