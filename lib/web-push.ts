import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import webpush from "web-push";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { enLocale } from "./i18n/messages/en";
import { zhCNLocale } from "./i18n/messages/zh-CN";
import { dataDir } from "./mode-homes";
import { getAgentDir } from "./session-reader";
import { legacyUserPushPath, userPushPath } from "./user-config";

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
  /** One browser endpoint belongs to one login: drop it from every other user. */
  removeEndpointFromOtherUsers: (endpoint: string, keepUserId: number) => void;
  generateVapidKeys: () => PushStateFile["vapidKeys"];
  listSessionNames: () => Promise<Map<string, string>>;
}

export interface WebPushNotifier {
  getVapidPublicKey: () => string;
  addSubscription: (subscription: PushSubscriptionRecord, userId?: number) => void;
  removeSubscription: (endpoint: string, userId?: number) => void;
  notifySessionComplete: (sessionId: string, ownerId?: number) => Promise<void>;
}

function stateFilePath(): string {
  return join(getAgentDir(), "web-push.json");
}

function loadUserSubscriptionsFromDisk(userId: number): PushSubscriptionRecord[] {
  const path = existsSync(userPushPath(userId)) ? userPushPath(userId) : legacyUserPushPath(userId);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const subscriptions = (parsed as Partial<UserPushFile>).subscriptions;
    return Array.isArray(subscriptions) ? subscriptions : [];
  } catch {
    return [];
  }
}

function saveUserSubscriptionsToDisk(userId: number, subscriptions: PushSubscriptionRecord[]): void {
  const path = userPushPath(userId);
  mkdirSync(dirname(path), { recursive: true });
  const data: UserPushFile = { version: 1, subscriptions };
  writePrivateFileAtomicSync(path, JSON.stringify(data));
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
    loadUserSubscriptions: loadUserSubscriptionsFromDisk,
    saveUserSubscriptions: saveUserSubscriptionsToDisk,
    removeEndpointFromOtherUsers(endpoint, keepUserId) {
      const userIds = new Set<number>();
      for (const root of [join(dataDir(), "state", "users"), join(dataDir(), "user-config")]) {
        let entries;
        try {
          entries = readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const match = /^u(\d+)$/.exec(entry.name);
          if (match) userIds.add(Number(match[1]));
        }
      }
      for (const userId of userIds) {
        if (userId === keepUserId) continue;
        const subscriptions = loadUserSubscriptionsFromDisk(userId);
        const next = subscriptions.filter((subscription) => subscription.endpoint !== endpoint);
        if (next.length !== subscriptions.length) saveUserSubscriptionsToDisk(userId, next);
      }
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
      // A browser has one push endpoint regardless of who logs in. Claiming it
      // for this user must remove it from every other user (and from the
      // auth-off legacy bucket), otherwise the previous user's session
      // completions keep arriving on this device.
      environment.removeEndpointFromOtherUsers(subscription.endpoint, userId);
      if (userId > 0 && state.subscriptions.some((s) => s.endpoint === subscription.endpoint)) {
        state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
        saveState();
      }
      const subscriptions = subscriptionsFor(userId);
      saveSubscriptionsFor(userId, [
        ...subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        subscription,
      ]);
    },
    removeSubscription(endpoint, userId = 0) {
      // 退订的是浏览器 endpoint，不是某账号的记录：换账号认领的清理只在
      // addSubscription 时跑一次，endpoint 仍可能残留在其他用户的桶或
      // legacy 桶里。与认领路径对称，这里一并清掉（“本浏览器退订”语义）。
      environment.removeEndpointFromOtherUsers(endpoint, userId);
      if (userId > 0 && state.subscriptions.some((s) => s.endpoint === endpoint)) {
        state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
        saveState();
      }
      const subscriptions = subscriptionsFor(userId);
      const next = subscriptions.filter((s) => s.endpoint !== endpoint);
      if (next.length !== subscriptions.length) saveSubscriptionsFor(userId, next);
    },
    async notifySessionComplete(sessionId, ownerId = 0) {
      // With auth enabled, an ownerless session must not fall back to the
      // shared auth-off bucket: that would broadcast to subscriptions whose
      // owner cannot be verified.
      if (ownerId <= 0 && process.env.PI_WEB_AUTH === "on") return;
      const initial = subscriptionsFor(ownerId);
      if (initial.length === 0) return;
      const sessionName = (await environment.listSessionNames()).get(sessionId);
      const payloadFor = (locale: string) => ({
        title: sessionName ?? localeText(locale, "sessionComplete"),
        body: localeText(locale, "taskFinished"),
        url: `/?session=${encodeURIComponent(sessionId)}`,
        tag: `pi-session-complete:${sessionId}`,
        ownerId,
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

export function removePushSubscription(endpoint: string, userId = 0): Promise<void> {
  return getNotifier().then((notifier) => notifier.removeSubscription(endpoint, userId));
}

export async function notifySessionComplete(sessionId: string, ownerId = 0): Promise<void> {
  const notifier = await getNotifier();
  await notifier.notifySessionComplete(sessionId, ownerId);
}
