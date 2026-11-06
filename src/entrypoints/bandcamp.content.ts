import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { isHookMessage } from "@/lib/hook";
import { listen } from "@/lib/messaging";
import { apiFetch, readArtistSpec, readCrumbs, readDiscoverSpec, readFanId, setWishlisted, type PageFetch } from "@/lib/page";
import type { ContentMessage } from "@/lib/types";

// Firefox globals for acting as the page (see MDN "Sharing objects with page scripts").
declare const content: { fetch: typeof fetch } | undefined;
declare function cloneInto<T>(obj: T, target: Window): T;

export default defineContentScript({
  // bandcamp.com for discover pages; artists' and labels' own <name>.bandcamp.com pages for "play all releases".
  matches: ["*://bandcamp.com/*", "*://*.bandcamp.com/*"],
  // Early, so no discover_web response from the page hook is missed.
  runAt: "document_start",
  main() {
    // Requests as the page itself. Firefox needs `content.fetch` for that; in
    // Chrome a content script fetch to its own origin already carries the cookies.
    const pageFetch: PageFetch =
      typeof content !== "undefined" && content?.fetch
        ? (url, init) => content.fetch(url, typeof cloneInto === "function" ? cloneInto(init, window) : init)
        : (url, init) => fetch(url, init);
    let crumbs: Record<string, string> | null = null;

    listen((raw) => {
      const msg = raw as unknown as ContentMessage;
      switch (msg.type) {
        case "getDiscoverSpec":
          return Promise.resolve(readDiscoverSpec(document, location.href));
        case "getArtistSpec":
          return Promise.resolve(readArtistSpec(document, location.href));
        case "getFanId":
          return Promise.resolve(readFanId(document));
        case "apiFetch":
          return apiFetch(pageFetch, msg.url, msg.method, msg.body);
        case "setWishlisted":
          crumbs ??= readCrumbs(document);
          return setWishlisted(pageFetch, location.origin, crumbs, msg);
        default:
          return undefined;
      }
    });

    // Chrome: discover_web responses caught by the main-world hook.
    window.addEventListener("message", (e) => {
      if (e.source !== window || !isHookMessage(e.data)) return;
      browser.runtime.sendMessage({ to: "bg", type: "discoverCaptured", body: e.data.body, data: e.data.data }).catch(() => {});
    });
  },
});
