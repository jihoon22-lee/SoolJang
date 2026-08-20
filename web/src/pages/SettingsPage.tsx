import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, authApi, llmSettingsApi } from "@/api/client";

//: 백엔드 기본값(`models/llm.py::DEFAULT_OPENAI_MODEL`)과 맞춘다. Vision 입력을 지원하는
//: 합리적인 기본값 — 사용자가 바꿀 수 있다.
const DEFAULT_MODEL = "gpt-4o-mini";
//: 백엔드 기본값(`models/llm.py::DEFAULT_REMATCH_MONTHLY_CAP`)과 맞춘다(Task 34 PR6).
const DEFAULT_REMATCH_MONTHLY_CAP = 200;

/**
 * 설정 화면. LLM(라벨 OCR, Task 17) API 키를 여기서 관리한다.
 *
 * `.env` 를 직접 고치지 않고 로그인한 뒤 이 화면에서 등록할 수 있어야 한다는 요구에 따른
 * 화면이다. API 키는 저장 직후 응답에만 마스킹된 값이 실리고, 이후 조회에서는 서버가 다시
 * 계산해 준 마스킹 값만 보여준다 — 원문은 화면에 절대 나타나지 않는다.
 */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [rematchEnabled, setRematchEnabled] = useState(false);
  const [rematchMonthlyCap, setRematchMonthlyCap] = useState(DEFAULT_REMATCH_MONTHLY_CAP);

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

  const setting = useQuery({
    queryKey: ["llm-settings"],
    queryFn: ({ signal }) => llmSettingsApi.get(signal),
  });

  // 저장된 "LLM 매칭 보조" 설정을 폼에 반영한다(Task 34 PR6) — 체크박스가 매번 꺼진
  // 상태로 보이면 이미 켜 뒀는지 사용자가 헷갈린다.
  useEffect(() => {
    if (!setting.data) return;
    setRematchEnabled(setting.data.rematch_enabled);
    setRematchMonthlyCap(setting.data.rematch_monthly_cap);
  }, [setting.data]);

  const save = useMutation({
    mutationFn: () =>
      llmSettingsApi.save({
        provider: "openai",
        api_key: apiKey,
        model,
        rematch_enabled: rematchEnabled,
        rematch_monthly_cap: rematchMonthlyCap,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["llm-settings"], result);
      setApiKey("");
    },
  });

  const remove = useMutation({
    mutationFn: () => llmSettingsApi.remove(),
    onSuccess: () => {
      queryClient.setQueryData(["llm-settings"], {
        configured: false,
        provider: null,
        model: null,
        api_key_masked: null,
        updated_at: null,
        rematch_enabled: false,
        rematch_monthly_cap: DEFAULT_REMATCH_MONTHLY_CAP,
      });
      setRematchEnabled(false);
      setRematchMonthlyCap(DEFAULT_REMATCH_MONTHLY_CAP);
    },
  });

  const saveError = save.error instanceof ApiError ? save.error : null;

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

      <div className="field">
        <h3>LLM API 키 (라벨 OCR)</h3>
        <p className="muted">
          라벨 사진으로 술 정보를 자동으로 채우려면 OpenAI API 키가 필요합니다. 키는 서버에
          암호화되어 저장되며, 화면에는 다시 보여주지 않습니다.
        </p>

        {setting.isPending && <output aria-live="polite">불러오는 중…</output>}

        {setting.data && (
          <p>
            현재 상태:{" "}
            {setting.data.configured ? (
              <strong>
                설정됨 (키 {setting.data.api_key_masked}, 모델 {setting.data.model})
              </strong>
            ) : (
              <strong>설정되지 않음</strong>
            )}
            {setting.data.rematch_enabled && (
              <span className="muted text-sm">
                {" "}
                · LLM 매칭 보조 켜짐 (월 상한 {setting.data.rematch_monthly_cap}회)
              </span>
            )}
          </p>
        )}

        {saveError && (
          <p className="alert" role="alert">
            {saveError.message}
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="settings-api-key">OpenAI API 키</label>
            <input
              id="settings-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              required
            />
          </div>
          <div className="field">
            <label htmlFor="settings-model">모델</label>
            <input
              id="settings-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="settings-rematch-enabled">
              <input
                id="settings-rematch-enabled"
                type="checkbox"
                checked={rematchEnabled}
                onChange={(event) => setRematchEnabled(event.target.checked)}
              />
              LLM 매칭 보조 사용
            </label>
            <p className="muted text-sm">
              외부 소스 조회에서 확신이 낮은 후보(50~85%)가 나오면 LLM 에게 한 번 더 물어 "LLM 추천"
              배지를 붙입니다. 기본은 꺼짐이며, 켜도 자동으로 고정하지 않고 추천만 합니다 — 고정은
              항상 직접 눌러야 합니다.
            </p>
          </div>
          {rematchEnabled && (
            <div className="field">
              <label htmlFor="settings-rematch-cap">월 호출 상한</label>
              <input
                id="settings-rematch-cap"
                type="number"
                min={1}
                step={1}
                value={rematchMonthlyCap}
                onChange={(event) => setRematchMonthlyCap(Number(event.target.value))}
              />
              <p className="muted text-sm">
                이번 달 호출이 이 수를 넘으면 예외 없이 기존 점수 결과로 조용히 넘어갑니다.
              </p>
            </div>
          )}
          <div className="button-row">
            <button type="submit" className="primary" disabled={save.isPending || !apiKey.trim()}>
              {save.isPending ? "저장 중…" : "저장"}
            </button>
            {setting.data?.configured && (
              <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
                {remove.isPending ? "삭제 중…" : "키 삭제"}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
