import { useEffect, useState } from "react";
import { draftEvents } from "@/sync/drafts";
import { applyWaitingUpdate, hasDirtyForms, isUpdateReady, updateEvents } from "@/sync/update";
export function UpdateNotice() {
  const [ready, setReady] = useState(isUpdateReady);
  const [dirty, setDirty] = useState(hasDirtyForms);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    const refresh = () => {
      setReady(isUpdateReady());
      setDirty(hasDirtyForms());
    };
    const error = () => setStorageError(true);
    updateEvents.addEventListener("change", refresh);
    draftEvents.addEventListener("storage-error", error);
    const interval = setInterval(refresh, 1000);
    return () => {
      updateEvents.removeEventListener("change", refresh);
      draftEvents.removeEventListener("storage-error", error);
      clearInterval(interval);
    };
  }, []);
  return (
    <>
      {storageError && (
        <p role="alert">
          임시 입력을 기기에 보관하지 못했습니다. 저장하기 전까지 화면을 닫지 마세요.
        </p>
      )}
      {ready && (
        <output className="panel">
          <p>
            {dirty
              ? "새 버전이 준비됐습니다. 작성 중인 입력을 저장하거나 폼을 닫으면 업데이트할 수 있습니다."
              : "새 버전이 준비됐습니다. 대기 중인 기록은 보존됩니다."}
          </p>
          <button type="button" disabled={dirty} onClick={() => void applyWaitingUpdate()}>
            새 버전 적용
          </button>
        </output>
      )}
    </>
  );
}
