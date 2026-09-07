import { DiscoveryPanel } from "@/components/DiscoveryPanel";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
export function DiscoverPage() {
  const { state } = useSyncStatus();
  return (
    <section>
      <h1>술 탐색</h1>
      <DiscoveryPanel offline={state === "offline"} />
    </section>
  );
}
