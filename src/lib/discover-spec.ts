// Reads the filters of a discover page from its URL, mirroring the page's own
// scheme: /discover/<tag+tag|all>/<category>?s=<slice>&loc=<geoname>&t=<time>&tags=a,b

import type { DiscoverSpec } from "./types";

interface Option {
  id: number;
  slug: string;
  label?: string;
}

/** The `appData.initialState` blob the discover page embeds in #DiscoverApp. */
export interface DiscoverInitialState {
  categories?: Option[];
  times?: Option[];
  genres?: Option[];
  subgenres?: Option[];
  customTags?: Option[];
}

const ALL_CATEGORIES: Option = { id: 0, slug: "all" };

const DEFAULT_CATEGORIES: Option[] = [
  ALL_CATEGORIES,
  { id: 1, slug: "digital" },
  { id: 2, slug: "vinyl" },
  { id: 3, slug: "cd" },
  { id: 4, slug: "cassette" },
  { id: 5, slug: "tshirt" },
];

const DEFAULT_TIMES: Option[] = [
  { id: -1, slug: "fresh" },
  { id: 0, slug: "today" },
  { id: 1, slug: "this-week" },
  { id: 2, slug: "1w" },
  { id: 3, slug: "2w" },
  { id: 4, slug: "3w" },
  { id: 5, slug: "4w" },
  { id: 6, slug: "5w" },
  { id: 7, slug: "6w" },
];

export function parseDiscoverSpec(href: string, state: DiscoverInitialState | null): DiscoverSpec | null {
  const url = new URL(href);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "discover") return null;

  const s = state || {};
  const categories = s.categories?.length ? s.categories : DEFAULT_CATEGORIES;
  const times = s.times?.length ? s.times : DEFAULT_TIMES;
  const isCategory = (slug: string) => categories.some((c) => c.slug === slug);

  let tagSeg = parts[1] || "all";
  let catSeg: string | null = parts[2] || null;
  if (!catSeg && isCategory(tagSeg)) {
    catSeg = tagSeg;
    tagSeg = "all";
  }

  const tags: string[] = [];
  if (tagSeg !== "all") {
    tags.push(...tagSeg.split(/[+\s]+/).map((t) => decodeURIComponent(t)).filter(Boolean));
  }
  const extraTags = url.searchParams.get("tags");
  if (extraTags) tags.push(...extraTags.split(",").filter(Boolean));

  const category = categories.find((c) => c.slug === catSeg) ?? categories[0] ?? ALL_CATEGORIES;
  const timeParam = url.searchParams.get("t");
  let timeId: number | null = null;
  if (timeParam) {
    const t = times.find((x) => x.slug === timeParam || String(x.id) === timeParam);
    timeId = t ? t.id : parseInt(timeParam, 10) || null;
  }
  const loc = parseInt(url.searchParams.get("loc") || "0", 10) || 0;

  // Human-readable label like "punk / hardcore punk · digital"
  const known = [...(s.genres || []), ...(s.subgenres || []), ...(s.customTags || [])];
  const tagLabels = tags.map((slug) => known.find((g) => g.slug === slug)?.label || slug.replace(/-/g, " "));

  return {
    pageUrl: href,
    label: [tagLabels.join(" / ") || "all genres", category.slug !== "all" ? category.slug : null]
      .filter(Boolean)
      .join(" · "),
    params: {
      category_id: category.id,
      tag_norm_names: tags,
      geoname_id: loc,
      slice: url.searchParams.get("s") || "top",
      time_facet_id: timeId,
      include_result_types: ["a", "s"],
      followed_bands: url.searchParams.get("fb") === "1",
    },
  };
}
