import { getMeta } from "./db";
import { api } from "./serverApi";
import { LAST_PUSH_ERROR_KEY, LAST_PUSH_KEY, LAST_PUSH_SYNC_ERROR_KEY } from "./syncCore";

export type PushAvailability = "unsupported" | "no-worker" | "blocked" | "off" | "on";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  // `ready` never settles when no worker was registered (development mode), so race a short timer.
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500))]);
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** What the settings screen should offer for wake-up notifications on this device. */
export async function getPushAvailability(): Promise<PushAvailability> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await registration();
  if (!reg) return "no-worker";
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error("설치된(빌드된) 앱에서만 켤 수 있어요.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("알림 권한이 허용되지 않았어요.");
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api("/api/push/subscribe", { method: "POST", body: { subscription: subscription.toJSON() } });
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api("/api/push/unsubscribe", { method: "POST", body: { endpoint } }).catch(() => {});
}

/** Re-sends this device's subscription so the PC always has the current one. Failures are harmless. */
export async function refreshPushRegistration(): Promise<void> {
  try {
    if (!supported() || Notification.permission !== "granted") return;
    const subscription = await (await registration())?.pushManager.getSubscription();
    if (subscription) await api("/api/push/subscribe", { method: "POST", body: { subscription: subscription.toJSON() } });
  } catch {
    // The next successful sync tries again.
  }
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
  return api("/api/push/test", { method: "POST", body: {} });
}

export function lastPushAt(): Promise<string | undefined> {
  return getMeta<string>(LAST_PUSH_KEY);
}

export function lastPushError(): Promise<string | undefined> {
  return getMeta<string>(LAST_PUSH_ERROR_KEY);
}

export function lastPushSyncError(): Promise<string | undefined> {
  return getMeta<string>(LAST_PUSH_SYNC_ERROR_KEY);
}

/** The browser-level permission, in words the settings screen can show. */
export function notificationPermission(): string {
  if (!("Notification" in window)) return "지원 안 함";
  return { granted: "허용됨", denied: "차단됨", default: "아직 묻지 않음" }[Notification.permission];
}
