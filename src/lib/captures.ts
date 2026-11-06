// The discover page gets its results from discover_web. Reading those responses
// keeps the queue identical to the page (matters for "surprise me", which is
// random on every load). A request with cursor "*" means the page started a new
// list: a reload or a filter change.

import { normalizeResults } from "./bandcamp";
import type { Capture, DiscoverParams, DiscoverResponse } from "./types";

/**
 * Folds one discover_web request/response pair into a tab's capture.
 * Returns the new capture, or `prev` unchanged when the pair is unusable.
 */
export function applyDiscoverResponse(
  prev: Capture | undefined,
  body: unknown,
  data: unknown,
): Capture | undefined {
  if (!body || typeof body !== "object") return prev;
  const res = data as DiscoverResponse | null;
  if (!res || !Array.isArray(res.results)) return prev;

  const results = normalizeResults(res.results);
  const { cursor, size: _size, ...params } = body as Record<string, unknown>;
  const startsList = !cursor || cursor === "*";
  if (!startsList && !prev) return prev; // the list started before we were listening

  const base: Capture = startsList
    ? { params: params as DiscoverParams, results: [], cursor: null, sig: results.map((r) => r.item_id).join(",") }
    : prev!;
  return { ...base, results: [...base.results, ...results], cursor: res.cursor || null };
}
