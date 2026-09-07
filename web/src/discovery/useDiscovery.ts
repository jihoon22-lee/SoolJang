import { useEffect, useRef, useState } from "react";
import {
  type DiscoveryDocument,
  type DiscoverySource,
  discoveryApi,
  type SourceMatch,
} from "@/api/discovery";
import type { InterestIdentity } from "@/api/interests";
import { sourceOutcomeLabel } from "@/sourceOutcome";
import { databaseIdentity } from "@/sync/db";

export interface DiscoveryJob {
  id: string;
  name: string;
  kind: "search" | "source";
}
export interface RunState {
  query: string;
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
    documents.set(
      doc.url,
      prior
        ? { ...prior, discovered_by: [...new Set([...prior.discovered_by, ...doc.discovered_by])] }
        : doc,
    );
  }
  return [...documents.values()];
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
    jobs: DiscoveryJob[],
    matches: Record<string, SourceMatch>,
    productId?: string,
    interestId?: string,
  ) => {
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
      searchConnections: jobs.filter((job) => job.kind === "search").length,
    });
    let next = 0;
    const worker = async () => {
      while (current()) {
        const job = jobs[next++];
        if (!job) return;
        try {
          if (job.kind === "search") {
            const response = await discoveryApi.search(job.id, identity.name, abort.signal);
            if (!current()) return;
            setState((old) => ({
              ...old,
              documents: mergeDocuments(old.documents, response.documents),
              notices: [
                ...old.notices,
                `${job.name}: ${sourceOutcomeLabel(response.outcome)}${response.warning ? ` · ${response.warning}` : ""}`,
              ],
            }));
          } else {
            const results = interestId
              ? await discoveryApi.interestLookup(interestId, job.id, abort.signal)
              : productId
                ? await discoveryApi.productLookup(productId, job.id, abort.signal)
                : await discoveryApi.lookup(identity, job.id, matches, abort.signal);
            if (!current()) return;
            setState((old) => ({ ...old, sources: [...old.sources, ...results] }));
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
        if (current()) setState((old) => ({ ...old, finished: old.finished + 1 }));
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
