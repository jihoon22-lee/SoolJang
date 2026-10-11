import type { DiscoveryDocument } from "@/api/discovery";
import type { InterestIdentity } from "@/api/interests";
import { expandSearchQueries, matchesQuery } from "@/search";

export function buildSearchQueries(identity: InterestIdentity): string[] {
  const variants = [
    identity.name,
    identity.name_en,
    ...(identity.search_aliases ?? []),
    ...expandSearchQueries(identity.name),
  ];
  const queries: string[] = [];
  for (const variant of variants) {
    if (!variant?.trim() || variant.trim().length > 300) continue;
    let text = variant.trim();
    const append = (value: string | number | null | undefined, unit: string, pattern: RegExp) => {
      if (
        value != null &&
        value !== "" &&
        !pattern.test(text) &&
        `${text} ${value}${unit}`.length <= 300
      )
        text += ` ${value}${unit}`;
    };
    append(identity.vintage, "", /(?:19|20)\d{2}/);
    append(identity.age_years, "년", /\d+(?:\.\d+)?\s*(?:년|years?\b|yo\b|y\b)/i);
    if (identity.volumes_ml?.length === 1)
      append(identity.volumes_ml[0], "ml", /\d+(?:\.\d+)?\s*(?:ml|cl|l|리터)\b/i);
    append(identity.abv, "%", /\d+(?:\.\d+)?\s*(?:%|도)/);
    if (!queries.some((query) => query.toLowerCase() === text.toLowerCase())) queries.push(text);
    if (queries.length === 2) break;
  }
  return queries;
}

export function documentTab(
  kind: DiscoveryDocument["kind"],
): "info" | "price" | "review" | "other" {
  return kind === "info"
    ? "info"
    : kind === "offer"
      ? "price"
      : ["review", "customer_tasting"].includes(kind)
        ? "review"
        : "other";
}
function rawRank(doc: DiscoveryDocument): number {
  const ranks = new Map<string, number>();
  for (const origin of doc.origins ?? []) {
    const key = `${origin.provider}|${origin.channel}|${origin.query}|${origin.language}`;
    ranks.set(key, Math.min(ranks.get(key) ?? Infinity, origin.rank));
  }
  return [...ranks.values()].reduce((sum, rank) => sum + 1 / (60 + rank), 0);
}
export function compareDocuments(a: DiscoveryDocument, b: DiscoveryDocument): number {
  return (
    rawRank(b) - rawRank(a) ||
    documentRichness(b) - documentRichness(a) ||
    a.url.localeCompare(b.url)
  );
}
export function documentRichness(doc: DiscoveryDocument): number {
  return (
    (doc.evidence === "provider_text" && doc.excerpt ? 10000 : 0) +
    doc.excerpt.length +
    (doc.kind !== "unknown" ? 100 : 0) +
    (doc.published_at ? 10 : 0)
  );
}
/** Relevance is only a display rank. It never creates a product identity or merges editions. */
export function rankDocuments(
  documents: DiscoveryDocument[],
  identity: InterestIdentity,
): DiscoveryDocument[] {
  const names = [identity.name, identity.name_en, ...(identity.search_aliases ?? [])].filter(
    (value): value is string => !!value,
  );
  const relevance = (doc: DiscoveryDocument) => {
    const name = names.some((query) => matchesQuery(doc.title, query));
    const producer =
      identity.producer && matchesQuery(`${doc.title} ${doc.excerpt}`, identity.producer);
    let conflict = false;
    for (const field of ["vintage", "abv", "age_years"] as const) {
      const actual = doc.applicable_fields?.[field];
      const expected = identity[field];
      if (actual != null && expected != null && Number(actual) !== Number(expected))
        conflict = true;
    }
    const volume = doc.title.match(/(\d+(?:\.\d+)?)\s*(ml|cl|l)\b/i);
    if (volume && identity.volumes_ml?.length) {
      const ml =
        Number(volume[1]) *
        (volume[2]?.toLowerCase() === "l" ? 1000 : volume[2]?.toLowerCase() === "cl" ? 10 : 1);
      if (!identity.volumes_ml.includes(ml)) conflict = true;
    }
    const batch = /(?:batch|배치|#)\s*([a-z0-9-]+)/i;
    const expectedBatch = identity.name.match(batch)?.[1]?.toLowerCase();
    const actualBatch = doc.title.match(batch)?.[1]?.toLowerCase();
    if (expectedBatch && actualBatch && expectedBatch !== actualBatch) conflict = true;
    const set = /(?:세트|gift\s*set|\bset\b)/i;
    if (set.test(doc.title) !== set.test(identity.name)) conflict = true;
    return (conflict ? -10 : 0) + (name ? 4 : 0) + (producer ? 1 : 0);
  };
  return [...documents].sort((a, b) => relevance(b) - relevance(a) || compareDocuments(a, b));
}
