import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Purchase } from "@/api/types";
import { PurchaseEditForm } from "@/components/PurchaseEditForm";
import { renderWithQuery } from "@/testing";

const purchase: Purchase = {
  id: "pu1",
  sku_id: "s1",
  volume_ml: 700,
  vendor_id: "v1",
  vendor_name: "가상마트",
  purchased_on: "2026-03-01",
  quantity: 3,
  unit_list_price: "30000.00",
  unit_paid_price: "0.00",
  list_total: "90000.00",
  paid_total: "0.00",
  currency: "KRW",
  fx_rate: null,
  foreign_unit_price: null,
  discount_note: null,
  import_note: null,
  bottle_count: 3,
};

describe("PurchaseEditForm", () => {
  it("기존 값을 채우고 고친 값을 넘긴다(0원은 빈 칸으로 보인다)", async () => {
    const onSubmit = vi.fn();
    renderWithQuery(
      <PurchaseEditForm
        purchase={purchase}
        vendorNames={["가상마트"]}
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("병당 정가 (원)")).toHaveValue(30000);
    expect(screen.getByLabelText("병당 실구매가 (원)")).toHaveValue(null);
    await userEvent.type(screen.getByLabelText("병당 실구매가 (원)"), "25000");
    await userEvent.clear(screen.getByLabelText("병수"));
    await userEvent.type(screen.getByLabelText("병수"), "2");
    expect(screen.getByText(/번호가 큰 미개봉 병부터 지웁니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(onSubmit).toHaveBeenCalledWith({
      purchasedOn: "2026-03-01",
      vendorName: "가상마트",
      quantity: 2,
      unitListPrice: "30000",
      unitPaidPrice: "25000",
    });
  });

  it("병수가 올바르지 않으면 저장을 막고 서버 오류를 보여준다", async () => {
    renderWithQuery(
      <PurchaseEditForm
        purchase={purchase}
        vendorNames={[]}
        submitting={false}
        error={new Error("미개봉 병 1개만 줄일 수 있습니다")}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.clear(screen.getByLabelText("병수"));
    expect(screen.getByRole("button", { name: "수정 저장" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("미개봉 병 1개만");
  });
});

it("저장 중에는 구매 입력·취소·중복 제출을 막는다", async () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  renderWithQuery(
    <PurchaseEditForm
      purchase={purchase}
      vendorNames={[]}
      submitting
      error={null}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByLabelText("병수")).toBeDisabled();
  expect(screen.getByLabelText("구매처")).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "취소" }));
  await userEvent.click(screen.getByRole("button", { name: "저장 중…" }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});
