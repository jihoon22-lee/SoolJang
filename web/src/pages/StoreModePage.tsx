import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import type { Purchase } from "@/api/types";
import { BarcodeScanPanel } from "@/components/BarcodeScanPanel";
import { ExternalInfoCard } from "@/components/ExternalInfoCard";
import { ProductForm } from "@/components/ProductForm";
import { formatCategoryPath, formatMoney, formatRating } from "@/format";
import { rankByQuery } from "@/search";
import {
  getCategoryTree,
  getProduct,
  getProducts,
  getPurchasesForProduct,
  getVendors,
} from "@/sync/queries";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { useCreateProduct } from "@/sync/useCreateProduct";

//: 검색창 아래 보여줄 후보 수. 매장에서 화면을 크게 스크롤하지 않아도 훑을 수 있는 정도.
const MAX_RESULTS = 8;

/**
 * 매장 모드(`#scan`, Task 22 PR10).
 *
 * "마트·주류샵에서 술을 앞에 두고 앱을 켠다"는 이 앱의 본래 사용 시나리오를 1급 화면으로
 * 만든다(plan.md Task 22 Track 4). 바코드 스캔·이름 검색 중 하나로 술을 찾으면 두 갈래로
 * 갈린다 — 이미 등록된 술이면 구매가·평점·재고를 즉시 보여주고(`StoreModeSummary`), 처음
 * 보는 술이면 등록 폼과 외부 정보 조회를 이어 붙인다.
 *
 * 매장은 통신이 나쁠 수 있다 — 로컬 정보(구매 이력·평점)는 Dexie 에서 즉시 읽어 보여주고,
 * 외부 조회(`ExternalInfoCard`)는 별도 컴포넌트라 그 실패·지연이 나머지 화면을 막지 않는다.
 */
export function StoreModePage({ onOpenDetail }: { onOpenDetail: (productId: string) => void }) {
  const { state } = useSyncStatus();
  const offline = state === "offline";
  const [query, setQuery] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const products = useLiveQuery(() => getProducts({}), []);
  const vendors = useLiveQuery(() => getVendors(), []);
  const vendorNames = (vendors ?? []).map((vendor) => vendor.name);
  const results = query.trim()
    ? rankByQuery(products ?? [], query, (product) => product.name).slice(0, MAX_RESULTS)
    : [];

  function reset(): void {
    setQuery("");
    setSelectedProductId(null);
    setRegistering(false);
  }

  if (selectedProductId !== null) {
    return (
      <StoreModeSummary
        productId={selectedProductId}
        offline={offline}
        onOpenDetail={onOpenDetail}
        onBack={reset}
      />
    );
  }

  if (registering) {
    return (
      <StoreModeRegister
        initialName={query.trim()}
        existingProducts={products ?? []}
        vendorNames={vendorNames}
        onDone={(productId) => setSelectedProductId(productId)}
        onCancel={() => setRegistering(false)}
      />
    );
  }

  return (
    <section aria-labelledby="store-mode-heading" className="panel">
      <h2 id="store-mode-heading">매장 모드</h2>
      <p className="muted">
        바코드를 스캔하거나 이름을 검색하면, 전에 얼마에 샀는지·평점이 어땠는지 바로 보여줍니다.
        처음 보는 술이면 외부 평점·판매처 시세를 확인할 수 있습니다.
      </p>

      {!offline && <BarcodeScanPanel onSelectProduct={(id) => setSelectedProductId(id)} />}
      {offline && <p className="muted text-sm">바코드 스캔은 온라인일 때만 할 수 있습니다.</p>}

      <div className="field mt-3">
        <label htmlFor="store-mode-search">이름으로 찾기</label>
        <input
          id="store-mode-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="예: 글렌피딕"
        />
      </div>

      {query.trim() && (
        <>
          {results.length > 0 ? (
            <ul className="store-mode-results">
              {results.map((product) => (
                <li key={product.id}>
                  <button type="button" onClick={() => setSelectedProductId(product.id)}>
                    <span className="name">{product.name}</span>
                    <span className="muted">{formatCategoryPath(product.category_path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <output className="notice">
              일치하는 술이 없습니다. 처음 보는 술이면 등록하면서 외부 정보를 확인하세요.
            </output>
          )}
          <button type="button" className="primary" onClick={() => setRegistering(true)}>
            "{query.trim()}" 새로 등록
          </button>
        </>
      )}
    </section>
  );
}

function StoreModeRegister({
  initialName,
  existingProducts,
  vendorNames,
  onDone,
  onCancel,
}: {
  initialName: string;
  existingProducts: { id: string; name: string }[];
  vendorNames: string[];
  onDone: (productId: string) => void;
  onCancel: () => void;
}) {
  const categoryTree = useLiveQuery(() => getCategoryTree(), []);
  const createProduct = useCreateProduct();

  return (
    <div>
      <button type="button" className="mb-3" onClick={onCancel}>
        ← 검색으로
      </button>
      <ProductForm
        categories={categoryTree?.items ?? []}
        submitting={createProduct.isPending}
        error={createProduct.error}
        onSubmit={(values) =>
          createProduct.mutate({ values }, { onSuccess: (productId) => onDone(productId) })
        }
        onCancel={onCancel}
        initialValues={{ name: initialName }}
        existingProducts={existingProducts}
        vendorNames={vendorNames}
      />
    </div>
  );
}

function StoreModeSummary({
  productId,
  offline,
  onOpenDetail,
  onBack,
}: {
  productId: string;
  offline: boolean;
  onOpenDetail: (productId: string) => void;
  onBack: () => void;
}) {
  const product = useLiveQuery(() => getProduct(productId), [productId]);
  const purchases = useLiveQuery(() => getPurchasesForProduct(productId), [productId]);

  if (product === undefined || purchases === undefined) {
    return <output aria-live="polite">불러오는 중…</output>;
  }

  if (product === null) {
    return (
      <>
        <p className="alert" role="alert">
          제품을 찾을 수 없습니다
        </p>
        <button type="button" onClick={onBack}>
          ← 다시 검색
        </button>
      </>
    );
  }

  const { latest, lowest } = priceHighlights(purchases);

  return (
    <section aria-labelledby="store-mode-summary-heading" className="panel">
      <button type="button" className="mb-3" onClick={onBack}>
        ← 다시 검색
      </button>
      <h2 id="store-mode-summary-heading" className="mb-1">
        {product.name}
      </h2>
      <p className="muted mt-0">{formatCategoryPath(product.category_path)}</p>

      <dl className="product-card-dl">
        <div>
          <dt className="muted">재고</dt>
          <dd>{product.metrics.in_stock_count}병</dd>
        </div>
        <div>
          <dt className="muted">내 평점</dt>
          <dd>{formatRating(product.personal_rating)}</dd>
        </div>
        <div>
          <dt className="muted">최근 구매가</dt>
          <dd>{latest ? formatMoney(latest) : "구매 기록 없음"}</dd>
        </div>
        <div>
          <dt className="muted">최저 구매가</dt>
          <dd>{lowest ? formatMoney(lowest) : "구매 기록 없음"}</dd>
        </div>
        <div>
          <dt className="muted">평균 구매가</dt>
          <dd>{formatMoney(product.metrics.avg_paid_price)}</dd>
        </div>
      </dl>

      {product.note && <p className="pre-wrap">{product.note}</p>}

      <div className="button-row">
        <button type="button" onClick={() => onOpenDetail(productId)}>
          상세로 이동 (구매 추가·시음 기록 등)
        </button>
      </div>

      <ExternalInfoCard productId={productId} offline={offline} />
    </section>
  );
}

/** 구매 이력에서 최근·최저 단가를 뽑는다. 실구매가가 없으면 정가로 대체한다. */
function priceHighlights(purchases: Purchase[]): { latest: string | null; lowest: string | null } {
  const priced = purchases
    .map((purchase) => ({ purchase, price: purchase.unit_paid_price ?? purchase.unit_list_price }))
    .filter((entry): entry is { purchase: Purchase; price: string } => entry.price !== null);

  if (priced.length === 0) return { latest: null, lowest: null };

  const latest = [...priced].sort((a, b) =>
    (b.purchase.purchased_on ?? "").localeCompare(a.purchase.purchased_on ?? ""),
  )[0];
  const lowest = priced.reduce((min, entry) =>
    Number(entry.price) < Number(min.price) ? entry : min,
  );

  return { latest: latest?.price ?? null, lowest: lowest.price };
}
