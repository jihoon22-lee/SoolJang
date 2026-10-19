import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { productsApi, vendorsApi } from "@/api/client";
import { type Interest, type InterestPurchase, interestsApi } from "@/api/interests";
import { DiscoveryPanel } from "@/components/DiscoveryPanel";
import { InterestEditor } from "@/components/InterestEditor";
import { PriceHistoryPanel } from "@/components/PriceHistoryPanel";
import { publicLink } from "@/discovery/useDiscovery";
import type { ProductContext } from "@/router";
import { matchesQuery } from "@/search";
import { databaseIdentity } from "@/sync/db";
import { captureFormDraft, clearSubmittedDraft, useDraftState } from "@/sync/drafts";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { useSessionMutation } from "@/sync/useSessionMutation";
import "@/discovery/discovery-quality.css";

function stateOf(row: Interest) {
  return row.deleted
    ? "deleted"
    : row.product_id
      ? "purchased"
      : row.archived
        ? "archived"
        : "active";
}
const states = { active: "관심 중", archived: "보관", purchased: "구매 완료", deleted: "삭제됨" };
export function InterestsPage({
  onSelectProduct,
}: {
  onSelectProduct: (id: string, context?: ProductContext) => void;
}) {
  const { state } = useSyncStatus();
  const online = state !== "offline";
  const cache = useQueryClient();
  const interests = useQuery({
    queryKey: ["interests"],
    queryFn: interestsApi.list,
    enabled: online,
  });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("updated");
  const [limit, setLimit] = useState(20);
  const [removeTarget, setRemoveTarget] = useState<Interest | null>(null);
  const [priceHistoryId, setPriceHistoryId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [convert, setConvert] = useState<Interest | null>(null);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ["interests"] });
  };
  const action = useMutation({
    networkMode: "always",
    mutationFn: async (work: () => Promise<unknown>) => {
      if (!online) throw new Error("온라인에서 저장하세요");
      const owner = databaseIdentity();
      await work();
      const now = databaseIdentity();
      if (now.userId !== owner.userId || now.generation !== owner.generation) return;
      setRemoveTarget(null);
      refresh();
    },
    onError: refresh,
  });
  const all = interests.data ?? [];
  const rows = all
    .filter(
      (row) =>
        (status === "all" ? !row.deleted : stateOf(row) === status) &&
        [
          row.name,
          row.identity.name_en ?? "",
          row.identity.producer ?? "",
          ...(row.identity.search_aliases ?? []),
          row.note ?? "",
        ].some((name) => matchesQuery(name, query)),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id)
        : (sort === "created" ? (b.created_at ?? b.updated_at) : b.updated_at).localeCompare(
            sort === "created" ? (a.created_at ?? a.updated_at) : a.updated_at,
          ) || a.id.localeCompare(b.id),
    );
  const comparisons = all.filter((row) => !row.deleted && selected.includes(row.id));
  const edited = all.find((row) => row.id === editing && !row.deleted);
  return (
    <section className="collection-page interest-page">
      <div className="interest-heading">
        <div>
          <h1>관심 목록</h1>
          <p className="muted">
            다음에 경험할 술을 모으고 비교하세요. 관심 저장은 재고와 지출에 포함되지 않습니다.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() => {
            setCreating(!creating);
            setEditing(null);
          }}
        >
          {creating ? "추가 접기" : "관심 추가"}
        </button>
      </div>
      {!online && (
        <output>오프라인입니다. 입력은 보관되며 조회·저장은 온라인에서 사용할 수 있습니다.</output>
      )}
      {creating && (
        <InterestEditor disabled={!online} onChanged={refresh} onClose={() => setCreating(false)} />
      )}
      <div className="interest-toolbar">
        <label>
          관심 검색
          <input
            type="search"
            placeholder="이름·원어명·별칭·메모"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(20);
            }}
          />
        </label>
        <label>
          관심 상태
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setLimit(20);
            }}
          >
            {Object.entries(states).map(([value, label]) => (
              <option value={value} key={value}>
                {label} ({all.filter((row) => stateOf(row) === value).length})
              </option>
            ))}
            <option value="all">전체 (삭제 제외)</option>
          </select>
        </label>
        <label>
          관심 정렬
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="updated">최근 수정순</option>
            <option value="created">최근 추가순</option>
            <option value="name">이름순</option>
          </select>
        </label>
      </div>
      {(action.error || interests.error) && (
        <p role="alert">{action.error?.message ?? interests.error?.message}</p>
      )}
      {interests.isPending && online && <output>관심 기록을 불러오는 중…</output>}
      {interests.isError && (
        <button type="button" disabled={!online} onClick={() => void interests.refetch()}>
          목록 다시 불러오기
        </button>
      )}
      {edited && (
        <InterestEditor
          key={edited.id}
          interest={edited}
          disabled={!online}
          onChanged={refresh}
          onClose={() => setEditing(null)}
        />
      )}
      {!interests.isPending && !rows.length && (
        <p className="notice">
          {query
            ? "검색에 맞는 관심이 없습니다."
            : status === "active"
              ? "아직 관심으로 저장한 술이 없습니다. 관심 추가 또는 탐색에서 시작하세요."
              : "이 상태의 관심 기록이 없습니다."}
        </p>
      )}
      <ul className="interest-list">
        {rows.slice(0, limit).map((row) => (
          <li key={row.id}>
            <div className="interest-row-heading">
              <div>
                <h2>{row.name}</h2>
                {row.identity.name_en && <p className="muted">{row.identity.name_en}</p>}
              </div>
              <span className="interest-state">{states[stateOf(row)]}</span>
            </div>
            <p className="interest-facts">
              {row.identity.producer && `${row.identity.producer} · `}
              {row.identity.volumes_ml?.length
                ? `${row.identity.volumes_ml.join(" / ")} ml`
                : "용량 미상"}{" "}
              · {row.identity.abv != null ? `${row.identity.abv}%` : "도수 미상"}
              {row.identity.vintage != null && ` · ${row.identity.vintage}년 빈티지`}
              {row.identity.age_years != null && ` · ${row.identity.age_years}년 숙성`}
            </p>
            <p className="interest-note-preview">{row.note || "관심 메모 없음"}</p>
            <div className="button-row">
              {!row.deleted && (
                <>
                  <label className="interest-compare">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      disabled={!selected.includes(row.id) && selected.length >= 4}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, row.id]
                            : selected.filter((id) => id !== row.id),
                        )
                      }
                    />
                    비교 선택
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(row.id);
                      setCreating(false);
                    }}
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    disabled={!online || action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        interestsApi.update(row.id, {
                          archived: !row.archived,
                          expected_updated_at: row.updated_at,
                        }),
                      )
                    }
                  >
                    {row.archived ? "관심 복원" : "관심 보관"}
                  </button>
                  <button
                    type="button"
                    disabled={!online || action.isPending}
                    onClick={() => {
                      action.reset();
                      setRemoveTarget(row);
                    }}
                  >
                    삭제
                  </button>
                  {row.product_id ? (
                    <button type="button" onClick={() => onSelectProduct(row.product_id as string)}>
                      구매 전환한 제품 보기
                    </button>
                  ) : (
                    !row.archived && (
                      <button type="button" disabled={!online} onClick={() => setConvert(row)}>
                        구매 전환
                      </button>
                    )
                  )}
                </>
              )}
              {row.deleted && (
                <button
                  type="button"
                  disabled={!online || action.isPending}
                  onClick={() => action.mutate(() => interestsApi.restore(row.id, row.updated_at))}
                >
                  삭제 복구
                </button>
              )}
            </div>
            {!row.deleted && (
              <details>
                <summary>출처·가격·자료 확인</summary>
                {(row.reference_urls ?? []).map(
                  (url) =>
                    publicLink(url) && (
                      <p key={url}>
                        <a href={publicLink(url)} target="_blank" rel="noreferrer">
                          {new URL(url).hostname} 참고 출처
                        </a>
                      </p>
                    ),
                )}
                {!row.archived && <InterestDiscovery interest={row} offline={!online} />}
                <button
                  type="button"
                  disabled={!online}
                  onClick={() => setPriceHistoryId(priceHistoryId === row.id ? null : row.id)}
                >
                  가격 이력·목표가
                </button>
                {priceHistoryId === row.id && <PriceHistoryPanel interestId={row.id} />}
              </details>
            )}
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" onClick={() => setLimit(limit + 20)}>
          관심 더 보기 ({Math.min(limit, rows.length)} / {rows.length})
        </button>
      )}
      {removeTarget && (
        <section className="card interest-delete" aria-label="관심 삭제 확인">
          <h2>‘{removeTarget.name}’ 관심을 삭제할까요?</h2>
          <p>
            구매·병·가격 관측은 유지합니다. 가격 감시와 대기 알림은 중지하며, 삭제 목록에서 복구해도
            감시를 자동 재개하지 않습니다.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={!online || action.isPending}
              onClick={() =>
                action.mutate(() => interestsApi.remove(removeTarget.id, removeTarget.updated_at))
              }
            >
              관심 삭제 확인
            </button>
            <button type="button" disabled={action.isPending} onClick={() => setRemoveTarget(null)}>
              취소
            </button>
            {all.some(
              (row) => row.id === removeTarget.id && row.updated_at !== removeTarget.updated_at,
            ) && (
              <button
                type="button"
                onClick={() =>
                  setRemoveTarget(all.find((row) => row.id === removeTarget.id) ?? null)
                }
              >
                최신 기록으로 다시 확인
              </button>
            )}
          </div>
        </section>
      )}
      {comparisons.length > 0 && (
        <section className="card">
          <h2>관심 비교 ({comparisons.length}/4)</h2>
          <button type="button" onClick={() => setSelected([])}>
            비교 선택 해제
          </button>
          <div className="table-scroll table-scroll--always">
            <table>
              <thead>
                <tr>
                  <th>항목</th>
                  {comparisons.map((row) => (
                    <th key={row.id}>{row.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["용량", (row: Interest) => row.identity.volumes_ml?.join(" / ") || "미상"],
                    ["도수", (row: Interest) => row.identity.abv ?? "미상"],
                    ["빈티지", (row: Interest) => row.identity.vintage ?? "미상"],
                    ["노트", (row: Interest) => row.note || "없음"],
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    {comparisons.map((row) => (
                      <td key={row.id}>{value(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {convert && (
        <InterestConversionForm
          key={convert.id}
          interest={convert}
          disabled={!online}
          onClose={() => setConvert(null)}
          onConverted={(id, context) => {
            setConvert(null);
            refresh();
            if (context) onSelectProduct(id, context);
            else onSelectProduct(id);
          }}
        />
      )}
    </section>
  );
}
function InterestDiscovery({ interest, offline }: { interest: Interest; offline: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>관심 자료 탐색</summary>
      {open && <DiscoveryPanel key={interest.id} interest={interest} offline={offline} />}
    </details>
  );
}

function InterestConversionForm({
  interest,
  disabled,
  onClose,
  onConverted,
}: {
  interest: Interest;
  disabled: boolean;
  onClose: () => void;
  onConverted: (id: string, context?: ProductContext) => void;
}) {
  const { triggerSync } = useSyncStatus();
  const formKey = `interest-purchase:${interest.id}`;
  const [form, setForm] = useDraftState(formKey, {
    mode: "existing",
    query: interest.name,
    productId: "",
    skuId: "",
    name: interest.name,
    volume: String(interest.identity.volumes_ml?.[0] ?? ""),
    abv: interest.identity.abv ?? "",
    vintage: String(interest.identity.vintage ?? ""),
    quantity: "1",
    vendorId: "",
    date: "",
    paid: "",
    list: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const products = useQuery({
    queryKey: ["interest-products", form.query],
    queryFn: () => productsApi.list({ q: form.query }),
    enabled: !disabled,
  });
  const product = useQuery({
    queryKey: ["interest-product", form.productId],
    queryFn: () => productsApi.get(form.productId),
    enabled: !disabled && !!form.productId,
  });
  const vendors = useQuery({
    queryKey: ["interest-vendors"],
    queryFn: () => vendorsApi.list(),
    enabled: !disabled,
  });
  const mutation = useSessionMutation({
    mutationFn: async () => {
      if (disabled) throw new Error("온라인에서 구매 전환을 저장하세요");
      const snapshot = captureFormDraft(formKey);
      const input: InterestPurchase = {
        confirmed_identity: true,
        expected_updated_at: interest.updated_at,
        quantity: Number(form.quantity),
        vendor_id: form.vendorId || null,
        purchased_on: form.date || null,
        unit_paid_price: form.paid || null,
        unit_list_price: form.list || null,
      };
      if (form.mode === "existing") input.sku_id = form.skuId;
      else
        input.new_product = {
          name: form.name,
          volume_ml: Number(form.volume),
          abv: form.abv || null,
          vintage: form.vintage ? Number(form.vintage) : null,
          name_en: interest.identity.name_en ?? null,
          producer: interest.identity.producer ?? null,
          age_years: interest.identity.age_years ?? null,
        };
      const result = await interestsApi.purchase(interest.id, input);
      return { result, snapshot };
    },
    onSuccess: ({ result, snapshot }) => {
      if (!mounted.current) return;
      const cleared = clearSubmittedDraft(snapshot);
      triggerSync();
      if (cleared) onConverted(result.product_id);
    },
  });
  const update = (field: keyof typeof form, value: string) => {
    setForm({ ...form, [field]: value });
    setConfirmed(false);
  };
  return (
    <section className="card" aria-label="관심 구매 전환">
      <h2>{interest.name} 구매 전환</h2>
      <p>제품의 판본과 규격을 확정하세요. 관심과 출처 고정은 같은 ID로 보존됩니다.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(undefined);
        }}
      >
        <fieldset disabled={disabled || mutation.isPending}>
          <legend>제품·규격 및 실제 구매</legend>
          <label>
            등록 방식
            <select value={form.mode} onChange={(event) => update("mode", event.target.value)}>
              <option value="existing">기존 제품·규격</option>
              <option value="new">새 제품·규격</option>
            </select>
          </label>
          {form.mode === "existing" ? (
            <>
              <label>
                기존 제품 검색
                <input
                  value={form.query}
                  onChange={(event) => update("query", event.target.value)}
                />
              </label>
              <label>
                구매한 제품
                <select
                  required
                  value={form.productId}
                  onChange={(event) => {
                    setForm({ ...form, productId: event.target.value, skuId: "" });
                    setConfirmed(false);
                  }}
                >
                  <option value="">제품 선택</option>
                  {products.data?.items.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · {row.vintage ?? "빈티지 미상"} · {row.abv ?? "도수 미상"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                구매한 규격
                <select
                  required
                  value={form.skuId}
                  onChange={(event) => update("skuId", event.target.value)}
                >
                  <option value="">규격 선택</option>
                  {product.data?.skus.map((row) => (
                    <option value={row.id} key={row.id}>
                      {row.volume_ml} ml · {row.package_note ?? "포장 메모 없음"}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                새 제품 이름
                <input
                  required
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </label>
              <label>
                구매한 용량 ml
                <input
                  required
                  type="number"
                  min={1}
                  max={100000}
                  value={form.volume}
                  onChange={(event) => update("volume", event.target.value)}
                />
              </label>
              <label>
                확정 도수 %
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={form.abv}
                  onChange={(event) => update("abv", event.target.value)}
                />
              </label>
              <label>
                확정 빈티지
                <input
                  type="number"
                  min={1800}
                  max={2200}
                  value={form.vintage}
                  onChange={(event) => update("vintage", event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            구매 병수
            <input
              required
              type="number"
              min={1}
              max={1000}
              value={form.quantity}
              onChange={(event) => update("quantity", event.target.value)}
            />
          </label>
          <label>
            구매처
            <select
              value={form.vendorId}
              onChange={(event) => update("vendorId", event.target.value)}
            >
              <option value="">미상</option>
              {vendors.data?.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            구매일
            <input
              type="date"
              value={form.date}
              onChange={(event) => update("date", event.target.value)}
            />
          </label>
          <label>
            병당 정가 (원)
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.list}
              onChange={(event) => update("list", event.target.value)}
            />
          </label>
          <label>
            병당 실구매가 (원)
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.paid}
              onChange={(event) => update("paid", event.target.value)}
            />
          </label>
          <p>가격 공란은 선물·포인트 구매 등의 0원으로 기록합니다.</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            제품·판본·규격과 실제 구매 내용을 확인했습니다
          </label>
          <button type="submit" className="primary" disabled={!confirmed}>
            구매와 병 생성
          </button>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </fieldset>
      </form>
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
      {mutation.isSuccess && mutation.data && (
        <output>
          구매를 저장했습니다. 이후 작성한 입력은 남겨 두었습니다.{" "}
          <button
            type="button"
            onClick={() => {
              if (mutation.data) onConverted(mutation.data.result.product_id);
            }}
          >
            구매한 제품 보기
          </button>
        </output>
      )}
    </section>
  );
}
