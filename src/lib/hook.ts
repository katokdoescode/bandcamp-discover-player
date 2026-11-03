// Runs in the page's own JS world (Chrome): wraps window.fetch so the discover
// app's discover_web responses can be read, and passes them to the content
// script with postMessage. The page gets its response untouched.

import { isPageDiscoverRequest } from "./bandcamp";

export const HOOK_SOURCE = "discover-player-hook";

export interface HookMessage {
  source: typeof HOOK_SOURCE;
  body: unknown;
  data: unknown;
}

export function isHookMessage(v: unknown): v is HookMessage {
  return !!v && typeof v === "object" && (v as HookMessage).source === HOOK_SOURCE;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function installDiscoverHook(win: Window): void {
  const original = win.fetch;
  win.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const promise = original.call(win, input, init);
    try {
      if (isPageDiscoverRequest(requestUrl(input))) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        promise
          .then((res) => res.clone().json())
          .then((data) => win.postMessage({ source: HOOK_SOURCE, body, data } satisfies HookMessage, win.location.origin))
          .catch(() => {});
      }
    } catch {
      // never break the page's own request
    }
    return promise;
  };
}
