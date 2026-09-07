import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/SettingsPage";
import { authenticatedRoutes, renderWithQuery, stubRoutes, TEST_USER } from "@/testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  describe("프로필", () => {
    function stubLlmSettings() {
      return {
        match: "/connections",
        method: "GET",
        body: [],
      };
    }

    /** 표시 이름은 `/auth/me` 조회가 끝난 뒤 별도 effect 로 채워진다 — 필드가 나타난
     * 직후가 아니라, 실제로 채워진 뒤에 상호작용해야 레이스가 안 생긴다. */
    async function findPrefilledInput() {
      const input = await screen.findByLabelText("표시 이름");
      await waitFor(() => expect(input).toHaveValue(TEST_USER.display_name));
      return input;
    }

    it("현재 표시 이름을 미리 채워 보여준다", async () => {
      stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
        stubLlmSettings(),
      ]);

      renderWithQuery(<SettingsPage />);

      await findPrefilledInput();
    });

    it("저장하면 안내를 보여준다", async () => {
      const { calls } = stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
        stubLlmSettings(),
        { match: "/auth/me", method: "PATCH", body: { ...TEST_USER, display_name: "새 이름" } },
      ]);

      renderWithQuery(<SettingsPage />);
      const input = await findPrefilledInput();
      await userEvent.clear(input);
      await userEvent.type(input, "새 이름");
      await userEvent.click(screen.getByRole("button", { name: "이름 저장" }));

      expect(await screen.findByText("이름을 바꿨습니다.")).toBeInTheDocument();

      const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("/auth/me"));
      expect(patch?.body).toMatchObject({ display_name: "새 이름" });
    });

    it("저장 실패는 오류 메시지를 보여준다", async () => {
      stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
        stubLlmSettings(),
        {
          match: "/auth/me",
          method: "PATCH",
          status: 422,
          body: {
            type: "https://sooljang.local/errors/validation",
            title: "요청 값이 올바르지 않습니다",
            status: 422,
            detail: "표시 이름을 입력하세요",
            errors: [],
          },
        },
      ]);

      renderWithQuery(<SettingsPage />);
      const input = await findPrefilledInput();
      await userEvent.clear(input);
      await userEvent.type(input, "x");
      await userEvent.click(screen.getByRole("button", { name: "이름 저장" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("표시 이름을 입력하세요");
    });

    it("빈 값이면 저장 버튼이 비활성화된다", async () => {
      stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
        stubLlmSettings(),
      ]);

      renderWithQuery(<SettingsPage />);
      const input = await findPrefilledInput();
      await userEvent.clear(input);

      expect(screen.getByRole("button", { name: "이름 저장" })).toBeDisabled();
    });
  });

  describe("비밀번호 변경", () => {
    function stubLlmSettings() {
      return {
        match: "/connections",
        method: "GET",
        body: [],
      };
    }

    it("성공하면 안내를 보여주고 입력을 비운다", async () => {
      const { calls } = stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
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
      const { calls } = stubRoutes([
        ...authenticatedRoutes(),
        { match: "/connections/providers", body: [] },
        stubLlmSettings(),
      ]);

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
        { match: "/connections/providers", body: [] },
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
