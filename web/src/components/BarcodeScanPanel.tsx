/**
 * 바코드 스캔 패널.
 *
 * 로컬 매칭 → Open Food Facts 제안 → 새로 등록/기존 술에 연결까지 한 흐름으로 이어간다
 * (`docs/plan.md` Task 16). 카메라·바코드 인식(`scan`)은 실제 하드웨어가 필요해 자동
 * 테스트로 검증할 수 없다 — `scan` prop 으로 주입 가능하게 해서, 이 컴포넌트의 나머지
 * 로직(조회·등록·학습)은 가짜 스캐너로 전부 테스트한다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { ApiError, barcodesApi, productsApi, skusApi } from "@/api/client";
import type { BarcodeLookupResponse } from "@/api/types";
import { startScanning } from "@/barcode/scanner";
import { productEdition } from "@/components/productDisplay";
import { formatVolume } from "@/format";
import type { ProductContext } from "@/router";
import { getProducts } from "@/sync/queries";
import { captureWriteSession } from "@/sync/writeSession";
import { useModalDialog } from "@/useModalDialog";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "looking_up" }
  | { kind: "result"; result: BarcodeLookupResponse }
  | { kind: "error"; message: string };

interface BarcodeScanPanelProps {
  onSelectProduct: (productId: string, context?: ProductContext) => void;
  /** 테스트가 실제 카메라 없이 감지를 흉내낼 수 있게 하는 주입점. */
  scan?: typeof startScanning;
}

export function BarcodeScanPanel({ onSelectProduct, scan = startScanning }: BarcodeScanPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 바코드 조회 응답이 늦게 오면, 그 사이 사용자가 패널을 닫거나(close) 컴포넌트가
  // 언마운트돼도 이 setPhase 는 막을 방법이 없었다 — 이미 닫은 다이얼로그가 다시
  // 열리는 것으로 보였다(B9). 스캔 세션이 여전히 "살아 있는지" 를 이 ref 로 추적한다.
  const liveRef = useRef(true);
  const lookupGeneration = useRef(0);

  useEffect(() => {
    return () => {
      liveRef.current = false;
    };
  }, []);

  const lookup = useCallback(async (code: string) => {
    const attempt = ++lookupGeneration.current;
    setPhase({ kind: "looking_up" });
    try {
      const result = await barcodesApi.lookup(code);
      if (!liveRef.current || attempt !== lookupGeneration.current) return;
      setPhase({ kind: "result", result });
    } catch (cause) {
      if (!liveRef.current || attempt !== lookupGeneration.current) return;
      setPhase({
        kind: "error",
        message: cause instanceof ApiError ? cause.message : "바코드 조회에 실패했습니다.",
      });
    }
  }, []);

  useEffect(() => {
    if (phase.kind !== "scanning") return;
    let active = true;

    void (async () => {
      if (!videoRef.current) return;
      try {
        const controller = await scan(videoRef.current, (code) => {
          if (!active) return;
          active = false;
          // 스캐너가 감지 시 스스로 카메라를 끄지만, 어떤 구현이든 남은 스트림을 확실히 닫는다.
          stopRef.current?.();
          stopRef.current = null;
          void lookup(code);
        });
        if (active) {
          stopRef.current = () => controller.stop();
        } else {
          controller.stop();
        }
      } catch {
        if (active) {
          setPhase({ kind: "error", message: "카메라를 시작할 수 없습니다. 권한을 확인하세요." });
        }
      }
    })();

    return () => {
      active = false;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [phase.kind, scan, lookup]);

  function close() {
    lookupGeneration.current += 1;
    liveRef.current = false;
    stopRef.current?.();
    stopRef.current = null;
    setPhase({ kind: "idle" });
  }

  function rescan() {
    lookupGeneration.current += 1;
    stopRef.current?.();
    stopRef.current = null;
    liveRef.current = true;
    setPhase({ kind: "scanning" });
  }

  if (phase.kind === "idle") {
    return (
      <button type="button" ref={triggerRef} onClick={rescan}>
        바코드로 스캔
      </button>
    );
  }

  return (
    <ScanDialog onClose={close} returnFocusRef={triggerRef}>
      <div className="section-header">
        <h2 id="barcode-scan-heading">바코드 스캔</h2>
        <div className="button-row">
          {phase.kind === "error" || phase.kind === "result" ? (
            <button type="button" onClick={rescan}>
              다시 스캔
            </button>
          ) : null}
          <button type="button" onClick={close}>
            닫기
          </button>
        </div>
      </div>

      {(phase.kind === "scanning" || phase.kind === "looking_up") && (
        <>
          <video ref={videoRef} className="barcode-scan-video" muted playsInline />
          <output className="muted">
            {phase.kind === "scanning" ? "바코드를 카메라에 비춰 주세요…" : "조회하는 중…"}
          </output>
        </>
      )}

      {phase.kind === "error" && (
        <p className="alert" role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === "result" && (
        <BarcodeResult result={phase.result} onDone={close} onSelectProduct={onSelectProduct} />
      )}
    </ScanDialog>
  );
}

/** 스캔 창. 열리면 초점을 옮기고 Tab 을 창 안에 가두며, Esc 로 닫고 연 버튼으로 돌아간다. */
function ScanDialog({
  children,
  onClose,
  returnFocusRef,
}: {
  children: ReactNode;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useModalDialog(returnFocusRef);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") closeRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div
      ref={dialogRef}
      className="panel barcode-scan-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="barcode-scan-heading"
      tabIndex={-1}
    >
      {children}
    </div>
  );
}

function BarcodeResult({
  result,
  onDone,
  onSelectProduct,
}: {
  result: BarcodeLookupResponse;
  onDone: () => void;
  onSelectProduct: (productId: string, context?: ProductContext) => void;
}) {
  if (result.source === "local" && result.local_match) {
    const match = result.local_match;
    return (
      <div className="field">
        <p>
          <strong>
            {match.product_name} · {formatVolume(match.volume_ml)}
          </strong>{" "}
          에 이미 등록된 바코드입니다.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            onDone();
            onSelectProduct(match.product_id, { skuId: match.sku_id });
          }}
        >
          제품으로 이동
        </button>
      </div>
    );
  }

  return (
    <UnmatchedBarcodeResult result={result} onDone={onDone} onSelectProduct={onSelectProduct} />
  );
}

function UnmatchedBarcodeResult({
  result,
  onDone,
  onSelectProduct,
}: {
  result: BarcodeLookupResponse;
  onDone: () => void;
  onSelectProduct: (productId: string, context?: ProductContext) => void;
}) {
  const suggestion = result.external_suggestion;
  const [name, setName] = useState(suggestion?.name ?? "");
  const [volumeMl, setVolumeMl] = useState("");
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);
  const submittingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const products = useLiveQuery(() => getProducts({}), []);
  const skuOptions = (products ?? []).flatMap((product) =>
    product.skus.map((sku) => ({
      id: sku.id,
      productId: product.id,
      label: [product.name, productEdition(product), formatVolume(sku.volume_ml)]
        .filter(Boolean)
        .join(" · "),
    })),
  );

  async function registerNew() {
    if (submittingRef.current) return;
    if (!name.trim() || !volumeMl.trim()) {
      setError("이름과 용량을 입력하세요");
      return;
    }
    const session = captureWriteSession();
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      session.assertCurrent();
      const created = await productsApi.create({
        name: name.trim(),
        skus: [{ volume_ml: Number(volumeMl), barcode: result.barcode }],
      });
      if (!mounted.current || !session.isCurrent()) return;
      const sku = created.skus.find((sku) => sku.volume_ml === Number(volumeMl));
      onDone();
      if (sku) onSelectProduct(created.id, { skuId: sku.id });
      else onSelectProduct(created.id);
    } catch (cause) {
      if (mounted.current && session.isCurrent())
        setError(cause instanceof ApiError ? cause.message : "등록에 실패했습니다.");
    } finally {
      submittingRef.current = false;
      if (mounted.current && session.isCurrent()) setSubmitting(false);
    }
  }

  async function attachToExisting() {
    if (submittingRef.current) return;
    const option = skuOptions.find((option) => option.id === selectedSkuId);
    if (!option) {
      setError("연결할 규격을 다시 선택하세요");
      return;
    }
    const session = captureWriteSession();
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      session.assertCurrent();
      await skusApi.update(option.id, { barcode: result.barcode });
      if (!mounted.current || !session.isCurrent()) return;
      onDone();
      onSelectProduct(option.productId, { skuId: option.id });
    } catch (cause) {
      if (mounted.current && session.isCurrent())
        setError(cause instanceof ApiError ? cause.message : "연결에 실패했습니다.");
    } finally {
      submittingRef.current = false;
      if (mounted.current && session.isCurrent()) setSubmitting(false);
    }
  }

  return (
    <div className="field">
      {result.is_rcn && (
        <p className="alert" role="alert">
          매장 내부용(RCN) 바코드로 보입니다. 다른 상품에 같은 번호가 쓰였을 수 있으니 확인 후
          저장하세요.
        </p>
      )}

      {suggestion && (
        <p className="muted">
          Open Food Facts 제안: <strong>{suggestion.name}</strong>
          {suggestion.brand ? ` · ${suggestion.brand}` : ""}
          {suggestion.quantity_text ? ` · ${suggestion.quantity_text}` : ""}
        </p>
      )}
      {!suggestion && (
        <p className="muted">
          일치하는 술을 찾지 못했습니다. 새로 등록하거나 기존 술에 연결하세요.
        </p>
      )}

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <fieldset className="fieldset-bordered" disabled={submitting}>
        <legend>새 술로 등록</legend>
        <div className="field">
          <label htmlFor="scan-new-name">이름</label>
          <input
            id="scan-new-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="scan-new-volume">용량 (ml)</label>
          <input
            id="scan-new-volume"
            type="number"
            inputMode="numeric"
            min={1}
            value={volumeMl}
            onChange={(event) => setVolumeMl(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="primary"
          disabled={submitting}
          onClick={() => void registerNew()}
        >
          이 바코드로 새로 등록
        </button>
      </fieldset>

      <fieldset className="fieldset-bordered" disabled={submitting}>
        <legend>기존 술에 연결</legend>
        <div className="field">
          <label htmlFor="scan-existing-sku">규격 선택</label>
          <select
            id="scan-existing-sku"
            value={selectedSkuId}
            onChange={(event) => setSelectedSkuId(event.target.value)}
          >
            <option value="">선택하세요</option>
            {skuOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={submitting || !selectedSkuId}
          onClick={() => void attachToExisting()}
        >
          이 규격에 바코드 연결
        </button>
      </fieldset>
    </div>
  );
}
