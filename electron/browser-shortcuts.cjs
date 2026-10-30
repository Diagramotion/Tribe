function browserShortcutForInput(input, platform) {
  if (!input || input.type !== "keyDown") return null;
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  const mac = platform === "darwin";
  const primary = mac ? Boolean(input.meta) : Boolean(input.control);
  const control = Boolean(input.control);
  const shift = Boolean(input.shift);
  const alt = Boolean(input.alt);

  if (control && key === "tab") return shift ? "previous-tab" : "next-tab";
  if (!primary && alt && key === "arrowleft") return "back";
  if (!primary && alt && key === "arrowright") return "forward";
  if (!primary) return null;

  if (key === "l") return "focus-address";
  if (key === "t" && !shift) return "new-tab";
  if (key === "w" && !shift) return "close-tab";
  if (key === "r") return shift ? "hard-reload" : "reload";
  if (key === "arrowleft" || code === "bracketleft") return "back";
  if (key === "arrowright" || code === "bracketright") return "forward";
  if (key === "0" || code === "digit0") return "reset-zoom";
  if (key === "-" || code === "numpadsubtract") return "zoom-out";
  if (["+", "="].includes(key) || code === "numpadadd") return "zoom-in";
  if (key === "tab" && shift && mac) return "previous-tab";
  if (key === "tab" && shift) return "previous-tab";
  if (/^[1-9]$/.test(key)) return `select-tab-${key}`;
  if (/^digit[1-9]$/.test(code)) return `select-tab-${code.at(-1)}`;
  return null;
}

module.exports = { browserShortcutForInput };
