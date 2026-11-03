// Chrome (MV3). The service worker can't play audio and is stopped when idle,
// so the player lives in an offscreen document. That document can only use
// runtime messaging; for tabs and storage it asks the service worker through a
// small "bridge". Captures and the player snapshot live in storage.session so
// they survive both the worker and the offscreen document being shut down.

import { browser } from "wxt/browser";
import { applyDiscoverResponse } from "../captures";
import { COMMANDS } from "../host";
import { listen, notify, request, requestTab } from "../messaging";
import type { Snapshot } from "../player";
import type { Capture, ContentMessage, Settings } from "../types";

const OFFSCREEN_PATH = "/offscreen.html";
const captureKey = (tabId: number) => `capture:${tabId}`;
const SNAPSHOT_KEY = "snapshot";

/** Operations the offscreen player asks the service worker to do. */
export interface BridgeOps {
  bandcampTabs: () => { id: number; active?: boolean }[];
  sendToTab: (tabId: number, msg: ContentMessage) => unknown;
  getCapture: (tabId: number) => Capture | undefined;
  loadSettings: () => Partial<Settings>;
  saveSettings: (s: Partial<Settings>) => void;
  loadSnapshot: () => Snapshot | null;
  saveSnapshot: (s: Snapshot) => void;
}

export function bridge<K extends keyof BridgeOps>(op: K, ...args: Parameters<BridgeOps[K]>): Promise<Awaited<ReturnType<BridgeOps[K]>>> {
  return request("bg", "bridge", { op, args });
}

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  const url = browser.runtime.getURL(OFFSCREEN_PATH);
  const existing = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (existing.length) return;
  creating ??= browser.offscreen
    .createDocument({
      url,
      reasons: [browser.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Plays the Bandcamp tracks queued in the Discover Player popup.",
    })
    .finally(() => {
      creating = null;
    });
  // Its listeners register on load and wait for the player's own init.
  await creating;
}

export function startChromeServiceWorker(): void {
  const ops: { [K in keyof BridgeOps]: (...args: Parameters<BridgeOps[K]>) => Promise<unknown> } = {
    async bandcampTabs() {
      const tabs = await browser.tabs.query({ url: "*://bandcamp.com/*" });
      return tabs.flatMap((t) => (t.id != null ? [{ id: t.id, active: t.active }] : []));
    },
    sendToTab: (tabId, msg) => requestTab(tabId, msg),
    async getCapture(tabId) {
      const key = captureKey(tabId);
      return (await browser.storage.session.get(key))[key];
    },
    loadSettings: () => browser.storage.local.get(["mode", "shuffle"]),
    saveSettings: (s) => browser.storage.local.set(s),
    async loadSnapshot() {
      return (await browser.storage.session.get(SNAPSHOT_KEY))[SNAPSHOT_KEY] ?? null;
    },
    saveSnapshot: (s) => browser.storage.session.set({ [SNAPSHOT_KEY]: s }),
  };

  listen((msg, sender) => {
    if (msg.to !== "bg") return undefined;
    switch (msg.type) {
      case "ensurePlayer":
        return ensureOffscreen().then(() => true);
      case "bridge": {
        const fn = ops[msg.op as keyof BridgeOps] as (...a: unknown[]) => Promise<unknown>;
        return fn ? fn(...(msg.args as unknown[])) : Promise.reject(new Error(`Unknown bridge op ${msg.op}`));
      }
      case "discoverCaptured": {
        const tabId = sender.tab?.id;
        if (tabId == null) return undefined;
        return storeCapture(tabId, msg.body, msg.data);
      }
      default:
        return undefined;
    }
  });

  browser.commands.onCommand.addListener(async (name) => {
    const c = COMMANDS[name];
    if (!c) return;
    await ensureOffscreen();
    notify("player", "command", { command: c });
  });

  browser.tabs.onRemoved.addListener((tabId) => void browser.storage.session.remove(captureKey(tabId)));
}

// Captures arrive one response at a time; chain the writes so appends don't race.
let captureWrites: Promise<unknown> = Promise.resolve();

function storeCapture(tabId: number, body: unknown, data: unknown): Promise<unknown> {
  captureWrites = captureWrites.then(async () => {
    const key = captureKey(tabId);
    const prev = (await browser.storage.session.get(key))[key] as Capture | undefined;
    const next = applyDiscoverResponse(prev, body, data);
    if (!next || next === prev) return;
    await browser.storage.session.set({ [key]: next });
    notify("popup", "tabChanged", { tabId });
  });
  return captureWrites.then(() => true);
}
