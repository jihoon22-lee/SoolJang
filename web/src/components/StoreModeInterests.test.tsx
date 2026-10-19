import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
    {
      amount: "45000",
      currency: "KRW",
      source: "합성 판매처",
      volumeMl: null,
      units: null,
      conditions: {},
    },
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

it("오프라인에서 캐시로 다시 그린 목록은 저장 시각을 새로 쓰지 않는다", async () => {
  vi.spyOn(interestsApi, "list").mockResolvedValue([interest("i1", "The Glenlivet 12")]);
  vi.spyOn(priceWatchApi, "list").mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mount = (offline: boolean) =>
    render(
      <QueryClientProvider client={client}>
        <StoreModeInterests query="" offline={offline} />
      </QueryClientProvider>,
    );
  const savedAt = async () => {
    const raw = (await db.sync_meta.get("interest-snapshot"))?.value;
    return raw ? (JSON.parse(raw) as { savedAt: string }).savedAt : undefined;
  };
  const online = mount(false);
  await waitFor(async () => expect(await savedAt()).toBeDefined());
  const first = await savedAt();
  online.unmount();
  await new Promise((resolve) => setTimeout(resolve, 5));

  mount(true);

  expect(await screen.findByText(/관심 목록 1개 · 오프라인 저장본/)).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await savedAt()).toBe(first);
});

it("더 늦게 받은 저장본은 오래된 목록으로 덮지 않는다", async () => {
  await saveInterestSnapshot(
    buildInterestSnapshot([interest("i1", "새 목록")], [], new Date("2026-10-18T05:00:00Z")),
  );
  await saveInterestSnapshot(
    buildInterestSnapshot([interest("i2", "옛 목록")], [], new Date("2026-10-18T04:00:00Z")),
  );

  const raw = (await db.sync_meta.get("interest-snapshot"))?.value ?? "";
  expect(raw).toContain("새 목록");
  expect(raw).not.toContain("옛 목록");
});

it("기기 시계가 앞서 있던 때의 미래 저장본은 새 목록이 덮는다", async () => {
  await saveInterestSnapshot(
    buildInterestSnapshot([interest("i1", "미래 목록")], [], new Date(Date.now() + 86_400_000)),
  );
  await saveInterestSnapshot(buildInterestSnapshot([interest("i2", "지금 목록")], [], new Date()));

  const raw = (await db.sync_meta.get("interest-snapshot"))?.value ?? "";
  expect(raw).toContain("지금 목록");
});

it("온라인이어도 목록을 받지 못하면 저장본임과 저장 시각을 함께 보인다", async () => {
  await saveInterestSnapshot(
    buildInterestSnapshot(
      [interest("i1", "The Glenlivet 12")],
      [],
      new Date("2026-10-18T03:00:00Z"),
    ),
  );
  vi.spyOn(interestsApi, "list").mockRejectedValue(new Error("502"));
  vi.spyOn(priceWatchApi, "list").mockResolvedValue([]);
  renderWithQuery(<StoreModeInterests query="" offline={false} />);

  expect(await screen.findByText(/관심 목록 1개 · 저장본\(/)).toBeInTheDocument();
});

it("목표가에는 감시한 용량을 함께 적는다", async () => {
  vi.spyOn(interestsApi, "list").mockResolvedValue([
    interest("i1", "The Glenlivet 12", {
      identity: { name: "The Glenlivet 12", volumes_ml: [700, 1750] },
    }),
  ]);
  vi.spyOn(priceWatchApi, "list").mockResolvedValue([
    watch({
      criteria: { target_amount: "45000", currency: "KRW", volume_ml: "700.00" },
    } as never),
  ]);
  renderWithQuery(<StoreModeInterests query="Glenlivet" offline={false} />);

  expect(await screen.findByText(/목표 45,000원 \(700ml, 합성 판매처\)/)).toBeInTheDocument();
});

it("묶음 수량·판매 조건이 붙은 목표가는 단품 진열가와 섞이지 않게 함께 적는다", async () => {
  vi.spyOn(interestsApi, "list").mockResolvedValue([interest("i1", "The Glenlivet 12")]);
  vi.spyOn(priceWatchApi, "list").mockResolvedValue([
    watch({
      criteria: {
        target_amount: "300000",
        currency: "KRW",
        volume_ml: "700.00",
        units: 6,
        conditions: { price_kind: "regular", membership: "member", coupon: null },
      },
    } as never),
  ]);
  renderWithQuery(<StoreModeInterests query="Glenlivet" offline={false} />);

  expect(
    await screen.findByText(
      /목표 300,000원 \(700ml × 6병, 가격 종류 regular, 회원 member, 합성 판매처\)/,
    ),
  ).toBeInTheDocument();
});

it("저장본이 없는 오프라인에서는 언제부터 볼 수 있는지 알린다", async () => {
  renderWithQuery(<StoreModeInterests query="" offline />);

  expect(await screen.findByText(/한 번 온라인에서 매장 모드를 연 뒤부터/)).toBeInTheDocument();
});
