import { useMutation, useQueryClient } from "@tanstack/react-query";
import { attachmentsApi, productsApi, purchasesApi, vendorsApi } from "@/api/client";
import type { Product, User } from "@/api/types";
import type { ProductFormValues } from "@/components/ProductForm";
import { setLastVendorName } from "@/lastVendor";
import { normalizeNameForMatching } from "@/search";
import { db } from "@/sync/db";
import { enqueue } from "@/sync/outbox";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { newId } from "@/sync/uuid7";

export interface CreateProductInput {
  values: ProductFormValues;
  /** 라벨 OCR(Task 17) 원본 사진. 온라인일 때만 첨부된다. `ProductsPage` 의 등록 폼만 쓴다 —
   * 매장 모드(Task 22 PR10)는 사진 촬영 흐름이 없어 생략한다. */
  labelFile?: File | null;
  /** 이전 시도에서 이미 서버에 만들어진 제품. 호출자가 `PartialProductCreationError` 를
   * 받은 뒤 같은 폼으로 재시도할 때 넘긴다 — `POST /products` 는 멱등키가 없어서, 이 값이
   * 없으면 재시도마다 새 제품이 또 생긴다(B7). */
  existingProduct?: Product | null;
  /** `existingProduct` 재시도 시, 구매 건까지는 이미 성공했는지. `purchasesApi.create` 도
   * 멱등키가 없어 이 값이 없으면 구매(와 그만큼의 병)가 중복 생성된다. 첨부는 `sha256` +
   * 소유 대상으로 서버가 중복 제거하므로(B1) 별도 추적이 필요 없다. */
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
  const queryClient = useQueryClient();
  const { state, triggerSync } = useSyncStatus();
  const offline = state === "offline";

  return useMutation({
    mutationFn: async ({
      values,
      labelFile,
      existingProduct,
      purchaseAlreadyCreated,
    }: CreateProductInput) => {
      if (!offline) {
        // 오프라인 outbox 는 아직 품종(product_variety)을 지원하지 않으므로, 온라인일
        // 때는 이 경로를 그대로 유지해 품종 입력을 지원한다.
        //
        // `existingProduct` 가 있으면 이전 시도에서 이미 만든 제품을 재사용한다 —
        // `POST /products` 는 멱등키가 없어서, 구매/첨부 단계 실패 뒤 재시도할 때마다
        // 다시 부르면 중복 제품이 생긴다(B7).
        const product =
          existingProduct ??
          (await productsApi.create({
            name: values.name.trim(),
            category_id: values.categoryId || null,
            abv: values.abv || null,
            vintage: values.vintage ? Number(values.vintage) : null,
            personal_rating: values.personalRating || null,
            note: values.note || null,
            variety_names: splitVarieties(values.varietyNames),
            skus: values.volumeMl ? [{ volume_ml: Number(values.volumeMl) }] : [],
          }));

        if (!existingProduct) {
          // 서버 응답을 로컬 미러에 낙관적으로 반영한다. 아래 구매·첨부 호출이 실패해도
          // 제품 자체는 이미 서버에 만들어졌으므로, 미러링을 여기서 바로 해 둬야 그 실패가
          // "서버엔 있는데 로컬 미러엔 없는" 고아 제품을 만들지 않는다 — 델타 풀
          // (triggerSync)로 내려오기 전까지 `getProduct()` 가 null 을 돌려줘 매장 모드
          // (Task 22 PR10)처럼 등록 직후 그 제품 화면으로 바로 넘어가는 흐름에서
          // "제품을 찾을 수 없습니다" 가 보이고, 재시도 시 중복 생성으로 이어질 수 있다.
          // 구매·병 행까지는 여기서 만들지 않는다(서버가 만드는 병 id 를 알 수 없다) —
          // 그 부분은 곧 sync 가 채운다.
          await mirrorProductOptimistically(
            product,
            queryClient.getQueryData<User>(["auth", "me"])?.id ?? "",
          );
          triggerSync();
        }

        const quantity = parseQuantity(values.quantity);
        const skuId = product.skus[0]?.id;
        let purchaseCreated = purchaseAlreadyCreated ?? false;
        try {
          if (!purchaseCreated && quantity > 0 && skuId) {
            const vendorId = values.vendorName.trim()
              ? await resolveVendorId(values.vendorName.trim())
              : null;
            await purchasesApi.create({
              sku_id: skuId,
              quantity,
              vendor_id: vendorId,
              purchased_on: values.purchasedOn || null,
              unit_list_price: values.unitListPrice || null,
              unit_paid_price: values.unitPaidPrice || null,
            });
            purchaseCreated = true;
          }
          if (labelFile) {
            // `attachmentsApi.create` 는 (user_id, sha256, kind, 소유 대상) 으로 서버가
            // 중복 제거하므로(B1) 재시도로 같은 파일을 다시 보내도 새 첨부가 안 생긴다 —
            // 구매와 달리 별도 추적이 필요 없다.
            await attachmentsApi.create(labelFile, { kind: "label", product_id: product.id });
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new PartialProductCreationError(
            `"${values.name.trim()}" 제품은 이미 등록됐습니다. 나머지 항목 저장에 실패했습니다: ${message}`,
            product,
            purchaseCreated,
          );
        }
        return product.id;
      }

      return await createProductOffline(
        values,
        queryClient.getQueryData<User>(["auth", "me"])?.id ?? "",
      );
    },
    onSuccess: (_result, { values }) => {
      if (values.vendorName.trim()) setLastVendorName(values.vendorName);
    },
  });
}

/** 온라인 생성 응답을 로컬 미러(`db.product`/`db.sku`)에 낙관적으로 반영한다. */
async function mirrorProductOptimistically(product: Product, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction("rw", db.product, db.sku, async () => {
    await db.product.put({
      id: product.id,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      name: product.name,
      name_en: product.name_en,
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
  if (!Number.isInteger(value) || value <= 0) {
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
export async function resolveVendorId(name: string): Promise<string> {
  const vendors = await vendorsApi.list();
  const existing = vendors.find((vendor) => vendor.name === name);
  if (existing) return existing.id;
  const created = await vendorsApi.create({ name });
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
async function createProductOffline(values: ProductFormValues, userId: string): Promise<string> {
  const now = new Date().toISOString();

  const productId = newId();
  const abv = values.abv || null;
  const vintage = values.vintage ? Number(values.vintage) : null;
  const personalRating = values.personalRating || null;
  const note = values.note || null;
  const categoryId = values.categoryId || null;

  await enqueue({
    entity: "product",
    op: "create",
    entityId: productId,
    fields: {
      name: values.name.trim(),
      category_id: categoryId,
      abv,
      vintage,
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
      name_en: null,
      category_id: categoryId,
      producer_id: null,
      country: null,
      region: null,
      abv,
      vintage,
      age_years: null,
      personal_rating: personalRating,
      note,
    },
  });

  let skuId: string | null = null;
  if (values.volumeMl) {
    skuId = newId();
    const volumeMl = Number(values.volumeMl);
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
      ? await resolveVendorIdOffline(values.vendorName.trim(), userId)
      : null;

    const purchaseId = newId();
    const bottleIds = Array.from({ length: quantity }, () => newId());
    const purchasedOn = values.purchasedOn || null;
    const unitListPrice = values.unitListPrice || null;
    const unitPaidPrice = values.unitPaidPrice || null;

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

async function resolveVendorIdOffline(name: string, userId: string): Promise<string> {
  const vendors = await db.vendor.toArray();
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
      user_id: userId,
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
