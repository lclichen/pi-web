import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { getAgentDir } from "./session-reader";
import { userPushPath } from "./user-config";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: string;
}

interface PushStateFile {
  vapidKeys: { publicKey: string; privateKey: string };
  /** Legacy/auth-off subscriptions; user ids use per-user files. */
  subscriptions: PushSubscriptionRecord[];
}

interface UserPushFile {
  version: 1;
  subscriptions: PushSubscriptionRecord[];
}

interface WebPushEnvironment {
  send: (subscription: PushSubscriptionRecord, payload: string, vapidKeys: PushStateFile["vapidKeys"]) => Promise<void>;
  loadState: () => PushStateFile | null;
  saveState: (state: PushStateFile) => void;
  loadUserSubscriptions: (userId: number) => PushSubscriptionRecord[];
  saveUserSubscriptions: (userId: number, subscriptions: PushSubscriptionRecord[]) => void;
  generateVapidKeys: () => PushStateFile["vapidKeys"];
  listSessionNames: () => Promise<Map<string, string>>;
}

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord, userId?: number) => void;
  notifySessionComplete: (sessionId: string, ownerId?: number) => Promise<void>;
}

function stateFilePath(): string {
  return join(getAgentDir(), "web-push.json");
}

function getDefaultEnvironment(): WebPushEnvironment {
  return {
    async send(subscription, payload, vapidKeys) {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
        vapidDetails: {
          subject: "mailto:pi-web@localhost",
          publicKey: vapidKeys.publicKey,
          privateKey: vapidKeys.privateKey,
        },
      });
    },
    loadState() {
      const path = stateFilePath();
      if (!existsSync(path)) return null;
      try {
        return JSON.parse(readFileSync(path, "utf8")) as PushStateFile;
      } catch {
        return null;
      }
    },
    saveState(state) {
      const path = stateFilePath();
      mkdirSync(dirname(path), { recursive: true });
      writePrivateFileAtomicSync(path, JSON.stringify(state));
    },
    loadUserSubscriptions(userId) {
      const path = userPushPath(userId);
      if (!existsSync(path)) return [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) return [];
        const subscriptions = (parsed as Partial<UserPushFile>).subscriptions;
        return Array.isArray(subscriptions) ? subscriptions : [];
      } catch {
        return [];
      }
    },
    saveUserSubscriptions(userId, subscriptions) {
      const path = userPushPath(userId);
      mkdirSync(dirname(path), { recursive: true });
      const data: UserPushFile = { version: 1, subscriptions };
      writePrivateFileAtomicSync(path, JSON.stringify(data));
    },
    generateVapidKeys: () => webpush.generateVAPIDKeys(),
    async listSessionNames() {
      const names = new Map<string, string>();
      try {
        for (const session of await SessionManager.listAll()) {
          if (session.name) names.set(session.id, session.name);
        }
      } catch {
        // Session list is best-effort; fall back to the generic title.
      }
      return names;
    },
  };
}

function pushStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * Locale lookup for push payloads. The browser reports its UI locale when it
 * subscribes; unknown locales fall back to English.
 */
export function localeText(locale: string, key: "sessionComplete" | "taskFinished"): string {
  if (locale === "zh-CN") {
    const message = zhCNLocale.messages[key === "sessionComplete" ? "i18n.sessionComplete" : "i18n.taskFinished"];
    if (message) return message;
  }
  const message = enLocale.messages[key === "sessionComplete" ? "i18n.sessionComplete" : "i18n.taskFinished"];
  return message ?? (key === "sessionComplete" ? "Session complete" : "Task finished.");
}

export function createWebPushNotifier(environment: WebPushEnvironment): WebPushNotifier {
  const state: PushStateFile = (() => {
    const loaded = environment.loadState();
    if (loaded?.vapidKeys?.publicKey && loaded.vapidKeys.privateKey) return loaded;
    return { vapidKeys: environment.generateVapidKeys(), subscriptions: [] };
  })();
  const saveState = () => {
    environment.saveState(state);
  };
  const subscriptionsFor = (userId: number) =>
    userId > 0 ? environment.loadUserSubscriptions(userId) : state.subscriptions;
  const saveSubscriptionsFor = (userId: number, subscriptions: PushSubscriptionRecord[]) => {
    if (userId > 0) environment.saveUserSubscriptions(userId, subscriptions);
    else {
      state.subscriptions = subscriptions;
      saveState();
    }
  };

  return {
    getVapidPublicKey() {
      saveState();
      return state.vapidKeys.publicKey;
    },
    addSubscription(subscription, userId = 0) {
      const subscriptions = subscriptionsFor(userId);
      saveSubscriptionsFor(userId, [
        ...subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ]);
    },
    async notifySessionComplete(sessionId, ownerId = 0) {
      const initial = subscriptionsFor(ownerId);
      if (initial.length === 0) return;
      const sessionName = (await environment.listSessionNames()).get(sessionId);
      const payloadFor = (locale: string) => ({
        title: sessionName ?? localeText(locale, "sessionComplete"),
        body: localeText(locale, "taskFinished"),
        url: `/?session=${encodeURIComponent(sessionId)}`,
        tag: `pi-session-complete:${sessionId}`,
      });

      let subscriptions = initial;
      let pruned = false;
      for (const subscription of [...subscriptions]) {
        try {
          await environment.send(subscription, JSON.stringify(payloadFor(subscription.locale)), state.vapidKeys);
        } catch (error) {
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
            pruned = true;
          }
        }
      }
      if (pruned) saveSubscriptionsFor(ownerId, subscriptions);
    },
  };
}

declare global {
  var __piWebPushNotifier: Promise<WebPushNotifier> | undefined;
}

function getNotifier(): Promise<WebPushNotifier> {
  if (!globalThis.__piWebPushNotifier) {
    globalThis.__piWebPushNotifier = Promise.resolve().then(() => createWebPushNotifier(getDefaultEnvironment()));
  }
  return globalThis.__piWebPushNotifier;
}

export function getVapidPublicKey(): Promise<string> {
  return getNotifier().then((notifier) => notifier.getVapidPublicKey());
}

export function addSubscription(subscription: PushSubscriptionRecord, userId = 0): Promise<void> {
  return getNotifier().then((notifier) => notifier.addSubscription(subscription, userId));
}

export async function notifySessionComplete(sessionId: string, ownerId = 0): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId, ownerId);
}
