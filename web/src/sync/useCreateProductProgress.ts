import { useMemo, useSyncExternalStore } from "react";
import type { Product, ProductCreateInput, PurchaseCreateInput } from "@/api/types";
import type { ProductFormValues } from "@/components/ProductForm";
import { databaseIdentity } from "@/sync/db";
import {
  captureFormDraft,
  finishSubmission,
  saveSubmissionProgress,
  submissionEvents,
  submissionSnapshot,
} from "@/sync/drafts";
import type { WriteSession } from "@/sync/writeSession";

const FORM = "product:create:recovery";

/** 기존 생성 요청 키와 함께 보관하는 성공 단계. 서버나 outbox의 별도 상태가 아니다. */
export interface ProductCreationProgress {
  version: 1;
  onlineAttempted: boolean;
  product: Product | null;
  /** 실제로 보낸 내용. 응답이 미확정인 동안 payload와 키를 함께 유지한다. */
  productRequest?: ProductCreateInput | null;
  purchaseRequest?: PurchaseCreateInput | null;
  purchaseCreated: boolean;
  labelPending: boolean;
  completedId: string | null;
  draftCleared: boolean;
  error: string | null;
  values: ProductFormValues;
}

function decode(snapshot: string | null): ProductCreationProgress | null {
  if (!snapshot) return null;
  try {
    const value = JSON.parse(snapshot)?.progress as ProductCreationProgress | undefined;
    if (
      value?.version !== 1 ||
      typeof value.onlineAttempted !== "boolean" ||
      typeof value.purchaseCreated !== "boolean" ||
      typeof value.labelPending !== "boolean" ||
      typeof value.draftCleared !== "boolean" ||
      (value.completedId !== null && typeof value.completedId !== "string") ||
      (value.error !== null && typeof value.error !== "string") ||
      !value.values ||
      typeof value.values.name !== "string" ||
      (value.product !== null &&
        (typeof value.product.id !== "string" || !Array.isArray(value.product.skus)))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function readProductCreationProgress(): ProductCreationProgress | null {
  return decode(submissionSnapshot(FORM));
}

export function saveProductCreationProgress(progress: ProductCreationProgress): void {
  saveSubmissionProgress(FORM, progress);
}

function ownerKey(): string {
  return captureFormDraft("product:create").prefix ?? "";
}

// 진행 중인 Promise와 File은 브라우저 탭에만 둔다. 새로고침 뒤에는 저장한 단계로 재시도한다.
const active = new Map<string, { token: object; generation: number }>();
const labels = new Map<string, File>();

export function productCreationPending(): boolean {
  return active.get(ownerKey())?.generation === databaseIdentity().generation;
}

export function beginProductCreation(session: WriteSession): () => void {
  session.assertCurrent();
  if (productCreationPending()) throw new Error("제품 등록을 저장 중입니다. 결과를 기다려 주세요");
  const key = ownerKey();
  const token = {};
  active.set(key, { token, generation: databaseIdentity().generation });
  submissionEvents.dispatchEvent(new Event("change"));
  return () => {
    if (active.get(key)?.token === token) {
      active.delete(key);
      submissionEvents.dispatchEvent(new Event("change"));
    }
  };
}

export function creationLabel(file: File | null | undefined, restore: boolean): File | null {
  const key = ownerKey();
  if (file) labels.set(key, file);
  else if (!restore) labels.delete(key);
  return file ?? labels.get(key) ?? null;
}

/** 정상 완료를 닫는다. 남은 새 입력은 명시적으로 확인할 때까지 보존한다. */
export function finishProductCreation(): boolean {
  const progress = readProductCreationProgress();
  if (
    productCreationPending() ||
    !progress?.completedId ||
    !progress.draftCleared ||
    captureFormDraft("product:create").entries.length > 0
  )
    return false;
  labels.delete(ownerKey());
  finishSubmission(FORM);
  return true;
}

function subscribe(listener: () => void): () => void {
  submissionEvents.addEventListener("change", listener);
  return () => submissionEvents.removeEventListener("change", listener);
}

export function useProductCreationProgress() {
  const snapshot = useSyncExternalStore(subscribe, () => submissionSnapshot(FORM));
  const pending = useSyncExternalStore(subscribe, productCreationPending);
  return { progress: useMemo(() => decode(snapshot), [snapshot]), pending };
}
