import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { productsApi, vendorsApi } from "@/api/client";
import { type Interest, type InterestPurchase, interestsApi } from "@/api/interests";
import { clearFormDraft, useDraftState } from "@/sync/drafts";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

export function InterestsPage({ onSelectProduct }: { onSelectProduct: (id: string) => void }) {
  const { state } = useSyncStatus();
  const online = state !== "offline";
  const cache = useQueryClient();
  const interests = useQuery({
    queryKey: ["interests"],
    queryFn: interestsApi.list,
    enabled: online,
  });
  const [form, setForm] = useDraftState("interest-create", {
    name: "",
    volume: "",
    abv: "",
    vintage: "",
    note: "",
    requestId: "",
  });
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [convert, setConvert] = useState<Interest | null>(null);
  const action = useMutation({
    mutationFn: async (work: () => Promise<unknown>) => {
      if (!online) throw new Error("온라인에서 저장하세요");
      await work();
      await cache.invalidateQueries({ queryKey: ["interests"] });
    },
  });
  const comparisons = (interests.data ?? []).filter((row) => selected.includes(row.id));
  return (
    <section className="collection-page">
      <h1>관심 목록</h1>
      <p>
        관심 저장은 재고와 지출에 포함되지 않습니다. 목록·노트·구매 전환은 온라인에서 사용할 수
        있습니다.
      </p>
      {!online && <output>오프라인입니다. 연결한 뒤 관심 기록을 확인하세요.</output>}
      <fieldset disabled={!online || action.isPending}>
        <legend>관심 제품 추가</legend>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate(async () => {
              const requestId = form.requestId || crypto.randomUUID();
              setForm({ ...form, requestId });
              await interestsApi.create(
                {
                  name: form.name,
                  volumes_ml: form.volume ? [Number(form.volume)] : [],
                  abv: form.abv || null,
                  vintage: form.vintage ? Number(form.vintage) : null,
                },
                form.note || null,
                requestId,
              );
              setForm({ name: "", volume: "", abv: "", vintage: "", note: "", requestId: "" });
              clearFormDraft("interest-create");
            });
          }}
        >
          <label>
            관심 제품 이름
            <input
              required
              maxLength={300}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label>
            용량 ml (선택)
            <input
              type="number"
              min={1}
              max={100000}
              value={form.volume}
              onChange={(event) => setForm({ ...form, volume: event.target.value })}
            />
          </label>
          <label>
            도수 % (선택)
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={form.abv}
              onChange={(event) => setForm({ ...form, abv: event.target.value })}
            />
          </label>
          <label>
            빈티지 (선택)
            <input
              type="number"
              min={1800}
              max={2200}
              value={form.vintage}
              onChange={(event) => setForm({ ...form, vintage: event.target.value })}
            />
          </label>
          <label>
            관심 노트
            <textarea
              maxLength={5000}
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
            />
          </label>
          <button type="submit">관심 저장</button>
        </form>
      </fieldset>
      {(action.error || interests.error) && (
        <p role="alert">{action.error?.message ?? interests.error?.message}</p>
      )}
      <label>
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => setArchived(event.target.checked)}
        />
        보관한 관심 보기
      </label>
      <ul>
        {(interests.data ?? [])
          .filter((row) => row.archived === archived)
          .map((row) => (
            <li key={row.id}>
              <h2>{row.name}</h2>
              <p>
                {row.identity.volumes_ml?.join(" / ") || "용량 미상"}
                {row.identity.volumes_ml?.length ? " ml" : ""} · {row.identity.abv ?? "도수 미상"}
                {row.identity.abv ? "%" : ""} · {row.identity.vintage ?? "빈티지 미상"}
              </p>
              <label>
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
              <InterestNote
                key={row.id}
                interest={row}
                disabled={!online}
                onSaved={() => void cache.invalidateQueries({ queryKey: ["interests"] })}
              />
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
              </button>{" "}
              {row.product_id ? (
                <button type="button" onClick={() => onSelectProduct(row.product_id ?? "")}>
                  구매 전환한 제품 보기
                </button>
              ) : (
                !row.archived && (
                  <button type="button" disabled={!online} onClick={() => setConvert(row)}>
                    구매 전환
                  </button>
                )
              )}
            </li>
          ))}
      </ul>
      {comparisons.length > 0 && (
        <section className="card">
          <h2>관심 비교</h2>
          <p>제품·규격 정보 비교입니다. 판매 가격과 조건은 해당 출처의 관측을 별도로 확인하세요.</p>
          <div style={{ overflowX: "auto" }}>
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
                <tr>
                  <th>용량</th>
                  {comparisons.map((row) => (
                    <td key={row.id}>{row.identity.volumes_ml?.join(" / ") || "미상"}</td>
                  ))}
                </tr>
                <tr>
                  <th>도수</th>
                  {comparisons.map((row) => (
                    <td key={row.id}>{row.identity.abv ?? "미상"}</td>
                  ))}
                </tr>
                <tr>
                  <th>빈티지</th>
                  {comparisons.map((row) => (
                    <td key={row.id}>{row.identity.vintage ?? "미상"}</td>
                  ))}
                </tr>
                <tr>
                  <th>노트</th>
                  {comparisons.map((row) => (
                    <td key={row.id}>{row.note ?? "없음"}</td>
                  ))}
                </tr>
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
          onConverted={(id) => {
            setConvert(null);
            void cache.invalidateQueries({ queryKey: ["interests"] });
            onSelectProduct(id);
          }}
        />
      )}
    </section>
  );
}

function InterestNote({
  interest,
  disabled,
  onSaved,
}: {
  interest: Interest;
  disabled: boolean;
  onSaved: () => void;
}) {
  const key = `interest-note:${interest.id}`;
  const [draft, setDraft] = useDraftState(key, {
    note: interest.note ?? "",
    expectedUpdatedAt: interest.updated_at,
  });
  const mutation = useMutation({
    mutationFn: () =>
      interestsApi.update(interest.id, {
        note: draft.note || null,
        expected_updated_at: draft.expectedUpdatedAt,
      }),
    onSuccess: (saved) => {
      setDraft({ note: saved.note ?? "", expectedUpdatedAt: saved.updated_at });
      clearFormDraft(key);
      onSaved();
    },
    onError: onSaved,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        {interest.name} 노트
        <textarea
          disabled={disabled || mutation.isPending}
          maxLength={5000}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        />
      </label>
      <button type="submit" disabled={disabled || mutation.isPending}>
        노트 저장
      </button>
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
      {draft.expectedUpdatedAt !== interest.updated_at && (
        <button
          type="button"
          onClick={() => {
            setDraft({ note: interest.note ?? "", expectedUpdatedAt: interest.updated_at });
            clearFormDraft(key);
            mutation.reset();
          }}
        >
          최신 노트 불러오기
        </button>
      )}
    </form>
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
  onConverted: (id: string) => void;
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
  const mutation = useMutation({
    mutationFn: async () => {
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
      return interestsApi.purchase(interest.id, input);
    },
    onSuccess: (result) => {
      clearFormDraft(formKey);
      triggerSync();
      onConverted(result.product_id);
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
          mutation.mutate();
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
          <p>가격 공란은 미상, 0은 무료 구매입니다.</p>
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
    </section>
  );
}
