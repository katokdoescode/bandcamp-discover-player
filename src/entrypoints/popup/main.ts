import { browser, type Browser } from "wxt/browser";
import { request } from "@/lib/messaging";
import type { DiscoverSpec, LyricsResult, PlayerCommand, PlayerEvent, PublicState } from "@/lib/types";
import { formatTime as fmt } from "@/lib/util";

type TabSpec = DiscoverSpec & { sig: string | null };
type Reply = { type: "reply"; reqId: number; result?: unknown; error?: string };
type Command = PlayerCommand extends infer C ? (C extends { cmd: infer K } ? Omit<C, "cmd"> & { cmd: K } : never) : never;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let port: Browser.runtime.Port | null = null;
let state: PublicState | null = null;
let tabSpec: TabSpec | null = null; // discover filters of the active tab, if it is a discover page
let activeTabId: number | null = null;
let queueKey = "";
let dragging = false;
let reqSeq = 0;
/** The track whose lyrics replace the queue; `follow` keeps it on the playing track. */
let lyricsView: { itemIndex: number; trackId: number; title: string; follow: boolean } | null = null;
let lyricsShown = ""; // itemIndex:trackId of the text on screen
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// The player may need starting first (Chrome's offscreen document), and Chrome
// closes that document after a while without sound: reconnect when that happens.
async function connect(): Promise<void> {
  await request("bg", "ensurePlayer").catch(() => {});
  port = browser.runtime.connect({ name: "popup" });
  port.onMessage.addListener(onPlayerMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const p of pending.values()) p.reject(new Error("Player restarted"));
    pending.clear();
    setTimeout(() => void connect(), 200);
  });
}

async function send<T = unknown>(c: Command): Promise<T> {
  if (!port) await connect();
  const reqId = ++reqSeq;
  port!.postMessage({ ...c, reqId });
  return new Promise<T>((resolve, reject) => pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject }));
}

function onPlayerMessage(msg: PlayerEvent | Reply): void {
  if (msg.type === "state") {
    state = msg.state;
    render();
  } else if (msg.type === "time") {
    if (!state) return;
    state.time = msg.time;
    if (msg.duration) state.duration = msg.duration;
    renderTime();
  } else if (msg.type === "reply") {
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }
}

// A discover tab loaded new results: re-check whether to offer them.
browser.runtime.onMessage.addListener((msg: any) => {
  if (msg?.to === "popup" && msg.type === "tabChanged" && msg.tabId === activeTabId) void inspectActiveTab();
  return false;
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- wishlist hearts ----------

function wishTitle(on: boolean, owned: boolean, what: string): string {
  if (owned) return `This ${what} is in your collection`;
  return on ? `Remove this ${what} from your wishlist` : `Add this ${what} to your wishlist`;
}

/** Sends a wishlist toggle; the button stays dimmed until the player replies. */
function toggleWish(btn: HTMLElement, itemIndex: number, trackId?: number): void {
  btn.classList.add("pending");
  send({ cmd: "toggleWishlist", itemIndex, trackId })
    .catch(() => {})
    .finally(() => btn.classList.remove("pending"));
}

function setWishState(btn: HTMLButtonElement, on: boolean, owned: boolean, what: string): void {
  btn.classList.toggle("on", on);
  btn.disabled = owned;
  btn.title = wishTitle(on, owned, what);
}

function wishButton(on: boolean, owned: boolean, what: string, itemIndex: number, trackId?: number): HTMLButtonElement {
  const b = el("button", "wish");
  setWishState(b, on, owned, what);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWish(b, itemIndex, trackId);
  });
  return b;
}

// ---------- rendering ----------

function render(): void {
  if (!state) return;
  const cur = state.current;

  $("source").textContent = state.source ? state.source.label : "";
  $("source").title = state.source ? state.source.pageUrl : "";

  // Offer the tab's list when it is a different page, or the same page showing
  // different releases since we loaded it (a reload of "surprise me").
  const samePage = !!tabSpec && !!state.source && state.source.pageUrl === tabSpec.pageUrl;
  const reloaded = samePage && !!tabSpec!.sig && tabSpec!.sig !== state.source!.sig;
  $("banner").hidden = !tabSpec || (samePage && !reloaded);
  if (tabSpec) $("bannerSpec").textContent = tabSpec.label;
  $("bannerLabel").textContent = reloaded ? "this page has new releases" : "this page";
  $("loadBtn").textContent = reloaded ? "update list" : "play this page";
  $<HTMLButtonElement>("loadBtn").disabled = state.loading;
  $("notice").hidden = state.notice !== "login";
  $("empty").hidden = !!state.source || !!tabSpec;

  $("now").hidden = !cur;
  $("options").hidden = !state.source;
  $("foot").hidden = !state.source;

  if (cur) {
    const rel = cur.release;
    $<HTMLImageElement>("art").src = rel.art || "";
    $<HTMLAnchorElement>("artLink").href = rel.url;
    $("relTitle").textContent = rel.title;
    $("relArtist").textContent = rel.artist;
    $<HTMLAnchorElement>("relArtist").href = rel.url;
    $("relYear").textContent = rel.year ? ` · ${rel.year}` : "";
    $("trackTitle").textContent = cur.track.title;
    $("trackTitle").title = cur.track.title;

    const relWish = $<HTMLButtonElement>("relWish");
    setWishState(relWish, rel.wishlisted, rel.owned, "release");
    relWish.querySelector(".label")!.textContent = rel.owned ? "In your collection" : rel.wishlisted ? "In Wishlist" : "Wishlist";
    setWishState($<HTMLButtonElement>("trackWish"), cur.track.wishlisted, false, "track");
    const lyricsBtn = $("lyricsBtn");
    lyricsBtn.hidden = !cur.track.hasLyrics;
    lyricsBtn.classList.toggle("on", !!lyricsView?.follow);
  }

  $("playBtn").classList.toggle("playing", !!cur && !state.paused);
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === state!.mode));
  $<HTMLInputElement>("shuffle").checked = state.shuffle;

  const status = $("status");
  status.hidden = !state.error && !(state.loading && !state.queue.length);
  status.classList.toggle("error", !!state.error);
  status.textContent = state.error || "loading releases…";

  $("count").textContent = state.queue.length ? `${state.queue.length} releases${state.hasMore ? "" : " · end of results"}` : "";
  const more = $<HTMLButtonElement>("moreBtn");
  more.hidden = !state.hasMore;
  more.disabled = state.loading;
  more.textContent = state.loading ? "loading…" : "load more";

  renderTime();
  renderQueue();
  renderLyrics();
}

function renderTime(): void {
  if (!state || !state.current) return;
  const dur = state.duration || state.current.track.duration || 0;
  $("timeElapsed").textContent = fmt(state.time);
  $("timeTotal").textContent = fmt(dur);
  if (!dragging) setProgress(dur ? state.time / dur : 0);
}

function setProgress(fraction: number): void {
  fraction = Math.max(0, Math.min(1, fraction));
  const max = $("progbar").clientWidth - $("thumb").offsetWidth;
  $("thumb").style.left = fraction * max + "px";
  $("progFill").style.width = fraction * 100 + "%";
}

function renderQueue(): void {
  const s = state!;
  const cur = s.current;
  const tracks = cur && s.mode === "album" ? cur.release.tracks : null;
  const key = [
    s.queue.length,
    s.queue[0]?.index,
    s.mode,
    cur?.itemIndex,
    cur?.track.id,
    tracks?.length,
    s.paused,
    s.queue.map((q) => (q.wishlisted ? 1 : 0)).join(""),
    tracks?.map((t) => (t.wishlisted ? 1 : 0)).join(""),
  ].join("|");
  if (key === queueKey) return;
  const firstRender = queueKey === "";
  queueKey = key;

  const list = $("queue");
  list.textContent = "";
  let currentRow: HTMLElement | null = null;

  s.queue.forEach((q, i) => {
    const li = el("li");
    const row = el("div", "row");
    const isCurrent = cur?.itemIndex === q.index;
    if (isCurrent) {
      row.classList.add("current");
      if (!s.paused) row.classList.add("playing");
      currentRow = row;
    }

    row.append(el("span", "play-col"));
    const img = el("img", "thumb-col");
    img.loading = "lazy";
    img.alt = "";
    if (q.thumb) img.src = q.thumb;
    row.append(img);

    const title = el("span", "title-col");
    title.append(el("span", "t", `${i + 1}. ${q.title}`));
    title.append(el("span", "a", s.mode === "track" && q.featured ? `${q.artist} — “${q.featured}”` : `by ${q.artist}`));
    row.append(title);

    const time = s.mode === "album" ? `${q.trackCount} ${q.trackCount === 1 ? "track" : "tracks"}` : q.duration ? fmt(q.duration) : "";
    const timeCol = el("span", "time", time);
    if (q.year) timeCol.append(el("span", "year", String(q.year)));
    row.append(timeCol);
    row.append(wishButton(q.wishlisted, q.owned, "release", q.index));

    row.addEventListener("click", () => void send(isCurrent ? { cmd: "togglePlay" } : { cmd: "playTrack", itemIndex: q.index }));
    li.append(row);

    if (isCurrent && tracks?.length) {
      const subList = el("ol", "subtracks");
      for (const t of tracks) {
        const sub = el("li", "subtrack" + (t.id === cur!.track.id ? " current" : ""));
        const lyricsLink = el("span");
        if (t.hasLyrics) {
          lyricsLink.className = "link lyrics-link" + (lyricsView && !lyricsView.follow && lyricsView.trackId === t.id ? " on" : "");
          lyricsLink.textContent = "lyrics";
          lyricsLink.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleLyrics({ itemIndex: q.index, trackId: t.id, title: t.title, follow: false });
          });
        }
        sub.append(
          el("span", "num", `${t.num}.`),
          el("span", "name", t.title),
          lyricsLink,
          el("span", "time", fmt(t.duration)),
          wishButton(t.wishlisted, false, "track", q.index, t.id),
        );
        sub.addEventListener("click", () => void send({ cmd: "playTrack", itemIndex: q.index, trackId: t.id }));
        subList.append(sub);
      }
      li.append(subList);
    }
    list.append(li);
  });

  if (currentRow) revealInList(list, currentRow, firstRender);
}

// ---------- lyrics ----------

function toggleLyrics(v: NonNullable<typeof lyricsView>): void {
  const same = lyricsView && lyricsView.follow === v.follow && (v.follow || lyricsView.trackId === v.trackId);
  lyricsView = same ? null : v;
  queueKey = ""; // redraw the lyrics links' state
  render();
}

/** Shows the lyrics in place of the queue, fetching them from the player when the track changes. */
function renderLyrics(): void {
  const s = state!;
  const cur = s.current;
  if (lyricsView?.follow && cur && (cur.itemIndex !== lyricsView.itemIndex || cur.track.id !== lyricsView.trackId)) {
    lyricsView = { itemIndex: cur.itemIndex, trackId: cur.track.id, title: cur.track.title, follow: true };
  }
  const open = !!lyricsView && !!s.source;
  $("lyricsView").hidden = !open;
  $("queue").hidden = open;
  if (open) $("foot").hidden = true;
  if (!open) {
    lyricsShown = "";
    return;
  }

  const v = lyricsView!;
  const key = `${v.itemIndex}:${v.trackId}`;
  $("lyricsTitle").textContent = v.title;
  if (key === lyricsShown) return;
  lyricsShown = key;
  const box = $("lyricsText");
  const show = (text: string, muted = false) => {
    if (lyricsShown !== key) return; // the view moved on while this was loading
    box.textContent = text;
    box.classList.toggle("muted", muted);
  };
  show("loading lyrics…", true);
  $("lyricsView").scrollTop = 0;
  // A failure stays on screen; closing and reopening the lyrics tries again.
  send<LyricsResult>({ cmd: "getLyrics", itemIndex: v.itemIndex, trackId: v.trackId }).then(
    (r) => ("error" in r ? show(r.error, true) : show(r.text ?? "No lyrics for this track.", !r.text)),
    (e: unknown) => show(e instanceof Error ? e.message : String(e), true),
  );
}

/** Scrolls only the queue (scrollIntoView would also scroll the whole popup and hide its header). */
function revealInList(list: HTMLElement, row: HTMLElement, center: boolean): void {
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (center) list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
  else if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

// ---------- controls ----------

$("playBtn").addEventListener("click", () => void send({ cmd: "togglePlay" }));
$("nextBtn").addEventListener("click", () => void send({ cmd: "next" }));
$("prevBtn").addEventListener("click", () => void send({ cmd: "prev" }));
$("moreBtn").addEventListener("click", () => void send({ cmd: "loadMore" }));
$("noticeClose").addEventListener("click", () => void send({ cmd: "dismissNotice" }));
$("relWish").addEventListener("click", (e) => {
  if (state?.current) toggleWish(e.currentTarget as HTMLElement, state.current.itemIndex);
});
$("lyricsBtn").addEventListener("click", () => {
  const cur = state?.current;
  if (cur) toggleLyrics({ itemIndex: cur.itemIndex, trackId: cur.track.id, title: cur.track.title, follow: true });
});
$("lyricsBack").addEventListener("click", () => toggleLyrics(lyricsView!));
$("trackWish").addEventListener("click", (e) => {
  if (state?.current) toggleWish(e.currentTarget as HTMLElement, state.current.itemIndex, state.current.track.id);
});
$<HTMLInputElement>("shuffle").addEventListener("change", (e) => void send({ cmd: "setShuffle", on: (e.target as HTMLInputElement).checked }));
document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
  t.addEventListener("click", () => void send({ cmd: "setMode", mode: t.dataset.mode === "album" ? "album" : "track" })),
);

$("loadBtn").addEventListener("click", () => {
  if (activeTabId == null) return;
  $<HTMLButtonElement>("loadBtn").disabled = true;
  // errors are shown through the player state
  send({ cmd: "loadFromTab", tabId: activeTabId }).catch(() => {});
});

function fractionAt(ev: MouseEvent): number {
  const rect = $("progbar").getBoundingClientRect();
  const half = $("thumb").offsetWidth / 2;
  return (ev.clientX - rect.left - half) / (rect.width - half * 2);
}

$("progbar").addEventListener("mousedown", (ev) => {
  if (!state?.current) return;
  dragging = true;
  setProgress(fractionAt(ev));
  const move = (e: MouseEvent) => setProgress(fractionAt(e));
  const up = (e: MouseEvent) => {
    dragging = false;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    void send({ cmd: "seek", fraction: Math.max(0, Math.min(1, fractionAt(e))) });
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

document.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    void send({ cmd: "togglePlay" });
  } else if (e.code === "ArrowRight" && e.shiftKey) void send({ cmd: "next" });
  else if (e.code === "ArrowLeft" && e.shiftKey) void send({ cmd: "prev" });
});

// ---------- active tab ----------

async function inspectActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null && /^https?:\/\/bandcamp\.com\/discover/.test(tab.url || "")) {
    activeTabId = tab.id;
    tabSpec = await send<TabSpec | null>({ cmd: "inspectTab", tabId: tab.id }).catch(() => null);
  }
  render();
}

void connect().then(inspectActiveTab);
