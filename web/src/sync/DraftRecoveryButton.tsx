import { useEffect, useState } from "react";
import { recoverableDraft, restoreFormDraft } from "@/sync/drafts";
import { markFormDirty } from "@/sync/update";
export function DraftRecoveryButton({ form }: { form: string }) {
  const [source, setSource] = useState(() => recoverableDraft(form));
  useEffect(() => {
    const refresh = () => setSource(recoverableDraft(form));
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [form]);
  if (!source) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        restoreFormDraft(form, source);
        const element = event.currentTarget.closest("form");
        if (element) markFormDirty(element);
        setSource(null);
      }}
    >
      이전 입력 불러오기
    </button>
  );
}
