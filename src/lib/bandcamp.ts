// Bandcamp endpoints and conversions from their JSON to our own shapes.
// These are Bandcamp's internal APIs (the ones its own pages use), not a public API.

import type { ArtistOrder, Buy, DiscoverResult, Item, Track } from "./types";

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

/**
 * Year of a release date in any of Bandcamp's formats: "2026-10-30 00:00:00 UTC"
 * (discover), "30 Oct 2026 00:00:00 GMT" (band_details) or unix seconds (tralbum_details).
 */
export function releaseYear(date: string | number | null | undefined): number | null {
  if (typeof date === "number") return Number.isFinite(date) && date > 0 ? new Date(date * 1000).getUTCFullYear() : null;
  const m = date?.match(/\b(\d{4})\b/);
  return m ? Number(m[1]) : null;
}

const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [snakeKey(k), snakeKeys(x)]));
}

/**
 * discover_web results with snake_case keys. Bandcamp switched the response to
 * camelCase (itemId, featuredTrack.streamUrl, …) in November 2026; both are accepted.
 */
export function normalizeResults(results: unknown): DiscoverResult[] {
  return Array.isArray(results) ? (results.map(snakeKeys) as DiscoverResult[]) : [];
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
    year: releaseYear(r.release_date),
    featured:
      ft && ft.stream_url
        ? { id: ft.id, title: ft.title, artist: ft.band_name, stream: ft.stream_url, duration: ft.duration }
        : null,
    tracks: null,
  };
}

export const BAND_DETAILS_URL = `${API}/mobile/25/band_details`;

export interface BandDetails {
  discography?: {
    item_id: number;
    item_type: "album" | "track" | string;
    title: string;
    artist_name?: string | null;
    band_name: string;
    band_id: number;
    art_id?: number | null;
    /** "30 Oct 2026 00:00:00 GMT" */
    release_date?: string | null;
  }[];
}

/**
 * An artist's (or label's) releases from band_details. It lacks links, track
 * counts and featured tracks; those come with each release's tracklist.
 */
export function toArtistItems(data: BandDetails, bandUrl: string): Item[] {
  return (data.discography || []).map((d) => {
    const released = d.release_date ? Date.parse(d.release_date) : NaN;
    return {
      id: d.item_id,
      type: d.item_type === "track" ? "t" : "a",
      title: d.title,
      artist: d.artist_name || d.band_name,
      bandId: d.band_id,
      url: bandUrl,
      artId: d.art_id || null,
      trackCount: d.item_type === "track" ? 1 : 0,
      wishlisted: false,
      owned: false,
      year: releaseYear(d.release_date),
      released: Number.isFinite(released) ? released : null,
      featured: null,
      tracks: null,
    };
  });
}

/** Item indices sorted by release date; undated releases go last. */
export function byReleaseDate(items: Item[], order: ArtistOrder): number[] {
  const dir = order === "oldest" ? 1 : -1;
  return items
    .map((it, i) => ({ i, t: it.released ?? null }))
    .sort((a, b) => {
      if (a.t === b.t) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return (a.t - b.t) * dir || a.i - b.i;
    })
    .map((x) => x.i);
}

export function tralbumDetailsUrl(item: Pick<Item, "bandId" | "id" | "type">): string {
  return `${API}/mobile/25/tralbum_details?band_id=${item.bandId}&tralbum_id=${item.id}&tralbum_type=${item.type}`;
}

export interface TralbumDetails {
  tralbum_artist?: string;
  /** The release's page. */
  bandcamp_url?: string;
  featured_track_id?: number;
  /** Unix seconds. */
  release_date?: number;
  is_purchasable?: boolean;
  free_download?: boolean;
  is_preorder?: boolean;
  /** false: the price is a minimum and the buyer names their own. */
  is_set_price?: boolean;
  price?: number;
  currency?: string;
  /** Full plays allowed before the artist asks to buy. */
  streaming_limit?: number | null;
  /** Physical editions by package id. */
  package_details_lite?: Record<string, { title?: string }> | null;
  tracks?: {
    track_id: number;
    track_num?: number;
    title: string;
    band_name?: string;
    duration: number;
    is_streamable?: boolean;
    streaming_url?: Record<string, string> | null;
    has_lyrics?: boolean;
    track_url?: string;
    /** Sold on its own. */
    is_purchasable?: boolean;
    is_set_price?: boolean;
    price?: number;
    currency?: string;
  }[];
}

/**
 * How a release is sold, from a tralbum_details response: its download, its physical
 * editions, or both. Null when neither can be bought.
 */
export function toBuy(data: TralbumDetails, what: Buy["what"]): Buy | null {
  const digital = !!(data.is_purchasable || data.free_download);
  const editions = Object.values(data.package_details_lite || {}).flatMap((p) => (p?.title ? [p.title] : []));
  if (!digital && !editions.length) return null;
  return {
    what,
    digital,
    editions,
    price: Number(data.price) || 0,
    currency: data.currency || "USD",
    nameYourPrice: data.is_set_price === false,
    free: !!data.free_download,
    preorder: !!data.is_preorder,
    limit: typeof data.streaming_limit === "number" && data.streaming_limit > 0 ? data.streaming_limit : null,
  };
}

/** Streamable tracks of a release, from a tralbum_details response. */
export function toTracks(data: TralbumDetails): Track[] {
  // A standalone track has no track_num; number tracks by position instead.
  return (data.tracks || []).flatMap((t, i) => {
    const stream = t.is_streamable ? t.streaming_url?.["mp3-128"] : undefined;
    if (!stream) return [];
    return [
      {
        id: t.track_id,
        num: t.track_num ?? i + 1,
        title: t.title,
        artist: t.band_name || data.tralbum_artist,
        stream,
        duration: t.duration,
        hasLyrics: !!t.has_lyrics,
        url: t.track_url,
        buy: t.is_purchasable
          ? {
              what: "track" as const,
              digital: true,
              editions: [],
              price: Number(t.price) || 0,
              currency: t.currency || data.currency || "USD",
              nameYourPrice: t.is_set_price === false,
              free: false,
              preorder: false,
              limit: null,
            }
          : null,
      },
    ];
  });
}

/**
 * True for pages on bandcamp.com and its artist subdomains: the only pages the extension
 * can fetch (lyrics, recommendations). Artists' custom domains are out of reach.
 */
export function isBandcampPage(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "bandcamp.com" || u.hostname.endsWith(".bandcamp.com"));
  } catch {
    return false;
  }
}

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", "#39": "'" };
const decodeEntities = (s: string) =>
  s.replace(/&(quot|amp|lt|gt|apos|#39|#x[0-9a-f]+|#\d+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** The "If you like …, you may also like" section of a release page. */
export interface Recommendations {
  /** "If you like DICKWEED, you may also like:" */
  title: string | null;
  items: Item[];
}

const attrOf = (attrs: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeEntities(m[1]!) : null;
};

/**
 * Recommendations from the HTML of an album or track page. Bandcamp renders them
 * server-side as li.recommended-album with data-* attributes; parsed as text, without a DOM.
 */
export function parseRecommendations(html: string): Recommendations {
  const titleMatch = /class="section-title"[^>]*>([\s\S]*?)<\//.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() || null : null;
  const items: Item[] = [];
  const re = /<li\s+class="recommended-album[^"]*"([^>]*)>([\s\S]*?)<\/li>/g;
  for (let m; (m = re.exec(html)); ) {
    const [, attrs, body] = m as unknown as [string, string, string];
    const id = Number(attrOf(attrs, "data-albumid"));
    const bandId = Number(attrOf(attrs, "data-artistid"));
    const href = /<a\b[^>]*href="([^"]*)"/.exec(body);
    const url = href ? decodeEntities(href[1]!).replace(/\?.*$/, "") : "";
    if (!id || !bandId || !isBandcampPage(url)) continue;
    const art = /\/img\/a(\d+)_/.exec(body);
    items.push({
      id,
      type: url.includes("/track/") ? "t" : "a",
      title: attrOf(attrs, "data-albumtitle") || "",
      artist: attrOf(attrs, "data-artist") || "",
      bandId,
      url,
      artId: art ? Number(art[1]) : null,
      trackCount: url.includes("/track/") ? 1 : 0,
      wishlisted: false,
      owned: false,
      year: null,
      featured: null,
      tracks: null,
    });
  }
  return { title, items };
}

/**
 * Lyrics text from a Bandcamp track page: its ld+json (recordingOf.lyrics.text),
 * or else the data-tralbum attribute (trackinfo[0].lyrics). Plain string parsing,
 * so it works without a DOM.
 */
export function parseLyrics(html: string): string | null {
  const clean = (t: unknown) => (typeof t === "string" && t.trim() ? t.replace(/\r\n?/g, "\n").trim() : null);
  const ld = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (ld) {
    try {
      const text = clean(JSON.parse(ld[1]!)?.recordingOf?.lyrics?.text);
      if (text) return text;
    } catch {
      // fall back to data-tralbum
    }
  }
  const attr = /data-tralbum="([^"]*)"/.exec(html);
  if (attr) {
    try {
      return clean(JSON.parse(decodeEntities(attr[1]!))?.trackinfo?.[0]?.lyrics);
    } catch {
      return null;
    }
  }
  return null;
}
