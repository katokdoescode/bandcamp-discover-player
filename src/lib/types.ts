// Shapes shared by the popup, the player and the content scripts.

/** Body of a discover_web request, minus paging fields. */
export interface DiscoverParams {
  category_id: number;
  tag_norm_names: string[];
  geoname_id: number;
  slice: string;
  time_facet_id: number | null;
  include_result_types: string[];
  followed_bands?: boolean;
  [key: string]: unknown;
}

/** What the content script reports about a discover page. */
export interface DiscoverSpec {
  kind?: "discover";
  pageUrl: string;
  label: string;
  params: DiscoverParams;
}

/** What the content script reports about an artist's or label's page on <name>.bandcamp.com. */
export interface ArtistSpec {
  kind: "artist";
  /** The artist's /music page, the same for all of its pages. */
  pageUrl: string;
  label: string;
  bandId: number;
}

export type PageSpec = DiscoverSpec | ArtistSpec;

export type ArtistOrder = "newest" | "oldest";

/** One release as returned by discover_web. */
export interface DiscoverResult {
  item_id: number;
  item_type: string;
  title: string;
  item_url?: string;
  album_artist?: string | null;
  band_name: string;
  band_id: number;
  primary_image?: { image_id: number; is_art: boolean } | null;
  track_count?: number;
  is_wishlisted?: boolean | null;
  is_owned?: boolean | null;
  /** "2026-10-30 00:00:00 UTC" */
  release_date?: string | null;
  featured_track?: {
    id: number;
    title: string;
    band_name?: string;
    stream_url?: string;
    duration: number;
  } | null;
}

export interface DiscoverResponse {
  results: DiscoverResult[];
  cursor?: string | null;
}

/** The release list a tab has loaded, as seen in its own discover_web responses. */
export interface Capture {
  params: DiscoverParams;
  results: DiscoverResult[];
  cursor: string | null;
  /** Ids of the first batch; a different value means the page shows other releases. */
  sig: string;
}

export interface Track {
  id: number;
  num?: number;
  title: string;
  artist?: string;
  stream: string;
  duration: number;
  /** From tralbum_details; unknown for discover's featured track until the tracklist loads. */
  hasLyrics?: boolean;
  /** Track page, where the lyrics text lives. */
  url?: string;
  /** Set when the track is also sold on its own, from tralbum_details. */
  buy?: Buy | null;
}

export interface Item {
  id: number;
  type: "a" | "t";
  title: string;
  artist: string;
  bandId: number;
  url: string;
  artId: number | null;
  trackCount: number;
  wishlisted: boolean;
  owned: boolean;
  /** Release year; missing in snapshots saved before 0.3.0. */
  year?: number | null;
  /** Release date (ms since epoch), for sorting an artist's releases. */
  released?: number | null;
  featured: Track | null;
  tracks: Track[] | null;
  /** How the release is sold, from its tracklist; null when it can't be bought, undefined until loaded. */
  buy?: Buy | null;
}

/** Price and terms of a release (or a single track) on Bandcamp. */
export interface Buy {
  /** What the digital purchase is. */
  what: "album" | "track";
  /** The download can be bought; false when only physical editions are sold. */
  digital: boolean;
  /** Physical editions (vinyl, CD, cassette…) by title. */
  editions: string[];
  /** The price of the download, or the minimum when the buyer names their price. */
  price: number;
  currency: string;
  nameYourPrice: boolean;
  free: boolean;
  preorder: boolean;
  /** Full plays the artist allows before asking to buy (Bandcamp's streaming_limit). */
  limit: number | null;
}

export type Mode = "track" | "album";

/** Keys of Settings, as read from extension storage. */
export const SETTINGS_KEYS = ["mode", "shuffle", "repeat", "artistOrder", "plays", "nudgeOff"] as const;

export interface Settings {
  mode: Mode;
  shuffle: boolean;
  /** Loop the current release (full releases mode only). */
  repeat: boolean;
  /** Order of an artist's releases. */
  artistOrder: ArtistOrder;
  /** Full plays per track ("t<id>"), kept only in the browser for the buy reminder. */
  plays: Record<string, number>;
  /** Releases ("a<id>" / "t<id>") whose buy reminder was closed. */
  nudgeOff: string[];
}

/** Messages the extension sends to the bandcamp.com content script. */
export type ContentMessage =
  | { type: "getDiscoverSpec" }
  | { type: "getArtistSpec" }
  | { type: "getFanId" }
  | { type: "apiFetch"; url: string; method: string; body?: unknown }
  | {
      type: "setWishlisted";
      add: boolean;
      bandId: number;
      fanId: number;
      itemId: number;
      itemType: "a" | "t";
    };

/** State the popup renders. */
export interface PublicState {
  source: { kind: "discover" | "artist" | "recs"; label: string; pageUrl: string; sig: string | null } | null;
  notice: "login" | null;
  mode: Mode;
  shuffle: boolean;
  repeat: boolean;
  artistOrder: ArtistOrder;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  paused: boolean;
  time: number;
  duration: number;
  pos: number;
  current: {
    itemIndex: number;
    track: Track & { wishlisted: boolean };
    release: {
      title: string;
      artist: string;
      url: string;
      art: string | null;
      year: number | null;
      /** The release page can be read for "you may also like". */
      hasRecs: boolean;
      wishlisted: boolean;
      owned: boolean;
      tracks: (Track & { wishlisted: boolean })[] | null;
      /** Null when it can't be bought or is already owned; undefined until the tracklist loads. */
      buy: Buy | null | undefined;
      /** The playing track, when it is also sold on its own (a track of an album). */
      trackBuy: (Buy & { url: string }) | null;
      /** Full plays of the most played track, once that reached the artist's limit: what to buy. */
      nudge: { plays: number; url: string; free: boolean } | null;
    };
  } | null;
  queue: {
    index: number;
    title: string;
    artist: string;
    url: string;
    thumb: string | null;
    featured: string | null;
    duration: number | null;
    trackCount: number;
    year: number | null;
    wishlisted: boolean;
    owned: boolean;
  }[];
}

/** Popup → player commands, sent over the "popup" port. */
export type PlayerCommand =
  | { cmd: "loadFromTab"; tabId: number }
  | { cmd: "inspectTab"; tabId: number }
  | { cmd: "togglePlay" }
  | { cmd: "next" }
  | { cmd: "prev" }
  | { cmd: "seek"; fraction: number }
  | { cmd: "playTrack"; itemIndex: number; trackId?: number }
  | { cmd: "setShuffle"; on: boolean }
  | { cmd: "setRepeat"; on: boolean }
  | { cmd: "setArtistOrder"; order: ArtistOrder }
  | { cmd: "setMode"; mode: Mode }
  | { cmd: "toggleWishlist"; itemIndex: number; trackId?: number }
  | { cmd: "dismissNotice" }
  | { cmd: "dismissNudge" }
  | { cmd: "loadMore" }
  | { cmd: "getLyrics"; itemIndex: number; trackId: number }
  | { cmd: "getRecs"; url: string }
  | { cmd: "playRecs"; url: string; index: number };

/** Answer to getLyrics: the text (null when the track has none), or why it could not be loaded. */
export type LyricsResult = { text: string | null } | { error: string };

/** Answer to getRecs: the releases recommended on a release page, or why they could not be loaded. */
export type RecsResult =
  | { title: string | null; items: { title: string; artist: string; url: string; thumb: string | null }[] }
  | { error: string };

/** Player → popup events. */
export type PlayerEvent =
  | { type: "state"; state: PublicState }
  | { type: "time"; time: number; duration: number };
