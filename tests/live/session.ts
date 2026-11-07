// A real browser on bandcamp.com for the live monitor. Bandcamp answers scripts with a
// JavaScript "Client Challenge" page, so requests are made from inside a page that
// passed it, the same way the extension's content script makes them.

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Window } from "happy-dom";

export const REPORT_DIR = "live-report";
const CHALLENGE_TITLE = "Client Challenge";

/** Bandcamp kept answering with its bot check: the run says nothing about the formats. */
export class BlockedError extends Error {}

let blocked: string | null = null;

/** Once Bandcamp has blocked the run, later checks stop at once instead of asking again. */
function stopIfBlocked(): void {
  if (blocked) throw new BlockedError(`Skipped: ${blocked}`);
}

export function markBlocked(reason: string): void {
  blocked = reason;
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(`${REPORT_DIR}/blocked.txt`, reason + "\n");
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  /** A bandcamp.com page that passed the bot check; API requests run in it. */
  page: Page;
}

export async function openSession(): Promise<Session> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  return { browser, context, page };
}

/** Opens url and waits until the bot check, if any, has let the page through. */
export async function visit(page: Page, url: string): Promise<string> {
  stopIfBlocked();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction((t) => document.title !== t && !!document.body?.children.length, CHALLENGE_TITLE, {
      timeout: 45_000,
    });
  } catch {
    const reason = `${url} kept showing Bandcamp's "${CHALLENGE_TITLE}" page.`;
    markBlocked(reason);
    throw new BlockedError(reason);
  }
  await page.waitForLoadState("load").catch(() => {});
  return page.content();
}

/** A same-origin request from the page, like the extension's apiFetch. Returns parsed JSON. */
export async function api<T = any>(page: Page, url: string, body?: unknown): Promise<T> {
  stopIfBlocked();
  const res = await page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: body ? "POST" : "GET",
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
    },
    { url, body },
  );
  if (res.text.includes(`<title>${CHALLENGE_TITLE}</title>`)) {
    const reason = `${url} answered with Bandcamp's bot check.`;
    markBlocked(reason);
    throw new BlockedError(reason);
  }
  if (res.status === 429) {
    const reason = `${url} answered HTTP 429 (too many requests).`;
    markBlocked(reason);
    throw new BlockedError(reason);
  }
  if (res.status !== 200) throw new Error(`${url} answered HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new Error(`${url} answered ${res.type || "no content type"}, not JSON: ${res.text.slice(0, 200)}`);
  }
}

/** Parses page HTML into a Document for the extension's page readers. */
export function toDocument(html: string, url: string): Document {
  const window = new Window({ url });
  return new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

/** Paths missing from an object, e.g. "tracks[].streaming_url.mp3-128"; a "[]" step looks into the first element. */
export function missingPaths(obj: unknown, paths: string[]): string[] {
  return paths.filter((path) => {
    let cur: unknown[] = [obj];
    for (const raw of path.split(".")) {
      const step = raw.replace(/\[\]$/, "");
      const next: unknown[] = [];
      for (const c of cur) {
        if (!c || typeof c !== "object" || !(step in (c as object))) return true;
        const v = (c as Record<string, unknown>)[step];
        if (raw.endsWith("[]")) {
          if (!Array.isArray(v) || !v.length) return true;
          next.push(v[0]);
        } else next.push(v);
      }
      cur = next;
    }
    return false;
  });
}
