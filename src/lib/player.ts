// The player: queue, play order, release/track modes, shuffle, paging of
// discover results and the wishlist. Everything browser-specific (audio, tabs,
// storage) comes in through PlayerEnv, so the same code runs in Firefox's
// background page, in Chrome's offscreen document and in unit tests.

import { DISCOVER_URL, OWN_MARK, PAGE_SIZE, artUrl, normalizeResults, toItem, toTracks, tralbumDetailsUrl } from "./bandcamp";
import type {
  Capture,
  ContentMessage,
  DiscoverResponse,
  DiscoverSpec,
  Item,
  Mode,
  PlayerCommand,
  PlayerEvent,
  PublicState,
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

export interface PlayerEnv {
  audio: AudioPort;
  /** Open bandcamp.com tabs. */
  bandcampTabs(): Promise<{ id: number; active?: boolean }[]>;
  /** Sends a message to the content script of a tab and returns its answer. */
  sendToTab<T>(tabId: number, msg: ContentMessage): Promise<T>;
  /** Fetches JSON directly; resolves to undefined when the answer is not JSON (bot challenge, network). */
  fetchJson(url: string, body?: unknown): Promise<unknown>;
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

interface Source {
  label: string;
  pageUrl: string;
  params: DiscoverSpec["params"];
  sig: string | null;
}

interface Current {
  itemIndex: number;
  track: Track;
}

/** "first" / "last" track of a release, or a specific track id. */
type Pick = "first" | "last" | number;

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
  private loading = false;
  private error: string | null = null;
  private notice: "login" | null = null;
  /** Bandcamp doesn't report wishlist state of single tracks, so we track our own changes. */
  private trackWish: Record<number, boolean> = {};

  /** Bumps on every play request, so stale async work can bail out. */
  private playGen = 0;
  private retried = false;
  private resumeAt = 0;
  private lastTick = 0;
  private listeners = new Set<(e: PlayerEvent) => void>();

  constructor(private env: PlayerEnv) {
    const a = env.audio;
    a.on("ended", () => void this.next());
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

  async init(snapshot?: Snapshot | null): Promise<void> {
    const s = await this.env.settings.load().catch(() => ({}) as Partial<Settings>);
    if (s.mode === "track" || s.mode === "album") this.mode = s.mode;
    if (typeof s.shuffle === "boolean") this.shuffle = s.shuffle;
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
        case "setMode":
          return this.setMode(c.mode);
        case "toggleWishlist":
          return this.toggleWishlist(c.itemIndex, c.trackId);
        case "dismissNotice":
          this.notice = null;
          this.broadcast();
          return;
        case "loadMore":
          return this.fetchNextPage();
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
    const tab = await this.findBandcampTab();
    if (!tab) throw new Error("Bandcamp is not reachable. Open any bandcamp.com page and try again.");
    return this.env.sendToTab<T>(tab.id, { type: "apiFetch", url, method: body ? "POST" : "GET", body });
  }

  private async findBandcampTab() {
    const tabs = await this.env.bandcampTabs();
    return tabs.find((t) => t.active) || tabs[0] || null;
  }

  private async loadTracks(item: Item, force = false): Promise<Track[]> {
    if (item.tracks && !force) return item.tracks;
    item.tracks = toTracks(await this.api(tralbumDetailsUrl(item)));
    return item.tracks;
  }

  // ---------- discover results ----------

  private async fetchNextPage(): Promise<void> {
    if (!this.source || this.exhausted || this.loading) return;
    this.loading = true;
    this.broadcast();
    try {
      const data = await this.api<DiscoverResponse>(`${DISCOVER_URL}?${OWN_MARK}`, {
        ...this.source.params,
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

  private async inspectTab(tabId: number) {
    const spec = await this.env.sendToTab<DiscoverSpec | null>(tabId, { type: "getDiscoverSpec" }).catch(() => null);
    if (!spec) return null;
    const cap = await this.env.getCapture(tabId);
    return { ...spec, sig: cap ? cap.sig : null };
  }

  /**
   * Takes the release list the tab is showing. When the same page was only
   * reloaded and music is playing, the current track keeps playing at the top
   * of the new list. Returns true in that case.
   */
  private async loadSourceFromTab(tabId: number): Promise<boolean> {
    const spec = await this.env.sendToTab<DiscoverSpec | null>(tabId, { type: "getDiscoverSpec" });
    if (!spec) throw new Error("This is not a Bandcamp discover page.");
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
    this.source = { label: spec.label, pageUrl: spec.pageUrl, params: cap ? cap.params : spec.params, sig: cap ? cap.sig : null };
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
    if (this.mode === "track" && item.featured && typeof pick !== "number") return item.featured;
    const tracks = await this.loadTracks(item);
    if (!tracks.length) return null;
    if (typeof pick === "number") return tracks.find((t) => t.id === pick) ?? tracks[0] ?? null;
    if (this.mode === "track") return item.featured ?? tracks[0] ?? null;
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

  async next(): Promise<void> {
    const cur = this.current;
    if (this.mode === "album" && cur) {
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
    if (this.mode === "album" && cur) {
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
      this.order = all;
      this.pos = curIndex ?? -1;
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

  /** The first open bandcamp.com tab with a logged-in fan. */
  private async findFanTab(): Promise<{ tabId: number; fanId: number } | null> {
    for (const tab of await this.env.bandcampTabs()) {
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
    const wish = (t: Track) => ({ ...t, wishlisted: !!this.trackWish[t.id] });
    return {
      source: this.source && { label: this.source.label, pageUrl: this.source.pageUrl, sig: this.source.sig },
      notice: this.notice,
      mode: this.mode,
      shuffle: this.shuffle,
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
                wishlisted: curItem.wishlisted,
                owned: curItem.owned,
                tracks: curItem.tracks && curItem.tracks.map(wish),
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
