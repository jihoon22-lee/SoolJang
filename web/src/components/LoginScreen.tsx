/**
 * 로그인 화면.
 *
 * 사용자가 없으면 최초 계정 생성 폼을, 있으면 로그인 폼을 보여준다. 두 화면을 따로 두면
 * "처음 켰을 때 무엇을 해야 하는지" 를 사용자가 스스로 알아내야 한다.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { ApiError, authApi } from "@/api/client";
import type { LoginResponse } from "@/api/types";

interface LoginScreenProps {
  onAuthenticated: (result: LoginResponse) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps): React.JSX.Element {
  const setupStatus = useQuery({
    queryKey: ["auth", "setup-status"],
    queryFn: ({ signal }) => authApi.setupStatus(signal),
    retry: false,
  });

  const needsSetup = setupStatus.data?.needs_setup ?? false;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (): Promise<LoginResponse> =>
      needsSetup
        ? authApi.setup({ email, password, display_name: displayName })
        : authApi.login({ email, password }),
    onSuccess: onAuthenticated,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setLocalError(null);

    if (needsSetup && password !== passwordConfirm) {
      setLocalError("비밀번호가 서로 다릅니다");
      return;
    }
    mutation.mutate();
  }

  const apiError = mutation.error instanceof ApiError ? mutation.error : null;
  const errorMessage = localError ?? apiError?.message ?? null;

  if (setupStatus.isPending) {
    return (
      <main className="auth-screen">
        <output className="auth-card">확인 중…</output>
      </main>
    );
  }

  if (setupStatus.isError) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <h1>서버에 연결할 수 없습니다</h1>
          <p className="auth-hint">
            API 서버가 실행 중인지 확인하세요. 잠시 후 다시 시도해 주세요.
          </p>
          <button type="button" onClick={() => void setupStatus.refetch()}>
            다시 시도
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={handleSubmit} noValidate>
        <h1>{needsSetup ? "술장 시작하기" : "술장 로그인"}</h1>
        <p className="auth-hint">
          {needsSetup
            ? "처음 실행입니다. 사용할 계정을 만드세요."
            : "기록한 술을 보려면 로그인하세요."}
        </p>

        {needsSetup ? (
          <label htmlFor="auth-display-name">
            표시 이름
            <input
              id="auth-display-name"
              name="display_name"
              autoComplete="name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        ) : null}

        <label htmlFor="auth-email">
          이메일
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label htmlFor="auth-password">
          비밀번호
          <input
            id="auth-password"
            name="password"
            type="password"
            autoComplete={needsSetup ? "new-password" : "current-password"}
            required
            minLength={needsSetup ? 10 : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {needsSetup ? (
          <label htmlFor="auth-password-confirm">
            비밀번호 확인
            <input
              id="auth-password-confirm"
              name="password_confirm"
              type="password"
              autoComplete="new-password"
              required
              value={passwordConfirm}
              onChange={(event) => setPasswordConfirm(event.target.value)}
            />
          </label>
        ) : null}

        {needsSetup ? <p className="auth-hint">비밀번호는 10자 이상이어야 합니다.</p> : null}

        {errorMessage ? (
          <p className="auth-error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "확인 중…" : needsSetup ? "계정 만들고 시작" : "로그인"}
        </button>
      </form>
    </main>
  );
}
