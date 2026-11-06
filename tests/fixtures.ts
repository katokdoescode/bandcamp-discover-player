import type { AudioEvent, AudioPort, PlayerEnv } from "@/lib/player";
import { Player } from "@/lib/player";
import type { ArtistSpec, Capture, ContentMessage, DiscoverResult, DiscoverSpec, Settings } from "@/lib/types";

/** A discover_web result whose featured track is `id * 10`. */
export function result(id: number, extra: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    item_id: id,
    item_type: "a",
    title: `Release ${id}`,
    item_url: `https://band${id}.bandcamp.com/album/r${id}?from=discover_page`,
    album_artist: null,
    band_name: `Band ${id}`,
    band_id: 1000 + id,
    primary_image: { image_id: 5000 + id, is_art: true },
    track_count: 3,
    is_wishlisted: false,
    is_owned: false,
    featured_track: { id: id * 10, title: `Featured ${id}`, band_name: `Band ${id}`, stream_url: `https://stream/${id * 10}`, duration: 100 },
    ...extra,
  };
}

/** tralbum_details for release `id`: tracks id*10, id*10+1, id*10+2; `lyrics` lists track ids that have lyrics. */
export function details(id: number, count = 3, lyrics: number[] = []) {
  return {
    tralbum_artist: `Band ${id}`,
    tracks: Array.from({ length: count }, (_, i) => ({
      track_id: id * 10 + i,
      track_num: i + 1,
      title: `Track ${id}.${i + 1}`,
      duration: 60,
      is_streamable: true,
      streaming_url: { "mp3-128": `https://stream/${id * 10 + i}?fresh=0` },
      has_lyrics: lyrics.includes(id * 10 + i),
      track_url: trackUrl(id * 10 + i),
    })),
  };
}

export const trackUrl = (trackId: number) => `https://band${Math.floor(trackId / 10)}.bandcamp.com/track/t${trackId}`;

/** A Bandcamp track page carrying `lyrics` the way the real one does (ld+json and data-tralbum). */
export function trackPage(lyrics: string): string {
  const ld = JSON.stringify({ "@type": "MusicRecording", recordingOf: { lyrics: { "@type": "CreativeWork", text: lyrics } } });
  const tralbum = JSON.stringify({ trackinfo: [{ lyrics }] }).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<html><head><script type="application/ld+json">\n${ld}\n</script></head><body><script data-tralbum="${tralbum}"></script></body></html>`;
}

export const ARTIST: ArtistSpec = { kind: "artist", pageUrl: "https://someband.bandcamp.com/music", label: "Some Band", bandId: 77 };

/** band_details discography entry for release `id`, released on `date`. */
export function disco(id: number, date: string | null, extra: Record<string, unknown> = {}) {
  return { item_id: id, item_type: "album", title: `Release ${id}`, artist_name: null, band_name: "Some Band", band_id: 77, art_id: 9000 + id, release_date: date, ...extra };
}

/** API answering band_details with `discography`, and the default tralbum_details. */
export function artistApi(discography: unknown[]) {
  const base = defaultApi();
  return (url: string, body?: any) => {
    if (url.includes("band_details")) return body?.band_id === 77 ? { discography } : undefined;
    const d = base(url) as any;
    const m = /tralbum_id=(\d+)/.exec(url);
    return m && d ? { ...d, bandcamp_url: `https://someband.bandcamp.com/album/r${m[1]}`, featured_track_id: Number(m[1]) * 10 + 1 } : d;
  };
}

export function capture(ids: number[], cursor: string | null = null): Capture {
  return {
    params: { category_id: 1, tag_norm_names: ["punk"], geoname_id: 0, slice: "rand", time_facet_id: null, include_result_types: ["a", "s"] },
    results: ids.map((id) => result(id)),
    cursor,
    sig: ids.join(","),
  };
}

export const SPEC: DiscoverSpec = {
  pageUrl: "https://bandcamp.com/discover/punk/digital?s=rand",
  label: "punk · digital",
  params: { category_id: 1, tag_norm_names: ["punk"], geoname_id: 0, slice: "rand", time_facet_id: null, include_result_types: ["a", "s"] },
};

export class FakeAudio implements AudioPort {
  paused = true;
  duration = 0;
  currentTime = 0;
  src = "";
  private handlers = new Map<AudioEvent, (() => void)[]>();

  get hasSource() {
    return !!this.src;
  }
  setSource(src: string) {
    this.src = src;
    this.currentTime = 0;
  }
  clear() {
    this.src = "";
  }
  async play() {
    this.paused = false;
    this.fire("play");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  on(event: AudioEvent, fn: () => void) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), fn]);
  }
  fire(event: AudioEvent) {
    for (const fn of this.handlers.get(event) || []) fn();
  }
}

export interface Setup {
  capture?: Capture;
  spec?: DiscoverSpec | null;
  fanId?: number | null;
  /** Direct API answers; undefined means "bot challenge", i.e. use the tab proxy. */
  api?: (url: string, body?: any) => unknown;
  /** Answers through the tab proxy (apiFetch). */
  proxy?: (url: string, body?: any) => unknown;
  /** Release ids whose tralbum_details have no streamable tracks. */
  silent?: number[];
  /** Settings saved by an earlier session. */
  settings?: Partial<Settings>;
  /** Track ids whose tralbum_details say has_lyrics. */
  lyrics?: number[];
  /** The tab is this artist's page (use with spec: null). */
  artist?: ArtistSpec;
  /** HTML of pages by URL, for fetchText. */
  pages?: Record<string, string>;
}

/** Default API: tralbum_details per release id, discover_web → no more results. */
export function defaultApi(silent: number[] = [], lyrics: number[] = []) {
  return (url: string) => {
    const m = /tralbum_id=(\d+)/.exec(url);
    if (m) {
      const id = Number(m[1]);
      return details(id, silent.includes(id) ? 0 : 3, lyrics);
    }
    if (url.includes("discover_web")) return { results: [], cursor: null };
    return undefined;
  };
}

export async function setup(o: Setup = {}) {
  const audio = new FakeAudio();
  const sent: ContentMessage[] = [];
  const apiCalls: { url: string; body?: any }[] = [];
  const settings: Partial<Settings> = { ...o.settings };
  const state = { capture: o.capture, spec: o.spec === undefined ? SPEC : o.spec, fanId: o.fanId ?? null };
  const api = o.api ?? defaultApi(o.silent, o.lyrics);
  const pageCalls: string[] = [];

  const env: PlayerEnv = {
    audio,
    bandcampTabs: async () => [{ id: 7, active: true }],
    async sendToTab(_tabId, msg) {
      sent.push(msg);
      switch (msg.type) {
        case "getDiscoverSpec":
          return state.spec as any;
        case "getArtistSpec":
          return (o.artist ?? null) as any;
        case "getFanId":
          return state.fanId as any;
        case "setWishlisted":
          return true as any;
        case "apiFetch":
          return (o.proxy ?? api)(msg.url, msg.body) as any;
      }
    },
    async fetchJson(url, body) {
      apiCalls.push({ url, body });
      return api(url, body);
    },
    async fetchText(url) {
      pageCalls.push(url);
      return o.pages?.[url];
    },
    getCapture: async () => state.capture,
    settings: {
      load: async () => ({ ...settings }),
      save: async (s) => void Object.assign(settings, s),
    },
    // Deterministic shuffle: always swap with the first element.
    random: () => 0,
  };
  const player = new Player(env);
  await player.init();
  return { player, audio, sent, apiCalls, pageCalls, settings, state, view: () => player.publicState() };
}
