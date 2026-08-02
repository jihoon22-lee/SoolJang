import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryNode } from "@/api/types";
import { LabelOcrPanel } from "@/components/LabelOcrPanel";
import type { ProductFormValues } from "@/components/ProductForm";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATEGORIES: CategoryNode[] = [
  {
    id: "cat-whiskey",
    parent_id: null,
    name: "위스키",
    depth: 0,
    path: ["위스키"],
    is_seeded: true,
    sort_order: 0,
    product_count: 0,
    descendant_product_count: 0,
  },
];

const CANNED_EXTRACTION = {
  name: "글렌알라키 12년",
  name_confidence: 0.9,
  producer: "GlenAllachie",
  producer_confidence: 0.7,
  abv: 46,
  abv_confidence: 0.6,
  volume_ml: 700,
  volume_ml_confidence: 0.85,
  vintage: null,
  vintage_confidence: 0.0,
  age_years: 12,
  age_years_confidence: 0.8,
  category_guess: "위스키",
  category_guess_confidence: 0.95,
};

function pngFile(name = "label.png"): File {
  return new File(["fake-png-bytes"], name, { type: "image/png" });
}

describe("LabelOcrPanel", () => {
  it("평소에는 라벨로 등록 버튼만 보인다", () => {
    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={vi.fn()} />);
    expect(screen.getByRole("button", { name: "라벨로 등록" })).toBeInTheDocument();
  });

  it("사진을 고르면 인식 결과를 보여주고, 등록하면 프리필 값을 넘긴다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/ocr/label", method: "POST", body: CANNED_EXTRACTION },
    ]);
    const onPrefill = vi.fn();

    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={onPrefill} />);
    const input = screen.getByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(input, pngFile());

    expect(await screen.findByRole("dialog", { name: "라벨 인식 결과" })).toBeInTheDocument();
    expect(screen.getByText(/글렌알라키 12년/)).toBeInTheDocument();
    expect(screen.getByText(/신뢰도 90%/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "이 정보로 등록" }));

    expect(onPrefill).toHaveBeenCalledTimes(1);
    const [values, file] = onPrefill.mock.calls[0] as [Partial<ProductFormValues>, File];
    expect(values.name).toBe("글렌알라키 12년");
    expect(values.abv).toBe("46");
    expect(values.volumeMl).toBe("700");
    expect(values.categoryId).toBe("cat-whiskey");
    expect(values.note).toBe("생산자: GlenAllachie · 숙성 12년");
    expect(file.name).toBe("label.png");

    // 등록 후에는 다시 idle 로 돌아간다.
    expect(screen.getByRole("button", { name: "라벨로 등록" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("취소하면 프리필을 넘기지 않고 idle 로 돌아간다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/ocr/label", method: "POST", body: CANNED_EXTRACTION },
    ]);
    const onPrefill = vi.fn();

    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={onPrefill} />);
    const input = screen.getByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(input, pngFile());
    await screen.findByRole("dialog", { name: "라벨 인식 결과" });

    await userEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(onPrefill).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "라벨로 등록" })).toBeInTheDocument();
  });

  it("LLM 설정이 없으면 설정 화면으로 안내한다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/ocr/label",
        method: "POST",
        status: 409,
        body: {
          type: "https://sooljang.local/errors/llm-not-configured",
          title: "LLM 설정이 필요합니다",
          status: 409,
          detail: "라벨 OCR 을 쓰려면 먼저 설정 화면에서 LLM API 키를 등록하세요",
          errors: [],
        },
      },
    ]);

    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={vi.fn()} />);
    const input = screen.getByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(input, pngFile());

    expect(await screen.findByRole("alert")).toHaveTextContent("LLM API 키를 등록하세요");
    expect(screen.getByText(/등록한 뒤 다시 시도하세요/)).toBeInTheDocument();
  });

  it("일반 오류는 일반 메시지를 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/ocr/label",
        method: "POST",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "요청 값이 올바르지 않습니다",
          status: 422,
          detail: "라벨 인식에 실패했습니다. 다시 시도하거나 직접 입력하세요",
          errors: [],
        },
      },
    ]);

    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={vi.fn()} />);
    const input = screen.getByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(input, pngFile());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("다시 시도하거나 직접 입력하세요");
    expect(screen.queryByText(/설정 화면에서/)).not.toBeInTheDocument();
  });

  it("일치하는 카테고리가 없으면 categoryId 를 비워 둔다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/ocr/label",
        method: "POST",
        body: { ...CANNED_EXTRACTION, category_guess: "엉뚱한주종" },
      },
    ]);
    const onPrefill = vi.fn();

    renderWithQuery(<LabelOcrPanel categories={CATEGORIES} onPrefill={onPrefill} />);
    const input = screen.getByLabelText("라벨 사진으로 등록", { selector: "input" });
    await userEvent.upload(input, pngFile());
    await screen.findByRole("dialog", { name: "라벨 인식 결과" });

    await userEvent.click(screen.getByRole("button", { name: "이 정보로 등록" }));

    await waitFor(() => expect(onPrefill).toHaveBeenCalledTimes(1));
    const [values] = onPrefill.mock.calls[0] as [Partial<ProductFormValues>, File];
    expect(values.categoryId).toBeUndefined();
  });
});
