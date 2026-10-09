import { databaseIdentity, db } from "@/sync/db";

/** 클릭한 계정과 저장소를 고정한다. 재접속 시점의 계정으로 다시 해석하지 않는다. */
export function captureWriteSession() {
  const identity = databaseIdentity();
  const store = db;
  const isCurrent = () =>
    Boolean(identity.userId) &&
    identity.userId === databaseIdentity().userId &&
    identity.generation === databaseIdentity().generation &&
    store === db;
  return {
    userId: identity.userId ?? "",
    store,
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) throw new Error("계정이 변경되어 저장을 중단했습니다. 다시 확인하세요");
    },
  };
}

export type WriteSession = ReturnType<typeof captureWriteSession>;
