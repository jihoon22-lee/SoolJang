import { useEffect, useRef, useState } from "react";
import {
  type DiscoveryDocument,
  type DiscoverySource,
  discoveryApi,
  type SourceMatch,
} from "@/api/discovery";
import type { InterestIdentity } from "@/api/interests";
import { buildSearchQueries, compareDocuments } from "@/discovery/quality";
import { sourceOutcomeLabel } from "@/sourceOutcome";
import { databaseIdentity } from "@/sync/db";

export interface DiscoveryJob {
  id: string;
  name: string;
  kind: "search" | "source";
  providerKind?: string;
}
export interface RunState {
  query: string;
  queries: string[];
  requests: number;
  requestLimit: number;
  elapsedMs: number;
  identity: InterestIdentity;
  searchConnections: number;
  documents: DiscoveryDocument[];
  sources: DiscoverySource[];
  finished: number;
  total: number;
  running: boolean;
  cancelled: boolean;
  notices: string[];
}
const empty = (): RunState => ({
  query: "",
  queries: [],
  requests: 0,
  requestLimit: 0,
  elapsedMs: 0,
  identity: { name: "" },
  searchConnections: 0,
  documents: [],
  sources: [],
  finished: 0,
  total: 0,
  running: false,
  cancelled: false,
  notices: [],
});
/** Only identical server canonical URLs are merged. SKU/edition/condition query parameters survive. */
export function mergeDocuments(
  previous: DiscoveryDocument[],
  incoming: DiscoveryDocument[],
): DiscoveryDocument[] {
  const documents = new Map(previous.map((doc) => [doc.url, doc]));
  for (const doc of incoming) {
    const prior = documents.get(doc.url);
    documents.set(doc.url, prior ? mergeDocument(prior, doc) : doc);
  }
  return [...documents.values()].sort(compareDocuments);
}

function mergeDocument(a: DiscoveryDocument, b: DiscoveryDocument): DiscoveryDocument {
  const contentKey = (doc: DiscoveryDocument) =>
    JSON.stringify([
      doc.title,
      doc.excerpt,
      doc.evidence,
      doc.applicable_fields,
      doc.evidence_token,
      doc.fetched_at,
      doc.rating,
      doc.rating_scale,
      doc.rating_count,
      doc.id,
    ]);
  const contentWeight = (doc: DiscoveryDocument) =>
    (doc.evidence === "provider_text" && doc.excerpt ? 10000 : 0) + doc.excerpt.length;
  const best = [a, b].sort(
    (left, right) =>
      contentWeight(right) - contentWeight(left) ||
      contentKey(left).localeCompare(contentKey(right)),
  )[0] as DiscoveryDocument;
  const purposes = [
    "service_review",
    "seller_note",
    "customer_tasting",
    "review",
    "offer",
    "info",
    "unknown",
  ];
  const origins = new Map(
    [...(a.origins ?? []), ...(b.origins ?? [])].map((origin) => [
      `${origin.provider}|${origin.channel}|${origin.query}|${origin.language}|${origin.rank}`,
      origin,
    ]),
  );
  return {
    ...best,
    discovered_by: [...new Set([...a.discovered_by, ...b.discovered_by])].sort(),
    origins: [...origins.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([, value]) => value),
    kind: purposes.indexOf(a.kind) < purposes.indexOf(b.kind) ? a.kind : b.kind,
    published_at:
      [a.published_at, b.published_at]
        .filter((value): value is string => !!value)
        .sort()
        .at(-1) ?? null,
  };
}
export function publicLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function useDiscovery() {
  const [state, setState] = useState<RunState>(empty);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const cancel = () => {
    generation.current++;
    controller.current?.abort();
    setState((old) => ({ ...old, running: false, cancelled: old.running || old.cancelled }));
  };
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  const run = async (
    identity: InterestIdentity,
    requestedJobs: DiscoveryJob[],
    matches: Record<string, SourceMatch>,
    productId?: string,
    interestId?: string,
  ) => {
    const selected = requestedJobs.slice(0, 4);
    const variants = buildSearchQueries(identity);
    const jobs: (DiscoveryJob & { query: string; cost: number })[] = selected.map((job) => ({
      ...job,
      query: variants[0] ?? identity.name,
      cost: job.kind === "source" ? 0 : job.providerKind?.startsWith("naver") ? 2 : 1,
    }));
    let budget = jobs.reduce((sum, job) => sum + job.cost, 0);
    for (const job of [...jobs]) {
      if (job.kind !== "search" || !variants[1] || budget + job.cost > 8) continue;
      jobs.push({ ...job, query: variants[1] });
      budget += job.cost;
    }
    const started = Date.now();
    controller.current?.abort();
    const ownGeneration = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const owner = databaseIdentity();
    const current = () => {
      const now = databaseIdentity();
      return (
        ownGeneration === generation.current &&
        !abort.signal.aborted &&
        now.userId === owner.userId &&
        now.generation === owner.generation
      );
    };
    setState({
      ...empty(),
      running: true,
      total: jobs.length,
      query: identity.name,
      identity,
      queries: [...new Set(jobs.filter((job) => job.kind === "search").map((job) => job.query))],
      requestLimit: budget,
      searchConnections: selected.filter((job) => job.kind === "search").length,
    });
    let next = 0;
    const worker = async () => {
      while (current()) {
        const job = jobs[next++];
        if (!job) return;
        try {
          if (job.kind === "search") {
            const response = await discoveryApi.search(
              job.id,
              job.query,
              abort.signal,
              (job.query.match(/[가-힣]/g)?.length ?? 0) > (job.query.match(/[a-z]/gi)?.length ?? 0)
                ? "ko"
                : "en",
            );
            if (!current()) return;
            setState((old) => ({
              ...old,
              documents: mergeDocuments(old.documents, response.documents),
              requests: old.requests + response.requests,
              notices: [
                ...old.notices,
                `${job.name} · ${job.query}: ${sourceOutcomeLabel(response.outcome)}${response.warning ? ` · ${response.warning}` : ""}`,
              ],
            }));
          } else {
            const results = interestId
              ? await discoveryApi.interestLookup(interestId, job.id, abort.signal)
              : productId
                ? await discoveryApi.productLookup(productId, job.id, abort.signal)
                : await discoveryApi.lookup(identity, job.id, matches, abort.signal);
            if (!current()) return;
            setState((old) => ({
              ...old,
              sources: [...old.sources, ...results].sort((a, b) =>
                a.source_id.localeCompare(b.source_id),
              ),
            }));
          }
        } catch (error) {
          if (!current()) return;
          setState((old) => ({
            ...old,
            notices: [
              ...old.notices,
              `${job.name}: ${error instanceof Error ? error.message : "조회 실패"}`,
            ],
          }));
        }
        if (current())
          setState((old) => ({
            ...old,
            finished: old.finished + 1,
            elapsedMs: Date.now() - started,
          }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    if (current()) setState((old) => ({ ...old, running: false }));
  };
  const reset = () => {
    cancel();
    setState(empty());
  };
  return { state, run, cancel, reset };
}
