// Pieces every player host needs: an <audio> adapter, the popup port protocol,
// direct JSON fetches and the OS media controls.

import { browser } from "wxt/browser";
import type { AudioEvent, AudioPort, BandcampTab, Player } from "./player";
import type { PlayerCommand } from "./types";
import { errorMessage } from "./util";

export function htmlAudioPort(el: HTMLAudioElement): AudioPort {
  el.preload = "auto";
  return {
    get paused() {
      return el.paused;
    },
    get duration() {
      return Number.isFinite(el.duration) ? el.duration : 0;
    },
    get hasSource() {
      return !!el.getAttribute("src");
    },
    get currentTime() {
      return el.currentTime;
    },
    set currentTime(v: number) {
      el.currentTime = v;
    },
    setSource(src) {
      el.src = src;
    },
    clear() {
      el.removeAttribute("src");
      el.load();
    },
    play: () => el.play(),
    pause: () => el.pause(),
    on: (event: AudioEvent, fn) => el.addEventListener(event, fn),
  };
}

/** Bandcamp API call from an extension page; undefined when the answer isn't JSON (bot challenge). */
/**
 * Open Bandcamp tabs: bandcamp.com and artists' own <name>.bandcamp.com pages.
 * API requests need a bandcamp.com tab; the wishlist works from either.
 */
export async function bandcampTabs(): Promise<BandcampTab[]> {
  const tabs = await browser.tabs.query({ url: "*://*.bandcamp.com/*" });
  return tabs.flatMap((t) => {
    if (t.id == null) return [];
    let artistPage = true;
    try {
      artistPage = new URL(t.url || "").hostname !== "bandcamp.com";
    } catch {}
    return [{ id: t.id, active: t.active, artistPage }];
  });
}

export async function fetchJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get("content-type") || "";
  return res.ok && type.includes("json") ? res.json() : undefined;
}

/** Fetches a page's HTML; undefined on HTTP errors or a non-HTML answer. */
export async function fetchText(url: string): Promise<string | undefined> {
  const res = await fetch(url, { credentials: "include" });
  const type = res.headers.get("content-type") || "";
  return res.ok && type.includes("html") ? res.text() : undefined;
}

/**
 * Serves popups that connect with runtime.connect({ name: "popup" }).
 * Requests carry a reqId and get a "reply"; state and time updates are pushed.
 */
export function servePopupPorts(ready: Promise<Player>): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup") return;
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    port.onDisconnect.addListener(() => {
      closed = true;
      unsubscribe?.();
    });
    void ready.then((player) => {
      if (closed) return;
      unsubscribe = player.subscribe((e) => port.postMessage(e));
      port.onMessage.addListener(async (msg: PlayerCommand & { reqId?: number }) => {
        try {
          const result = await player.handle(msg);
          if (msg.reqId) port.postMessage({ type: "reply", reqId: msg.reqId, result });
        } catch (e) {
          if (msg.reqId) port.postMessage({ type: "reply", reqId: msg.reqId, error: errorMessage(e) });
        }
      });
    });
  });
}

export const COMMANDS: Record<string, PlayerCommand> = {
  "play-pause": { cmd: "togglePlay" },
  "next-track": { cmd: "next" },
  "prev-track": { cmd: "prev" },
};

/** Keeps the OS "now playing" widget and media keys in sync, where the context supports it. */
export function attachMediaSession(player: Player): void {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  try {
    ms.setActionHandler("play", () => player.togglePlay());
    ms.setActionHandler("pause", () => player.togglePlay());
    ms.setActionHandler("nexttrack", () => void player.next());
    ms.setActionHandler("previoustrack", () => void player.prev());
  } catch {
    return;
  }
  let lastKey = "";
  player.subscribe((e) => {
    if (e.type !== "state") return;
    const np = player.nowPlaying();
    const key = np ? `${np.title}|${np.album}` : "";
    if (!np || key === lastKey) return;
    lastKey = key;
    ms.metadata = new MediaMetadata({
      title: np.title,
      artist: np.artist,
      album: np.album,
      artwork: np.art ? [{ src: np.art, sizes: "350x350", type: "image/jpeg" }] : [],
    });
  });
}
