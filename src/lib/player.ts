// The player: queue, play order, release/track modes, shuffle, paging of
// discover results and the wishlist. Everything browser-specific (audio, tabs,
// storage) comes in through PlayerEnv, so the same code runs in Firefox's
// background page, in Chrome's offscreen document and in unit tests.

import {
  BAND_DETAILS_URL,
  DISCOVER_URL,
  OWN_MARK,
  PAGE_SIZE,
  artUrl,
  byReleaseDate,
  isBandcampPage,
  parseRecommendations,
  normalizeResults,
  parseLyrics,
  releaseYear,
  toArtistItems,
  toBuy,
  toItem,
  toTracks,
  tralbumDetailsUrl,
} from "./bandcamp";
import type { BandDetails, Recommendations, TralbumDetails } from "./bandcamp";
import type {
  ArtistOrder,
  ArtistSpec,
  Buy,
  Capture,
  ContentMessage,
  DiscoverResponse,
  DiscoverSpec,
  Item,
  LyricsResult,
  Mode,
  PageSpec,
  PlayerCommand,
  PlayerEvent,
  PublicState,
  RecsResult,
  Settings,
  Track,
} from "./types";
import { errorMessage, range, shuffled } from "./util";

export type AudioEvent = "ended" | "error" | "play" | "pause" | "loadedmetadata" | "timeupdate";

/** The bits of an <audio> element the player uses. */
export interface AudioPort {
  readonly paused: boolean;
  readonly duration: number;
  readonly hasSource: boolean;
  currentTime: number;
  setSource(src: string): void;
  clear(): void;
  play(): Promise<void>;
  pause(): void;
  on(event: AudioEvent, fn: () => void): void;
}

export interface BandcampTab {
  id: number;
  active?: boolean;
  /** An artist's or label's <name>.bandcamp.com page rather than bandcamp.com. */
  artistPage?: boolean;
}

export interface PlayerEnv {
  audio: AudioPort;
  /** Open bandcamp.com and <name>.bandcamp.com tabs. */
  bandcampTabs(): Promise<BandcampTab[]>;
  /** Sends a message to the content script of a tab and returns its answer. */
  sendToTab<T>(tabId: number, msg: ContentMessage): Promise<T>;
  /** Fetches JSON directly; resolves to undefined when the answer is not JSON (bot challenge, network). */
  fetchJson(url: string, body?: unknown): Promise<unknown>;
  /** Fetches a page's HTML directly; undefined when it is not available. */
  fetchText(url: string): Promise<string | undefined>;
  getCapture(tabId: number): Promise<Capture | undefined>;
  settings: {
    load(): Promise<Partial<Settings>>;
    save(s: Partial<Settings>): Promise<void>;
  };
  random?: () => number;
}

/** Everything needed to rebuild the player after its document was closed. */
export interface Snapshot {
  source: Source | null;
  items: Item[];
  cursor: string | null;
  exhausted: boolean;
  order: number[];
  pos: number;
  current: Current | null;
  trackWish: Record<number, boolean>;
  time: number;
}

/** Where the list comes from. Snapshots saved before 1.0.0 have no `kind`: discover. */
type Source =
  | { kind?: "discover"; label: string; pageUrl: string; params: DiscoverSpec["params"]; sig: string | null }
  | { kind: "artist"; label: string; pageUrl: string; bandId: number; sig: null }
  /** "You may also like" of the release at pageUrl. */
  | { kind: "recs"; label: string; pageUrl: string; sig: null };

interface Current {
  itemIndex: number;
  track: Track;
}

/** "first" / "last" track of a release, or a specific track id. */
type Pick = "first" | "last" | number;

/** Bandcamp's usual streaming limit, for releases whose limit is unknown. */
const DEFAULT_PLAY_LIMIT = 3;
const MAX_PLAYS = 2000;
const MAX_NUDGE_OFF = 500;

export class Player {
  private source: Source | null = null;
  private items: Item[] = [];
  private cursor: string | null = null;
  private exhausted = false;
  private order: number[] = [];
  private pos = -1;
  private current: Current | null = null;
  private mode: Mode = "track";
  private shuffle = false;
  private repeat = false;
  private artistOrder: ArtistOrder = "newest";
  private loading = false;
  private error: string | null = null;
  private notice: "login" | null = null;
  /** Bandcamp doesn't report wishlist state of single tracks, so we track our own changes. */
  private trackWish: Record<number, boolean> = {};
  /** Full plays per track, for the buy reminder; oldest first. */
  private plays: Record<string, number> = {};
  /** Releases whose buy reminder was closed. */
  private nudgeOff: string[] = [];

  /** Bumps on every play request, so stale async work can bail out. */
  private playGen = 0;
  private retried = false;
  /** Lyrics by track id; null when the track page has none. */
  private lyrics = new Map<number, string | null>();
  /** "You may also like" by release page url. */
  private recs = new Map<string, Recommendations>();
  private resumeAt = 0;
  private lastTick = 0;
  private listeners = new Set<(e: PlayerEvent) => void>();

  constructor(private env: PlayerEnv) {
    const a = env.audio;
    a.on("ended", () => void this.onEnded());
    a.on("play", () => this.broadcast());
    a.on("pause", () => this.broadcast());
    a.on("loadedmetadata", () => this.broadcast());
    a.on("timeupdate", () => {
      const now = Date.now();
      if (now - this.lastTick < 250) return;
      this.lastTick = now;
      this.emit({ type: "time", time: a.currentTime, duration: a.duration || 0 });
    });
    a.on("error", () => void this.onAudioError());
  }

  /** Recommendations always play whole releases; the user's own mode stays saved for other lists. */
  private get playMode(): Mode {
    return this.source?.kind === "recs" ? "album" : this.mode;
  }

  async init(snapshot?: Snapshot | null): Promise<void> {
    const s = await this.env.settings.load().catch(() => ({}) as Partial<Settings>);
    if (s.mode === "track" || s.mode === "album") this.mode = s.mode;
    if (typeof s.shuffle === "boolean") this.shuffle = s.shuffle;
    if (typeof s.repeat === "boolean") this.repeat = s.repeat;
    if (s.artistOrder === "newest" || s.artistOrder === "oldest") this.artistOrder = s.artistOrder;
    if (s.plays && typeof s.plays === "object") this.plays = s.plays;
    if (Array.isArray(s.nudgeOff)) this.nudgeOff = s.nudgeOff;
    if (snapshot) this.restore(snapshot);
  }

  subscribe(fn: (e: PlayerEvent) => void): () => void {
    this.listeners.add(fn);
    fn({ type: "state", state: this.publicState() });
    return () => this.listeners.delete(fn);
  }

  async handle(c: PlayerCommand): Promise<unknown> {
    try {
      switch (c.cmd) {
        case "loadFromTab": {
          const kept = await this.loadSourceFromTab(c.tabId);
          if (!kept && this.order.length) await this.playPos(0);
          return;
        }
        case "inspectTab":
          return this.inspectTab(c.tabId);
        case "togglePlay":
          return this.togglePlay();
        case "next":
          return this.next();
        case "prev":
          return this.prev();
        case "seek":
          if (this.env.audio.duration) this.env.audio.currentTime = c.fraction * this.env.audio.duration;
          return;
        case "playTrack":
          return this.playTrack(c.itemIndex, c.trackId);
        case "setShuffle":
          return this.setShuffle(c.on);
        case "setRepeat":
          this.repeat = c.on;
          void this.env.settings.save({ repeat: c.on });
          this.broadcast();
          return;
        case "setArtistOrder":
          return this.setArtistOrder(c.order);
        case "setMode":
          return this.setMode(c.mode);
        case "toggleWishlist":
          return this.toggleWishlist(c.itemIndex, c.trackId);
        case "dismissNotice":
          this.notice = null;
          this.broadcast();
          return;
        case "dismissNudge":
          return this.dismissNudge();
        case "loadMore":
          return this.fetchNextPage();
        case "getLyrics":
          return this.getLyrics(c.itemIndex, c.trackId);
        case "getRecs":
          return this.getRecs(c.url);
        case "playRecs":
          return this.playRecs(c.url, c.index);
      }
    } catch (e) {
      this.error = errorMessage(e);
      this.broadcast();
      throw e;
    }
  }

  private itemAt(index: number): Item {
    const item = this.items[index];
    if (!item) throw new Error(`No release at ${index}`);
    return item;
  }

  // ---------- network ----------

  /** Tries the API directly first; if Bandcamp answers with its bot challenge, retries through an open tab. */
  private async api<T>(url: string, body?: unknown): Promise<T> {
    const direct = await this.env.fetchJson(url, body).catch(() => undefined);
    if (direct !== undefined) return direct as T;
    const tabs = await this.bandcampComTabs();
    if (!tabs.length) throw new Error("Bandcamp is not reachable. Open any bandcamp.com page and try again.");
    // A tab that hasn't passed Bandcamp's bot check gets a page instead of JSON: try the others.
    let error: unknown;
    for (const tab of tabs) {
      try {
        return await this.env.sendToTab<T>(tab.id, { type: "apiFetch", url, method: body ? "POST" : "GET", body });
      } catch (e) {
        error = e;
      }
    }
    throw error;
  }

  /** bandcamp.com tabs, the active one first: API requests go to bandcamp.com, so an artist's subdomain won't do. */
  private async bandcampComTabs() {
    const tabs = (await this.env.bandcampTabs()).filter((t) => !t.artistPage);
    return [...tabs.filter((t) => t.active), ...tabs.filter((t) => !t.active)];
  }

  private async loadTracks(item: Item, force = false): Promise<Track[]> {
    if (item.tracks && !force) return item.tracks;
    const data = await this.api<TralbumDetails>(tralbumDetailsUrl(item));
    item.tracks = toTracks(data);
    if (item.year == null) item.year = releaseYear(data.release_date);
    // An artist's discography lists releases without these.
    if (data.bandcamp_url) item.url = data.bandcamp_url;
    if (!item.trackCount) item.trackCount = item.tracks.length;
    if (!item.featured) item.featured = item.tracks.find((t) => t.id === data.featured_track_id) ?? null;
    item.buy = toBuy(data, item.type === "t" ? "track" : "album");
    return item.tracks;
  }

  // ---------- discover results ----------

  private async fetchNextPage(): Promise<void> {
    const src = this.source;
    if (!src || (src.kind && src.kind !== "discover") || this.exhausted || this.loading) return;
    this.loading = true;
    this.broadcast();
    try {
      const data = await this.api<DiscoverResponse>(`${DISCOVER_URL}?${OWN_MARK}`, {
        ...src.params,
        cursor: this.cursor || "*",
        size: PAGE_SIZE,
      });
      const known = new Set(this.items.map((i) => i.id));
      const fresh = normalizeResults(data.results).map(toItem).filter((i) => !known.has(i.id));
      const start = this.items.length;
      this.items.push(...fresh);
      const added = range(start, this.items.length);
      this.order.push(...(this.shuffle ? shuffled(added, this.env.random) : added));
      this.cursor = data.cursor || null;
      this.exhausted = !data.cursor || fresh.length === 0;
      this.error = null;
    } catch (e) {
      this.error = errorMessage(e);
    } finally {
      this.loading = false;
      this.broadcast();
    }
  }

  /** What the tab shows: a discover page or an artist's page; null for anything else. */
  private async pageSpec(tabId: number): Promise<PageSpec | null> {
    const discover = await this.env.sendToTab<DiscoverSpec | null>(tabId, { type: "getDiscoverSpec" }).catch(() => null);
    if (discover) return { ...discover, kind: "discover" };
    return this.env.sendToTab<ArtistSpec | null>(tabId, { type: "getArtistSpec" }).catch(() => null);
  }

  private async inspectTab(tabId: number) {
    const spec = await this.pageSpec(tabId);
    if (!spec) return null;
    if (spec.kind === "artist") return { ...spec, sig: null };
    const cap = await this.env.getCapture(tabId);
    return { ...spec, sig: cap ? cap.sig : null };
  }

  /** Release order before shuffling: as discover sent them, or by date for an artist. */
  private baseOrder(): number[] {
    return this.source?.kind === "artist" ? byReleaseDate(this.items, this.artistOrder) : range(0, this.items.length);
  }

  /** Plays everything an artist (or label) has released, from band_details. */
  private async loadArtist(spec: ArtistSpec): Promise<void> {
    const data = await this.api<BandDetails>(BAND_DETAILS_URL, { band_id: spec.bandId });
    const items = toArtistItems(data, spec.pageUrl.replace(/\/music$/, ""));
    if (!items.length) throw new Error("This artist has no releases to play.");
    this.stop();
    this.source = { kind: "artist", label: spec.label, pageUrl: spec.pageUrl, bandId: spec.bandId, sig: null };
    this.items = items;
    this.cursor = null;
    this.exhausted = true;
    const base = this.baseOrder();
    this.order = this.shuffle ? shuffled(base, this.env.random) : base;
    this.pos = -1;
    this.current = null;
    this.error = null;
    this.broadcast();
  }

  private setArtistOrder(order: ArtistOrder): void {
    this.artistOrder = order;
    void this.env.settings.save({ artistOrder: order });
    if (this.source?.kind === "artist" && !this.shuffle) {
      this.order = this.baseOrder();
      this.pos = this.current ? this.order.indexOf(this.current.itemIndex) : -1;
    }
    this.broadcast();
  }

  /**
   * Takes the release list the tab is showing. When the same page was only
   * reloaded and music is playing, the current track keeps playing at the top
   * of the new list. Returns true in that case.
   */
  private async loadSourceFromTab(tabId: number): Promise<boolean> {
    const spec = await this.pageSpec(tabId);
    if (!spec) throw new Error("This is not a Bandcamp discover or artist page.");
    if (spec.kind === "artist") {
      await this.loadArtist(spec);
      return false;
    }
    const cap = await this.env.getCapture(tabId);
    const cur = this.current;
    const keep =
      cur && !this.env.audio.paused && this.source && this.source.pageUrl === spec.pageUrl
        ? (this.items[cur.itemIndex] ?? null)
        : null;
    if (!keep) this.stop();

    const fresh = cap ? cap.results.map(toItem) : [];
    const items = keep ? [keep, ...fresh.filter((i) => i.id !== keep.id)] : fresh;
    const rest = range(keep ? 1 : 0, items.length);
    this.source = { kind: "discover", label: spec.label, pageUrl: spec.pageUrl, params: cap ? cap.params : spec.params, sig: cap ? cap.sig : null };
    this.items = items;
    this.cursor = cap ? cap.cursor : null;
    this.exhausted = cap ? !cap.cursor : false;
    this.order = [...(keep ? [0] : []), ...(this.shuffle ? shuffled(rest, this.env.random) : rest)];
    this.pos = keep ? 0 : -1;
    this.current = keep && cur ? { itemIndex: 0, track: cur.track } : null;
    this.error = null;
    if (!items.length) await this.fetchNextPage();
    this.broadcast();
    return !!keep;
  }

  // ---------- playback ----------

  private async trackFor(item: Item, pick: Pick): Promise<Track | null> {
    if (this.playMode === "track" && item.featured && typeof pick !== "number") return item.featured;
    const tracks = await this.loadTracks(item);
    if (!tracks.length) return null;
    if (typeof pick === "number") return tracks.find((t) => t.id === pick) ?? tracks[0] ?? null;
    if (this.playMode === "track") return item.featured ?? tracks[0] ?? null;
    return (pick === "last" ? tracks[tracks.length - 1] : tracks[0]) ?? null;
  }

  private async playPos(pos: number, pick: Pick = "first", direction: 1 | -1 = 1): Promise<void> {
    const gen = ++this.playGen;
    // Skip releases that have nothing streamable, in the direction of travel.
    while (pos >= 0) {
      if (pos >= this.order.length - 2 && !this.exhausted) {
        await this.fetchNextPage();
        if (gen !== this.playGen) return;
      }
      if (pos >= this.order.length) break;
      const itemIndex = this.order[pos]!;
      let track: Track | null = null;
      try {
        track = await this.trackFor(this.itemAt(itemIndex), pick);
      } catch (e) {
        this.error = errorMessage(e);
      }
      if (gen !== this.playGen) return;
      if (track) {
        this.pos = pos;
        this.current = { itemIndex, track };
        this.startAudio(track.stream);
        // Discover's featured track says nothing about lyrics: the tracklist does.
        const item = this.itemAt(itemIndex);
        if (!item.tracks) this.loadTracks(item).then(() => this.broadcast(), () => {});
        return;
      }
      pos += direction;
      pick = direction > 0 ? "first" : "last";
    }
    // Ran off either end of the queue.
    this.env.audio.pause();
    this.broadcast();
  }

  private startAudio(src: string, at = 0): void {
    const a = this.env.audio;
    a.setSource(src);
    if (at) a.currentTime = at;
    this.retried = false;
    a.play().catch(() => {});
    this.broadcast();
  }

  /**
   * A track finished. With repeat on in full releases mode, the last track of a release
   * loops back to its first; otherwise (and for manual next/prev) playback moves on.
   */
  private async onEnded(): Promise<void> {
    const cur = this.current;
    if (cur) this.countPlay(cur.track.id);
    if (this.repeat && this.playMode === "album" && cur) {
      try {
        const tracks = await this.loadTracks(this.itemAt(cur.itemIndex));
        const idx = tracks.findIndex((t) => t.id === cur.track.id);
        if (idx >= 0 && idx === tracks.length - 1) return this.playTrack(cur.itemIndex, tracks[0]!.id);
      } catch {
        // fall through to the next track
      }
    }
    return this.next();
  }

  async next(): Promise<void> {
    const cur = this.current;
    if (this.playMode === "album" && cur) {
      try {
        const tracks = await this.loadTracks(this.itemAt(cur.itemIndex));
        const idx = tracks.findIndex((t) => t.id === cur.track.id);
        const following = idx >= 0 ? tracks[idx + 1] : undefined;
        if (following) return this.playTrack(cur.itemIndex, following.id);
      } catch {
        // fall through to the next release
      }
    }
    return this.playPos(this.pos + 1, "first", 1);
  }

  async prev(): Promise<void> {
    const a = this.env.audio;
    if (a.currentTime > 3) {
      a.currentTime = 0;
      return;
    }
    const cur = this.current;
    if (this.playMode === "album" && cur) {
      const tracks = this.itemAt(cur.itemIndex).tracks || [];
      const idx = tracks.findIndex((t) => t.id === cur.track.id);
      const previous = idx > 0 ? tracks[idx - 1] : undefined;
      if (previous) return this.playTrack(cur.itemIndex, previous.id);
    }
    if (this.pos <= 0) {
      a.currentTime = 0;
      return;
    }
    return this.playPos(this.pos - 1, "last", -1);
  }

  /**
   * Lyrics of a track, fetched from its page on Bandcamp. Never throws: a failure is
   * the answer's own business, not the player's error line.
   */
  private async getLyrics(itemIndex: number, trackId: number): Promise<LyricsResult> {
    if (this.lyrics.has(trackId)) return { text: this.lyrics.get(trackId)! };
    try {
      const tracks = await this.loadTracks(this.itemAt(itemIndex));
      const track = tracks.find((t) => t.id === trackId);
      if (!track?.hasLyrics || !isBandcampPage(track.url)) return { text: null };
      const html = await this.env.fetchText(track.url).catch(() => undefined);
      if (html === undefined) return { error: "Could not load the lyrics. Try again later." };
      const text = parseLyrics(html);
      this.lyrics.set(trackId, text);
      return { text };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ---------- you may also like ----------

  private async loadRecs(url: string): Promise<Recommendations> {
    const cached = this.recs.get(url);
    if (cached) return cached;
    if (!isBandcampPage(url)) throw new Error("Recommendations are only available for releases on bandcamp.com.");
    const html = await this.env.fetchText(url).catch(() => undefined);
    if (html === undefined) throw new Error("Could not load the recommendations. Try again later.");
    const recs = parseRecommendations(html);
    this.recs.set(url, recs);
    return recs;
  }

  /** The releases a release page recommends, for the popup to list. Never throws, like getLyrics. */
  private async getRecs(url: string): Promise<RecsResult> {
    try {
      const r = await this.loadRecs(url);
      return { title: r.title, items: r.items.map((it) => ({ title: it.title, artist: it.artist, url: it.url, thumb: artUrl(it.artId, 3) })) };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  /** Makes a release page's recommendations the list and plays the chosen one, in full. */
  private async playRecs(url: string, index: number): Promise<void> {
    const r = await this.loadRecs(url);
    if (!r.items.length) throw new Error("This release has no recommendations.");
    const from = this.items.find((it) => it.url === url);
    this.stop();
    this.source = { kind: "recs", label: from ? `like ${from.title}` : "you may also like", pageUrl: url, sig: null };
    // Copies: tracklists loaded while playing must not leak into the cached list.
    this.items = r.items.map((it) => ({ ...it, tracks: null }));
    this.cursor = null;
    this.exhausted = true;
    const base = this.baseOrder();
    const start = base[Math.min(Math.max(index, 0), base.length - 1)]!;
    this.order = this.shuffle ? [start, ...shuffled(base.filter((i) => i !== start), this.env.random)] : base;
    this.pos = -1;
    this.current = null;
    this.error = null;
    await this.playPos(this.order.indexOf(start));
  }

  /** Plays a specific track (or the default track) of a release from the list. */
  private playTrack(itemIndex: number, trackId?: number): Promise<void> | undefined {
    const pos = this.order.indexOf(itemIndex);
    if (pos < 0) return;
    return this.playPos(pos, trackId ?? "first", 1);
  }

  togglePlay(): void {
    const a = this.env.audio;
    if (!this.current) {
      if (this.order.length) void this.playPos(0);
      return;
    }
    // After a restore the element is empty: resume where we left off.
    if (!a.hasSource) {
      this.startAudio(this.current.track.stream, this.resumeAt);
      this.resumeAt = 0;
      return;
    }
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  private stop(): void {
    this.playGen++;
    this.env.audio.pause();
    this.env.audio.clear();
  }

  private setShuffle(on: boolean): void {
    this.shuffle = on;
    const all = range(0, this.items.length);
    const curIndex = this.current ? this.current.itemIndex : null;
    if (on) {
      const rest = shuffled(
        all.filter((i) => i !== curIndex),
        this.env.random,
      );
      this.order = curIndex != null ? [curIndex, ...rest] : rest;
      this.pos = curIndex != null ? 0 : -1;
    } else {
      this.order = this.baseOrder();
      this.pos = curIndex != null ? this.order.indexOf(curIndex) : -1;
    }
    void this.env.settings.save({ shuffle: on });
    this.broadcast();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    void this.env.settings.save({ mode });
    // Preload the tracklist of the current release so the queue can show it.
    if (mode === "album" && this.current) {
      this.loadTracks(this.itemAt(this.current.itemIndex)).then(
        () => this.broadcast(),
        () => {},
      );
    }
    this.broadcast();
  }

  /** Stream links expire after a while: refresh the tracklist once, then skip. */
  private async onAudioError(): Promise<void> {
    const cur = this.current;
    if (!cur || !this.env.audio.hasSource) return;
    if (!this.retried) {
      const gen = this.playGen;
      try {
        const tracks = await this.loadTracks(this.itemAt(cur.itemIndex), true);
        const fresh = tracks.find((t) => t.id === cur.track.id);
        if (fresh && gen === this.playGen) {
          cur.track = fresh;
          this.env.audio.setSource(fresh.stream);
          this.retried = true;
          this.env.audio.play().catch(() => {});
          return;
        }
      } catch {
        // skip below
      }
    }
    await this.next();
  }

  // ---------- buy reminder ----------

  /** A track played to its end. Only the latest MAX_PLAYS tracks are remembered. */
  private countPlay(trackId: number): void {
    const key = `t${trackId}`;
    const n = (this.plays[key] || 0) + 1;
    delete this.plays[key];
    this.plays[key] = n;
    const keys = Object.keys(this.plays);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PLAYS))) delete this.plays[k];
    void this.env.settings.save({ plays: this.plays });
  }

  /**
   * Once the release's most played track reaches the artist's limit of full plays: the
   * release to buy, or that track when only tracks are sold on their own.
   */
  private nudgeFor(item: Item, track: Track): { plays: number; url: string; free: boolean } | null {
    if (item.buy === undefined || item.owned || this.nudgeOff.includes(`${item.type}${item.id}`)) return null;
    const tracks = item.tracks ?? [track];
    let top = tracks[0];
    for (const t of tracks) if ((this.plays[`t${t.id}`] || 0) > (this.plays[`t${top!.id}`] || 0)) top = t;
    if (!top) return null;
    const plays = this.plays[`t${top.id}`] || 0;
    if (plays < (item.buy?.limit ?? DEFAULT_PLAY_LIMIT)) return null;
    if (item.buy) return { plays, url: item.url, free: item.buy.digital && item.buy.free };
    return top.buy && top.url ? { plays, url: top.url, free: false } : null;
  }

  /** The playing track of an album, when it is also sold on its own. */
  private trackBuyFor(item: Item, track: Track): (Buy & { url: string }) | null {
    if (item.type !== "a" || item.owned) return null;
    const t = item.tracks?.find((x) => x.id === track.id);
    return t?.buy && t.url ? { ...t.buy, url: t.url } : null;
  }

  private dismissNudge(): void {
    const cur = this.current;
    if (!cur) return;
    const item = this.itemAt(cur.itemIndex);
    this.nudgeOff = [...this.nudgeOff.filter((k) => k !== `${item.type}${item.id}`), `${item.type}${item.id}`].slice(-MAX_NUDGE_OFF);
    void this.env.settings.save({ nudgeOff: this.nudgeOff });
    this.broadcast();
  }

  // ---------- wishlist ----------

  /**
   * Toggles a release (no trackId) or a single track of it in the fan's wishlist:
   * a heart that is already set removes the item again. The request has to come
   * from a logged-in bandcamp.com page, so it goes through the content script.
   */
  private async toggleWishlist(itemIndex: number, trackId?: number): Promise<void> {
    const item = this.items[itemIndex];
    if (!item) return;
    const fan = await this.findFanTab();
    if (!fan) {
      this.notice = "login";
      this.broadcast();
      return;
    }
    const isTrack = trackId != null;
    const add = isTrack ? !this.trackWish[trackId] : !item.wishlisted;
    await this.env.sendToTab(fan.tabId, {
      type: "setWishlisted",
      add,
      bandId: item.bandId,
      fanId: fan.fanId,
      itemId: isTrack ? trackId : item.id,
      itemType: isTrack ? "t" : item.type,
    });
    if (isTrack) this.trackWish[trackId] = add;
    else item.wishlisted = add;
    this.error = null;
    this.notice = null;
    this.broadcast();
  }

  /** The first open Bandcamp tab with a logged-in fan; an artist's page works too. */
  private async findFanTab(): Promise<{ tabId: number; fanId: number } | null> {
    const tabs = await this.env.bandcampTabs();
    for (const tab of [...tabs.filter((t) => !t.artistPage), ...tabs.filter((t) => t.artistPage)]) {
      const fanId = await this.env.sendToTab<number | null>(tab.id, { type: "getFanId" }).catch(() => null);
      if (fanId) return { tabId: tab.id, fanId };
    }
    return null;
  }

  // ---------- state ----------

  snapshot(): Snapshot {
    return {
      source: this.source,
      items: this.items,
      cursor: this.cursor,
      exhausted: this.exhausted,
      order: this.order,
      pos: this.pos,
      current: this.current,
      trackWish: this.trackWish,
      time: this.env.audio.hasSource ? this.env.audio.currentTime : this.resumeAt,
    };
  }

  private restore(s: Snapshot): void {
    this.source = s.source;
    this.items = s.items;
    this.cursor = s.cursor;
    this.exhausted = s.exhausted;
    this.order = s.order;
    this.pos = s.pos;
    this.current = s.current;
    this.trackWish = s.trackWish || {};
    this.resumeAt = s.time || 0;
  }

  publicState(): PublicState {
    const a = this.env.audio;
    const cur = this.current;
    const curItem = cur ? this.items[cur.itemIndex] : null;
    const known = (t: Track) => curItem?.tracks?.find((x) => x.id === t.id) ?? t;
    const wish = (t: Track) => {
      const k = known(t);
      return { ...t, wishlisted: !!this.trackWish[t.id], hasLyrics: !!k.hasLyrics && isBandcampPage(k.url) };
    };
    return {
      source: this.source && { kind: this.source.kind ?? "discover", label: this.source.label, pageUrl: this.source.pageUrl, sig: this.source.sig },
      notice: this.notice,
      mode: this.playMode,
      shuffle: this.shuffle,
      repeat: this.repeat,
      artistOrder: this.artistOrder,
      loading: this.loading,
      error: this.error,
      hasMore: !this.exhausted,
      paused: a.paused,
      time: a.hasSource ? a.currentTime : this.resumeAt,
      duration: a.duration || cur?.track.duration || 0,
      pos: this.pos,
      current:
        cur && curItem
          ? {
              itemIndex: cur.itemIndex,
              track: wish(cur.track),
              release: {
                title: curItem.title,
                artist: curItem.artist,
                url: curItem.url,
                art: artUrl(curItem.artId, 2),
                year: curItem.year ?? null,
                hasRecs: isBandcampPage(curItem.url) && /\/(album|track)\//.test(curItem.url),
                wishlisted: curItem.wishlisted,
                owned: curItem.owned,
                tracks: curItem.tracks && curItem.tracks.map(wish),
                buy: curItem.owned ? null : curItem.buy,
                trackBuy: this.trackBuyFor(curItem, cur.track),
                nudge: this.nudgeFor(curItem, cur.track),
              },
            }
          : null,
      queue: this.order.map((i) => {
        const it = this.itemAt(i);
        return {
          index: i,
          title: it.title,
          artist: it.artist,
          url: it.url,
          thumb: artUrl(it.artId, 3),
          featured: it.featured?.title ?? null,
          duration: it.featured?.duration ?? null,
          trackCount: it.trackCount,
          year: it.year ?? null,
          wishlisted: it.wishlisted,
          owned: it.owned,
        };
      }),
    };
  }

  /** Metadata for the OS media controls. */
  nowPlaying(): { title: string; artist: string; album: string; art: string | null } | null {
    const cur = this.current;
    if (!cur) return null;
    const item = this.itemAt(cur.itemIndex);
    return { title: cur.track.title, artist: cur.track.artist || item.artist, album: item.title, art: artUrl(item.artId, 2) };
  }

  private broadcast(): void {
    this.emit({ type: "state", state: this.publicState() });
  }

  private emit(e: PlayerEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}
