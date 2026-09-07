import { useState } from "react";
import type { Money } from "@/api/types";
import { DiscoveryPanel } from "./DiscoveryPanel";

/** Product detail and store mode share the explicit, non-generative discovery flow. */
export function ExternalInfoCard({
  productId,
  productName,
  offline,
  myPricePer100ml,
  open: controlledOpen,
  onOpenChange,
}: {
  productId: string;
  productName: string;
  offline: boolean;
  myPricePer100ml?: Money;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        onOpenChange?.(event.currentTarget.open);
      }}
    >
      <summary>외부 정보 조회</summary>
      {open && (
        <DiscoveryPanel
          key={productId}
          productId={productId}
          initialName={productName}
          offline={offline}
          myPricePer100ml={myPricePer100ml ?? null}
        />
      )}
    </details>
  );
}
