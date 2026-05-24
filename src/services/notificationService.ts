// Browser Notifications API wrapper.
//
// Permission is requested on the first user gesture (same Start click that
// unlocks audio). Notifications fire on phase transitions.
//
// iOS Safari note: Web Notifications only work when the app is installed as a
// PWA (Add to Home Screen) on iOS 16.4+. We surface this in the UI separately.

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationSupported()) return 'denied';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notify(title: string, body: string): void {
  if (!isNotificationSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.svg',
      tag: 'focus-stamina', // collapse repeats
      requireInteraction: true // stay visible until the user interacts
    });
    // Clicking the notification focuses the tab/window.
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers throw if no SW is registered and you use certain options.
    // Falling through silently — the chime is the primary signal.
  }
}
