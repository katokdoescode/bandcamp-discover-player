// Live checks that Bandcamp still serves what the extension reads. Each test runs the
// extension's own parsers on real answers, so a failure names what changed.
// Run with `npm run test:live`; the weekly workflow turns failures into an issue.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BAND_DETAILS_URL,
  DISCOVER_URL,
  OWN_MARK,
  isBandcampPage,
  isPageDiscoverRequest,
  normalizeResults,
  parseLyrics,
  parseRecommendations,
  toArtistItems,
  toBuy,
  toItem,
  toTracks,
  tralbumDetailsUrl,
} from "@/lib/bandcamp";
import { applyDiscoverResponse } from "@/lib/captures";
import { readArtistSpec, readDiscoverSpec } from "@/lib/page";
import type { DiscoverSpec, Item } from "@/lib/types";
import { api, missingPaths, openSession, toDocument, visit, type Session } from "./session";

// Releases that are known to exist. If one disappears, pick another with the same traits.
const DISCOVER_PAGE = "https://bandcamp.com/discover/metal";
/** High Reeper: an artist with several releases, one of them a standalone track. */
const ARTIST = { page: "https://highreeper.bandcamp.com/music", bandId: 3406059544 };
const SINGLE_TRACK = { bandId: 3406059544, id: 2420947794, type: "t" as const };
/** A track with lyrics. */
const LYRICS_PAGE = "https://anginedepoitrine.bandcamp.com/track/sherpa-2";

let s: Session;
let spec: DiscoverSpec | null = null;
let items: Item[] = [];

const listMissing = (what: string, missing: string[]) =>
  expect(missing, `${what} no longer has: ${missing.join(", ")}`).toEqual([]);

beforeAll(async () => {
  s = await openSession();
});

afterAll(async () => {
  await s?.browser.close();
});

describe("discover page", () => {
  let pageRequest: { url: string; type: string; body: unknown; data: unknown } | null = null;

  it("loads its results with discover_web through fetch, which the extension reads", async () => {
    s.page.on("response", async (res) => {
      const req = res.request();
      if (pageRequest || req.method() !== "POST" || !isPageDiscoverRequest(req.url())) return;
      pageRequest = { url: req.url(), type: req.resourceType(), body: req.postDataJSON(), data: await res.json().catch(() => null) };
    });
    const html = await visit(s.page, DISCOVER_PAGE);
    await expect.poll(() => pageRequest, { timeout: 20_000, message: "the page made no discover_web request" }).not.toBeNull();

    // Chrome reads it by wrapping window.fetch; an XHR would slip past.
    expect(pageRequest!.type, "the page no longer uses fetch for discover_web").toBe("fetch");
    const capture = applyDiscoverResponse(undefined, pageRequest!.body, pageRequest!.data);
    expect(capture?.results.length, "the page's discover_web answer has no results the extension can read").toBeGreaterThan(0);

    const doc = toDocument(html, DISCOVER_PAGE);
    expect(doc.getElementById("DiscoverApp"), "#DiscoverApp (filters, fan id, wishlist crumbs) is gone").not.toBeNull();
    const blob = JSON.parse(doc.getElementById("DiscoverApp")!.dataset.blob || "null");
    listMissing("#DiscoverApp's data-blob", missingPaths(blob, ["appData.initialState.genres[]", "pageContext"]));
    spec = readDiscoverSpec(doc, DISCOVER_PAGE);
    expect(spec?.params.tag_norm_names, "the page's filters can't be read").toEqual(["metal"]);
  });

  it("answers the extension's own discover_web request", async () => {
    expect(spec, "needs the discover page's filters").not.toBeNull();
    const data = await api(s.page, `${DISCOVER_URL}?${OWN_MARK}`, { ...spec!.params, cursor: "*", size: 20 });
    listMissing("discover_web", missingPaths(data, ["results[]", "cursor"]));
    const results = normalizeResults(data.results);
    listMissing(
      "discover_web results",
      missingPaths({ results }, [
        "results[].item_id",
        "results[].item_type",
        "results[].title",
        "results[].band_name",
        "results[].band_id",
        "results[].item_url",
        "results[].primary_image.image_id",
        "results[].featured_track.id",
        "results[].featured_track.stream_url",
        "results[].featured_track.duration",
        "results[].release_date",
      ]),
    );
    items = results.map(toItem);
    const playable = items.filter((i) => i.featured?.stream.startsWith("https://") && i.featured.duration > 0);
    expect(playable.length, "no result has a playable featured track").toBeGreaterThan(0);
    expect(items.every((i) => i.id > 0 && i.bandId > 0 && isBandcampPage(i.url)), "results lack ids or release links").toBe(true);
    expect(items.some((i) => i.year), "no result has a release date").toBe(true);
  });
});

describe("releases", () => {
  it("tralbum_details gives an album's tracklist, streams and price", async () => {
    const album = items.find((i) => i.type === "a");
    expect(album, "needs an album from discover").toBeTruthy();
    const data = await api(s.page, tralbumDetailsUrl(album!));
    listMissing(
      "tralbum_details",
      missingPaths(data, [
        "bandcamp_url",
        "release_date",
        "featured_track_id",
        "is_purchasable",
        "price",
        "currency",
        "is_set_price",
        "streaming_limit",
        "tracks[].track_id",
        "tracks[].track_num",
        "tracks[].title",
        "tracks[].duration",
        "tracks[].is_streamable",
        "tracks[].streaming_url.mp3-128",
        "tracks[].has_lyrics",
        "tracks[].track_url",
        "tracks[].is_purchasable",
      ]),
    );
    const tracks = toTracks(data);
    expect(tracks.length, "no streamable tracks").toBeGreaterThan(0);
    expect(tracks.every((t) => t.stream.startsWith("https://") && t.duration > 0 && t.num)).toBe(true);
    expect(isBandcampPage(data.bandcamp_url), "bandcamp_url is not a release page").toBe(true);

    // The stream itself plays: an mp3 behind the link.
    const res = await s.context.request.get(tracks[0]!.stream, { headers: { Range: "bytes=0-1023" } });
    expect([200, 206], `stream link answered HTTP ${res.status()}`).toContain(res.status());
    expect(res.headers()["content-type"], "stream link is not audio").toMatch(/audio|mpeg|octet-stream/);
  });

  it("tralbum_details of a standalone track: one track and its price", async () => {
    const data = await api(s.page, tralbumDetailsUrl(SINGLE_TRACK));
    expect(data.tracks, `test track ${SINGLE_TRACK.id} is gone; pick another standalone track`).toBeTruthy();
    const tracks = toTracks(data);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.num, "track number fallback broke").toBe(1);
    const buy = toBuy(data, "track");
    expect(buy, "the price of a track can't be read").not.toBeNull();
    expect(typeof buy!.price).toBe("number");
    expect(buy!.currency).toMatch(/^[A-Z]{3}$/);
  });
});

describe("artist pages", () => {
  it("an artist's page names its band", async () => {
    const html = await visit(s.page, ARTIST.page);
    const artist = readArtistSpec(toDocument(html, ARTIST.page), ARTIST.page);
    expect(artist?.bandId, "data-band on artist pages can't be read").toBe(ARTIST.bandId);
  });

  it("band_details lists the discography", async () => {
    await visit(s.page, "https://bandcamp.com/");
    const data = await api(s.page, BAND_DETAILS_URL, { band_id: ARTIST.bandId });
    listMissing(
      "band_details",
      missingPaths(data, ["discography[].item_id", "discography[].item_type", "discography[].title", "discography[].band_id", "discography[].release_date"]),
    );
    const releases = toArtistItems(data, "https://highreeper.bandcamp.com");
    expect(releases.length, "discography is empty").toBeGreaterThanOrEqual(3);
    expect(releases.some((r) => r.released && r.year), "release dates can't be read").toBe(true);
    expect(releases.some((r) => r.type === "t" && r.trackCount === 1), "standalone tracks are not marked as tracks").toBe(true);
  });
});

describe("release pages", () => {
  it('"you may also like" is in the page', async () => {
    const album = items.find((i) => i.type === "a" && isBandcampPage(i.url));
    expect(album, "needs an album from discover").toBeTruthy();
    const recs = parseRecommendations(await visit(s.page, album!.url));
    expect(recs.items.length, `no recommendations read from ${album!.url}`).toBeGreaterThan(0);
    expect(recs.items.every((r) => r.id > 0 && r.bandId > 0 && isBandcampPage(r.url))).toBe(true);
  });

  it("lyrics are in the track page", async () => {
    const lyrics = parseLyrics(await visit(s.page, LYRICS_PAGE));
    expect(lyrics, `no lyrics read from ${LYRICS_PAGE}`).toBeTruthy();
  });
});
