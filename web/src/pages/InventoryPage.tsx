import type { ProductContext } from "@/router";
/**
 * 보관 위치와 재고 실사.
 *
 * 세 가지 일을 탭으로 나눈다 — 병을 골라 위치로 옮기기(가장 잦음), 위치 목록 관리, 실사.
 * 예전에는 한 페이지에 병마다 위치 선택 상자를 늘어놓아 재고 수백 병이면 끝없이 길어졌다.
 * 이제 표에서 여러 병을 골라 한 번에 옮기고, 실사는 카메라를 켠 채 연속으로 확인한다.
 *
 * 위치·실사 기록은 서버 기록을 직접 쓰므로 온라인 전용이다. 실사는 재고 상태를 스스로
 * 바꾸지 않는다 — 미확인 병의 소진 처리나 위치 반영은 사용자가 명시적으로 고른다.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  type CleanupPreview,
  collectionApi,
  type InventoryBottle,
  type Location,
  type Stocktake,
} from "@/api/collection";
import { BottleQr, BottleQrCamera } from "@/components/BottleQr";
import { CleanupConfirmation } from "@/components/CleanupConfirmation";
import { productEdition, purchaseReference } from "@/components/productDisplay";
import { useToast } from "@/components/Toast";
import { downloadCsv } from "@/csvExport";
import { formatDate, formatVolume, todayLocal } from "@/format";
import { matchesQuery } from "@/search";
import { applyBottleTransitions, undoBottleTransitions } from "@/sync/bottleActions";
import { clearFormDraft, useDraftState } from "@/sync/drafts";
import { useSyncStatus } from "@/sync/SyncStatusProvider";
import { useSessionMutation } from "@/sync/useSessionMutation";
import { captureWriteSession } from "@/sync/writeSession";

const RESULTS: Record<string, string> = {
  checked: "확인",
  unexpected: "예정 목록 밖의 병",
  location_mismatch: "위치 불일치",
  relocated: "위치 반영함",
  relocation_skipped: "반영 못 함(병·위치 삭제됨)",
};

const KIND_LABELS: Record<Location["kind"], string> = {
  cabinet: "찬장",
  shelf: "선반",
  box: "상자",
};

type Tab = "bottles" | "locations" | "stocktake";

const TABS: { id: Tab; label: string }[] = [
  { id: "bottles", label: "병 위치" },
  { id: "locations", label: "위치 관리" },
  { id: "stocktake", label: "재고 실사" },
];

function isInStock(bottle: InventoryBottle): boolean {
  return bottle.status === "open" || bottle.status === "unopened";
}

export function InventoryPage({
  onSelectProduct,
}: {
  onSelectProduct: (id: string, context?: ProductContext) => void;
}) {
  const { state } = useSyncStatus();
  const online = state !== "offline";
  const cache = useQueryClient();
  const [tab, setTab] = useState<Tab>("bottles");
  const locations = useQuery({
    queryKey: ["collection", "locations"],
    queryFn: collectionApi.locations,
    enabled: online,
  });
  const bottles = useQuery({
    queryKey: ["collection", "bottles"],
    queryFn: collectionApi.bottles,
    enabled: online,
  });
  const stocktakes = useQuery({
    queryKey: ["collection", "stocktakes"],
    queryFn: collectionApi.stocktakes,
    enabled: online,
  });
  const action = useSessionMutation({
    networkMode: "online",
    mutationFn: async (work: () => Promise<unknown>, session) => {
      if (!online) throw new Error("온라인에서 저장하세요");
      try {
        await work();
      } finally {
        if (session.isCurrent()) await cache.invalidateQueries({ queryKey: ["collection"] });
      }
    },
  });

  const activeLocations = (locations.data ?? []).filter((row) => !row.deleted);
  const locationName = (id: string | null) =>
    (locations.data ?? []).find((row) => row.id === id)?.name ?? "미지정";
  const running = (stocktakes.data ?? []).find((row) => row.status === "active");
  const [sessionId, setSessionId] = useState("");

  return (
    <section className="collection-page">
      <h1>보관 위치 · 재고 실사</h1>
      <p className="muted">
        병별 위치와 실사 관찰을 온라인에서 기록합니다. 실사에서 확인하지 못한 병도 자동으로
        소진·증여 처리하지 않습니다.
      </p>
      {!online && <output>오프라인입니다. 연결한 뒤 보관·실사를 기록하세요.</output>}
      {[locations.error, bottles.error, stocktakes.error, action.error]
        .filter(Boolean)
        .map((error) => (
          <p role="alert" key={error?.message}>
            {error?.message}
          </p>
        ))}

      {running && tab !== "stocktake" ? (
        <button
          type="button"
          className="stocktake-banner"
          onClick={() => {
            setSessionId(running.id);
            setTab("stocktake");
          }}
        >
          실사 진행 중: {running.name} · 확인 {running.observed_count}/{running.expected_count}병
        </button>
      ) : null}

      <div className="tab-list" role="tablist" aria-label="보관·실사 화면">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`inventory-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`inventory-panel-${item.id}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`inventory-panel-${tab}`} aria-labelledby={`inventory-tab-${tab}`}>
        {tab === "bottles" && (
          <BottleLocations
            bottles={bottles.data ?? []}
            locations={activeLocations}
            online={online}
            pending={action.isPending}
            run={(work) => action.mutateAsync(work)}
            onSelectProduct={onSelectProduct}
            locationName={locationName}
          />
        )}
        {tab === "locations" && (
          <LocationManager
            locations={activeLocations}
            online={online}
            pending={action.isPending}
            run={(work) => action.mutate(work)}
          />
        )}
        {tab === "stocktake" && (
          <StocktakePanel
            stocktakes={stocktakes.data ?? []}
            bottles={bottles.data ?? []}
            locations={activeLocations}
            online={online}
            pending={action.isPending}
            run={(work) => action.mutateAsync(work)}
            sessionId={sessionId}
            setSessionId={setSessionId}
            onSelectProduct={onSelectProduct}
            locationName={locationName}
          />
        )}
      </div>
    </section>
  );
}

// --- 병 위치 ---------------------------------------------------------------------

function BottleLocations({
  bottles,
  locations,
  online,
  pending,
  run,
  onSelectProduct,
  locationName,
}: {
  bottles: InventoryBottle[];
  locations: Location[];
  online: boolean;
  pending: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  onSelectProduct: (id: string, context?: ProductContext) => void;
  locationName: (id: string | null) => string;
}) {
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState("");
  const [qrBottle, setQrBottle] = useState<InventoryBottle | null>(null);

  const visible = useMemo(
    () =>
      bottles
        .filter(isInStock)
        .filter(
          (row) =>
            !filter || (filter === "unassigned" ? !row.location_id : row.location_id === filter),
        )
        .filter((row) => !query.trim() || matchesQuery(row.name, query)),
    [bottles, filter, query],
  );
  const visibleIds = visible.map((row) => row.id);
  const chosen = visibleIds.filter((id) => selected.has(id));
  const unassigned = bottles.filter(isInStock).filter((row) => !row.location_id).length;

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function moveChosen(): Promise<void> {
    const locationId = target === "__none__" ? null : target;
    const previous = new Map(bottles.map((row) => [row.id, row.location_id]));
    const ids = [...chosen];
    let moved = 0;
    await run(async () => {
      moved = (await collectionApi.moveMany(ids, locationId)).moved;
    });
    setSelected(new Set());
    toast.show({
      message: `${moved}병을 ${locationName(locationId)}(으)로 옮겼습니다`,
      actionLabel: "실행 취소",
      onAction: () =>
        run(async () => {
          const groups = new Map<string | null, string[]>();
          for (const id of ids) {
            const from = previous.get(id) ?? null;
            groups.set(from, [...(groups.get(from) ?? []), id]);
          }
          for (const [from, group] of groups) await collectionApi.moveMany(group, from);
        }),
    });
  }

  return (
    <>
      <div className="filter-row">
        <label>
          위치
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">전체 재고</option>
            <option value="unassigned">미지정 ({unassigned})</option>
            {locations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} ({row.bottle_count})
              </option>
            ))}
          </select>
        </label>
        <label>
          이름 검색
          <input
            type="search"
            value={query}
            placeholder="한글·초성 검색"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <output className="notice">조건에 맞는 재고 병이 없습니다.</output>
      ) : (
        <div className="table-scroll">
          <table className="product-table inventory-table">
            <caption className="sr-only">재고 병과 보관 위치</caption>
            <thead>
              <tr>
                <th scope="col" className="select-col">
                  <input
                    type="checkbox"
                    aria-label="보이는 병 모두 선택"
                    checked={chosen.length === visible.length}
                    onChange={(event) =>
                      setSelected(event.currentTarget.checked ? new Set(visibleIds) : new Set())
                    }
                  />
                </th>
                <th scope="col">술</th>
                <th scope="col">위치</th>
                <th scope="col">QR</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((bottle) => (
                <tr key={bottle.id}>
                  <td className="select-col">
                    <input
                      type="checkbox"
                      aria-label={`${inventoryBottleLabel(bottle, bottles)} 선택`}
                      checked={selected.has(bottle.id)}
                      onChange={() => toggle(bottle.id)}
                    />
                  </td>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-like"
                      onClick={() => onSelectProduct(bottle.product_id, { bottleId: bottle.id })}
                    >
                      {inventoryBottleLabel(bottle, bottles)}
                    </button>
                    {bottle.legacy_location ? (
                      <span className="muted text-sm"> · 기존 메모: {bottle.legacy_location}</span>
                    ) : null}
                  </th>
                  <td>
                    <select
                      aria-label={`${inventoryBottleLabel(bottle, bottles)} 위치`}
                      disabled={!online || pending}
                      value={bottle.location_id ?? ""}
                      onChange={(event) => {
                        const locationId = event.currentTarget.value || null;
                        void run(() => collectionApi.move(bottle.id, locationId));
                      }}
                    >
                      <option value="">미지정</option>
                      {locations.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="sort-button"
                      aria-label={`${bottle.name} ${bottle.label_no}번 병 QR · 이동 이력`}
                      onClick={() => setQrBottle(bottle)}
                    >
                      QR
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chosen.length > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="선택한 병 옮기기">
          <span className="bulk-bar-count">{chosen.length}병</span>
          <label htmlFor="bulk-location" className="sr-only">
            옮길 위치
          </label>
          <select
            id="bulk-location"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">옮길 위치 선택</option>
            {locations.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
            <option value="__none__">미지정으로</option>
          </select>
          <button
            type="button"
            className="primary"
            disabled={!online || pending || !target}
            onClick={() => void moveChosen()}
          >
            옮기기
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            선택 해제
          </button>
        </div>
      ) : null}

      {qrBottle ? (
        <BottleQrCard
          bottle={qrBottle}
          locationName={locationName}
          online={online}
          onClose={() => setQrBottle(null)}
        />
      ) : null}
    </>
  );
}

function BottleQrCard({
  bottle,
  locationName,
  online,
  onClose,
}: {
  bottle: InventoryBottle;
  locationName: (id: string | null) => string;
  online: boolean;
  onClose: () => void;
}) {
  const movements = useQuery({
    queryKey: ["collection", "movements", bottle.id],
    queryFn: () => collectionApi.movements(bottle.id),
    enabled: online,
  });
  return (
    <section className="card">
      <h3>{inventoryBottleLabel(bottle, [bottle])}</h3>
      <BottleQr code={bottle.bottle_code} />
      <button type="button" onClick={() => window.print()}>
        QR 인쇄
      </button>
      <h4>이동 이력</h4>
      <ul>
        {movements.data?.map((move) => (
          <li key={move.id}>
            {locationName(move.from_location_id)} → {locationName(move.to_location_id)} ·{" "}
            {new Date(move.created_at).toLocaleString()}
          </li>
        ))}
      </ul>
      {movements.data?.length === 0 ? <p className="muted">이동 기록이 없습니다.</p> : null}
      <button type="button" onClick={onClose}>
        닫기
      </button>
    </section>
  );
}

// --- 위치 관리 ---------------------------------------------------------------------

function LocationManager({
  locations,
  online,
  pending,
  run,
}: {
  locations: Location[];
  online: boolean;
  pending: boolean;
  run: (work: () => Promise<unknown>) => void;
}) {
  const [form, setForm] = useDraftState("storage-location", { name: "", kind: "shelf" });
  const [editId, setEditId] = useState<string | undefined>();
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  return (
    <>
      <fieldset disabled={!online || pending}>
        <legend>{editId ? "위치 수정" : "새 위치"}</legend>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => {
              await collectionApi.saveLocation(form, editId);
              setEditId(undefined);
              setForm({ name: "", kind: "shelf" });
              clearFormDraft("storage-location");
            });
          }}
        >
          <label>
            위치 이름
            <input
              required
              maxLength={200}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label>
            위치 종류
            <select
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            >
              <option value="cabinet">찬장</option>
              <option value="shelf">선반</option>
              <option value="box">상자</option>
            </select>
          </label>
          <button type="submit">{editId ? "이름·종류 저장" : "위치 추가"}</button>
          {editId && (
            <button
              type="button"
              onClick={() => {
                setEditId(undefined);
                setForm({ name: "", kind: "shelf" });
              }}
            >
              수정 취소
            </button>
          )}
        </form>
      </fieldset>
      {locations.length === 0 ? (
        <output className="notice">아직 위치가 없습니다. 찬장·선반·상자를 먼저 추가하세요.</output>
      ) : (
        <ul className="location-list">
          {locations.map((location) => (
            <li key={location.id}>
              <span>
                {location.name} · {location.bottle_count}병{" "}
                <span className="muted text-sm">({KIND_LABELS[location.kind]})</span>
              </span>
              <span className="button-row">
                <button
                  type="button"
                  disabled={!online || pending}
                  onClick={() => {
                    setEditId(location.id);
                    setForm({ name: location.name, kind: location.kind });
                  }}
                >
                  수정
                </button>
                <button
                  type="button"
                  disabled={!online || pending}
                  onClick={() =>
                    run(async () =>
                      setPreview(await collectionApi.preview("location_delete", [location.id])),
                    )
                  }
                >
                  삭제 영향 확인
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <>
          <p>위치를 삭제하면 현재 배치된 병은 미지정으로 옮기며 이동·실사 이력은 보존합니다.</p>
          <CleanupConfirmation
            preview={preview}
            pending={!online || pending}
            onCancel={() => setPreview(null)}
            onConfirm={() =>
              run(async () => {
                await collectionApi.confirm(preview.id);
                setPreview(null);
              })
            }
          />
        </>
      )}
    </>
  );
}

// --- 재고 실사 ---------------------------------------------------------------------

function StocktakePanel({
  stocktakes,
  bottles,
  locations,
  online,
  pending,
  run,
  sessionId,
  setSessionId,
  onSelectProduct,
  locationName,
}: {
  stocktakes: Stocktake[];
  bottles: InventoryBottle[];
  locations: Location[];
  online: boolean;
  pending: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  sessionId: string;
  setSessionId: (id: string, context?: ProductContext) => void;
  onSelectProduct: (id: string, context?: ProductContext) => void;
  locationName: (id: string | null) => string;
}) {
  const toast = useToast();
  const [sessionName, setSessionName] = useDraftState("stocktake-name", "");
  const [scope, setScope] = useState("");
  const [code, setCode] = useState("");
  const [observed, setObserved] = useState("");
  const [camera, setCamera] = useState(false);
  const [foundNote, setFoundNote] = useDraftState("stocktake-found", "");
  const [notice, setNotice] = useState("");
  const [missingSelected, setMissingSelected] = useState<ReadonlySet<string>>(new Set());
  const active = stocktakes.find((row) => row.id === sessionId);
  const bottleName = (id: string) => {
    const bottle = bottles.find((row) => row.id === id);
    return bottle ? `${bottle.name} #${bottle.label_no}` : id;
  };

  async function scan(raw: string): Promise<void> {
    if (!active) return;
    const value = raw.trim();
    if (!value) return;
    await run(async () => {
      const result = await collectionApi.scan(active.id, value, observed || null);
      const prefix = "sooljang:bottle:";
      const name = value.startsWith(prefix) ? bottleName(value.slice(prefix.length)) : value;
      setNotice(
        result.duplicate
          ? `이미 확인한 병입니다 · ${name}`
          : `${RESULTS[result.observation.result] ?? result.observation.result} · ${name}`,
      );
      setCode("");
    }).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : "확인하지 못했습니다");
    });
  }

  const changeStatus = (status: Stocktake["status"]) => {
    if (active) void run(() => collectionApi.status(active.id, status));
  };

  async function finishMissing(): Promise<void> {
    const ids = [...missingSelected];
    const result = await applyBottleTransitions(ids, "finish");
    setMissingSelected(new Set());
    toast.show({
      message: `미확인 ${result.applied.length}병을 소진 처리했습니다`,
      actionLabel: "실행 취소",
      onAction: async () => {
        const undone = await undoBottleTransitions(result.applied);
        toast.show({
          message:
            `${undone.applied.length}병 취소 기록 저장` +
            (undone.skipped.length
              ? ` · ${undone.skipped.length}병은 이후 변경이 있어 유지했습니다`
              : ""),
          tone: undone.skipped.length ? "warn" : "info",
        });
      },
    });
  }

  const progress =
    active && active.expected_count > 0 ? active.observed_count / active.expected_count : 0;

  return (
    <>
      <fieldset disabled={!online || pending}>
        <legend>새 실사</legend>
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              // 이름은 나중에 목록에서 구분하려는 용도라 비워 두면 날짜로 채운다.
              const row = await collectionApi.start(
                sessionName.trim() || `${todayLocal()} 실사`,
                scope || null,
              );
              setSessionId(row.id);
              setSessionName("");
              clearFormDraft("stocktake-name");
            });
          }}
        >
          <label>
            실사 이름
            <input
              maxLength={200}
              placeholder={`비워 두면 "${todayLocal()} 실사"`}
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
            />
          </label>
          <label>
            범위
            <select value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">전체 재고</option>
              {locations.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">실사 시작</button>
        </form>
      </fieldset>
      <label>
        진행·완료 실사
        <select
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value);
            setNotice("");
            setCamera(false);
          }}
        >
          <option value="">실사를 선택하세요</option>
          {stocktakes.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name} (
              {row.status === "active" ? "진행 중" : row.status === "paused" ? "일시 중지" : "완료"}
              )
            </option>
          ))}
        </select>
      </label>
      {active && (
        <section className="card">
          <h3>{active.name}</h3>
          <p className="muted">
            범위: {active.location_id ? locationName(active.location_id) : "전체 재고"}
          </p>
          <div className="progress-row">
            <progress max={1} value={progress} aria-label="실사 진행률" />
            <span>
              확인 {active.observed_count}/{active.expected_count}병 · 미확인{" "}
              {active.missing.length}병
              {active.mismatch_count > 0 ? ` · 위치 불일치 ${active.mismatch_count}병` : ""}
              {active.unexpected_count > 0 ? ` · 예정 밖 ${active.unexpected_count}병` : ""}
            </span>
          </div>
          <fieldset disabled={!online || pending || active.status !== "active"}>
            <legend>병 확인</legend>
            <label>
              지금 확인하는 위치
              <select value={observed} onChange={(event) => setObserved(event.target.value)}>
                <option value="">미지정</option>
                {locations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void scan(code);
              }}
            >
              <label>
                내부 병 QR 문자열
                <input required value={code} onChange={(event) => setCode(event.target.value)} />
              </label>
              <button type="submit">병 확인</button>
              <button type="button" aria-pressed={camera} onClick={() => setCamera(!camera)}>
                {camera ? "연속 스캔 끄기" : "연속 스캔 켜기"}
              </button>
            </form>
            {camera && (
              <>
                <p className="muted text-sm">
                  카메라를 켠 채로 병을 차례로 비추세요. 확인할 때마다 짧게 진동합니다.
                </p>
                <BottleQrCamera continuous onScan={(value) => void scan(value)} />
              </>
            )}
          </fieldset>
          {notice && (
            <output className="scan-notice" aria-live="polite">
              {notice}
            </output>
          )}
          {active.mismatch_count > 0 ? (
            <div className="button-row">
              <button
                type="button"
                disabled={!online || pending}
                onClick={() =>
                  void run(async () => {
                    const result = await collectionApi.applyLocations(active.id);
                    toast.show({
                      message:
                        result.skipped > 0
                          ? `${result.moved}병의 위치를 바꿨습니다. 삭제된 병·위치 ${result.skipped}건은 건너뛰었습니다`
                          : `${result.moved}병의 위치를 확인한 곳으로 바꿨습니다`,
                    });
                  })
                }
              >
                위치 불일치 {active.mismatch_count}병을 확인한 위치로 옮기기
              </button>
            </div>
          ) : null}
          <div className="button-row">
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  `sooljang-stocktake-${active.name}-${todayLocal()}.csv`,
                  ["구분", "술", "기록된 위치", "확인한 위치"],
                  [
                    ...active.missing.map((bottle) => [
                      "미확인",
                      `${bottle.name} #${bottle.label_no}`,
                      locationName(bottle.location_id),
                      "",
                    ]),
                    ...active.observations
                      .filter((row) => row.result !== "checked")
                      .map((row) => [
                        RESULTS[row.result] ?? row.result,
                        bottleName(row.bottle_id),
                        locationName(row.recorded_location_id),
                        locationName(row.observed_location_id),
                      ]),
                  ],
                )
              }
            >
              미확인·불일치 CSV
            </button>
          </div>
          <details>
            <summary>확인한 병 {active.observations.length}개</summary>
            <ul>
              {active.observations.map((row) => (
                <li key={`${active.id}:${row.bottle_id}`}>
                  {RESULTS[row.result] ?? row.result} · {bottleName(row.bottle_id)}
                  <p className="muted text-sm">
                    기록 위치: {locationName(row.recorded_location_id)} · 확인 위치:{" "}
                    {locationName(row.observed_location_id)}
                  </p>
                  {active.status === "active" &&
                  ["checked", "unexpected", "location_mismatch"].includes(row.result) ? (
                    <ObservationCorrection
                      stocktakeId={active.id}
                      observation={row}
                      locations={locations}
                      online={online}
                      pending={pending}
                      run={run}
                      locationName={locationName}
                    />
                  ) : (
                    <p className="muted text-sm">
                      {active.status === "paused"
                        ? "실사를 재개하면 관찰 위치를 정정할 수 있습니다."
                        : "완료하거나 위치를 반영한 관찰입니다. 실제 병 위치는 병 위치 화면에서 바꾸세요."}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <h4>미확인 병 {active.missing.length}개</h4>
          {active.missing.length > 0 ? (
            <>
              <p className="muted text-sm">
                마셨는데 기록하지 않은 병이 있다면 골라서 한 번에 소진 처리할 수 있습니다.
              </p>
              <ul className="check-list">
                {active.missing.map((bottle) => (
                  <li key={bottle.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={missingSelected.has(bottle.id)}
                        onChange={() =>
                          setMissingSelected((current) => {
                            const next = new Set(current);
                            if (next.has(bottle.id)) next.delete(bottle.id);
                            else next.add(bottle.id);
                            return next;
                          })
                        }
                      />
                      {inventoryBottleLabel(bottle, bottles)}
                    </label>{" "}
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => onSelectProduct(bottle.product_id, { bottleId: bottle.id })}
                    >
                      제품 보기
                    </button>
                  </li>
                ))}
              </ul>
              <div className="button-row">
                <button
                  type="button"
                  disabled={missingSelected.size === 0}
                  onClick={() => void finishMissing()}
                >
                  선택한 {missingSelected.size}병 소진 처리
                </button>
              </div>
            </>
          ) : (
            <p className="muted">모두 확인했습니다.</p>
          )}
          <fieldset disabled={!online || pending || active.status !== "active"}>
            <legend>미등록 발견</legend>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await collectionApi.found(active.id, foundNote);
                  setFoundNote("");
                  clearFormDraft("stocktake-found");
                });
              }}
            >
              <label>
                미등록 발견 메모
                <input
                  required
                  value={foundNote}
                  onChange={(event) => setFoundNote(event.target.value)}
                />
              </label>
              <button type="submit">발견 기록</button>
            </form>
          </fieldset>
          <ul>
            {active.found_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {active.status !== "completed" && (
            <div className="button-row">
              <button
                type="button"
                disabled={!online || pending}
                onClick={() => changeStatus(active.status === "active" ? "paused" : "active")}
              >
                {active.status === "active" ? "일시 중지" : "실사 재개"}
              </button>
              <button
                type="button"
                disabled={!online || pending}
                onClick={() => changeStatus("completed")}
              >
                관찰 기록으로 완료
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** 재스캔의 중복 방지와 구분한 명시적 관찰 정정. 실제 병 위치는 이동하지 않는다. */
function ObservationCorrection({
  stocktakeId,
  observation,
  locations,
  online,
  pending,
  run,
  locationName,
}: {
  stocktakeId: string;
  observation: Stocktake["observations"][number];
  locations: Location[];
  online: boolean;
  pending: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  locationName: (id: string | null) => string;
}) {
  const cache = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [original, setOriginal] = useState<string | null>(observation.observed_location_id);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function refreshObservation(): Promise<void> {
    const session = captureWriteSession();
    setRefreshing(true);
    try {
      session.assertCurrent();
      const fresh = await collectionApi.stocktakes();
      session.assertCurrent();
      const stocktake = fresh.find((row) => row.id === stocktakeId);
      const row = stocktake?.observations.find((item) => item.bottle_id === observation.bottle_id);
      if (!row) throw new Error("관찰을 다시 찾지 못했습니다. 실사 목록을 확인하세요");
      cache.setQueryData(["collection", "stocktakes"], fresh);
      setOriginal(row.observed_location_id);
      setChosen(row.observed_location_id ?? "");
      setError(null);
    } catch (cause) {
      if (session.isCurrent())
        setError(cause instanceof Error ? cause.message : "최신 관찰을 불러오지 못했습니다");
    } finally {
      setRefreshing(false);
    }
  }
  if (!editing)
    return (
      <button
        type="button"
        disabled={!online || pending || refreshing}
        onClick={() => {
          setOriginal(observation.observed_location_id);
          setChosen(observation.observed_location_id ?? "");
          setError(null);
          setEditing(true);
        }}
      >
        위치 정정
      </button>
    );
  return (
    <form
      className="panel"
      aria-label="관찰 위치 정정"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        void run(() =>
          collectionApi.correctObservation(
            stocktakeId,
            observation.bottle_id,
            chosen || null,
            original,
          ),
        )
          .then(() => setEditing(false))
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "관찰 위치를 정정하지 못했습니다");
          });
      }}
    >
      <label className="field">
        정정할 관찰 위치
        <select
          disabled={!online || pending || refreshing}
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">미지정</option>
          {original && !locations.some((location) => location.id === original) ? (
            <option value={original} disabled>
              {locationName(original)} (삭제된 위치)
            </option>
          ) : null}
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        {locationName(original)} → {locationName(chosen || null)}
      </p>
      <p className="muted text-sm">
        실사에서 확인한 위치만 고칩니다. 실제 병 위치는 자동으로 이동하지 않습니다.
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={pending || refreshing}
            onClick={() => void refreshObservation()}
          >
            최신 관찰로 다시 확인
          </button>
        </>
      ) : null}
      <div className="button-row">
        <button
          type="submit"
          disabled={!online || pending || refreshing || (chosen || null) === original}
        >
          관찰 위치 정정 저장
        </button>
        <button type="button" disabled={pending || refreshing} onClick={() => setEditing(false)}>
          취소
        </button>
      </div>
    </form>
  );
}

function inventoryBottleLabel(bottle: InventoryBottle, bottles: InventoryBottle[]): string {
  const context = [
    bottle.volume_ml ? formatVolume(bottle.volume_ml) : null,
    productEdition({
      vintage: bottle.vintage ?? null,
      age_years: bottle.age_years ?? null,
      abv: bottle.abv ?? null,
    }),
    bottle.purchased_on ? formatDate(bottle.purchased_on) : null,
    bottle.vendor_name,
    bottle.purchase_id
      ? purchaseReference(
          bottle.purchase_id,
          bottles.flatMap((item) => (item.purchase_id ? [item.purchase_id] : [])),
        )
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${bottle.name} ${bottle.label_no}번 병${context ? ` · ${context}` : ""}`;
}
