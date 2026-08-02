import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, llmSettingsApi } from "@/api/client";

//: 백엔드 기본값(`models/llm.py::DEFAULT_OPENAI_MODEL`)과 맞춘다. Vision 입력을 지원하는
//: 합리적인 기본값 — 사용자가 바꿀 수 있다.
const DEFAULT_MODEL = "gpt-4o-mini";

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

  const setting = useQuery({
    queryKey: ["llm-settings"],
    queryFn: ({ signal }) => llmSettingsApi.get(signal),
  });

  const save = useMutation({
    mutationFn: () => llmSettingsApi.save({ provider: "openai", api_key: apiKey, model }),
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
      });
    },
  });

  const saveError = save.error instanceof ApiError ? save.error : null;

  return (
    <section aria-labelledby="settings-heading" className="panel">
      <h2 id="settings-heading">설정</h2>

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
