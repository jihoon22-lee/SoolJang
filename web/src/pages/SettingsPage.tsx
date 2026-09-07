import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, authApi } from "@/api/client";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";

/** 프로필·비밀번호와 API·외부 연결의 단일 설정 진입점. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  // 헤더의 계정 표시 이름과 같은 캐시 키를 써서, 여기서 바꾸면 재조회 없이 헤더도 즉시
  // 갱신된다(`App.tsx` 가 이미 로그인 단계에서 채워 둔 캐시를 그대로 재사용).
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => authApi.me(signal),
  });
  const [displayName, setDisplayName] = useState(() => me.data?.display_name ?? "");
  const [profileSaved, setProfileSaved] = useState(false);

  // 마운트 시점엔 아직 캐시가 없을 수 있다(예: 이 페이지를 단독으로 렌더하는 테스트).
  // 실제 화면에서는 `App` 이 로그인 단계에서 이미 캐시를 채워 둬 즉시 반영된다.
  useEffect(() => {
    if (me.data) setDisplayName(me.data.display_name);
  }, [me.data]);

  const updateProfile = useMutation({
    mutationFn: () => authApi.updateProfile({ display_name: displayName }),
    onSuccess: (user) => {
      queryClient.setQueryData(["auth", "me"], user);
      setDisplayName(user.display_name);
      setProfileSaved(true);
    },
  });

  function handleProfileSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setProfileSaved(false);
    updateProfile.mutate();
  }

  const profileError = updateProfile.error instanceof ApiError ? updateProfile.error : null;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [passwordLocalError, setPasswordLocalError] = useState<string | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);

  const changePassword = useMutation({
    mutationFn: () =>
      authApi.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setPasswordChanged(true);
    },
  });

  function handlePasswordSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPasswordLocalError(null);
    setPasswordChanged(false);

    if (newPassword !== newPasswordConfirm) {
      setPasswordLocalError("새 비밀번호가 서로 다릅니다");
      return;
    }
    changePassword.mutate();
  }

  const passwordApiError = changePassword.error instanceof ApiError ? changePassword.error : null;
  const passwordErrorMessage = passwordLocalError ?? passwordApiError?.message ?? null;

  return (
    <section aria-labelledby="settings-heading" className="panel">
      <h2 id="settings-heading">설정</h2>

      <div className="field">
        <h3>프로필</h3>
        <p className="muted">화면 상단에 표시되는 이름입니다.</p>

        {profileSaved && <output>이름을 바꿨습니다.</output>}

        {profileError && (
          <p className="alert" role="alert">
            {profileError.message}
          </p>
        )}

        <form onSubmit={handleProfileSubmit}>
          <div className="field">
            <label htmlFor="settings-display-name">표시 이름</label>
            <input
              id="settings-display-name"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setProfileSaved(false);
              }}
              required
            />
          </div>
          <div className="button-row">
            <button
              type="submit"
              className="primary"
              disabled={updateProfile.isPending || !displayName.trim()}
            >
              {updateProfile.isPending ? "저장 중…" : "이름 저장"}
            </button>
          </div>
        </form>
      </div>

      <div className="field">
        <h3>비밀번호 변경</h3>
        <p className="muted">
          비밀번호를 바꾸면 이 기기를 제외한 다른 모든 기기의 로그인이 풀립니다.
        </p>

        {passwordChanged && <output>비밀번호를 바꿨습니다.</output>}

        {passwordErrorMessage && (
          <p className="alert" role="alert">
            {passwordErrorMessage}
          </p>
        )}

        <form onSubmit={handlePasswordSubmit}>
          <div className="field">
            <label htmlFor="settings-current-password">현재 비밀번호</label>
            <input
              id="settings-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="settings-new-password">새 비밀번호</label>
            <input
              id="settings-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="settings-new-password-confirm">새 비밀번호 확인</label>
            <input
              id="settings-new-password-confirm"
              type="password"
              autoComplete="new-password"
              value={newPasswordConfirm}
              onChange={(event) => setNewPasswordConfirm(event.target.value)}
              required
            />
          </div>
          <p className="muted">비밀번호는 10자 이상이어야 합니다.</p>
          <div className="button-row">
            <button type="submit" className="primary" disabled={changePassword.isPending}>
              {changePassword.isPending ? "변경 중…" : "비밀번호 변경"}
            </button>
          </div>
        </form>
      </div>

      <ConnectionsPanel />
    </section>
  );
}
