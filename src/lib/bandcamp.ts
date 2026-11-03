// Bandcamp endpoints and conversions from their JSON to our own shapes.
// These are Bandcamp's internal APIs (the ones its own pages use), not a public API.

import type { DiscoverResult, Item, Track } from "./types";

export const API = "https://bandcamp.com/api";
export const DISCOVER_PATH = "/api/discover/1/discover_web";
export const DISCOVER_URL = `https://bandcamp.com${DISCOVER_PATH}`;
/** Tags the extension's own discover requests so they are never mistaken for the page's. */
export const OWN_MARK = "via=discover-player";
export const PAGE_SIZE = 60;

/** True for discover_web requests made by the page itself (relative or absolute URL). */
export function isPageDiscoverRequest(url: string): boolean {
  return url.includes(DISCOVER_PATH) && !url.includes(OWN_MARK);
}

export function artUrl(artId: number | null | undefined, size: number): string | null {
  if (!artId) return null;
  return `https://f4.bcbits.com/img/a${String(artId).padStart(10, "0")}_${size}.jpg`;
}

export function toItem(r: DiscoverResult): Item {
  const ft = r.featured_track;
  return {
    id: r.item_id,
    type: r.item_type === "t" ? "t" : "a",
    title: r.title,
    artist: r.album_artist || r.band_name,
    bandId: r.band_id,
    url: (r.item_url || "").replace(/\?from=discover_page$/, ""),
    artId: r.primary_image && r.primary_image.is_art ? r.primary_image.image_id : null,
    trackCount: r.track_count || 1,
    wishlisted: !!r.is_wishlisted,
    owned: !!r.is_owned,
    featured:
      ft && ft.stream_url
        ? { id: ft.id, title: ft.title, artist: ft.band_name, stream: ft.stream_url, duration: ft.duration }
        : null,
    tracks: null,
  };
}

export function tralbumDetailsUrl(item: Pick<Item, "bandId" | "id" | "type">): string {
  return `${API}/mobile/25/tralbum_details?band_id=${item.bandId}&tralbum_id=${item.id}&tralbum_type=${item.type}`;
}

interface TralbumDetails {
  tralbum_artist?: string;
  tracks?: {
    track_id: number;
    track_num?: number;
    title: string;
    band_name?: string;
    duration: number;
    is_streamable?: boolean;
    streaming_url?: Record<string, string> | null;
  }[];
}

/** Streamable tracks of a release, from a tralbum_details response. */
export function toTracks(data: TralbumDetails): Track[] {
  return (data.tracks || []).flatMap((t) => {
    const stream = t.is_streamable ? t.streaming_url?.["mp3-128"] : undefined;
    if (!stream) return [];
    return [{ id: t.track_id, num: t.track_num, title: t.title, artist: t.band_name || data.tralbum_artist, stream, duration: t.duration }];
  });
}
