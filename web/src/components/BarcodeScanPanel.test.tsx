import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barcodesApi, productsApi } from "@/api/client";
import type { Product } from "@/api/types";
import type { ScannerController } from "@/barcode/scanner";
import { BarcodeScanPanel } from "@/components/BarcodeScanPanel";
import { activateDatabase, db, lockDatabase } from "@/sync/db";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const NOW = "2026-01-01T00:00:00Z";

function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    user_id: "u1",
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

/** 실제 카메라 대신 즉시 코드 하나를 감지한 것처럼 흉내 낸다. */
function fakeScanDetecting(code: string) {
  return async (
    _video: HTMLVideoElement,
    onDetect: (code: string) => void,
  ): Promise<ScannerController> => {
    onDetect(code);
    return { stop: () => {} };
  };
}

beforeEach(async () => {
  await activateDatabase("u1");
  await Promise.all([db.product.clear(), db.sku.clear()]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([db.product.clear(), db.sku.clear()]);
  lockDatabase();
});

describe("BarcodeScanPanel", () => {
  it("평소에는 스캔 버튼만 보인다", () => {
    renderWithQuery(<BarcodeScanPanel onSelectProduct={vi.fn()} />);
    expect(screen.getByRole("button", { name: "바코드로 스캔" })).toBeInTheDocument();
  });

  it("로컬에 이미 등록된 바코드면 제품 이동 버튼을 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234567890",
        body: {
          barcode: "8801234567890",
          barcode_type: "ean13",
          is_rcn: false,
          source: "local",
          local_match: {
            product_id: "p1",
            product_name: "글렌알라키",
            sku_id: "s1",
            volume_ml: 700,
          },
          external_suggestion: null,
        },
      },
    ]);
    const onSelectProduct = vi.fn();

    renderWithQuery(
      <BarcodeScanPanel
        onSelectProduct={onSelectProduct}
        scan={fakeScanDetecting("8801234567890")}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    expect(await screen.findByText(/글렌알라키/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "제품으로 이동" }));
    expect(onSelectProduct).toHaveBeenCalledWith("p1", { skuId: "s1" });
  });

  it("외부 제안이 있으면 이름을 미리 채우고, 등록하면 바코드를 붙여 만든다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234500009",
        body: {
          barcode: "8801234500009",
          barcode_type: "ean13",
          is_rcn: false,
          source: "external",
          local_match: null,
          external_suggestion: {
            name: "외부 제안 위스키",
            brand: "가상 브랜드",
            quantity_text: "700 ml",
            image_url: null,
            source_url: "https://world.openfoodfacts.org/product/8801234500009",
          },
        },
      },
      {
        match: "/products",
        method: "POST",
        status: 201,
        body: {
          id: "new-product",
          name: "외부 제안 위스키",
          skus: [{ id: "new-sku", volume_ml: 700 }],
        },
      },
    ]);
    const onSelectProduct = vi.fn();

    renderWithQuery(
      <BarcodeScanPanel
        onSelectProduct={onSelectProduct}
        scan={fakeScanDetecting("8801234500009")}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    expect(await screen.findByLabelText("이름")).toHaveValue("외부 제안 위스키");
    await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
    await userEvent.click(screen.getByRole("button", { name: "이 바코드로 새로 등록" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url.includes("/products"));
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        name: "외부 제안 위스키",
        skus: [{ volume_ml: 700, barcode: "8801234500009" }],
      });
    });
    expect(onSelectProduct).toHaveBeenCalledWith("new-product", { skuId: "new-sku" });
  });

  it("RCN 바코드는 경고를 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/2000010000059",
        body: {
          barcode: "2000010000059",
          barcode_type: "rcn",
          is_rcn: true,
          source: "not_found",
          local_match: null,
          external_suggestion: null,
        },
      },
    ]);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("2000010000059")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("매장 내부용(RCN)");
  });

  it("기존 술에 연결하면 규격에 바코드를 저장한다", async () => {
    await db.product.put(row({ id: "p1", name: "이미 있는 술", category_id: null }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 500 }));
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234500009",
        body: {
          barcode: "8801234500009",
          barcode_type: "ean13",
          is_rcn: false,
          source: "not_found",
          local_match: null,
          external_suggestion: null,
        },
      },
      { match: "/skus/s1", method: "PATCH", body: { id: "s1", barcode: "8801234500009" } },
    ]);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234500009")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    const select = await screen.findByLabelText("규격 선택");
    await waitFor(() => {
      expect(select.querySelectorAll("option")).toHaveLength(2); // "선택하세요" + 1개
    });
    await userEvent.selectOptions(select, "s1");
    await userEvent.click(screen.getByRole("button", { name: "이 규격에 바코드 연결" }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("/skus/s1"));
      expect(patch).toBeDefined();
      expect(patch?.body).toMatchObject({ barcode: "8801234500009" });
    });
  });

  it("카메라를 시작할 수 없으면 오류를 보여준다", async () => {
    const failingScan = async (): Promise<ScannerController> => {
      throw new Error("permission denied");
    };
    stubRoutes([...authenticatedRoutes()]);

    renderWithQuery(<BarcodeScanPanel onSelectProduct={vi.fn()} scan={failingScan} />);
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("카메라를 시작할 수 없습니다");
  });

  it("등록 폼을 비운 채 제출하면 로컬에서 바로 막는다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234500009",
        body: {
          barcode: "8801234500009",
          barcode_type: "ean13",
          is_rcn: false,
          source: "not_found",
          local_match: null,
          external_suggestion: null,
        },
      },
    ]);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234500009")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
    await userEvent.click(await screen.findByRole("button", { name: "이 바코드로 새로 등록" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("이름과 용량을 입력하세요");
  });

  it("규격을 고르지 않으면 연결 버튼이 비활성 상태다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234500009",
        body: {
          barcode: "8801234500009",
          barcode_type: "ean13",
          is_rcn: false,
          source: "not_found",
          local_match: null,
          external_suggestion: null,
        },
      },
    ]);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234500009")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));

    expect(await screen.findByRole("button", { name: "이 규격에 바코드 연결" })).toBeDisabled();
  });

  it("연결 중 서버 오류가 나면 메시지를 보여준다", async () => {
    await db.product.put(row({ id: "p1", name: "이미 있는 술", category_id: null }));
    await db.sku.put(row({ id: "s1", product_id: "p1", volume_ml: 500 }));
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/barcodes/8801234500009",
        body: {
          barcode: "8801234500009",
          barcode_type: "ean13",
          is_rcn: false,
          source: "not_found",
          local_match: null,
          external_suggestion: null,
        },
      },
      {
        match: "/skus/s1",
        method: "PATCH",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "요청 값이 올바르지 않습니다",
          status: 422,
          detail: "이미 다른 규격이 쓰고 있는 바코드입니다",
          errors: [],
        },
      },
    ]);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234500009")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
    const select = await screen.findByLabelText("규격 선택");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    await userEvent.selectOptions(select, "s1");
    await userEvent.click(screen.getByRole("button", { name: "이 규격에 바코드 연결" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "이미 다른 규격이 쓰고 있는 바코드입니다",
    );
  });

  it("닫기를 누르면 처음 화면으로 돌아간다", async () => {
    stubRoutes([...authenticatedRoutes()]);
    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234567890")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
    await screen.findByRole("dialog", { name: "바코드 스캔" });

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    expect(screen.getByRole("button", { name: "바코드로 스캔" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("조회 응답이 늦게 오는 동안 닫으면 다시 열리지 않는다(B9)", async () => {
    stubRoutes([...authenticatedRoutes()]);
    let resolveLookup: (value: Awaited<ReturnType<typeof barcodesApi.lookup>>) => void = () => {};
    const pending = new Promise<Awaited<ReturnType<typeof barcodesApi.lookup>>>((resolve) => {
      resolveLookup = resolve;
    });
    vi.spyOn(barcodesApi, "lookup").mockReturnValue(pending);

    renderWithQuery(
      <BarcodeScanPanel onSelectProduct={vi.fn()} scan={fakeScanDetecting("8801234567890")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
    await screen.findByText("조회하는 중…");

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.getByRole("button", { name: "바코드로 스캔" })).toBeInTheDocument();

    resolveLookup({
      barcode: "8801234567890",
      barcode_type: "ean13",
      is_rcn: false,
      source: "local",
      local_match: { product_id: "p1", product_name: "테스트 술", sku_id: "s1", volume_ml: 700 },
      external_suggestion: null,
    });
    // 늦게 도착한 응답의 setPhase 가 다이얼로그를 다시 열지 않는지 확인한다 — 열렸다면
    // 아래 쿼리가 실패해야 하므로, 이미 안정된 이 시점에 바로 확인해도 된다.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "바코드로 스캔" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

it("확인한 판본·규격에만 바코드를 연결하고 그 SKU 맥락으로 이동한다", async () => {
  await db.product.bulkPut([
    row({ id: "p20", name: "같은 이름", vintage: 2020, abv: "40", category_id: null }),
    row({ id: "p21", name: "같은 이름", vintage: 2021, abv: "46", category_id: null }),
  ]);
  await db.sku.bulkPut([
    row({ id: "s20", product_id: "p20", volume_ml: 750 }),
    row({ id: "s21", product_id: "p21", volume_ml: 750 }),
  ]);
  const { calls } = stubRoutes([
    ...authenticatedRoutes(),
    {
      match: "/barcodes/8801234500009",
      body: {
        barcode: "8801234500009",
        barcode_type: "ean13",
        is_rcn: false,
        source: "not_found",
        local_match: null,
        external_suggestion: null,
      },
    },
    { match: "/skus/s21", method: "PATCH", body: { id: "s21", barcode: "8801234500009" } },
  ]);
  const onSelectProduct = vi.fn();
  renderWithQuery(
    <BarcodeScanPanel
      onSelectProduct={onSelectProduct}
      scan={fakeScanDetecting("8801234500009")}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
  expect(
    await screen.findByRole("option", { name: /2020 빈티지.*40%.*750ml/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /2021 빈티지.*46%.*750ml/ })).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText("규격 선택"), "s21");
  expect(onSelectProduct).not.toHaveBeenCalled();
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "이 규격에 바코드 연결" }));
  await waitFor(() => expect(onSelectProduct).toHaveBeenCalledWith("p21", { skuId: "s21" }));
  expect(calls.filter((call) => call.method === "PATCH").map((call) => call.url)).toEqual([
    expect.stringContaining("/skus/s21"),
  ]);
});

it("닫힌 바코드 등록의 늦은 성공은 새 화면으로 이동시키지 않는다", async () => {
  stubRoutes([
    {
      match: "/barcodes/8801234500009",
      body: {
        barcode: "8801234500009",
        barcode_type: "ean13",
        is_rcn: false,
        source: "not_found",
        local_match: null,
        external_suggestion: null,
      },
    },
  ]);
  let complete!: (value: Product) => void;
  vi.spyOn(productsApi, "create").mockImplementation(
    () =>
      new Promise<Product>((resolve) => {
        complete = resolve;
      }),
  );
  const onSelectProduct = vi.fn();
  renderWithQuery(
    <BarcodeScanPanel
      onSelectProduct={onSelectProduct}
      scan={fakeScanDetecting("8801234500009")}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
  await userEvent.type(await screen.findByLabelText("이름"), "늦게 생성된 술");
  await userEvent.type(screen.getByLabelText("용량 (ml)"), "700");
  await userEvent.click(screen.getByRole("button", { name: "이 바코드로 새로 등록" }));
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await act(async () =>
    complete({ id: "late-product", skus: [{ id: "late-sku", volume_ml: 700 }] } as Product),
  );
  expect(onSelectProduct).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "바코드로 스캔" })).toBeInTheDocument();
});

it("닫고 다시 스캔한 뒤 이전 조회 응답이 와도 새 바코드의 SKU를 유지한다", async () => {
  let finishOld!: (value: Awaited<ReturnType<typeof barcodesApi.lookup>>) => void;
  const lookup = vi.spyOn(barcodesApi, "lookup");
  lookup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  lookup.mockResolvedValueOnce({
    barcode: "8801234567890",
    barcode_type: "ean13",
    is_rcn: false,
    source: "local",
    local_match: {
      product_id: "new-product",
      product_name: "새 스캔 술",
      sku_id: "new-sku",
      volume_ml: 750,
    },
    external_suggestion: null,
  });
  let calls = 0;
  const scan = async (
    _video: HTMLVideoElement,
    onDetect: (code: string) => void,
  ): Promise<ScannerController> => {
    onDetect(calls++ === 0 ? "8801234500009" : "8801234567890");
    return { stop: () => {} };
  };
  const onSelectProduct = vi.fn();
  renderWithQuery(<BarcodeScanPanel onSelectProduct={onSelectProduct} scan={scan} />);
  await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
  await screen.findByText("조회하는 중…");
  await userEvent.click(screen.getByRole("button", { name: "닫기" }));
  await userEvent.click(screen.getByRole("button", { name: "바코드로 스캔" }));
  await screen.findByText(/새 스캔 술/);
  await act(async () =>
    finishOld({
      barcode: "8801234500009",
      barcode_type: "ean13",
      is_rcn: false,
      source: "local",
      local_match: {
        product_id: "old-product",
        product_name: "이전 스캔 술",
        sku_id: "old-sku",
        volume_ml: 500,
      },
      external_suggestion: null,
    }),
  );
  expect(screen.queryByText(/이전 스캔 술/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "제품으로 이동" }));
  expect(onSelectProduct).toHaveBeenCalledWith("new-product", { skuId: "new-sku" });
});
