import { DiscoveryPanel } from "@/components/DiscoveryPanel";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
export function DiscoverPage() {
  const { state } = useSyncStatus();
  return (
    <section>
      <h2 className="page-title">술 탐색</h2>
      <DiscoveryPanel offline={state === "offline"} />
    </section>
  );
}
