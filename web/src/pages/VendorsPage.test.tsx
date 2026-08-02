import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VendorsPage } from "@/pages/VendorsPage";
import { db } from "@/sync/db";
import { renderWithQuery } from "@/testing";

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
    renderWithQuery(<VendorsPage />);

    expect(await screen.findByText("등록된 구매처가 없습니다.")).toBeInTheDocument();
  });

  it("이름·종류·구매 건수를 이름순으로 보여준다", async () => {
    await db.vendor.bulkPut([
      row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }),
      row({ id: "v2", name: "데일리샷", kind: "online", url: null, note: null }),
    ]);
    await db.purchase.bulkPut([
      row({ id: "pu1", sku_id: "s1", vendor_id: "v1", quantity: 1 }),
      row({ id: "pu2", sku_id: "s2", vendor_id: "v1", quantity: 1 }),
    ]);

    renderWithQuery(<VendorsPage />);

    const names = (await screen.findAllByText(/이마트|데일리샷/)).map((el) => el.textContent);
    expect(names).toEqual(["데일리샷", "이마트"]);
    expect(screen.getByText("마트")).toBeInTheDocument();
    expect(screen.getByText("온라인")).toBeInTheDocument();
    expect(screen.getByText("구매 2건")).toBeInTheDocument();
    expect(screen.getByText("구매 0건")).toBeInTheDocument();
  });

  it("수정을 누르면 현재 값이 채워진 폼이 열린다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderWithQuery(<VendorsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "수정" }));

    expect(screen.getByLabelText("이름")).toHaveValue("이마트");
    expect(screen.getByLabelText("종류")).toHaveValue("mart");
  });

  it("취소하면 저장하지 않고 폼을 닫는다", async () => {
    await db.vendor.put(row({ id: "v1", name: "이마트", kind: "mart", url: null, note: null }));

    renderWithQuery(<VendorsPage />);
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

    renderWithQuery(<VendorsPage />);
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
