import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VendorsPage } from "@/pages/VendorsPage";
import { db } from "@/sync/db";
import { renderWithQuery } from "@/testing";

function renderVendorsPage(onSelectVendor = vi.fn()) {
  renderWithQuery(<VendorsPage onSelectVendor={onSelectVendor} />);
  return { onSelectVendor };
}

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

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  await Promise.all([db.vendor.clear(), db.purchase.clear(), db.outbox.clear()]);
});

describe("VendorsPage", () => {
  it("구매처가 없으면 안내한다", async () => {
    renderVendorsPage();

    expect(await screen.findByText("등록된 구매처가 없습니다.")).toBeInTheDocument();
  });

  it("이름·종류·구매 건수·총 지출을 이름순으로 보여준다", async () => {
    await db.vendor.bulkPut([
      row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }),
      row({ id: "v2", name: "데일리샷", kind: "online", url: null, note: null }),
    ]);
    await db.purchase.bulkPut([
      row({
        id: "pu1",
        sku_id: "s1",
        vendor_id: "v1",
        quantity: 2,
        unit_paid_price: "10000",
        unit_list_price: "12000",
      }),
      // 실구매가가 없으면 정가로 보충한다.
      row({ id: "pu2", sku_id: "s2", vendor_id: "v1", quantity: 1, unit_list_price: "5000" }),
    ]);

    renderVendorsPage();

    const names = (await screen.findAllByRole("button", { name: /이마트|데일리샷/ })).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["데일리샷", "이마트"]);
    expect(screen.getByText("마트")).toBeInTheDocument();
    expect(screen.getByText("온라인")).toBeInTheDocument();
    expect(screen.getByText("구매 2건")).toBeInTheDocument();
    expect(screen.getByText("구매 0건")).toBeInTheDocument();
    // 10000*2 + 5000*1 = 25000
    expect(screen.getByText("25,000원")).toBeInTheDocument();
    expect(screen.getByText("가격 정보 없음")).toBeInTheDocument();
  });

  it("검색창에 타이핑하면 일치하는 구매처만 남는다", async () => {
    await db.vendor.bulkPut([
      row({ id: "v1", name: "이마트 트레이더스", kind: "mart", url: null, note: null }),
      row({ id: "v2", name: "데일리샷", kind: "online", url: null, note: null }),
    ]);

    renderVendorsPage();
    await screen.findByRole("button", { name: "이마트 트레이더스" });

    await userEvent.type(screen.getByLabelText("검색"), "이마트");

    expect(screen.getByRole("button", { name: "이마트 트레이더스" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "데일리샷" })).not.toBeInTheDocument();
  });

  it("검색 결과가 없으면 안내하고, 검색창은 지운다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderVendorsPage();
    await screen.findByRole("button", { name: "이마트" });

    await userEvent.type(screen.getByLabelText("검색"), "존재하지않는구매처");

    expect(screen.getByText("검색 결과가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이마트" })).not.toBeInTheDocument();
  });

  it("구매처가 없으면 검색창을 보여주지 않는다", async () => {
    renderVendorsPage();

    await screen.findByText("등록된 구매처가 없습니다.");
    expect(screen.queryByLabelText("검색")).not.toBeInTheDocument();
  });

  it("이름을 누르면 onSelectVendor 를 호출한다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));
    const { onSelectVendor } = renderVendorsPage();

    await userEvent.click(await screen.findByRole("button", { name: "이마트" }));

    expect(onSelectVendor).toHaveBeenCalledWith("v1");
  });

  it("수정을 누르면 현재 값이 채워진 폼이 열린다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderVendorsPage();
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));

    expect(screen.getByLabelText("이름")).toHaveValue("이마트");
    expect(screen.getByLabelText("종류")).toHaveValue("mart");
  });

  it("취소하면 저장하지 않고 폼을 닫는다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderVendorsPage();
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));
    await userEvent.clear(screen.getByLabelText("이름"));
    await userEvent.type(screen.getByLabelText("이름"), "다른 이름");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.queryByLabelText("이름")).not.toBeInTheDocument();
    const vendor = await db.vendor.get("v1");
    expect(vendor?.name).toBe("이마트");
  });

  it("이름·종류를 수정하면 로컬 미러에 낙관적으로 반영된다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderVendorsPage();
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));
    await userEvent.clear(screen.getByLabelText("이름"));
    await userEvent.type(screen.getByLabelText("이름"), "이마트 트레이더스");
    await userEvent.selectOptions(screen.getByLabelText("종류"), "duty_free");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(async () => {
      const vendor = await db.vendor.get("v1");
      expect(vendor?.name).toBe("이마트 트레이더스");
      expect(vendor?.kind).toBe("duty_free");
    });
    expect(screen.queryByLabelText("이름")).not.toBeInTheDocument();

    const entries = await db.outbox.toArray();
    expect(entries.some((entry) => entry.entity === "vendor" && entry.op === "update")).toBe(true);
  });
});
