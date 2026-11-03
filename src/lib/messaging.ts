// One request/response convention for runtime and tab messages, in both browsers:
// the answer is wrapped as { ok, result } / { ok: false, error }, so errors
// survive the trip and Chrome's sendResponse works the same as Firefox promises.

import { browser, type Browser } from "wxt/browser";
import type { ContentMessage } from "./types";
import { errorMessage } from "./util";

type Envelope = { ok: true; result: unknown } | { ok: false; error: string };

/** Who a runtime message is for: the background/service worker, the player, or the popup. */
export type Target = "bg" | "player" | "popup";

export type Handler = (
  msg: { to?: Target; type?: string; [key: string]: unknown },
  sender: Browser.runtime.MessageSender,
) => Promise<unknown> | undefined;

/** Answers runtime/tab messages. Return undefined from the handler to leave a message to other listeners. */
export function listen(handler: Handler): void {
  browser.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
    const pending = handler(msg ?? {}, sender);
    if (!pending) return false;
    pending.then(
      (result) => sendResponse({ ok: true, result } satisfies Envelope),
      (e) => sendResponse({ ok: false, error: errorMessage(e) } satisfies Envelope),
    );
    return true;
  });
}

function unwrap<T>(res: unknown): T {
  const env = res as Envelope | undefined;
  if (!env || typeof env !== "object" || !("ok" in env)) throw new Error("No answer from the extension");
  if (!env.ok) throw new Error(env.error);
  return env.result as T;
}

export async function request<T>(to: Target, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return unwrap<T>(await browser.runtime.sendMessage({ to, type, ...payload }));
}

export async function requestTab<T>(tabId: number, msg: ContentMessage): Promise<T> {
  return unwrap<T>(await browser.tabs.sendMessage(tabId, msg));
}

/** Fire-and-forget notice; fine when nobody listens (e.g. the popup is closed). */
export function notify(to: Target, type: string, payload: Record<string, unknown> = {}): void {
  browser.runtime.sendMessage({ to, type, ...payload }).catch(() => {});
}
