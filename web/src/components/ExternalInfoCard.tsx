import type { Money } from "@/api/types";
import { DiscoveryPanel } from "./DiscoveryPanel";

/** Product detail and store mode share the explicit, non-generative discovery flow. */
export function ExternalInfoCard({
  productId,
  productName,
  offline,
  myPricePer100ml,
}: {
  productId: string;
  productName: string;
  offline: boolean;
  myPricePer100ml?: Money;
}) {
  return (
    <details>
      <summary>외부 정보 조회</summary>
      <DiscoveryPanel
        key={productId}
        productId={productId}
        initialName={productName}
        offline={offline}
        myPricePer100ml={myPricePer100ml ?? null}
      />
    </details>
  );
}
