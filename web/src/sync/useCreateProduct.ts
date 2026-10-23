import { ApiError, attachmentsApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import type { Product } from "@/api/types";
import type { ProductFormValues } from "@/components/ProductForm";
import { setLastVendorName } from "@/lastVendor";
import { normalizeNameForMatching } from "@/search";
import { db, type SoolJangDB } from "@/sync/db";
import {
  captureFormDraft,
  clearSubmittedDraft,
  finishSubmission,
  pendingSubmissionRequestId,
  submissionRequestId,
} from "@/sync/drafts";
import { validNumericInput } from "@/sync/inputContract";
import { enqueue } from "@/sync/outbox";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import {
  beginProductCreation,
  creationLabel,
  finishProductCreation,
  type ProductCreationProgress,
  productCreationPending,
  readProductCreationProgress,
  saveProductCreationProgress,
  useProductCreationProgress,
} from "@/sync/useCreateProductProgress";
import { useSessionMutation } from "@/sync/useSessionMutation";
import { newId } from "@/sync/uuid7";
import { captureWriteSession, type WriteSession } from "@/sync/writeSession";

export interface CreateProductInput {
  values: ProductFormValues;
  /** 라벨 OCR(Task 17) 원본 사진. 온라인일 때만 첨부된다. `ProductsPage` 의 등록 폼만 쓴다 —
   * 매장 모드(Task 22 PR10)는 사진 촬영 흐름이 없어 생략한다. */
  labelFile?: File | null;
  /** 이전 호출자와의 호환 입력. 새 폼 인스턴스는 보관한 성공 단계를 자동으로 이어 쓴다. */
  existingProduct?: Product | null;
  /** 이전 시도에서 구매까지 성공했는지. 새 호출자는 보관한 단계에서 읽는다. */
  purchaseAlreadyCreated?: boolean;
}

/** 제품은 이미 서버에 커밋됐는데 구매/첨부 단계가 실패했을 때 던진다. 폼을 닫지 않고 이
 * 안의 `product`/`purchaseCreated` 를 다음 `CreateProductInput` 에 그대로 넘기면, 이미
 * 성공한 단계를 되풀이하지 않고 실패한 부분부터 재시도할 수 있다. */
export class PartialProductCreationError extends Error {
  constructor(
    message: string,
    readonly product: Product,
    readonly purchaseCreated: boolean,
  ) {
    super(message);
    this.name = "PartialProductCreationError";
  }
}

/**
 * 제품 등록(신규 제품 + 선택적 첫 구매 건)을 온라인/오프라인 분기와 함께 캡슐화한 훅.
 *
 * `ProductsPage` 의 등록 폼과 매장 모드(`StoreModePage`)의 "바로 등록" 폼이 완전히 같은
 * 로직을 필요로 해 공유 훅으로 뽑았다 — 두 곳에서 실제로 쓰이는 중복이라 추상화 비용이
 * 정당하다(가상의 미래 재사용이 아니다).
 */
export function useCreateProduct() {
  const { state, triggerSync } = useSyncStatus();
  const { progress, pending } = useProductCreationProgress();
  const offline = state === "offline";

  const mutation = useSessionMutation({
    mutationFn: async (input: CreateProductInput, session) => {
      const previous = readProductCreationProgress();
      if (previous?.completedId)
        throw new Error("이미 등록한 술입니다. 보관한 입력은 등록한 술에서 확인하세요");
      if (previous?.productConflict)
        throw new Error(
          "앞선 등록 요청이 충돌했습니다. 술 목록을 확인한 뒤 요청을 중단하고 새로 작성하세요",
        );
      const end = beginProductCreation(session);
      const draft = captureFormDraft("product:create");
      const { values } = input;
      const label = creationLabel(input.labelFile, previous?.labelPending ?? false);
      const current: ProductCreationProgress = {
        version: 1,
        onlineAttempted: previous?.onlineAttempted ?? false,
        product: input.existingProduct ?? previous?.product ?? null,
        productRequest: previous?.productRequest ?? null,
        productConflict: false,
        purchaseRequest: previous?.purchaseRequest ?? null,
        purchaseCreated: input.purchaseAlreadyCreated ?? previous?.purchaseCreated ?? false,
        labelPending: Boolean(label) || (previous?.labelPending ?? false),
        completedId: null,
        draftCleared: false,
        error: null,
        values: { ...values },
      };
      const draftMatchesInput = draftContainsValues(draft, values);
      let remembered = false;
      const remember = () => {
        session.assertCurrent();
        saveProductCreationProgress({ ...current });
        remembered = true;
      };
      try {
        for (const [field, value] of [
          ["quantity", values.quantity],
          ["volume_ml", values.volumeMl],
          ["abv", values.abv],
          ["price", values.unitListPrice],
          ["price", values.unitPaidPrice],
          ["personal_rating", values.personalRating],
        ] as const) {
          if (value && !validNumericInput(field, value))
            throw new Error("입력한 수치가 허용 범위를 벗어났습니다");
        }
        if (values.quantity && !values.volumeMl)
          throw new Error("구매 정보를 입력하려면 용량이 필요합니다");
        if (
          previous?.productRequest &&
          !previous.product &&
          JSON.stringify(productPayload(previous.values)) !== JSON.stringify(productPayload(values))
        )
          throw new Error(
            "앞서 보낸 제품 결과가 미확정입니다. 보낸 입력으로 결과를 확인한 뒤 등록한 술에서 수정하세요",
          );
        if (
          previous?.purchaseRequest &&
          !previous.purchaseCreated &&
          JSON.stringify(purchaseFields(previous.values)) !== JSON.stringify(purchaseFields(values))
        )
          throw new PartialProductCreationError(
            "앞서 보낸 구매 결과가 미확정입니다. 보낸 입력으로 결과를 확인한 뒤 구매 이력에서 수정하세요",
            previous.product as Product,
            false,
          );
        if (
          previous?.product &&
          (JSON.stringify(productPayload(previous.values)) !==
            JSON.stringify(productPayload(values)) ||
            (previous.purchaseCreated &&
              JSON.stringify(purchaseFields(previous.values)) !==
                JSON.stringify(purchaseFields(values))))
        )
          throw new PartialProductCreationError(
            "이미 등록한 정보가 입력과 다릅니다. 보관한 입력을 확인하고 등록한 술에서 수정하세요",
            previous.product,
            previous.purchaseCreated,
          );
        if (
          previous?.product &&
          !previous.purchaseCreated &&
          !values.quantity.trim() &&
          pendingSubmissionRequestId(`product:create:purchase:${previous.product.id}`)
        )
          throw new PartialProductCreationError(
            "앞서 보낸 구매 결과가 미확정입니다. 원래 구매 입력으로 다시 확인하거나 남은 입력 지우기를 선택하세요",
            previous.product,
            false,
          );
        const productForm = "product:create:product";
        if (
          offline &&
          (current.product || current.onlineAttempted || pendingSubmissionRequestId(productForm))
        ) {
          current.onlineAttempted = true;
          remember();
          const message =
            "앞서 보낸 등록은 온라인에서 이어서 확인하세요. 입력과 저장된 단계는 보존했습니다";
          if (current.product)
            throw new PartialProductCreationError(
              message,
              current.product,
              current.purchaseCreated,
            );
          throw new Error(message);
        }
        current.onlineAttempted = !offline;
        remember();
        if (offline && current.labelPending)
          throw new Error(
            "라벨 사진이 있는 등록은 온라인에서 저장하세요. 입력과 사진은 보관했습니다",
          );
        let productId: string;
        if (!offline) {
          // 두 요청 키는 전체 등록이 끝날 때까지 유지한다. 폼을 다시 열거나 새로고침해도
          // 이미 성공한 제품·구매 단계는 recovery 기록과 서버 멱등 응답으로 이어간다.
          const productRequestId =
            current.productRequest?.request_id ?? submissionRequestId(productForm);
          let product = current.product;
          if (!product) {
            const wasUncertain = Boolean(previous?.productRequest);
            current.productRequest ??= { ...productPayload(values), request_id: productRequestId };
            remember();
            product = await productsApi.create(current.productRequest).catch((error: unknown) => {
              session.assertCurrent();
              // 첫 전송의 422만 입력 수정을 허용한다. 앞서 응답을 잃었다면 422에도 원래
              // payload를 보존한다. 409는 자동 재전송을 멈추고 명시적 중단을 기다린다.
              if (!wasUncertain && error instanceof ApiError && error.status === 422)
                current.productRequest = null;
              if (error instanceof ApiError && error.status === 409) current.productConflict = true;
              throw error;
            });
            session.assertCurrent();
            current.product = product;
            remember();
            await mirrorProductOptimistically(product, session.userId);
            session.assertCurrent();
            triggerSync();
          } else if (!(await session.store.product.get(product.id))) {
            session.assertCurrent();
            await mirrorProductOptimistically(product, session.userId);
          }
          session.assertCurrent();
          const purchaseForm = `product:create:purchase:${product.id}`;
          try {
            const quantity = parseQuantity(values.quantity);
            if (!current.purchaseCreated && quantity > 0) {
              const wasUncertain = Boolean(previous?.purchaseRequest);
              if (!current.purchaseRequest) {
                // 응답을 잃고 다시 받은 제품에는 다른 탭이 추가·수정한 규격이 있을 수 있다.
                // 원래 용량이 하나로 정해질 때만 구매를 만들며 미확정 구매는 저장한 SKU를 쓴다.
                const matches = product.skus.filter(
                  (sku) => sku.volume_ml === Number(values.volumeMl),
                );
                const sku = matches.length === 1 ? matches[0] : undefined;
                if (!sku)
                  throw new Error(
                    "입력한 용량의 규격을 확인할 수 없습니다. 등록한 술에서 규격과 구매를 확인하세요",
                  );
                const vendorId = values.vendorName.trim()
                  ? await resolveVendorId(values.vendorName.trim(), session)
                  : null;
                session.assertCurrent();
                current.purchaseRequest = {
                  sku_id: sku.id,
                  quantity,
                  vendor_id: vendorId,
                  purchased_on: values.purchasedOn || null,
                  unit_list_price: values.unitListPrice || null,
                  unit_paid_price: values.unitPaidPrice || null,
                  request_id: submissionRequestId(purchaseForm),
                };
              }
              remember();
              await purchasesApi.create(current.purchaseRequest).catch((error: unknown) => {
                session.assertCurrent();
                if (!wasUncertain && error instanceof ApiError && error.status === 422)
                  current.purchaseRequest = null;
                throw error;
              });
              session.assertCurrent();
              current.purchaseCreated = true;
              remember();
            }
            if (current.labelPending) {
              if (!label)
                throw new Error(
                  "라벨 사진을 다시 선택한 뒤 이어서 저장하세요. 제품과 구매는 다시 만들지 않습니다",
                );
              await attachmentsApi.create(label, { kind: "label", product_id: product.id });
              session.assertCurrent();
              current.labelPending = false;
              remember();
            }
          } catch (cause) {
            session.assertCurrent();
            const message = cause instanceof Error ? cause.message : String(cause);
            throw new PartialProductCreationError(
              `"${product.name}" 제품은 이미 등록됐습니다. 나머지 항목 저장에 실패했습니다: ${message}`,
              product,
              current.purchaseCreated,
            );
          }
          session.assertCurrent();
          finishSubmission(purchaseForm);
          finishSubmission(productForm, productRequestId);
          productId = product.id;
        } else {
          productId = await createProductOffline(values, session.userId);
        }
        session.assertCurrent();
        current.completedId = productId;
        current.draftCleared = draftMatchesInput && clearSubmittedDraft(draft);
        remember();
        if (values.vendorName.trim()) setLastVendorName(values.vendorName);
        triggerSync();
        return productId;
      } catch (cause) {
        if (session.isCurrent() && remembered) {
          current.error = cause instanceof Error ? cause.message : "등록을 저장하지 못했습니다";
          remember();
        }
        throw cause;
      } finally {
        end();
      }
    },
  });
  return {
    ...mutation,
    progress,
    isPending: pending || mutation.isPending,
    error: mutation.error ?? (progress?.error ? new Error(progress.error) : null),
    reset() {
      if (productCreationPending()) return;
      mutation.reset();
      finishProductCreation();
    },
    discardCompleted(draft: ReturnType<typeof captureFormDraft>): boolean {
      const current = readProductCreationProgress();
      const productId = current?.completedId ?? current?.product?.id;
      if (
        productCreationPending() ||
        !current ||
        (!productId && !current.productConflict) ||
        !clearSubmittedDraft(draft)
      )
        return false;
      // 사용자가 이미 만들어진 술을 확인한 뒤 남은 입력을 명시적으로 포기하는 경우다.
      // 서버 기록은 삭제하지 않는다. ID가 없어도 확정 409는 명시적으로 중단할 수 있지만,
      // 네트워크 오류·5xx처럼 결과가 미확정인 요청은 계속 보존한다.
      finishSubmission("product:create:product");
      if (productId) finishSubmission(`product:create:purchase:${productId}`);
      saveProductCreationProgress({
        ...current,
        completedId: productId ?? null,
        draftCleared: true,
      });
      const finished = finishProductCreation(true);
      if (finished) mutation.reset();
      return finished;
    },
  };
}

/** 원래 전송을 재확인할 때 이후에 보관한 다른 입력을 성공한 초안으로 지우지 않는다. */
function draftContainsValues(
  draft: ReturnType<typeof captureFormDraft>,
  values: ProductFormValues,
): boolean {
  if (draft.entries.length === 0) return true;
  if (draft.entries.length !== 1 || draft.entries[0]?.[0] !== draft.prefix) return false;
  try {
    const stored: unknown = JSON.parse(draft.entries[0]?.[1] ?? "null")?.value;
    return (
      stored !== null &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      Object.entries(stored).every(
        ([key, value]) => value === values[key as keyof ProductFormValues],
      )
    );
  } catch {
    return false;
  }
}

function purchaseFields(values: ProductFormValues) {
  return [
    values.quantity,
    values.vendorName,
    values.purchasedOn,
    values.unitListPrice,
    values.unitPaidPrice,
  ];
}

function productPayload(values: ProductFormValues) {
  return {
    name: values.name.trim(),
    name_en: values.nameEn?.trim() || null,
    search_aliases: (values.searchAliases ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    category_id: values.categoryId || null,
    abv: values.abv || null,
    vintage: values.vintage ? Number(values.vintage) : null,
    age_years: values.ageYears || null,
    producer_name: values.producerName?.trim() || null,
    personal_rating: values.personalRating || null,
    note: values.note || null,
    variety_names: splitVarieties(values.varietyNames),
    skus: values.volumeMl ? [{ volume_ml: Number(values.volumeMl) }] : [],
  };
}

/** 온라인 생성 응답을 로컬 미러(`db.product`/`db.sku`)에 낙관적으로 반영한다. */
async function mirrorProductOptimistically(product: Product, userId: string): Promise<void> {
  const session = captureWriteSession();
  session.assertCurrent();
  if (session.userId !== userId) throw new Error("다른 계정의 저장 결과입니다");
  const db = session.store;
  const now = new Date().toISOString();
  await db.transaction("rw", db.product, db.sku, db.sync_meta, async () => {
    session.assertCurrent();
    // 이 행의 updated_at 은 기기 시계다. 기기 시계가 서버보다 빠르면 다음 pull 의 서버 행이
    // "더 오래됐다" 고 판단돼 무시된다 — 서버가 정규화한 값(생산자 등)을 반드시 받도록
    // 비교 없이 덮어쓸 대상으로 표시한다.
    const reconcile = new Set<string>(
      JSON.parse((await db.sync_meta.get("reconcile_ids"))?.value ?? "[]"),
    );
    reconcile.add(product.id);
    for (const sku of product.skus) reconcile.add(sku.id);
    await db.sync_meta.put({ key: "reconcile_ids", value: JSON.stringify([...reconcile]) });
    await db.product.put({
      id: product.id,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name: product.name,
      name_en: product.name_en,
      search_aliases: product.search_aliases ?? [],
      normalized_name: normalizeNameForMatching(product.name),
      category_id: product.category_id,
      producer_id: product.producer_id,
      country: product.country,
      region: product.region,
      abv: product.abv,
      vintage: product.vintage,
      age_years: product.age_years,
      personal_rating: product.personal_rating,
      note: product.note,
      import_note: null,
    });
    for (const sku of product.skus) {
      await db.sku.put({
        id: sku.id,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        product_id: product.id,
        volume_ml: sku.volume_ml,
        barcode: sku.barcode,
        barcode_type: sku.barcode_type,
        package_note: sku.package_note,
      });
    }
    session.assertCurrent();
  });
}

/**
 * 병수 입력을 검증한다. 빈 값은 "구매 정보 없음" 이라 0 을 돌려준다.
 *
 * `ProductForm` 이 이미 폼 단계에서 이 조건을 막지만, 이 훅 자체도(신뢰 경계 — 여기서
 * 만든 값이 그대로 서버 요청/outbox 항목이 된다) 독립적으로 확인한다. 정수가 아닌
 * 병수가 여기까지 오면 낙관적으로 만드는 병 id 개수와 서버에 보내는 `quantity` 가
 * 어긋나(예: "2.5" → 병 2개, quantity 2.5) 오프라인 동기화 큐가 영구히 막히는
 * 결함으로 실사용 중 발견됐다.
 */
function parseQuantity(raw: string): number {
  if (!raw.trim()) return 0;
  const value = Number(raw);
  if (!validNumericInput("quantity", value)) {
    throw new Error("병수는 1 이상의 정수를 입력하세요");
  }
  return value;
}

export function splitVarieties(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 구매처 이름으로 id 를 찾고, 없으면 만든다. 매번 목록에서 고르게 하면 입력이 느려진다. */
export async function resolveVendorId(name: string, session: WriteSession): Promise<string> {
  session.assertCurrent();
  const vendors = await vendorsApi.list();
  session.assertCurrent();
  const existing = vendors.find((vendor) => vendor.name === name);
  if (existing) return existing.id;
  const created = await vendorsApi.create({ name });
  session.assertCurrent();
  return created.id;
}

/**
 * 오프라인 등록 체인: product → sku → (필요하면) vendor → purchase 순으로 outbox 에 쌓는다.
 *
 * 서버는 `purchase.create` 안에서 `bottle_ids` 로 병을 자동 생성한다(`POST /purchases` 의
 * 온라인 동작과 같다) — 그래서 별도 `bottle.create` 오퍼레이션을 보내지 않는다. 로컬 미러에는
 * 낙관적으로 병 행을 직접 써서 병 화면이 바로 재고를 보여주게 한다.
 *
 * 품종(품종·스타일)은 오프라인 쓰기 대상 7종에 들어 있지 않아 여기서는 지정할 수 없다 —
 * 온라인일 때 다시 시도해야 한다.
 *
 * 반환값은 낙관적으로 만든 로컬 id다 — 서버가 outbox 를 처리하기 전까지는 서버 id 와
 * 다를 수 있지만(동기화가 화해한다), 즉시 그 제품 상세로 이동하는 데는 이걸로 충분하다.
 */
export async function createProductOffline(
  values: ProductFormValues,
  userId: string,
): Promise<string> {
  const session = captureWriteSession();
  session.assertCurrent();
  if (session.userId !== userId) throw new Error("다른 계정의 입력을 저장할 수 없습니다");
  const store = session.store;
  return await store.transaction("rw", store.tables, async () => {
    session.assertCurrent();
    const id = await createProductOfflineChain(values, session);
    session.assertCurrent();
    return id;
  });
}

async function createProductOfflineChain(
  values: ProductFormValues,
  session: WriteSession,
): Promise<string> {
  const db = session.store;
  const userId = session.userId;
  const now = new Date().toISOString();

  const productId = newId();
  const abv = values.abv || null;
  const vintage = values.vintage ? Number(values.vintage) : null;
  const ageYears = values.ageYears || null;
  const personalRating = values.personalRating || null;
  const categoryId = values.categoryId || null;
  // 생산자는 오프라인 쓰기 대상 7종에 없어 새로 만들 수 없다 — 미러에 이미 있으면 재사용,
  // 없으면 잃지 않게 메모로 보존한다(온라인 등록처럼 실제 필드로 저장할 수는 없다).
  const { producerId, note } = await resolveOfflineProducer(values.producerName, values.note, db);

  session.assertCurrent();
  await enqueue({
    entity: "product",
    op: "create",
    entityId: productId,
    fields: {
      name_en: values.nameEn?.trim() || null,
      name: values.name.trim(),
      search_aliases: (values.searchAliases ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      category_id: categoryId,
      producer_id: producerId,
      abv,
      vintage,
      age_years: ageYears,
      personal_rating: personalRating,
      note,
    },
    optimisticRow: {
      id: productId,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name: values.name.trim(),
      search_aliases: (values.searchAliases ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      name_en: values.nameEn?.trim() || null,
      category_id: categoryId,
      producer_id: producerId,
      country: null,
      region: null,
      abv,
      vintage,
      age_years: ageYears,
      personal_rating: personalRating,
      note,
    },
  });

  let skuId: string | null = null;
  if (values.volumeMl) {
    skuId = newId();
    const volumeMl = Number(values.volumeMl);
    session.assertCurrent();
    await enqueue({
      entity: "sku",
      op: "create",
      entityId: skuId,
      fields: { product_id: productId, volume_ml: volumeMl },
      optimisticRow: {
        id: skuId,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        product_id: productId,
        volume_ml: volumeMl,
        barcode: null,
        barcode_type: null,
        package_note: null,
      },
    });
  }

  const quantity = parseQuantity(values.quantity);
  if (quantity > 0 && skuId) {
    const vendorId = values.vendorName.trim()
      ? await resolveVendorIdOffline(values.vendorName.trim(), session)
      : null;

    const purchaseId = newId();
    const bottleIds = Array.from({ length: quantity }, () => newId());
    const purchasedOn = values.purchasedOn || null;
    const unitListPrice = values.unitListPrice || null;
    const unitPaidPrice = values.unitPaidPrice || null;

    session.assertCurrent();
    await enqueue({
      entity: "purchase",
      op: "create",
      entityId: purchaseId,
      fields: {
        sku_id: skuId,
        quantity,
        vendor_id: vendorId,
        purchased_on: purchasedOn,
        unit_list_price: unitListPrice,
        unit_paid_price: unitPaidPrice,
        bottle_ids: bottleIds,
      },
      optimisticRow: {
        id: purchaseId,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sku_id: skuId,
        vendor_id: vendorId,
        purchased_on: purchasedOn,
        quantity,
        unit_list_price: unitListPrice,
        unit_paid_price: unitPaidPrice,
        currency: "KRW",
        fx_rate: null,
        foreign_unit_price: null,
        discount_note: null,
        import_note: null,
      },
    });

    session.assertCurrent();
    await db.bottle.bulkPut(
      bottleIds.map((id, index) => ({
        id,
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        purchase_id: purchaseId,
        label_no: index + 1,
        status: "unopened",
        opened_on: null,
        finished_on: null,
        remaining_ml: null,
        storage_location: null,
        note: null,
      })),
    );
  }

  return productId;
}

async function resolveVendorIdOffline(name: string, session: WriteSession): Promise<string> {
  const vendors = await session.store.vendor.toArray();
  session.assertCurrent();
  const existing = vendors.find((vendor) => vendor.deleted_at === null && vendor.name === name);
  if (existing) return existing.id;

  const id = newId();
  const now = new Date().toISOString();
  await enqueue({
    entity: "vendor",
    op: "create",
    entityId: id,
    fields: { name },
    optimisticRow: {
      id,
      user_id: session.userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name,
      kind: "other",
      url: null,
      note: null,
    },
  });
  return id;
}

/** 미러에서 생산자 이름으로 id 를 찾는다. 없으면(오프라인에서 새로 못 만든다) null. */
export async function resolveProducerIdOffline(
  name: string,
  store: SoolJangDB = db,
): Promise<string | null> {
  const producers = await store.producer.toArray();
  const normalized = name.trim().toLowerCase();
  const existing = producers.find(
    (producer) =>
      producer.deleted_at === null && String(producer.name).toLowerCase() === normalized,
  );
  return existing ? existing.id : null;
}

/** 오프라인 등록의 생산자 해석 — 미러에 있으면 id, 없으면 메모로 보존한다. */
async function resolveOfflineProducer(
  rawName: string,
  existingNote: string | null,
  store: SoolJangDB,
): Promise<{ producerId: string | null; note: string | null }> {
  const name = rawName?.trim() || null;
  if (!name) return { producerId: null, note: existingNote || null };
  const producerId = await resolveProducerIdOffline(name, store);
  if (producerId) return { producerId, note: existingNote || null };
  const note = existingNote ? `${existingNote}\n생산자: ${name}` : `생산자: ${name}`;
  return { producerId: null, note };
}
