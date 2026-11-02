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

describe("외화 구매 수정 (D276)", () => {
  const foreign: Purchase = {
    ...purchase,
    quantity: 1,
    unit_list_price: null,
    unit_paid_price: "66827.00",
    currency: "USD",
    fx_rate: "1431.900000",
    foreign_unit_price: "46.67",
  };
  function renderForm(item: Purchase) {
    const onSubmit = vi.fn();
    renderWithQuery(
      <PurchaseEditForm
        purchase={item}
        vendorNames={[]}
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    return onSubmit;
  }

  it("외화 칸을 고치지 않으면 저장된 실구매가와 외화 값을 보내지 않는다", async () => {
    const onSubmit = renderForm({ ...foreign, unit_paid_price: "46.67" });

    expect(screen.getByRole("checkbox", { name: "해외 구매(외화로 결제)" })).toBeChecked();
    expect(screen.getByLabelText("통화")).toHaveValue("USD");
    expect(screen.getByLabelText("환율 (1 USD당 원)")).toHaveValue(1431.9);
    // 검사 전 기록처럼 어긋난 실구매가도 고치지 않으면 그대로 둔다.
    expect(screen.getByLabelText("병당 실구매가 (원)")).toHaveValue(46.67);
    expect(screen.getByText(/저장된 실구매가가 외화 단가 × 환율과 1% 넘게 다릅니다/)).toBeVisible();
    await userEvent.clear(screen.getByLabelText("구매처"));
    await userEvent.type(screen.getByLabelText("구매처"), "해외 직구");
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(onSubmit).toHaveBeenCalledWith({
      purchasedOn: "2026-03-01",
      vendorName: "해외 직구",
      quantity: 1,
      unitListPrice: "",
    });
  });

  it("환율을 고치면 원 단위 환산 실구매가와 외화 값을 함께 보낸다", async () => {
    const onSubmit = renderForm(foreign);

    const rate = screen.getByLabelText("환율 (1 USD당 원)");
    await userEvent.clear(rate);
    await userEvent.type(rate, "1500");
    expect(screen.getByLabelText("병당 실구매가 (원)")).toHaveValue(70005);
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        unitPaidPrice: "70005",
        foreign: { currency: "USD", fxRate: "1500", foreignUnitPrice: "46.67" },
      }),
    );
  });

  it("어긋난 실구매가는 환산값으로 맞춰 저장할 수 있다", async () => {
    const onSubmit = renderForm({ ...foreign, unit_paid_price: "46.67" });

    await userEvent.click(screen.getByRole("button", { name: "환산값으로 맞추기" }));
    expect(screen.getByLabelText("병당 실구매가 (원)")).toHaveValue(66827);
    expect(screen.getByLabelText("병당 실구매가 (원)")).toHaveFocus();
    expect(screen.queryByText(/1% 넘게 다릅니다/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        unitPaidPrice: "66827",
        foreign: { currency: "USD", fxRate: "1431.9", foreignUnitPrice: "46.67" },
      }),
    );
  });

  it("원화로 되돌리면 외화 값을 지우고 입력한 실구매가를 보낸다", async () => {
    const onSubmit = renderForm(foreign);

    await userEvent.click(screen.getByRole("checkbox", { name: "해외 구매(외화로 결제)" }));
    const paid = screen.getByLabelText("병당 실구매가 (원)");
    expect(paid).not.toHaveAttribute("readonly");
    await userEvent.clear(paid);
    await userEvent.type(paid, "65000");
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ unitPaidPrice: "65000", foreign: null }),
    );
  });

  function formFor(item: Purchase, onSubmit: (input: unknown) => void) {
    return (
      <PurchaseEditForm
        purchase={item}
        vendorNames={[]}
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );
  }

  async function changeVendorAndSave() {
    await userEvent.clear(screen.getByLabelText("구매처"));
    await userEvent.type(screen.getByLabelText("구매처"), "해외 직구");
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));
  }

  it("열어 둔 사이 동기화로 바뀐 외화 값을 사용자가 고친 값으로 되돌려 보내지 않는다", async () => {
    const onSubmit = vi.fn();
    const view = renderWithQuery(formFor(foreign, onSubmit));
    // 방금 저장한 환율 수정이나 다른 기기의 수정이 열린 폼 아래로 동기화된다.
    view.rerender(
      formFor({ ...foreign, fx_rate: "1500.000000", unit_paid_price: "70005.00" }, onSubmit),
    );
    await changeVendorAndSave();

    expect(onSubmit).toHaveBeenCalledWith({
      purchasedOn: "2026-03-01",
      vendorName: "해외 직구",
      quantity: 1,
      unitListPrice: "",
    });
  });

  it("원화로 연 폼은 그 사이 외화로 바뀐 기록의 외화 값을 지우라고 보내지 않는다", async () => {
    const onSubmit = vi.fn();
    const view = renderWithQuery(formFor(purchase, onSubmit));
    view.rerender(
      formFor(
        {
          ...purchase,
          unit_paid_price: "66827.00",
          currency: "USD",
          fx_rate: "1431.900000",
          foreign_unit_price: "46.67",
        },
        onSubmit,
      ),
    );
    await changeVendorAndSave();

    expect(onSubmit).toHaveBeenCalledWith({
      purchasedOn: "2026-03-01",
      vendorName: "해외 직구",
      quantity: 3,
      unitListPrice: "30000",
      unitPaidPrice: "",
    });
  });

  it("외화로 바꿀 때 외화 단가·환율이 없거나 환산값이 저장 범위를 넘으면 보내지 않는다", async () => {
    const onSubmit = renderForm(purchase);

    await userEvent.click(screen.getByRole("checkbox", { name: "해외 구매(외화로 결제)" }));
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "해외 구매는 외화 단가와 환율을 함께 입력하세요",
    );
    await userEvent.type(screen.getByLabelText("병당 외화 단가 (USD)"), "9999999999");
    await userEvent.type(screen.getByLabelText("환율 (1 USD당 원)"), "1000");
    await userEvent.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(screen.getByRole("alert")).toHaveTextContent("저장할 수 있는 금액보다 큽니다");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
