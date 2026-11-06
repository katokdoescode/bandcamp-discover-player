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
  pageUrl: string;
  label: string;
  params: DiscoverParams;
}

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
  featured: Track | null;
  tracks: Track[] | null;
}

export type Mode = "track" | "album";

export interface Settings {
  mode: Mode;
  shuffle: boolean;
}

/** Messages the extension sends to the bandcamp.com content script. */
export type ContentMessage =
  | { type: "getDiscoverSpec" }
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
  source: { label: string; pageUrl: string; sig: string | null } | null;
  notice: "login" | null;
  mode: Mode;
  shuffle: boolean;
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
      wishlisted: boolean;
      owned: boolean;
      tracks: (Track & { wishlisted: boolean })[] | null;
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
  | { cmd: "setMode"; mode: Mode }
  | { cmd: "toggleWishlist"; itemIndex: number; trackId?: number }
  | { cmd: "dismissNotice" }
  | { cmd: "loadMore" };

/** Player → popup events. */
export type PlayerEvent =
  | { type: "state"; state: PublicState }
  | { type: "time"; time: number; duration: number };
