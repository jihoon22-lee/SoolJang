import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportAnalysis, ImportCommitResult } from "@/api/types";
import { ImportPage } from "@/pages/ImportPage";
import { renderWithQuery, stubRoutes } from "@/testing";

const analysis: ImportAnalysis = {
  block: {
    record_count: 429,
    skipped_blank_lines: [326],
    total_row_lines: [432],
    excluded_line_count: 100,
  },
  totals: {
    products: 405,
    source_rows: 429,
    skus: 414,
    purchases: 434,
    bottles: 1078,
    vendors: 64,
    categories: 33,
    varieties: 82,
    list_amount: "42401108.00",
    paid_amount: "36495453.00",
    volume_ml: 704970,
  },
  review: {
    merge_group_count: 17,
    merge_examples: [[10, 11]],
    split_vendor_rows: [42],
    unsplit_vendor_rows: [7, 12, 19],
    warning_summary: [["주종 사전에 없는 값입니다", 3]],
  },
  sample: [
    {
      line_number: 2,
      name: "가상 와이너리 카베르네",
      vintage: 2019,
      volume_ml: 750,
      abv: "14.50",
      category_path: ["와인", "레드와인"],
      varieties: ["Cabernet Sauvignon"],
      unit_list_price: "23980.00",
      unit_paid_price: "23980.00",
      quantity: 1,
      vendors: ["가상마트"],
    },
  ],
};

const committed: ImportCommitResult = {
  products_created: 405,
  products_reused: 24,
  skus_created: 414,
  purchases_created: 434,
  purchases_skipped: 0,
  bottles_created: 1078,
  categories_created: 33,
  vendors_created: 64,
  varieties_created: 82,
  failed_rows: [],
};

function pickFile(): File {
  return new File(["dummy"], "alcohol.csv", { type: "text/csv" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ImportPage", () => {
  it("재실행이 안전함을 안내한다", () => {
    stubRoutes([]);
    renderWithQuery(<ImportPage />);

    expect(screen.getByText(/두 번 넣어도 중복이 생기지 않습니다/)).toBeInTheDocument();
  });

  it("파일을 고르기 전에는 분석할 수 없다", () => {
    stubRoutes([]);
    renderWithQuery(<ImportPage />);

    expect(screen.getByRole("button", { name: "분석 (미리보기)" })).toBeDisabled();
  });

  it("분석 전에는 적재할 수 없다", async () => {
    stubRoutes([]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());

    expect(screen.getByRole("button", { name: "분석 (미리보기)" })).toBeEnabled();
    // 미리보기 없이 넣으면 잘못된 매핑을 되돌리기 어렵다.
    expect(screen.getByRole("button", { name: "적재 실행" })).toBeDisabled();
  });

  it("분석 결과로 블록 분리 내역을 보여준다", async () => {
    stubRoutes([{ match: ":analyze", method: "POST", body: analysis }]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));

    expect(await screen.findByText("429행")).toBeInTheDocument();
    expect(screen.getByText("326")).toBeInTheDocument();
    expect(screen.getByText("432")).toBeInTheDocument();
    expect(screen.getByText("100행")).toBeInTheDocument();
  });

  it("적재될 총계를 보여준다", async () => {
    stubRoutes([{ match: ":analyze", method: "POST", body: analysis }]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));

    expect(await screen.findByText("1078병")).toBeInTheDocument();
    expect(screen.getByText("42,401,108원")).toBeInTheDocument();
    expect(screen.getByText("704,970ml")).toBeInTheDocument();
  });

  it("확인이 필요한 항목을 알려준다", async () => {
    stubRoutes([{ match: ":analyze", method: "POST", body: analysis }]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));

    expect(await screen.findByText(/합쳐질 행 묶음/)).toBeInTheDocument();
    expect(screen.getByText(/병수를 나눌 수 없어 하나로 넣을 행/)).toBeInTheDocument();
    expect(screen.getByText(/주종 사전에 없는 값입니다/)).toBeInTheDocument();
  });

  it("정규화 표본을 보여준다", async () => {
    stubRoutes([{ match: ":analyze", method: "POST", body: analysis }]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));

    expect(await screen.findByText("가상 와이너리 카베르네")).toBeInTheDocument();
    expect(screen.getByText("와인 › 레드와인")).toBeInTheDocument();
    expect(screen.getByText("2019")).toBeInTheDocument();
  });

  it("분석 후 적재하고 결과를 보여준다", async () => {
    const { calls } = stubRoutes([
      { match: ":analyze", method: "POST", body: analysis },
      { match: ":commit", method: "POST", status: 201, body: committed },
    ]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));
    await userEvent.click(await screen.findByRole("button", { name: "적재 실행" }));

    expect(await screen.findByText(/제품 405종 생성/)).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes(":commit"))).toBe(true);
    });
  });

  it("건너뛴 구매 건을 알려준다", async () => {
    stubRoutes([
      { match: ":analyze", method: "POST", body: analysis },
      {
        match: ":commit",
        method: "POST",
        status: 201,
        body: {
          ...committed,
          products_created: 0,
          products_reused: 429,
          purchases_skipped: 434,
          bottles_created: 0,
        },
      },
    ]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));
    await userEvent.click(await screen.findByRole("button", { name: "적재 실행" }));

    expect(await screen.findByText(/건너뛰었습니다/)).toBeInTheDocument();
  });

  it("실패한 행을 나열하고 나머지는 적재됐음을 알린다", async () => {
    stubRoutes([
      { match: ":analyze", method: "POST", body: analysis },
      {
        match: ":commit",
        method: "POST",
        status: 201,
        body: { ...committed, failed_rows: [[423, "제약 위반"]] },
      },
    ]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));
    await userEvent.click(await screen.findByRole("button", { name: "적재 실행" }));

    expect(await screen.findByText(/실패한 행 1건/)).toBeInTheDocument();
    expect(screen.getByText(/나머지 행은 정상 적재되었습니다/)).toBeInTheDocument();
  });

  it("분석 실패를 alert 로 알린다", async () => {
    stubRoutes([
      {
        match: ":analyze",
        method: "POST",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "요청 값이 올바르지 않습니다",
          status: 422,
          detail: "본 테이블 헤더를 찾지 못했습니다",
          instance: null,
          errors: [],
        },
      },
    ]);
    renderWithQuery(<ImportPage />);

    await userEvent.upload(screen.getByLabelText("CSV 파일"), pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("본 테이블 헤더를 찾지 못했습니다");
  });

  it("파일을 다시 고르면 이전 분석 결과를 지운다", async () => {
    stubRoutes([{ match: ":analyze", method: "POST", body: analysis }]);
    renderWithQuery(<ImportPage />);

    const input = screen.getByLabelText("CSV 파일");
    await userEvent.upload(input, pickFile());
    await userEvent.click(screen.getByRole("button", { name: "분석 (미리보기)" }));
    expect(await screen.findByText("429행")).toBeInTheDocument();

    await userEvent.upload(input, new File(["x"], "other.csv", { type: "text/csv" }));

    expect(screen.queryByText("429행")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적재 실행" })).toBeDisabled();
  });
});
