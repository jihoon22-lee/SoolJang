import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection, ProviderDefinition } from "@/api/types";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { authenticatedRoutes, type RouteStub, renderWithQuery, stubRoutes } from "@/testing";

const provider: ProviderDefinition = {
  kind: "openai_ocr",
  label: "OpenAI · 라벨 인식",
  fields: [{ name: "api_key", label: "OpenAI API 키", saved: false, masked_hint: null }],
  features: ["라벨 사진 인식"],
  guide_url: "https://platform.openai.com/api-keys",
  note: "모델 목록으로 인증만 확인합니다.",
  probe_supported: true,
};
const saved: ProviderConnection = {
  id: "connection-one",
  provider_kind: "openai_ocr",
  name: "내 라벨 인식",
  is_active: false,
  config_revision: 2,
  rate_limit_per_min: 6,
  request_limit_per_day: 1000,
  registration: "saved",
  missing_fields: [],
  credential_fields: [
    { name: "api_key", label: "OpenAI API 키", saved: true, masked_hint: "...abcd" },
  ],
  origin_kind: "llm",
  updated_at: "2026-09-07T00:00:00Z",
  verified_revision: null,
  last_test_at: null,
  last_outcome: "unknown",
  verification_stale: false,
  features: provider.features,
  sources: [],
  usage: { minute: 0, day: 0 },
  provider_remaining: null,
  ocr_model: "existing-model",
  ocr_rematch_enabled: false,
  ocr_rematch_monthly_cap: 200,
};
function setup(connections: ProviderConnection[] = [saved], extra: RouteStub[] = []) {
  const result = stubRoutes([
    ...authenticatedRoutes(),
    { match: "/connections/providers", body: [provider] },
    ...extra,
    { match: "/connections", body: connections },
  ]);
  renderWithQuery(<ConnectionsPanel />);
  return result;
}
afterEach(() => vi.unstubAllGlobals());
describe("ConnectionsPanel", () => {
  it("등록·확인·사용을 구분하고 조회만으로 외부 요청을 하지 않는다", async () => {
    const { calls, spy } = setup();
    expect(await screen.findByText("저장됨")).toBeInTheDocument();
    expect(screen.getByText("미검증")).toBeInTheDocument();
    expect(screen.getByText("일시 중지")).toBeInTheDocument();
    expect(screen.getByText(/\.\.\.abcd/)).toBeInTheDocument();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(
      spy.mock.calls
        .filter(([url]) => String(url).includes("/connections"))
        .every(([, init]) => init?.cache === "no-store"),
    ).toBe(true);
  });
  it("새 키 저장 뒤 입력을 비우고 자동 확인하지 않는다", async () => {
    const { calls } = setup(
      [],
      [{ match: "/connections", method: "POST", status: 201, body: saved }],
    );
    expect(await screen.findByText(/등록된 연결이 없습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "OpenAI · 라벨 인식 추가" }));
    expect(screen.getByLabelText("OpenAI API 키")).toHaveAttribute("type", "password");
    await userEvent.type(screen.getByLabelText("OpenAI API 키"), "test-secret-value");
    await userEvent.click(screen.getByRole("button", { name: "연결 저장" }));
    await waitFor(() => expect(screen.queryByLabelText("OpenAI API 키")).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      credentials: { api_key: "test-secret-value" }, // scan-secrets-allow: synthetic test credential
    });
    expect(calls.some((call) => call.url.includes("/probe"))).toBe(false);
  });
  it("빈 키를 유지하고 OCR 옵션을 함께 저장한다", async () => {
    const { calls } = setup(
      [saved],
      [{ match: "/connections/connection-one", method: "PATCH", body: saved }],
    );
    await userEvent.click(await screen.findByRole("button", { name: "설정 변경" }));
    expect(screen.getByLabelText("OpenAI API 키")).toHaveValue("");
    expect(screen.getByLabelText("라벨 인식 모델")).toHaveValue("existing-model");
    expect(screen.getByLabelText("AI 매칭 보조 사용")).not.toBeChecked();
    expect(screen.queryByLabelText("AI 매칭 월 호출 상한")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("AI 매칭 보조 사용"));
    await userEvent.clear(screen.getByLabelText("AI 매칭 월 호출 상한"));
    await userEvent.type(screen.getByLabelText("AI 매칭 월 호출 상한"), "30");
    await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        expected_revision: 2,
        credentials: {},
        ocr_rematch_enabled: true,
        ocr_rematch_monthly_cap: 30,
      }),
    );
  });
  it("기존 AI 옵션을 표시하고 선택한 키만 삭제한다", async () => {
    const { calls } = setup(
      [{ ...saved, ocr_rematch_enabled: true, ocr_rematch_monthly_cap: 50 }],
      [{ match: "/connections/connection-one", method: "PATCH", body: saved }],
    );
    await userEvent.click(await screen.findByRole("button", { name: "설정 변경" }));
    expect(screen.getByLabelText("AI 매칭 월 호출 상한")).toHaveValue(50);
    await userEvent.click(screen.getByLabelText("OpenAI API 키 삭제"));
    expect(screen.getByLabelText("OpenAI API 키")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        delete_credentials: ["api_key"],
        credentials: {},
      }),
    );
  });
  it("설정 충돌 오류를 표시한다", async () => {
    setup(
      [saved],
      [
        {
          match: "/connections/connection-one",
          method: "PATCH",
          status: 409,
          body: {
            type: "https://sooljang.local/errors/conflict",
            status: 409,
            title: "설정 충돌",
            detail: "최신 상태를 확인하세요",
            errors: [],
          },
        },
      ],
    );
    await userEvent.click(await screen.findByRole("button", { name: "설정 변경" }));
    await userEvent.click(screen.getByRole("button", { name: "변경 저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("최신 상태를 확인하세요");
  });
  it("사용 시작을 명시 요청으로 처리한다", async () => {
    const { calls } = setup(
      [saved],
      [{ match: "/connections/connection-one", method: "PATCH", body: saved }],
    );
    await userEvent.click(await screen.findByRole("button", { name: "사용 시작" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        expected_revision: 2,
        is_active: true,
      }),
    );
  });
  it("비용 안내 뒤 확인하고 늦은 결과 적용 여부를 보여준다", async () => {
    const { calls } = setup(
      [saved],
      [
        {
          match: "/connections/connection-one/probe",
          method: "POST",
          body: { outcome: "success", tested_revision: 2, applied: false },
        },
      ],
    );
    await userEvent.click(await screen.findByRole("button", { name: "연결 확인" }));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(screen.getByText(/요금에 반영될 수/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "지금 연결 확인" }));
    expect(await screen.findByText(/이전 검사 결과를 적용하지/)).toBeInTheDocument();
  });
  it("해제 영향을 안내한 뒤 명시 삭제한다", async () => {
    const { calls } = setup(
      [saved],
      [{ match: "/connections/connection-one", method: "DELETE", status: 204, body: null }],
    );
    await userEvent.click(await screen.findByRole("button", { name: "연결 해제" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("구매 기록은 보존");
    await userEvent.click(screen.getByRole("button", { name: "인증 정보 삭제하고 해제" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
        expected_revision: 2,
      }),
    );
  });
  it("키 불필요와 설정 변경 후 재확인을 구분한다", async () => {
    setup([
      {
        ...saved,
        registration: "not_required",
        credential_fields: [],
        verified_revision: 1,
        verification_stale: true,
      },
    ]);
    expect(await screen.findByText("키 불필요")).toBeInTheDocument();
    expect(screen.getByText("설정 변경 후 다시 확인 필요")).toBeInTheDocument();
  });
});
