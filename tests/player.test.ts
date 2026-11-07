import { describe, expect, it, vi } from "vitest";
import { OWN_MARK } from "@/lib/bandcamp";
import { Player } from "@/lib/player";
import { ARTIST, artistApi, capture, defaultApi, details, disco, recsPage, result, setup, trackPage, trackUrl } from "./fixtures";

const TAB = 7;
const playing = (audio: { src: string }) => audio.src;

describe("loading a discover page", () => {
  it("plays the releases the tab has loaded, starting with the first featured track", async () => {
    const { player, audio, view } = await setup({ capture: capture([1, 2, 3]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    expect(view().queue.map((q) => q.title)).toEqual(["Release 1", "Release 2", "Release 3"]);
    expect(view().source).toMatchObject({ label: "punk · digital", sig: "1,2,3" });
    expect(playing(audio)).toBe("https://stream/10");
    expect(audio.paused).toBe(false);
  });

  it("strips the discover tracking parameter from release links", async () => {
    const { player, view } = await setup({ capture: capture([1]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().queue[0]!.url).toBe("https://band1.bandcamp.com/album/r1");
  });

  it("asks the API itself when the page's own results were not seen", async () => {
    const { player, apiCalls, view } = await setup({
      api: (url) => (url.includes("discover_web") ? { results: [result(4), result(5)], cursor: null } : undefined),
    });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    const call = apiCalls.find((c) => c.url.includes("discover_web"))!;
    expect(call.url).toContain(OWN_MARK);
    expect(call.body).toMatchObject({ tag_norm_names: ["punk"], slice: "rand", cursor: "*" });
    expect(view().queue.map((q) => q.index)).toEqual([0, 1]);
  });

  it("goes through an open bandcamp.com tab when the API answers with the bot challenge", async () => {
    const { player, sent, view } = await setup({
      api: () => undefined,
      proxy: (url) => (url.includes("discover_web") ? { results: [result(4)], cursor: null } : undefined),
    });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    expect(sent.some((m) => m.type === "apiFetch")).toBe(true);
    expect(view().queue).toHaveLength(1);
  });

  it("tries the other bandcamp.com tabs when one gets the bot check too", async () => {
    const { player, view } = await setup({
      tabs: [
        { id: 5, active: true },
        { id: 6, active: false, artistPage: true },
        { id: 7, active: false },
      ],
      api: () => undefined,
      proxy: (url, _body, tabId) => {
        if (tabId !== 7) throw new Error("Bandcamp is checking that you're not a bot.");
        return url.includes("discover_web") ? { results: [result(4)], cursor: null } : undefined;
      },
    });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().queue).toHaveLength(1);
  });

  it("shows the release year in the queue and for the current release", async () => {
    const c = capture([1, 2]);
    c.results[0]!.release_date = "2024-02-09 00:00:00 UTC";
    const { player, view } = await setup({ capture: c });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    expect(view().queue.map((q) => q.year)).toEqual([2024, null]);
    expect(view().current!.release.year).toBe(2024);
  });

  it("refuses pages that are neither discover nor artist pages", async () => {
    const { player } = await setup({ spec: null });
    await expect(player.handle({ cmd: "loadFromTab", tabId: TAB })).rejects.toThrow("not a Bandcamp discover or artist page");
  });

  it("reports the tab's filters and which list it shows", async () => {
    const { player } = await setup({ capture: capture([1, 2]) });
    await expect(player.handle({ cmd: "inspectTab", tabId: TAB })).resolves.toMatchObject({ label: "punk · digital", sig: "1,2" });
  });
});

describe("one track per release", () => {
  it("moves to the next release's featured track", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2, 3]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "next" });
    expect(playing(audio)).toBe("https://stream/20");
  });

  it("advances when a track ends", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    audio.fire("ended");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/20"));
  });

  it("restarts the track when it has played for a while, otherwise goes back", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "next" });

    audio.currentTime = 30;
    await player.handle({ cmd: "prev" });
    expect(playing(audio)).toBe("https://stream/20");
    expect(audio.currentTime).toBe(0);

    await player.handle({ cmd: "prev" });
    expect(playing(audio)).toBe("https://stream/10");
  });

  it("stops at the end of the results", async () => {
    const { player, audio, view } = await setup({ capture: capture([1]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "next" });
    expect(audio.paused).toBe(true);
    expect(view().hasMore).toBe(false);
  });
});

describe("full releases", () => {
  it("plays every track of a release, then the next release", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    const heard = [playing(audio)];
    for (let i = 0; i < 3; i++) {
      await player.handle({ cmd: "next" });
      heard.push(playing(audio));
    }
    expect(heard).toEqual(["https://stream/10?fresh=0", "https://stream/11?fresh=0", "https://stream/12?fresh=0", "https://stream/20?fresh=0"]);
  });

  it("takes the year from the tracklist when discover did not give one", async () => {
    const base = defaultApi();
    const api = (url: string) => {
      const d = base(url);
      return url.includes("tralbum_id=1&") ? { ...(d as object), release_date: 1793318400 } : d;
    };
    const { player, view } = await setup({ capture: capture([1, 2]), api });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().current!.release.year).toBe(2026);
  });

  it("goes back to the previous track, and to the last track of the previous release", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "playTrack", itemIndex: 1, trackId: 21 });

    await player.handle({ cmd: "prev" });
    expect(playing(audio)).toBe("https://stream/20?fresh=0");
    await player.handle({ cmd: "prev" });
    expect(playing(audio)).toBe("https://stream/12?fresh=0");
  });

  it("continues with the rest of the release after switching from one-track mode", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB }); // featured track 10 = first track
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "next" });
    expect(playing(audio)).toBe("https://stream/11?fresh=0");
  });

  it("shows the tracklist of the current release", async () => {
    const { player, view } = await setup({ capture: capture([1]) });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().current!.release.tracks!.map((t) => t.title)).toEqual(["Track 1.1", "Track 1.2", "Track 1.3"]);
  });

  it("skips releases with nothing to stream", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2, 3]), silent: [2] });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "playTrack", itemIndex: 0, trackId: 12 });
    await player.handle({ cmd: "next" });
    expect(playing(audio)).toBe("https://stream/30?fresh=0");
  });

  it("remembers the mode", async () => {
    const { player, settings } = await setup();
    await player.handle({ cmd: "setMode", mode: "album" });
    expect(settings.mode).toBe("album");
  });
});

describe("repeat release (beta)", () => {
  async function albumWithRepeat() {
    const ctx = await setup({ capture: capture([1, 2]) });
    await ctx.player.handle({ cmd: "setMode", mode: "album" });
    await ctx.player.handle({ cmd: "setRepeat", on: true });
    await ctx.player.handle({ cmd: "loadFromTab", tabId: TAB });
    await ctx.player.handle({ cmd: "playTrack", itemIndex: 0, trackId: 12 });
    return ctx;
  }

  it("loops back to the first track when the release's last track ends", async () => {
    const { audio, view } = await albumWithRepeat();
    audio.fire("ended");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/10?fresh=0"));
    expect(view().repeat).toBe(true);
  });

  it("moves on through the tracks before the last one as usual", async () => {
    const { player, audio } = await albumWithRepeat();
    await player.handle({ cmd: "playTrack", itemIndex: 0, trackId: 10 });
    audio.fire("ended");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/11?fresh=0"));
  });

  it("lets next leave the loop for the next release", async () => {
    const { player, audio } = await albumWithRepeat();
    await player.handle({ cmd: "next" });
    expect(playing(audio)).toBe("https://stream/20?fresh=0");
  });

  it("has no effect in one track per release mode", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "setRepeat", on: true });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    audio.fire("ended");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/20"));
  });

  it("is remembered between sessions", async () => {
    const { player, settings } = await setup();
    await player.handle({ cmd: "setRepeat", on: true });
    expect(settings.repeat).toBe(true);
    const next = await setup({ settings: { repeat: true } });
    expect(next.view().repeat).toBe(true);
  });
});

describe("lyrics", () => {
  const pages = { [trackUrl(11)]: trackPage("line one\nline two") };

  it("loads a track's lyrics from its page once", async () => {
    const { player, pageCalls } = await setup({ capture: capture([1]), lyrics: [11], pages });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await expect(player.handle({ cmd: "getLyrics", itemIndex: 0, trackId: 11 })).resolves.toEqual({ text: "line one\nline two" });
    await player.handle({ cmd: "getLyrics", itemIndex: 0, trackId: 11 });
    expect(pageCalls).toEqual([trackUrl(11)]);
  });

  it("does not ask for tracks without lyrics", async () => {
    const { player, pageCalls } = await setup({ capture: capture([1]), lyrics: [11], pages });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await expect(player.handle({ cmd: "getLyrics", itemIndex: 0, trackId: 10 })).resolves.toEqual({ text: null });
    expect(pageCalls).toEqual([]);
  });

  it("reports a page that could not be loaded, and tries again next time", async () => {
    const { player, pageCalls, view } = await setup({ capture: capture([1]), lyrics: [11], pages: {} });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await expect(player.handle({ cmd: "getLyrics", itemIndex: 0, trackId: 11 })).resolves.toEqual({ error: expect.stringContaining("Could not load the lyrics") });
    expect(view().error).toBeNull(); // not the player's error line
    await player.handle({ cmd: "getLyrics", itemIndex: 0, trackId: 11 });
    expect(pageCalls).toHaveLength(2);
  });

  it("learns whether the featured track has lyrics from the release's tracklist", async () => {
    const c = capture([1]);
    c.results[0]!.featured_track!.id = 11;
    const { player, view } = await setup({ capture: c, lyrics: [11], pages });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.track.hasLyrics).toBe(true));
  });

  it("marks the tracks with lyrics in a release played in full", async () => {
    const { player, view } = await setup({ capture: capture([1]), lyrics: [11], pages });
    await player.handle({ cmd: "setMode", mode: "album" });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().current!.release.tracks!.map((t) => t.hasLyrics)).toEqual([false, true, false]);
  });
});

describe("an artist's releases", () => {
  const discography = [
    disco(1, "05 Mar 2021 00:00:00 GMT"),
    disco(2, "30 Oct 2026 00:00:00 GMT"),
    disco(3, null),
    disco(4, "16 Mar 2019 00:00:00 GMT", { item_type: "track", artist_name: "Guest" }),
  ];
  const artistSetup = (o: Parameters<typeof setup>[0] = {}) => setup({ spec: null, artist: ARTIST, api: artistApi(discography), ...o });

  it("plays the whole discography, newest first, undated last", async () => {
    const { player, view, audio } = await artistSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().source).toMatchObject({ kind: "artist", label: "Some Band", pageUrl: ARTIST.pageUrl });
    expect(view().queue.map((q) => q.title)).toEqual(["Release 2", "Release 1", "Release 4", "Release 3"]);
    expect(view().queue[2]).toMatchObject({ artist: "Guest", year: 2019 });
    // Featured track and the release's own link come with its tracklist.
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/21?fresh=0"));
    expect(view().current!.release.url).toBe("https://someband.bandcamp.com/album/r2");
    expect(view().hasMore).toBe(false);
  });

  it("can play oldest first, and re-sorts without interrupting the current track", async () => {
    const { player, view, audio, settings } = await artistSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "next" }); // Release 1
    const before = playing(audio);
    await player.handle({ cmd: "setArtistOrder", order: "oldest" });
    expect(settings.artistOrder).toBe("oldest");
    expect(view().queue.map((q) => q.title)).toEqual(["Release 4", "Release 1", "Release 2", "Release 3"]);
    expect(playing(audio)).toBe(before);
    await player.handle({ cmd: "next" });
    expect(view().current!.release.title).toBe("Release 2");
  });

  it("starts with the saved order", async () => {
    const { player, view } = await artistSetup({ settings: { artistOrder: "oldest" } });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().queue[0]!.title).toBe("Release 4");
  });

  it("never asks discover for more", async () => {
    const { player, apiCalls } = await artistSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "loadMore" });
    for (let i = 0; i < 4; i++) await player.handle({ cmd: "next" });
    expect(apiCalls.some((c) => c.url.includes("discover_web"))).toBe(false);
  });

  it("goes back to date order when shuffle is turned off", async () => {
    const { player, view } = await artistSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "setShuffle", on: true });
    await player.handle({ cmd: "setShuffle", on: false });
    expect(view().queue.map((q) => q.title)).toEqual(["Release 2", "Release 1", "Release 4", "Release 3"]);
    expect(view().pos).toBe(0);
  });

  it("is offered on artist pages", async () => {
    const { player } = await artistSetup();
    await expect(player.handle({ cmd: "inspectTab", tabId: TAB })).resolves.toMatchObject({ kind: "artist", label: "Some Band", sig: null });
  });
});

describe("you may also like", () => {
  const REL = "https://band1.bandcamp.com/album/r1";
  const recsSetup = (o: Parameters<typeof setup>[0] = {}) =>
    setup({ capture: capture([1, 2]), pages: { [REL]: recsPage([3, 4, 5]) }, ...o });

  it("offers the playing release's recommendations", async () => {
    const { player, view, pageCalls } = await recsSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().current!.release.hasRecs).toBe(true);
    const r = (await player.handle({ cmd: "getRecs", url: REL })) as any;
    expect(r.title).toBe("If you like DICKWEED, you may also like:");
    expect(r.items.map((i: any) => i.title)).toEqual(["Release 3 & Friends", "Release 4 & Friends", "Release 5 & Friends"]);
    await player.handle({ cmd: "getRecs", url: REL });
    expect(pageCalls).toEqual([REL]); // cached
  });

  it("plays them in full, from the chosen one, whatever the saved mode", async () => {
    const { player, view, audio, settings } = await recsSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "playRecs", url: REL, index: 1 });
    expect(view().source).toMatchObject({ kind: "recs", label: "like Release 1", pageUrl: REL });
    expect(view().mode).toBe("album");
    expect(settings.mode).toBeUndefined(); // the user's own mode is untouched
    expect(playing(audio)).toBe("https://stream/40?fresh=0");
    await player.handle({ cmd: "next" });
    expect(playing(audio)).toBe("https://stream/41?fresh=0");
    expect(view().queue.map((q) => q.title)).toEqual(["Release 3 & Friends", "Release 4 & Friends", "Release 5 & Friends"]);
  });

  it("never asks discover for more", async () => {
    const { player, apiCalls, view } = await recsSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    const before = apiCalls.filter((c) => c.url.includes("discover_web")).length;
    await player.handle({ cmd: "playRecs", url: REL, index: 2 });
    await player.handle({ cmd: "loadMore" });
    expect(apiCalls.filter((c) => c.url.includes("discover_web")).length).toBe(before);
    expect(view().hasMore).toBe(false);
  });

  it("goes back to the saved mode for the next discover list", async () => {
    const { player, view } = await recsSetup();
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "playRecs", url: REL, index: 0 });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().mode).toBe("track");
  });

  it("reports a page that could not be loaded without touching the player's error line", async () => {
    const { player, view } = await recsSetup({ pages: {} });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await expect(player.handle({ cmd: "getRecs", url: REL })).resolves.toEqual({ error: expect.stringContaining("Could not load") });
    expect(view().error).toBeNull();
  });
});

describe("shuffle", () => {
  it("keeps the current release first and shuffles the rest", async () => {
    const { player, view, settings } = await setup({ capture: capture([1, 2, 3]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "playTrack", itemIndex: 1 });
    await player.handle({ cmd: "setShuffle", on: true });

    expect(view().queue[0]!.index).toBe(1);
    expect(view().queue.map((q) => q.index).sort()).toEqual([0, 1, 2]);
    expect(settings.shuffle).toBe(true);
  });

  it("restores page order when turned off", async () => {
    const { player, view } = await setup({ capture: capture([1, 2, 3]) });
    await player.handle({ cmd: "setShuffle", on: true });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "setShuffle", on: false });
    expect(view().queue.map((q) => q.index)).toEqual([0, 1, 2]);
  });
});

describe("more results", () => {
  it("loads the next page of the same list when the queue runs low", async () => {
    const { player, apiCalls, view } = await setup({
      capture: capture([1, 2], "cursor-1"),
      api: (url) => (url.includes("discover_web") ? { results: [result(3), result(4)], cursor: null } : undefined),
    });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    const call = apiCalls.find((c) => c.url.includes("discover_web"))!;
    expect(call.body).toMatchObject({ cursor: "cursor-1", slice: "rand" });
    expect(view().queue.map((q) => q.title)).toEqual(["Release 1", "Release 2", "Release 3", "Release 4"]);
    expect(view().hasMore).toBe(false);
  });

  it("drops releases it already has", async () => {
    const { player, view } = await setup({
      capture: capture([1, 2], "cursor-1"),
      api: (url) => (url.includes("discover_web") ? { results: [result(2), result(3)], cursor: "cursor-2" } : undefined),
    });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().queue.map((q) => q.title)).toEqual(["Release 1", "Release 2", "Release 3"]);
  });
});

describe("reloading the page", () => {
  it("keeps the current track playing and queues the new releases after it", async () => {
    const env = await setup({ capture: capture([1, 2]) });
    await env.player.handle({ cmd: "loadFromTab", tabId: TAB });
    await env.player.handle({ cmd: "next" });

    env.state.capture = capture([5, 6, 2]);
    await env.player.handle({ cmd: "loadFromTab", tabId: TAB });

    expect(playing(env.audio)).toBe("https://stream/20");
    expect(env.view().queue.map((q) => q.title)).toEqual(["Release 2", "Release 5", "Release 6"]);
    expect(env.view().source!.sig).toBe("5,6,2");
  });

  it("starts the new list from the top when nothing is playing", async () => {
    const env = await setup({ capture: capture([1, 2]) });
    await env.player.handle({ cmd: "loadFromTab", tabId: TAB });
    env.audio.pause();

    env.state.capture = capture([5, 6]);
    await env.player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(playing(env.audio)).toBe("https://stream/50");
  });
});

describe("expired stream links", () => {
  it("refreshes the link once, then skips to the next track", async () => {
    const { player, audio } = await setup({ capture: capture([1, 2]) });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    audio.fire("error");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/10?fresh=0"));

    audio.fire("error");
    await vi.waitFor(() => expect(playing(audio)).toBe("https://stream/20"));
  });
});

describe("wishlist", () => {
  it("asks to log in when no bandcamp.com tab has a logged-in fan", async () => {
    const { player, view, sent } = await setup({ capture: capture([1]), fanId: null });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "toggleWishlist", itemIndex: 0 });

    expect(view().notice).toBe("login");
    expect(sent.some((m) => m.type === "setWishlisted")).toBe(false);

    await player.handle({ cmd: "dismissNotice" });
    expect(view().notice).toBeNull();
  });

  it("adds a release, and removes it on the second click", async () => {
    const { player, view, sent } = await setup({ capture: capture([1]), fanId: 42 });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });

    await player.handle({ cmd: "toggleWishlist", itemIndex: 0 });
    expect(view().queue[0]!.wishlisted).toBe(true);
    await player.handle({ cmd: "toggleWishlist", itemIndex: 0 });
    expect(view().queue[0]!.wishlisted).toBe(false);

    const calls = sent.filter((m) => m.type === "setWishlisted");
    expect(calls).toEqual([
      { type: "setWishlisted", add: true, bandId: 1001, fanId: 42, itemId: 1, itemType: "a" },
      { type: "setWishlisted", add: false, bandId: 1001, fanId: 42, itemId: 1, itemType: "a" },
    ]);
  });

  it("wishlists from an artist's page when no bandcamp.com tab is open", async () => {
    const { player, view, wishTabs } = await setup({ capture: capture([1]), fanId: 42, tabs: [{ id: 9, active: true, artistPage: true }] });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "toggleWishlist", itemIndex: 0 });

    expect(view().notice).toBeNull();
    expect(view().queue[0]!.wishlisted).toBe(true);
    expect(wishTabs).toEqual([9]);
  });

  it("prefers a bandcamp.com tab for the wishlist", async () => {
    const tabs = [
      { id: 9, active: true, artistPage: true },
      { id: 7, active: false },
    ];
    const { player, wishTabs } = await setup({ capture: capture([1]), fanId: 42, tabs });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "toggleWishlist", itemIndex: 0 });
    expect(wishTabs).toEqual([7]);
  });

  it("wishlists single tracks as tracks", async () => {
    const { player, view, sent } = await setup({ capture: capture([1]), fanId: 42 });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await player.handle({ cmd: "toggleWishlist", itemIndex: 0, trackId: 10 });

    expect(sent.at(-1)).toMatchObject({ type: "setWishlisted", add: true, itemId: 10, itemType: "t" });
    expect(view().current!.track.wishlisted).toBe(true);
  });

  it("shows what Bandcamp already reports as wishlisted", async () => {
    const cap = capture([1]);
    cap.results[0]!.is_wishlisted = true;
    const { player, view } = await setup({ capture: cap });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    expect(view().queue[0]!.wishlisted).toBe(true);
  });
});

describe("buying", () => {
  /** tralbum_details of a release sold for $7 that allows `limit` full plays. */
  const soldApi = (limit: number | null = 3) => {
    const api = defaultApi();
    return (url: string, body?: unknown) => {
      const d = api(url) as Record<string, unknown> | undefined;
      return d && "tracks" in d ? { ...d, is_purchasable: true, is_set_price: true, price: 7, currency: "USD", streaming_limit: limit } : d;
    };
  };

  it("shows the price once the tracklist is in", async () => {
    const { player, view } = await setup({ capture: capture([1]), api: soldApi() });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.release.buy).toMatchObject({ price: 7, currency: "USD" }));
  });

  it("asks to buy after the artist's limit of full plays, until closed", async () => {
    const { player, audio, view, settings } = await setup({ capture: capture([1]), api: soldApi(), settings: { plays: { t10: 2 } } });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.release.buy).toBeTruthy());
    expect(view().current!.release.nudge).toBeNull();

    // A track played to its end counts.
    audio.fire("ended");
    await vi.waitFor(() => expect(view().current!.release.nudge).toMatchObject({ plays: 3, free: false }));
    expect(settings.plays).toEqual({ t10: 3 });

    await player.handle({ cmd: "dismissNudge" });
    expect(view().current!.release.nudge).toBeNull();
    expect(settings.nudgeOff).toEqual(["a1"]);
  });

  it("uses Bandcamp's usual limit of 3 when the release has none", async () => {
    const { player, view } = await setup({ capture: capture([1]), api: soldApi(null), settings: { plays: { t10: 3 } } });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.release.nudge).toMatchObject({ plays: 3, free: false }));
  });

  it("offers a track of an album that is sold on its own", async () => {
    const api = defaultApi();
    const tracksOnly = (url: string) => {
      const d = api(url) as ReturnType<typeof details> | undefined;
      if (!d || !("tracks" in d)) return d;
      Object.assign(d.tracks[0]!, { is_purchasable: true, is_set_price: true, price: 1, currency: "USD" });
      return { ...d, is_purchasable: false };
    };
    const { player, view } = await setup({ capture: capture([1]), api: tracksOnly, settings: { plays: { t10: 3 } } });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.release.tracks).toBeTruthy());

    expect(view().current!.release.buy).toBeNull();
    expect(view().current!.release.trackBuy).toMatchObject({ what: "track", price: 1, url: trackUrl(10) });
    // Only the track can be bought, so the reminder points to it.
    expect(view().current!.release.nudge).toEqual({ plays: 3, url: trackUrl(10), free: false });
  });

  it("doesn't ask for releases that can't be bought", async () => {
    const { player, view } = await setup({ capture: capture([1]), settings: { plays: { t10: 9 } } });
    await player.handle({ cmd: "loadFromTab", tabId: TAB });
    await vi.waitFor(() => expect(view().current!.release.tracks).toBeTruthy());
    expect(view().current!.release.buy).toBeNull();
    expect(view().current!.release.nudge).toBeNull();
  });
});

describe("snapshots", () => {
  it("resumes the same track at the same moment in a new player", async () => {
    const first = await setup({ capture: capture([1, 2]) });
    await first.player.handle({ cmd: "loadFromTab", tabId: TAB });
    await first.player.handle({ cmd: "next" });
    first.audio.currentTime = 42;
    const snap = structuredClone(first.player.snapshot());

    const second = await setup();
    const restored = new Player({ ...(second.player as any).env });
    await restored.init(snap);
    expect(restored.publicState().current!.track.title).toBe("Featured 2");
    expect(restored.publicState().time).toBe(42);

    restored.togglePlay();
    expect(second.audio.src).toBe("https://stream/20");
    expect(second.audio.currentTime).toBe(42);
  });
});
