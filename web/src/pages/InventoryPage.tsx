import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type CleanupPreview,
  collectionApi,
  type InventoryBottle,
  type Stocktake,
} from "@/api/collection";
import { BottleQr, BottleQrCamera } from "@/components/BottleQr";
import { CleanupConfirmation } from "@/components/CleanupConfirmation";
import { clearFormDraft, useDraftState } from "@/sync/drafts";
import { useSyncStatus } from "@/sync/SyncStatusProvider";

const RESULTS: Record<string, string> = {
  checked: "확인",
  unexpected: "예정 목록 밖의 병",
  location_mismatch: "위치 불일치",
};
export function InventoryPage({ onSelectProduct }: { onSelectProduct: (id: string) => void }) {
  const { state } = useSyncStatus();
  const online = state !== "offline";
  const cache = useQueryClient();
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
  const [form, setForm] = useDraftState("storage-location", { name: "", kind: "shelf" });
  const [editId, setEditId] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  const [selectedBottle, setSelectedBottle] = useState<InventoryBottle | null>(null);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [sessionName, setSessionName] = useDraftState("stocktake-name", "");
  const [code, setCode] = useState("");
  const [observed, setObserved] = useState("");
  const [camera, setCamera] = useState(false);
  const [foundNote, setFoundNote] = useDraftState("stocktake-found", "");
  const [notice, setNotice] = useState("");
  const active = (stocktakes.data ?? []).find((row) => row.id === sessionId);
  const movements = useQuery({
    queryKey: ["collection", "movements", selectedBottle?.id],
    queryFn: () => collectionApi.movements(selectedBottle?.id ?? ""),
    enabled: online && !!selectedBottle,
  });
  const action = useMutation({
    mutationFn: async (work: () => Promise<unknown>) => {
      if (!online) throw new Error("온라인에서 저장하세요");
      await work();
      await cache.invalidateQueries({ queryKey: ["collection"] });
    },
  });
  const activeLocations = (locations.data ?? []).filter((row) => !row.deleted);
  const locationName = (id: string | null) =>
    (locations.data ?? []).find((row) => row.id === id)?.name ?? "미지정";
  const scan = (raw: string) => {
    if (!active) return;
    setCamera(false);
    action.mutate(async () => {
      const result = await collectionApi.scan(active.id, raw, observed || null);
      setNotice(
        result.duplicate
          ? "이미 확인한 병입니다"
          : (RESULTS[result.observation.result] ?? result.observation.result),
      );
      setCode("");
    });
  };
  const changeStatus = (status: Stocktake["status"]) => {
    if (active) action.mutate(() => collectionApi.status(active.id, status));
  };
  return (
    <section className="collection-page">
      <h1>보관 위치 · 재고 실사</h1>
      <p>
        병별 위치와 관찰을 온라인에서 기록합니다. 실사에서 미확인된 병도 자동 소진·증여 처리하지
        않습니다.
      </p>
      {!online && <output>오프라인입니다. 연결한 뒤 보관·실사를 기록하세요.</output>}
      {[locations.error, bottles.error, stocktakes.error, action.error]
        .filter(Boolean)
        .map((error) => (
          <p role="alert" key={error?.message}>
            {error?.message}
          </p>
        ))}
      <fieldset disabled={!online || action.isPending}>
        <legend>보관 위치</legend>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate(async () => {
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
        <ul>
          {activeLocations.map((location) => (
            <li key={location.id}>
              {location.name} · {location.bottle_count}병{" "}
              <button
                type="button"
                onClick={() => {
                  setEditId(location.id);
                  setForm({ name: location.name, kind: location.kind });
                }}
              >
                수정
              </button>{" "}
              <button
                type="button"
                onClick={() =>
                  action.mutate(async () =>
                    setPreview(await collectionApi.preview("location_delete", [location.id])),
                  )
                }
              >
                삭제 영향 확인
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      {preview && (
        <>
          <p>위치를 삭제하면 현재 배치된 병은 미지정으로 옮기며 이동·실사 이력은 보존합니다.</p>
          <CleanupConfirmation
            preview={preview}
            pending={!online || action.isPending}
            onCancel={() => setPreview(null)}
            onConfirm={() =>
              action.mutate(async () => {
                await collectionApi.confirm(preview.id);
                setPreview(null);
              })
            }
          />
        </>
      )}
      <h2>개별 병 위치</h2>
      <label>
        위치 필터
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="">전체</option>
          <option value="unassigned">미지정</option>
          {activeLocations.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <ul>
        {(bottles.data ?? [])
          .filter((row) => row.status === "open" || row.status === "unopened")
          .filter(
            (row) =>
              !filter || (filter === "unassigned" ? !row.location_id : row.location_id === filter),
          )
          .map((bottle) => (
            <li key={bottle.id}>
              <button type="button" onClick={() => onSelectProduct(bottle.product_id)}>
                {bottle.name} #{bottle.label_no}
              </button>{" "}
              <label>
                현재 위치
                <select
                  aria-label={`${bottle.name} ${bottle.label_no}번 병 위치`}
                  disabled={!online || action.isPending}
                  value={bottle.location_id ?? ""}
                  onChange={(event) => {
                    const locationId = event.currentTarget.value || null;
                    action.mutate(() => collectionApi.move(bottle.id, locationId));
                  }}
                >
                  <option value="">미지정</option>
                  {activeLocations.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              {bottle.legacy_location && <span>기존 메모: {bottle.legacy_location}</span>}{" "}
              <button type="button" onClick={() => setSelectedBottle(bottle)}>
                병 QR · 이동 이력
              </button>
            </li>
          ))}
      </ul>
      {selectedBottle && (
        <section className="card">
          <h3>
            {selectedBottle.name} #{selectedBottle.label_no}
          </h3>
          <BottleQr code={selectedBottle.bottle_code} />
          <button type="button" onClick={() => window.print()}>
            QR 인쇄
          </button>
          <ul>
            {movements.data?.map((move) => (
              <li key={move.id}>
                {locationName(move.from_location_id)} → {locationName(move.to_location_id)} ·{" "}
                {new Date(move.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setSelectedBottle(null)}>
            닫기
          </button>
        </section>
      )}
      <h2>재고 실사</h2>
      <fieldset disabled={!online || action.isPending}>
        <legend>새 실사</legend>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate(async () => {
              const row = await collectionApi.start(
                sessionName,
                filter && filter !== "unassigned" ? filter : null,
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
              required
              maxLength={200}
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
            />
          </label>
          <p>범위: {filter && filter !== "unassigned" ? locationName(filter) : "전체 재고"}</p>
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
          {stocktakes.data?.map((row) => (
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
          <p>
            예정 {active.expected_count}병 · 관찰 {active.observations.length}병 · 미확인{" "}
            {active.missing.length}병
          </p>
          <fieldset disabled={!online || action.isPending || active.status !== "active"}>
            <legend>병 확인</legend>
            <label>
              실제로 확인한 위치
              <select value={observed} onChange={(event) => setObserved(event.target.value)}>
                <option value="">미지정</option>
                {activeLocations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                scan(code);
              }}
            >
              <label>
                내부 병 QR 문자열
                <input required value={code} onChange={(event) => setCode(event.target.value)} />
              </label>
              <button type="submit">병 확인</button>
              <button type="button" onClick={() => setCamera(!camera)}>
                {camera ? "카메라 닫기" : "QR 카메라"}
              </button>
            </form>
            {camera && <BottleQrCamera onScan={scan} />}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                action.mutate(async () => {
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
          {notice && <output>{notice}</output>}
          <ul>
            {active.observations.map((row) => (
              <li key={row.bottle_id}>
                {RESULTS[row.result] ?? row.result} ·{" "}
                {(bottles.data ?? []).find((bottle) => bottle.id === row.bottle_id)?.name ??
                  row.bottle_id}
              </li>
            ))}
          </ul>
          <h4>미확인 병</h4>
          <ul>
            {active.missing.map((bottle) => (
              <li key={bottle.id}>
                <button type="button" onClick={() => onSelectProduct(bottle.product_id)}>
                  {bottle.name} #{bottle.label_no} · 제품에서 상태 확인
                </button>
              </li>
            ))}
          </ul>
          <h4>미등록 발견</h4>
          <ul>
            {active.found_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {active.status !== "completed" && (
            <div className="button-row">
              <button
                type="button"
                disabled={!online || action.isPending}
                onClick={() => changeStatus(active.status === "active" ? "paused" : "active")}
              >
                {active.status === "active" ? "일시 중지" : "실사 재개"}
              </button>
              <button
                type="button"
                disabled={!online || action.isPending}
                onClick={() => changeStatus("completed")}
              >
                관찰 기록으로 완료
              </button>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
