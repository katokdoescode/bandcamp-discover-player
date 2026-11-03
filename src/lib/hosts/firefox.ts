// Firefox (MV2): the player lives right here in the persistent background page,
// and the page's discover_web responses are read with filterResponseData.

import { browser } from "wxt/browser";
import { DISCOVER_URL, OWN_MARK } from "../bandcamp";
import { applyDiscoverResponse } from "../captures";
import { COMMANDS, attachMediaSession, fetchJson, htmlAudioPort, servePopupPorts } from "../host";
import { listen, notify, requestTab } from "../messaging";
import { Player } from "../player";
import type { Capture, Settings } from "../types";

interface StreamFilter {
  ondata: ((e: { data: ArrayBuffer }) => void) | null;
  onstop: (() => void) | null;
  write(data: ArrayBuffer): void;
  close(): void;
}

export function startFirefoxHost(): void {
  const captures = new Map<number, Capture>();

  const player = new Player({
    audio: htmlAudioPort(new Audio()),
    bandcampTabs: async () =>
      (await browser.tabs.query({ url: "*://bandcamp.com/*" })).flatMap((t) => (t.id != null ? [{ id: t.id, active: t.active }] : [])),
    sendToTab: requestTab,
    fetchJson,
    getCapture: async (tabId) => captures.get(tabId),
    settings: {
      load: () => browser.storage.local.get(["mode", "shuffle"]) as Promise<Partial<Settings>>,
      save: (s) => browser.storage.local.set(s),
    },
  });
  const ready = player.init().then(() => player);

  servePopupPorts(ready);
  attachMediaSession(player);
  listen((msg) => (msg.to === "bg" && msg.type === "ensurePlayer" ? ready.then(() => true) : undefined));
  browser.commands.onCommand.addListener((name) => {
    const c = COMMANDS[name];
    if (c) void player.handle(c);
  });

  const webRequest = browser.webRequest as typeof browser.webRequest & {
    filterResponseData(requestId: string): StreamFilter;
  };
  webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0 || details.url.includes(OWN_MARK)) return;
      let body: unknown = null;
      try {
        const raw = details.requestBody?.raw?.[0]?.bytes;
        if (raw) body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        // not JSON: ignored by applyDiscoverResponse
      }
      const filter = webRequest.filterResponseData(details.requestId);
      const decoder = new TextDecoder();
      let text = "";
      filter.ondata = (e) => {
        text += decoder.decode(e.data, { stream: true });
        filter.write(e.data);
      };
      filter.onstop = () => {
        filter.close();
        try {
          const next = applyDiscoverResponse(captures.get(details.tabId), body, JSON.parse(text + decoder.decode()));
          if (next && next !== captures.get(details.tabId)) {
            captures.set(details.tabId, next);
            notify("popup", "tabChanged", { tabId: details.tabId });
          }
        } catch {
          // unreadable response: keep the capture as it was
        }
      };
      return undefined;
    },
    { urls: [`${DISCOVER_URL}*`] },
    ["blocking", "requestBody"],
  );
  browser.tabs.onRemoved.addListener((tabId) => captures.delete(tabId));
}
