// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HOOK_SOURCE, installDiscoverHook } from "@/lib/hook";
import { BOT_CHECK, apiFetch, readArtistSpec, readCrumbs, readDiscoverSpec, readFanId, setWishlisted } from "@/lib/page";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("discover hook", () => {
  function fakeWindow(response: Response) {
    const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
    const win = { fetch: original, postMessage: vi.fn(), location: { origin: "https://bandcamp.com" } };
    installDiscoverHook(win as unknown as Window);
    return { win: win as unknown as Window & { postMessage: ReturnType<typeof vi.fn> }, original };
  }

  it("passes the page's discover responses on and leaves them readable for the page", async () => {
    const data = { results: [{ item_id: 1 }], cursor: "c1" };
    const { win, original } = fakeWindow(json(data));
    const body = { tag_norm_names: ["punk"], cursor: "*" };

    const res = await win.fetch("/api/discover/1/discover_web", { method: "POST", body: JSON.stringify(body) });
    expect(await res.json()).toEqual(data);
    expect(original).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(win.postMessage).toHaveBeenCalledWith({ source: HOOK_SOURCE, body, data }, "https://bandcamp.com"),
    );
  });

  it("ignores other requests and the extension's own", async () => {
    const { win } = fakeWindow(json({ results: [] }));
    await win.fetch("/api/design_system/1/menubar", { method: "POST", body: "{}" });
    await win.fetch("https://bandcamp.com/api/discover/1/discover_web?via=discover-player", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 10));
    expect(win.postMessage).not.toHaveBeenCalled();
  });
});

describe("page data", () => {
  function page(html: string) {
    document.body.innerHTML = html;
    return document;
  }
  const blob = (v: unknown) => JSON.stringify(v).replace(/"/g, "&quot;");

  it("reads the fan id from the discover app or from older pages", () => {
    expect(readFanId(page(`<div id="DiscoverApp" data-blob="${blob({ pageContext: { identity: { fanId: 42 } } })}"></div>`))).toBe(42);
    expect(readFanId(page(`<div id="pagedata" data-blob="${blob({ identities: { fan: { id: 7 } } })}"></div>`))).toBe(7);
    expect(readFanId(page(`<div id="DiscoverApp" data-blob="${blob({ pageContext: { identity: { fanId: null } } })}"></div>`))).toBeNull();
  });

  it("labels the page with the discover app's own names", () => {
    const doc = page(
      `<div id="DiscoverApp" data-blob="${blob({ appData: { initialState: { customTags: [{ id: 9, slug: "hardcore-punk", label: "hardcore punk" }] } } })}"></div>`,
    );
    expect(readDiscoverSpec(doc, "https://bandcamp.com/discover/hardcore-punk")!.label).toBe("hardcore punk");
  });

  it("reads wishlist crumbs", () => {
    expect(readCrumbs(page(`<div id="js-crumbs-data" data-crumbs="${blob({ collect_item_cb: "abc" })}"></div>`))).toEqual({
      collect_item_cb: "abc",
    });
    expect(readCrumbs(page(""))).toEqual({});
  });

  it("reads wishlist crumbs of the discover page from its blob", () => {
    const html = `<div id="DiscoverApp" data-blob="${blob({ pageContext: { crumbs: { collect_item_cb: "d1", uncollect_item_cb: "d2" } } })}"></div>`;
    expect(readCrumbs(page(html))).toEqual({ collect_item_cb: "d1", uncollect_item_cb: "d2" });
  });
});

describe("setWishlisted", () => {
  const req = { add: true, bandId: 1, fanId: 2, itemId: 3, itemType: "a" as const };

  it("posts the same form as the site's wishlist button", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true }));
    await setWishlisted(fetch, "https://bandcamp.com", { collect_item_cb: "crumb-1" }, req);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://bandcamp.com/collect_item_cb");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      band_id: "1",
      fan_id: "2",
      item_id: "3",
      item_type: "a",
      crumb: "crumb-1",
    });
  });

  it("uses uncollect_item_cb to remove", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ ok: true }));
    await setWishlisted(fetch, "https://bandcamp.com", {}, { ...req, add: false });
    expect(fetch.mock.calls[0]![0]).toBe("https://bandcamp.com/uncollect_item_cb");
  });

  it("retries with the fresh crumb the server hands back", async () => {
    const fetch = vi
      .fn(async (_url: string, _init: RequestInit) => json({ ok: true }))
      .mockResolvedValueOnce(json({ error: "invalid_crumb", crumb: "fresh" }, 403));
    const crumbs: Record<string, string> = {};
    await setWishlisted(fetch, "https://bandcamp.com", crumbs, req);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(String(fetch.mock.calls[1]![1].body)).get("crumb")).toBe("fresh");
    expect(crumbs.collect_item_cb).toBe("fresh");
  });

  it("reports server errors", async () => {
    const fetch = vi.fn(async () => json({ error: true, error_message: "not logged in" }));
    await expect(setWishlisted(fetch, "https://bandcamp.com", {}, req)).rejects.toThrow("not logged in");
  });
});

describe("artist pages", () => {
  function page(band: unknown) {
    const doc = document.implementation.createHTMLDocument("x");
    const el = doc.createElement("div");
    el.setAttribute("data-band", JSON.stringify(band));
    doc.body.append(el);
    return doc;
  }

  it("reads the band from any of the artist's pages, with one page url for all of them", () => {
    const doc = page({ id: 1127011076, name: "Twisted Teens", subdomain: "twistedteens" });
    for (const href of ["https://twistedteens.bandcamp.com/", "https://twistedteens.bandcamp.com/album/florida-water-blues"]) {
      expect(readArtistSpec(doc, href)).toEqual({
        kind: "artist",
        pageUrl: "https://twistedteens.bandcamp.com/music",
        label: "Twisted Teens",
        bandId: 1127011076,
      });
    }
  });

  it("ignores bandcamp.com itself and pages without a band", () => {
    expect(readArtistSpec(page({ id: 1, name: "x" }), "https://bandcamp.com/discover/punk")).toBeNull();
    expect(readArtistSpec(document.implementation.createHTMLDocument("x"), "https://daily.bandcamp.com/")).toBeNull();
  });
});

describe("apiFetch", () => {
  it("explains Bandcamp's bot check instead of failing to parse it", async () => {
    const page = async () => new Response("<html><title>Client Challenge</title></html>", { headers: { "content-type": "text/html" } });
    await expect(apiFetch(page, "https://bandcamp.com/api/x", "GET")).rejects.toThrow(BOT_CHECK);
    await expect(apiFetch(async () => json({ ok: 1 }), "https://bandcamp.com/api/x", "GET")).resolves.toEqual({ ok: 1 });
    await expect(apiFetch(async () => new Response("", { status: 429 }), "https://bandcamp.com/api/x", "GET")).rejects.toThrow("too many requests");
  });
});
