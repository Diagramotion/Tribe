import { useEffect } from "react";

const openDialogs = [];

function focusableElements(dialog) {
  return [...dialog.querySelectorAll(
    'a[href], area[href], input:not([type="hidden"]), select, textarea, button, iframe, object, embed, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.disabled
    && element.getAttribute("aria-hidden") !== "true"
    && element.getClientRects().length > 0
    && !element.closest("[inert]"));
}

function focusInitial(dialog) {
  const focusables = focusableElements(dialog);
  const target = dialog.querySelector("[autofocus], [data-dialog-initial-focus]") ?? focusables[0] ?? dialog;
  target.focus({ preventScroll: true });
}

function handleKeyDown(event) {
  if (event.key !== "Tab") return;
  const dialog = openDialogs.at(-1)?.dialog;
  if (!dialog) return;
  const focusables = focusableElements(dialog);
  if (!focusables.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return;
  }
  const first = focusables[0];
  const last = focusables.at(-1);
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function handleFocusIn(event) {
  const dialog = openDialogs.at(-1)?.dialog;
  if (dialog && !dialog.contains(event.target)) focusInitial(dialog);
}

export function useDialogFocus(dialogRef, active = true) {
  useEffect(() => {
    const dialog = active ? dialogRef.current : null;
    if (!dialog) return undefined;
    const previousFocus = document.activeElement;
    const entry = { dialog, previousFocus };
    openDialogs.push(entry);
    if (openDialogs.length === 1) {
      document.addEventListener("keydown", handleKeyDown, true);
      document.addEventListener("focusin", handleFocusIn, true);
    }
    focusInitial(dialog);

    return () => {
      const wasTopDialog = openDialogs.at(-1) === entry;
      const index = openDialogs.indexOf(entry);
      if (index !== -1) openDialogs.splice(index, 1);
      if (!openDialogs.length) {
        document.removeEventListener("keydown", handleKeyDown, true);
        document.removeEventListener("focusin", handleFocusIn, true);
      }
      if (!wasTopDialog) return;
      const nextDialog = openDialogs.at(-1)?.dialog;
      if (nextDialog) {
        const target = previousFocus instanceof HTMLElement && nextDialog.contains(previousFocus)
          ? previousFocus
          : null;
        (target ?? nextDialog.querySelector("[autofocus], [data-dialog-initial-focus]") ?? focusableElements(nextDialog)[0] ?? nextDialog)
          .focus({ preventScroll: true });
      } else if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [active, dialogRef]);
}
