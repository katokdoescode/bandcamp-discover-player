import { describe, expect, it } from "vitest";
import { artUrl, isBandcampPage, parseRecommendations, isPageDiscoverRequest, parseLyrics, normalizeResults, releaseYear, toItem, toTracks } from "@/lib/bandcamp";
import { applyDiscoverResponse } from "@/lib/captures";
import { parseDiscoverSpec } from "@/lib/discover-spec";
import { AUTO_LOAD_MARGIN, formatTime, range, shouldAutoLoad, shuffled } from "@/lib/util";
import { capture, details, recsPage, result, trackPage } from "./fixtures";

describe("parseDiscoverSpec", () => {
  it("builds the same request body as the discover page", () => {
    const spec = parseDiscoverSpec("https://bandcamp.com/discover/punk+hardcore-punk/digital?s=rand", null);
    expect(spec!.params).toEqual({
      category_id: 1,
      tag_norm_names: ["punk", "hardcore-punk"],
      geoname_id: 0,
      slice: "rand",
      time_facet_id: null,
      include_result_types: ["a", "s"],
      followed_bands: false,
    });
    expect(spec!.label).toBe("punk / hardcore punk · digital");
  });

  it("reads format-only pages, location, time and extra tags", () => {
    expect(parseDiscoverSpec("https://bandcamp.com/discover/vinyl", null)!.params).toMatchObject({
      category_id: 2,
      tag_norm_names: [],
      slice: "top",
    });
    const spec = parseDiscoverSpec("https://bandcamp.com/discover/metal/cassette?s=new&loc=2950159&t=this-week&tags=doom,sludge&fb=1", null);
    expect(spec!.params).toMatchObject({
      category_id: 4,
      tag_norm_names: ["metal", "doom", "sludge"],
      geoname_id: 2950159,
      slice: "new",
      time_facet_id: 1,
      followed_bands: true,
    });
    expect(spec!.label).toBe("metal / doom / sludge · cassette");
  });

  it("uses the page's own labels when available", () => {
    const spec = parseDiscoverSpec("https://bandcamp.com/discover/r-b-soul", {
      genres: [{ id: 21, slug: "r-b-soul", label: "r&b/soul" }],
    });
    expect(spec!.label).toBe("r&b/soul");
  });

  it("says 'all genres' for the bare discover page and ignores other pages", () => {
    expect(parseDiscoverSpec("https://bandcamp.com/discover", null)!.label).toBe("all genres");
    expect(parseDiscoverSpec("https://bandcamp.com/tag/punk", null)).toBeNull();
  });
});

describe("applyDiscoverResponse", () => {
  const body = (cursor: string | null) => ({ category_id: 1, tag_norm_names: ["punk"], slice: "rand", cursor, size: 24 });
  const page = (ids: number[], cursor: string | null) => ({ results: ids.map((id) => result(id)), cursor });

  it("starts a new list on cursor '*' and remembers its params without paging fields", () => {
    const cap = applyDiscoverResponse(undefined, body("*"), page([1, 2], "c1"))!;
    expect(cap.sig).toBe("1,2");
    expect(cap.cursor).toBe("c1");
    expect(cap.params).toEqual({ category_id: 1, tag_norm_names: ["punk"], slice: "rand" });
  });

  it("appends 'view more results' pages to the same list", () => {
    const first = applyDiscoverResponse(undefined, body("*"), page([1, 2], "c1"));
    const more = applyDiscoverResponse(first, body("c1"), page([3], null))!;
    expect(more.results.map((r) => r.item_id)).toEqual([1, 2, 3]);
    expect(more.sig).toBe("1,2");
    expect(more.cursor).toBeNull();
  });

  it("replaces the list on reload", () => {
    const first = applyDiscoverResponse(undefined, body("*"), page([1, 2], "c1"));
    const reloaded = applyDiscoverResponse(first, body("*"), page([7, 8], "c9"))!;
    expect(reloaded.results.map((r) => r.item_id)).toEqual([7, 8]);
    expect(reloaded.sig).toBe("7,8");
  });

  it("ignores later pages of a list it never saw start, and malformed pairs", () => {
    expect(applyDiscoverResponse(undefined, body("c1"), page([3], null))).toBeUndefined();
    const prev = capture([1]);
    expect(applyDiscoverResponse(prev, null, page([3], null))).toBe(prev);
    expect(applyDiscoverResponse(prev, body("*"), { error: true })).toBe(prev);
  });
});

describe("bandcamp helpers", () => {
  it("recognises the page's discover requests but not our own", () => {
    expect(isPageDiscoverRequest("/api/discover/1/discover_web")).toBe(true);
    expect(isPageDiscoverRequest("https://bandcamp.com/api/discover/1/discover_web?via=discover-player")).toBe(false);
    expect(isPageDiscoverRequest("/api/design_system/1/menubar")).toBe(false);
  });

  it("builds zero-padded art urls", () => {
    expect(artUrl(848761897, 2)).toBe("https://f4.bcbits.com/img/a0848761897_2.jpg");
    expect(artUrl(null, 2)).toBeNull();
  });

  it("converts results and drops featured tracks without a stream", () => {
    const item = toItem(result(1, { album_artist: "Someone", featured_track: null }));
    expect(item).toMatchObject({ id: 1, type: "a", artist: "Someone", artId: 5001, featured: null });
  });

  it("reads the release year in every date format Bandcamp uses", () => {
    expect(releaseYear("2026-10-30 00:00:00 UTC")).toBe(2026);
    expect(releaseYear("30 Oct 1998 00:00:00 GMT")).toBe(1998);
    expect(releaseYear(1793318400)).toBe(2026);
    expect(releaseYear(undefined)).toBeNull();
    expect(releaseYear("")).toBeNull();
    expect(releaseYear(0)).toBeNull();
  });

  it("takes the year from discover results", () => {
    expect(toItem(result(1, { release_date: "2019-05-03 00:00:00 UTC" })).year).toBe(2019);
    expect(toItem(result(1)).year).toBeNull();
  });

  it("reads the camelCase results Bandcamp sends since November 2026", () => {
    const camel = {
      itemId: 7,
      itemType: "a",
      title: "Computer Metal",
      itemUrl: "https://mbr.bandcamp.com/album/computer-metal?from=discover_page",
      albumArtist: null,
      bandName: "MASTER BOOT RECORD",
      bandId: 99,
      primaryImage: { imageId: 2829643149, isArt: true },
      trackCount: 10,
      isWishlisted: null,
      isOwned: null,
      featuredTrack: { id: 70, title: "Command Prompt", bandName: "MASTER BOOT RECORD", streamUrl: "https://stream/70", duration: 333 },
    };
    const [r] = normalizeResults([camel]);
    expect(toItem(r!)).toMatchObject({
      id: 7,
      artist: "MASTER BOOT RECORD",
      url: "https://mbr.bandcamp.com/album/computer-metal",
      artId: 2829643149,
      trackCount: 10,
      featured: { id: 70, stream: "https://stream/70", duration: 333 },
    });
    expect(normalizeResults([result(1)])[0]).toEqual(result(1));
    expect(normalizeResults(undefined)).toEqual([]);
  });

  it("reads lyrics from a track page", () => {
    const text = "I invented a taste\nWhy did you miss it? \"Rock & roll\" <3";
    expect(parseLyrics(trackPage(text))).toBe(text);
    // Without ld+json, the data-tralbum attribute has the same text, HTML-escaped.
    const noLd = trackPage(text).replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    expect(parseLyrics(noLd)).toBe(text);
    expect(parseLyrics(trackPage("  \r\n "))).toBeNull();
    expect(parseLyrics("<html>Client Challenge</html>")).toBeNull();
  });

  it("fetches lyrics only from Bandcamp's own domains", () => {
    expect(isBandcampPage("https://twistedteens.bandcamp.com/track/why")).toBe(true);
    expect(isBandcampPage("https://music.someband.com/track/why")).toBe(false);
    expect(isBandcampPage("https://evilbandcamp.com/track/why")).toBe(false);
    expect(isBandcampPage(undefined)).toBe(false);
  });

  it("keeps lyrics flags and track pages from the tracklist", () => {
    const tracks = toTracks(details(1, 3, [11]));
    expect(tracks.map((t) => t.hasLyrics)).toEqual([false, true, false]);
    expect(tracks[1]!.url).toBe("https://band1.bandcamp.com/track/t11");
  });

  it("reads the recommendations of a release page", () => {
    const r = parseRecommendations(recsPage([3, 4]));
    expect(r.title).toBe("If you like DICKWEED, you may also like:");
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      id: 3,
      type: "a",
      title: "Release 3 & Friends",
      artist: "Band 3",
      bandId: 1003,
      url: "https://band3.bandcamp.com/album/r3",
      artId: 5003,
      tracks: null,
    });
    expect(parseRecommendations("<html>no section</html>")).toEqual({ title: null, items: [] });
  });

  it("keeps only streamable tracks", () => {
    const d = details(1);
    d.tracks[1]!.is_streamable = false;
    expect(toTracks(d).map((t) => t.id)).toEqual([10, 12]);
  });
});

describe("util", () => {
  it("formats times like Bandcamp", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(174.6)).toBe("02:54");
    expect(formatTime(NaN)).toBe("00:00");
  });

  it("auto-loads only near the end of the queue, when more exist and nothing failed", () => {
    const ok = { hasMore: true, loading: false, error: null };
    const near = { scrollTop: 1000 - 300 - AUTO_LOAD_MARGIN, scrollHeight: 1000, clientHeight: 300 };
    const far = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
    const short = { scrollTop: 0, scrollHeight: 200, clientHeight: 300 };
    expect(shouldAutoLoad(ok, near)).toBe(true);
    expect(shouldAutoLoad(ok, short)).toBe(true);
    expect(shouldAutoLoad(ok, far)).toBe(false);
    expect(shouldAutoLoad({ ...ok, hasMore: false }, near)).toBe(false);
    expect(shouldAutoLoad({ ...ok, loading: true }, near)).toBe(false);
    expect(shouldAutoLoad({ ...ok, error: "offline" }, near)).toBe(false);
  });

  it("shuffles without losing items", () => {
    expect(shuffled(range(0, 10)).sort((a, b) => a - b)).toEqual(range(0, 10));
  });
});
