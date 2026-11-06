// What the bandcamp.com content script does with the page: read its embedded
// data, and make requests as the page itself (same origin, the fan's cookies).

import { parseDiscoverSpec, type DiscoverInitialState } from "./discover-spec";
import type { ArtistSpec, DiscoverSpec } from "./types";

function readBlob(doc: Document, id: string): any {
  const el = doc.getElementById(id);
  const raw = el?.dataset.blob;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readDiscoverSpec(doc: Document, href: string): DiscoverSpec | null {
  const blob = readBlob(doc, "DiscoverApp");
  return parseDiscoverSpec(href, (blob?.appData?.initialState as DiscoverInitialState) ?? null);
}

/**
 * An artist's or label's page on <name>.bandcamp.com (home, /music, an album or a track):
 * every one of them carries the band in a data-band attribute.
 */
export function readArtistSpec(doc: Document, href: string): ArtistSpec | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".bandcamp.com")) return null;
  try {
    const band = JSON.parse(doc.querySelector("[data-band]")?.getAttribute("data-band") || "null");
    const id = Number(band?.id);
    if (!id || typeof band.name !== "string") return null;
    return { kind: "artist", pageUrl: `${url.origin}/music`, label: band.name, bandId: id };
  } catch {
    return null;
  }
}

/** Logged-in fan id: new Vue pages keep it in pageContext, older pages in #pagedata. */
export function readFanId(doc: Document): number | null {
  return readBlob(doc, "DiscoverApp")?.pageContext?.identity?.fanId || readBlob(doc, "pagedata")?.identities?.fan?.id || null;
}

export type PageFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function apiFetch(pageFetch: PageFetch, url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await pageFetch(url, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export interface WishlistRequest {
  add: boolean;
  bandId: number;
  fanId: number;
  itemId: number;
  itemType: "a" | "t";
}

/**
 * Same flow as the discover page's wishlist button: POST a form to
 * /collect_item_cb (or /uncollect_item_cb); on "invalid_crumb" the server hands
 * back a fresh crumb and the request is retried.
 */
export async function setWishlisted(
  pageFetch: PageFetch,
  origin: string,
  crumbs: Record<string, string>,
  req: WishlistRequest,
): Promise<true> {
  const endpoint = req.add ? "collect_item_cb" : "uncollect_item_cb";
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new URLSearchParams({
      band_id: String(req.bandId),
      fan_id: String(req.fanId),
      item_id: String(req.itemId),
      item_type: req.itemType,
      crumb: crumbs[endpoint] || "",
    });
    const res = await pageFetch(`${origin}/${endpoint}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    });
    if (res.status !== 200 && res.status !== 403) throw new Error("Wishlist request failed: HTTP " + res.status);
    const data = await res.json();
    if (data.error === "invalid_crumb" && data.crumb) {
      crumbs[endpoint] = data.crumb;
      continue;
    }
    if (data.error_message || data.error) throw new Error(String(data.error_message || data.error));
    return true;
  }
  throw new Error("Wishlist request failed: invalid crumb");
}

export function readCrumbs(doc: Document): Record<string, string> {
  const raw = doc.getElementById("js-crumbs-data")?.dataset.crumbs;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
