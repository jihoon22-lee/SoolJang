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

  describe("비밀번호 변경", () => {
    function stubLlmSettings() {
      return {
        match: "/llm-settings",
        method: "GET",
        body: {
          configured: false,
          provider: null,
          model: null,
          api_key_masked: null,
          updated_at: null,
        },
      };
    }

    it("성공하면 안내를 보여주고 입력을 비운다", async () => {
      const { calls } = stubRoutes([
        ...authenticatedRoutes(),
        stubLlmSettings(),
        { match: "/auth/password", method: "POST", status: 204, body: null },
      ]);

      renderWithQuery(<SettingsPage />);
      await userEvent.type(screen.getByLabelText("현재 비밀번호"), "old-password-123");
      await userEvent.type(screen.getByLabelText("새 비밀번호"), "new-password-456");
      await userEvent.type(screen.getByLabelText("새 비밀번호 확인"), "new-password-456");
      await userEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

      expect(await screen.findByText("비밀번호를 바꿨습니다.")).toBeInTheDocument();
      expect(screen.getByLabelText("현재 비밀번호")).toHaveValue("");
      expect(screen.getByLabelText("새 비밀번호")).toHaveValue("");

      const post = calls.find(
        (call) => call.method === "POST" && call.url.includes("/auth/password"),
      );
      expect(post?.body).toMatchObject({
        current_password: "old-password-123", // scan-secrets-allow
        new_password: "new-password-456", // scan-secrets-allow
      });
    });

    it("새 비밀번호와 확인이 다르면 요청을 보내지 않는다", async () => {
      const { calls } = stubRoutes([...authenticatedRoutes(), stubLlmSettings()]);

      renderWithQuery(<SettingsPage />);
      await userEvent.type(screen.getByLabelText("현재 비밀번호"), "old-password-123");
      await userEvent.type(screen.getByLabelText("새 비밀번호"), "new-password-456");
      await userEvent.type(screen.getByLabelText("새 비밀번호 확인"), "다른값");
      await userEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("서로 다릅니다");
      expect(calls.some((call) => call.url.includes("/auth/password"))).toBe(false);
    });

    it("현재 비밀번호가 틀리면 서버 오류를 보여준다", async () => {
      stubRoutes([
        ...authenticatedRoutes(),
        stubLlmSettings(),
        {
          match: "/auth/password",
          method: "POST",
          status: 401,
          body: {
            type: "https://sooljang.local/errors/unauthorized",
            title: "인증되지 않았습니다",
            status: 401,
            detail: "현재 비밀번호가 올바르지 않습니다",
            errors: [],
          },
        },
      ]);

      renderWithQuery(<SettingsPage />);
      await userEvent.type(screen.getByLabelText("현재 비밀번호"), "wrong-password");
      await userEvent.type(screen.getByLabelText("새 비밀번호"), "new-password-456");
      await userEvent.type(screen.getByLabelText("새 비밀번호 확인"), "new-password-456");
      await userEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "현재 비밀번호가 올바르지 않습니다",
      );
    });
  });
});
