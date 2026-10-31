const isDesktopApp = () => Boolean(window.__TAURI_INTERNALS__);

export async function desktopNotificationsEnabled() {
  if (!isDesktopApp()) return false;
  try {
    const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
    return await isPermissionGranted();
  } catch {
    return false;
  }
}

export async function enableDesktopNotifications() {
  if (!isDesktopApp()) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export async function sendDesktopNotification(title, body, { allowWhileFocused = false } = {}) {
  if (!isDesktopApp() || (!allowWhileFocused && document.hasFocus())) return false;
  try {
    const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
    if (!(await isPermissionGranted())) return false;
    await sendNotification({ title, body });
    return true;
  } catch {
    // The in-app notice remains available if the operating system rejects the notification.
    return false;
  }
}

export function sendTestDesktopNotification() {
  return sendDesktopNotification(
    "Tribe notifications are on",
    "This is a test notification.",
    { allowWhileFocused: true },
  );
}
