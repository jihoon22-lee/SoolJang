import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/SettingsPage";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("설정이 없으면 설정되지 않음을 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/llm-settings",
        method: "GET",
        body: {
          configured: false,
          provider: null,
          model: null,
          api_key_masked: null,
          updated_at: null,
        },
      },
    ]);

    renderWithQuery(<SettingsPage />);

    expect(await screen.findByText("설정되지 않음")).toBeInTheDocument();
  });

  it("키를 저장하면 마스킹된 값을 보여준다", async () => {
    const { calls } = stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/llm-settings",
        method: "GET",
        body: {
          configured: false,
          provider: null,
          model: null,
          api_key_masked: null,
          updated_at: null,
        },
      },
      {
        match: "/llm-settings",
        method: "PUT",
        body: {
          configured: true,
          provider: "openai",
          model: "gpt-4o-mini",
          api_key_masked: "...cdef",
          updated_at: "2026-08-01T00:00:00Z",
        },
      },
    ]);

    renderWithQuery(<SettingsPage />);
    await screen.findByText("설정되지 않음");

    await userEvent.type(screen.getByLabelText("OpenAI API 키"), "sk-test-1234567890abcdef"); // scan-secrets-allow
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText(/설정됨/)).toBeInTheDocument();
    expect(screen.getByText(/\.\.\.cdef/)).toBeInTheDocument();

    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT" && call.url.includes("/llm-settings"));
      expect(put).toBeDefined();
      expect(put?.body).toMatchObject({
        provider: "openai",
        api_key: "sk-test-1234567890abcdef", // scan-secrets-allow
      });
    });
  });

  it("저장 실패는 오류 메시지를 보여준다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/llm-settings",
        method: "GET",
        body: {
          configured: false,
          provider: null,
          model: null,
          api_key_masked: null,
          updated_at: null,
        },
      },
      {
        match: "/llm-settings",
        method: "PUT",
        status: 422,
        body: {
          type: "https://sooljang.local/errors/validation",
          title: "요청 값이 올바르지 않습니다",
          status: 422,
          detail: "API 키가 너무 짧습니다",
          errors: [],
        },
      },
    ]);

    renderWithQuery(<SettingsPage />);
    await screen.findByText("설정되지 않음");

    await userEvent.type(screen.getByLabelText("OpenAI API 키"), "sk-short");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("API 키가 너무 짧습니다");
  });

  it("설정된 키를 삭제하면 다시 설정되지 않음으로 바뀐다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/llm-settings",
        method: "GET",
        body: {
          configured: true,
          provider: "openai",
          model: "gpt-4o-mini",
          api_key_masked: "...cdef",
          updated_at: "2026-08-01T00:00:00Z",
        },
      },
      { match: "/llm-settings", method: "DELETE", status: 204, body: null },
    ]);

    renderWithQuery(<SettingsPage />);
    await screen.findByText(/설정됨/);

    await userEvent.click(screen.getByRole("button", { name: "키 삭제" }));

    expect(await screen.findByText("설정되지 않음")).toBeInTheDocument();
  });
});
