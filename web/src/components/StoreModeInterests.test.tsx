import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Interest, interestsApi } from "@/api/interests";
import { type PriceWatch, priceWatchApi } from "@/api/priceWatch";
import { StoreModeInterests } from "@/components/StoreModeInterests";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { buildInterestSnapshot, saveInterestSnapshot } from "@/sync/interestSnapshot";
import { renderWithQuery } from "@/testing";

const interest = (id: string, name: string, overrides: Partial<Interest> = {}): Interest => ({
  id,
  name,
  identity: { name, volumes_ml: [700], search_aliases: ["글렌리벳"] },
  source_matches: {},
  note: null,
  archived: false,
  product_id: null,
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
});
const watch = (overrides: Partial<PriceWatch>): PriceWatch =>
  ({
    id: "w1",
    interest_id: "i1",
    source_name: "합성 판매처",
    criteria: { target_amount: "45000", currency: "KRW" },
    is_active: true,
    ...overrides,
  }) as PriceWatch;

beforeEach(async () => {
  await activateDatabase("store-interest-owner");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.sync_meta.clear();
  lockDatabase();
});

it("저장본에는 보관·삭제하지 않은 관심과 활성 감시의 목표가만 담는다", () => {
  const snapshot = buildInterestSnapshot(
    [
      interest("i1", "The Glenlivet 12"),
      interest("i2", "보관한 술", { archived: true }),
      interest("i3", "삭제한 술", { deleted: true }),
    ],
    [
      watch({}),
      watch({
        id: "w2",
        is_active: false,
        criteria: { target_amount: "1", currency: "KRW" },
      } as never),
    ],
    new Date("2026-10-18T00:00:00Z"),
  );

  expect(snapshot.interests.map((item) => item.name)).toEqual(["The Glenlivet 12"]);
  expect(snapshot.interests[0]?.targets).toEqual([
    { amount: "45000", currency: "KRW", source: "합성 판매처" },
  ]);
});

it("온라인에서 받은 관심·목표가를 저장하고 검색어에 맞는 관심을 보인다", async () => {
  vi.spyOn(interestsApi, "list").mockResolvedValue([
    interest("i1", "The Glenlivet 12"),
    interest("i2", "다른 술", { identity: { name: "다른 술" } }),
  ]);
  vi.spyOn(priceWatchApi, "list").mockResolvedValue([watch({})]);
  renderWithQuery(<StoreModeInterests query="글렌리" offline={false} />);

  expect(await screen.findByText("The Glenlivet 12")).toBeInTheDocument();
  expect(screen.getByText(/목표 45,000원 \(합성 판매처\)/)).toBeInTheDocument();
  expect(screen.queryByText("다른 술")).toBeNull();
  await waitFor(async () => expect(await db.sync_meta.get("interest-snapshot")).toBeDefined());
});

it("오프라인이면 받지 않고 마지막 저장본을 저장 시각과 함께 보인다", async () => {
  await saveInterestSnapshot(
    buildInterestSnapshot(
      [interest("i1", "The Glenlivet 12")],
      [],
      new Date("2026-10-18T03:00:00Z"),
    ),
  );
  const list = vi.spyOn(interestsApi, "list");
  renderWithQuery(<StoreModeInterests query="" offline />);

  expect(await screen.findByText(/관심 목록 1개 · 오프라인 저장본/)).toBeInTheDocument();
  expect(list).not.toHaveBeenCalled();
});

it("저장본이 없는 오프라인에서는 언제부터 볼 수 있는지 알린다", async () => {
  renderWithQuery(<StoreModeInterests query="" offline />);

  expect(await screen.findByText(/한 번 온라인에서 매장 모드를 연 뒤부터/)).toBeInTheDocument();
});
