import type { Buy } from "./types";

export function shuffled<T>(arr: readonly T[], random: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

/** "mm:ss", like Bandcamp's own player. */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How close (px) to the end of the queue the popup starts loading the next page. */
export const AUTO_LOAD_MARGIN = 240;

/**
 * Whether the popup should load the next page of results: the user has scrolled near
 * the end of the list (or it does not fill its box), more exist, and nothing is in
 * flight. After an error it waits for the "load more" button instead of retrying in a loop.
 */
export function shouldAutoLoad(
  s: { hasMore: boolean; loading: boolean; error: string | null },
  list: { scrollTop: number; scrollHeight: number; clientHeight: number },
): boolean {
  if (!s.hasMore || s.loading || s.error) return false;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= AUTO_LOAD_MARGIN;
}

/** "$7", "€4.50"; the code itself when the currency is unknown to Intl. */
export function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * Text of a buy link: "Buy album · $7", "Buy track · name your price", "Pre-order album · $5 or more",
 * "Free download", or "Buy · 2 physical editions" when only vinyl, CDs and the like are sold.
 */
export function buyLabel(buy: Buy): string {
  if (!buy.digital) return buy.editions.length === 1 ? "Buy · physical edition" : `Buy · ${buy.editions.length} physical editions`;
  if (buy.free) return "Free download";
  const verb = `${buy.preorder ? "Pre-order" : "Buy"} ${buy.what}`;
  if (buy.nameYourPrice && !buy.price) return `${verb} · name your price`;
  const price = formatPrice(buy.price, buy.currency);
  return `${verb} · ${buy.nameYourPrice ? `${price} or more` : price}`;
}

/** Tooltip of a buy link: the physical editions sold besides the download. */
export function buyTitle(buy: Buy): string {
  return buy.editions.length ? `Also on Bandcamp: ${buy.editions.join("; ")}` : "Opens the release page on Bandcamp";
}
