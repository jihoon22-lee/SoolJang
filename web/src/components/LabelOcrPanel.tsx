/**
 * 라벨 사진으로 등록 폼 프리필(Task 17).
 *
 * 카메라 스트림을 직접 다루는 `BarcodeScanPanel` 과 달리, 사진 한 장만 받으면 되므로
 * `<input type="file" capture="environment">` 로 충분하다 — 브라우저가 카메라 UI를
 * 대신 띄워 주므로 `barcode/scanner.ts` 같은 별도 스캐너 모듈이 필요 없다. 이 덕분에
 * 테스트도 실제 카메라 목킹 없이 `userEvent.upload` 로 바로 검증할 수 있다.
 *
 * 이 컴포넌트는 아무것도 저장하지 않는다 — 추출된 필드를 `onPrefill` 로 부모에 넘기면,
 * 부모가 `ProductForm` 을 프리필해서 열고 사용자가 검수한 뒤 저장한다. 저장이 성공하면
 * 그때 부모가 원본 사진을 `POST /attachments` 로 올린다("원본·결과 보관").
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, ocrApi } from "@/api/client";
import type { CategoryNode } from "@/api/types";
import type { ProductFormValues } from "@/components/ProductForm";

type Phase =
  | { kind: "idle" }
  | { kind: "extracting" }
  | { kind: "result"; prefill: Partial<ProductFormValues>; summary: FieldSummary[] }
  | { kind: "error"; message: string; llmNotConfigured: boolean };

interface FieldSummary {
  label: string;
  value: string;
  confidence: number;
}

//: 이 밑으로는 사용자에게 "낮은 신뢰도" 로 표시한다 — 그대로 믿지 말고 확인하라는 신호다.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

interface LabelOcrPanelProps {
  categories: CategoryNode[];
  onPrefill: (values: Partial<ProductFormValues>, labelFile: File) => void;
}

export function LabelOcrPanel({ categories, onPrefill }: LabelOcrPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 라벨 인식 응답이 늦게 오는 동안 컴포넌트가 언마운트되면(예: 다른 탭으로 이동) 이
  // setPhase 를 막을 방법이 없었다(B9, BarcodeScanPanel 과 같은 결함).
  const liveRef = useRef(true);

  useEffect(() => {
    return () => {
      liveRef.current = false;
    };
  }, []);

  async function handleFileSelected(file: File) {
    fileRef.current = file;
    setPhase({ kind: "extracting" });
    try {
      const extraction = await ocrApi.extractLabel(file);
      if (!liveRef.current) return;
      const prefill = toPrefill(extraction, categories);
      setPhase({ kind: "result", prefill, summary: toSummary(extraction) });
    } catch (cause) {
      if (!liveRef.current) return;
      const apiError = cause instanceof ApiError ? cause : null;
      setPhase({
        kind: "error",
        message: apiError?.message ?? "라벨 인식에 실패했습니다.",
        llmNotConfigured: apiError?.problem?.type.endsWith("/llm-not-configured") ?? false,
      });
    }
  }

  function reset() {
    fileRef.current = null;
    setPhase({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="라벨 사진으로 등록"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFileSelected(file);
        }}
        disabled={phase.kind === "extracting"}
        className="hidden"
        id="label-ocr-input"
      />
      <button type="button" onClick={() => inputRef.current?.click()}>
        라벨로 등록
      </button>

      {phase.kind === "extracting" && <output aria-live="polite">라벨을 인식하는 중…</output>}

      {phase.kind === "error" && (
        <div className="panel" role="alert">
          <p className="alert">{phase.message}</p>
          {phase.llmNotConfigured && (
            <p className="muted">설정 화면에서 LLM API 키를 등록한 뒤 다시 시도하세요.</p>
          )}
          <button type="button" onClick={reset}>
            닫기
          </button>
        </div>
      )}

      {phase.kind === "result" && (
        <div className="panel" role="dialog" aria-label="라벨 인식 결과">
          <h3>인식 결과</h3>
          <ul>
            {phase.summary.map((field) => (
              <li key={field.label}>
                {field.label}: {field.value}{" "}
                <span className={field.confidence < LOW_CONFIDENCE_THRESHOLD ? "alert" : "muted"}>
                  (신뢰도 {Math.round(field.confidence * 100)}%)
                </span>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const file = fileRef.current;
                if (!file) return;
                onPrefill(phase.prefill, file);
                reset();
              }}
            >
              이 정보로 등록
            </button>
            <button type="button" onClick={reset}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface LabelExtractionLike {
  name: string | null;
  name_confidence: number;
  producer: string | null;
  producer_confidence: number;
  abv: number | null;
  abv_confidence: number;
  volume_ml: number | null;
  volume_ml_confidence: number;
  vintage: number | null;
  vintage_confidence: number;
  age_years: number | null;
  age_years_confidence: number;
  category_guess: string | null;
  category_guess_confidence: number;
}

function toSummary(extraction: LabelExtractionLike): FieldSummary[] {
  const rows: [string, string | number | null, number][] = [
    ["이름", extraction.name, extraction.name_confidence],
    ["생산자", extraction.producer, extraction.producer_confidence],
    ["도수", extraction.abv !== null ? `${extraction.abv}%` : null, extraction.abv_confidence],
    [
      "용량",
      extraction.volume_ml !== null ? `${extraction.volume_ml}ml` : null,
      extraction.volume_ml_confidence,
    ],
    ["빈티지", extraction.vintage, extraction.vintage_confidence],
    ["숙성 연수", extraction.age_years, extraction.age_years_confidence],
    ["주종 추정", extraction.category_guess, extraction.category_guess_confidence],
  ];
  return rows
    .filter(([, value]) => value !== null)
    .map(([label, value, confidence]) => ({ label, value: String(value), confidence }));
}

/**
 * OCR 결과를 폼 값으로 옮긴다.
 *
 * 생산자·숙성 연수는 `ProductForm` 에 실제 입력칸이 생겨(생산자 자동완성·숙성 연수 칸)
 * 이제 메모가 아니라 그 필드로 채운다. 주종 추정은 카테고리 목록에서 이름이 정확히
 * 일치하는 항목이 있을 때만 채운다. 오탐(엉뚱한 카테고리를 골라 버림)이 이름 불일치로
 * 안 채워지는 것보다 나쁘다.
 */
function toPrefill(
  extraction: LabelExtractionLike,
  categories: CategoryNode[],
): Partial<ProductFormValues> {
  const values: Partial<ProductFormValues> = {};
  if (extraction.name) values.name = extraction.name;
  if (extraction.producer) values.producerName = extraction.producer;
  if (extraction.abv !== null) values.abv = String(extraction.abv);
  if (extraction.volume_ml !== null) values.volumeMl = String(extraction.volume_ml);
  if (extraction.vintage !== null) values.vintage = String(extraction.vintage);
  if (extraction.age_years !== null) values.ageYears = String(extraction.age_years);

  if (extraction.category_guess) {
    const guess = extraction.category_guess.trim().toLowerCase();
    const matched = categories.find((category) => category.name.trim().toLowerCase() === guess);
    if (matched) values.categoryId = matched.id;
  }

  return values;
}
