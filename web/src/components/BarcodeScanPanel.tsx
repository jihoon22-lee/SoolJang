/**
 * 바코드 스캔 패널.
 *
 * 로컬 매칭 → Open Food Facts 제안 → 새로 등록/기존 술에 연결까지 한 흐름으로 이어간다
 * (`docs/plan.md` Task 16). 카메라·바코드 인식(`scan`)은 실제 하드웨어가 필요해 자동
 * 테스트로 검증할 수 없다 — `scan` prop 으로 주입 가능하게 해서, 이 컴포넌트의 나머지
 * 로직(조회·등록·학습)은 가짜 스캐너로 전부 테스트한다.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, barcodesApi, productsApi, skusApi } from "@/api/client";
import type { BarcodeLookupResponse } from "@/api/types";
import { startScanning } from "@/barcode/scanner";
import { getProducts } from "@/sync/queries";

type Phase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "looking_up" }
  | { kind: "result"; result: BarcodeLookupResponse }
  | { kind: "error"; message: string };

interface BarcodeScanPanelProps {
  onSelectProduct: (productId: string) => void;
  /** 테스트가 실제 카메라 없이 감지를 흉내낼 수 있게 하는 주입점. */
  scan?: typeof startScanning;
}

export function BarcodeScanPanel({ onSelectProduct, scan = startScanning }: BarcodeScanPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  // 바코드 조회 응답이 늦게 오면, 그 사이 사용자가 패널을 닫거나(close) 컴포넌트가
  // 언마운트돼도 이 setPhase 는 막을 방법이 없었다 — 이미 닫은 다이얼로그가 다시
  // 열리는 것으로 보였다(B9). 스캔 세션이 여전히 "살아 있는지" 를 이 ref 로 추적한다.
  const liveRef = useRef(true);

  useEffect(() => {
    return () => {
      liveRef.current = false;
    };
  }, []);

  const lookup = useCallback(async (code: string) => {
    setPhase({ kind: "looking_up" });
    try {
      const result = await barcodesApi.lookup(code);
      if (!liveRef.current) return;
      setPhase({ kind: "result", result });
    } catch (cause) {
      if (!liveRef.current) return;
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
    liveRef.current = false;
    stopRef.current?.();
    stopRef.current = null;
    setPhase({ kind: "idle" });
  }

  if (phase.kind === "idle") {
    return (
      <button
        type="button"
        onClick={() => {
          liveRef.current = true;
          setPhase({ kind: "scanning" });
        }}
      >
        바코드로 스캔
      </button>
    );
  }

  return (
    <div className="panel barcode-scan-panel" role="dialog" aria-label="바코드 스캔">
      <div className="section-header">
        <h2>바코드 스캔</h2>
        <button type="button" onClick={close}>
          닫기
        </button>
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
  onSelectProduct: (productId: string) => void;
}) {
  if (result.source === "local" && result.local_match) {
    const match = result.local_match;
    return (
      <div className="field">
        <p>
          <strong>{match.product_name}</strong> 에 이미 등록된 바코드입니다.
        </p>
        <button type="button" className="primary" onClick={() => onSelectProduct(match.product_id)}>
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
  onSelectProduct: (productId: string) => void;
}) {
  const suggestion = result.external_suggestion;
  const [name, setName] = useState(suggestion?.name ?? "");
  const [volumeMl, setVolumeMl] = useState("");
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const products = useLiveQuery(() => getProducts({}), []);
  const skuOptions = (products ?? []).flatMap((product) =>
    product.skus.map((sku) => ({
      id: sku.id,
      label: `${product.name} (${sku.volume_ml.toLocaleString("ko-KR")}ml)`,
    })),
  );

  async function registerNew() {
    if (!name.trim() || !volumeMl.trim()) {
      setError("이름과 용량을 입력하세요");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await productsApi.create({
        name: name.trim(),
        skus: [{ volume_ml: Number(volumeMl), barcode: result.barcode }],
      });
      onSelectProduct(created.id);
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "등록에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  async function attachToExisting() {
    // 버튼이 selectedSkuId 없이는 disabled 라 여기 도달할 때는 항상 값이 있다.
    setSubmitting(true);
    setError(null);
    try {
      await skusApi.update(selectedSkuId, { barcode: result.barcode });
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "연결에 실패했습니다.");
    } finally {
      setSubmitting(false);
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

      <fieldset className="fieldset-bordered">
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

      <fieldset className="fieldset-bordered">
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
