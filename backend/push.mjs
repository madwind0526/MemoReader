import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";

// A client chooses the subscription endpoint and this server then POSTs to it, so only the real
// push services are accepted. Anything else would let a client aim the server at an arbitrary URL.
const PUSH_SERVICES = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//i;
const MAX_SUBSCRIPTIONS = 20;

export function isAllowedEndpoint(endpoint) {
  return typeof endpoint === "string" && endpoint.length <= 1000 && PUSH_SERVICES.test(endpoint);
}

function cleanSubscription(raw) {
  const endpoint = raw?.endpoint;
  const p256dh = raw?.keys?.p256dh;
  const auth = raw?.keys?.auth;
  if (!isAllowedEndpoint(endpoint)) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint, keys: { p256dh, auth } };
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Web Push for waking phones: when the PC comes online (or finishes organizing a backlog) every
 * subscribed device gets a push, its service worker syncs, and the user sees the organized memos.
 * `send` is injectable so tests never touch a real push service.
 */
export async function createPush({ dataDir, subject = "mailto:memoreader@example.com", send = webpush.sendNotification, log = console }) {
  const keysFile = path.join(dataDir, "runtime", "vapid.json");
  const subscriptionsFile = path.join(dataDir, "runtime", "push.json");

  let keys = await readJson(keysFile, null);
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = webpush.generateVAPIDKeys();
    await atomicWrite(keysFile, JSON.stringify(keys, null, 2));
  }
  const subscriptions = new Map((await readJson(subscriptionsFile, [])).map((entry) => [entry.endpoint, entry]));
  const vapid = { subject, publicKey: keys.publicKey, privateKey: keys.privateKey };

  const save = () => atomicWrite(subscriptionsFile, JSON.stringify([...subscriptions.values()], null, 2));

  return {
    publicKey: keys.publicKey,

    count: () => subscriptions.size,

    async subscribe(raw, user = "") {
      const subscription = cleanSubscription(raw);
      if (!subscription) return false;
      if (!subscriptions.has(subscription.endpoint) && subscriptions.size >= MAX_SUBSCRIPTIONS) return false;
      subscriptions.set(subscription.endpoint, { ...subscription, user: String(user).slice(0, 100), createdAt: new Date().toISOString() });
      await save();
      return true;
    },

    async unsubscribe(endpoint) {
      if (subscriptions.delete(endpoint)) await save();
    },

    /** Sends one payload to every device. Subscriptions the push service reports as gone are dropped. */
    async notifyAll(payload) {
      let sent = 0;
      let failed = 0;
      let dropped = false;
      for (const subscription of [...subscriptions.values()]) {
        try {
          await send({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), {
            vapidDetails: vapid,
            TTL: 60 * 60 * 12,
            urgency: "normal",
          });
          sent += 1;
        } catch (error) {
          failed += 1;
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            subscriptions.delete(subscription.endpoint);
            dropped = true;
          } else {
            log.warn?.(`[push] send failed (${error?.statusCode ?? error?.message})`);
          }
        }
      }
      if (dropped) await save();
      return { sent, failed };
    },
  };
}
