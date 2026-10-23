/** 인증 전환 식별자. 토큰이나 사용자 정보를 저장하지 않는다. */
export const AUTH_SESSION_KEY = "sooljang-auth-generation-v1";
let generation = 0;

function sharedGeneration(): string | null {
  try {
    return localStorage.getItem(AUTH_SESSION_KEY);
  } catch {
    return null;
  }
}

// 새 요청마다 공유 값을 그대로 받아들이면 storage 이벤트가 처리되기 전에 이전 계정
// 화면의 쓰기가 새 쿠키로 전송될 수 있다. 화면을 잠근 뒤에만 새 세대를 인정한다.
let acknowledgedShared = sharedGeneration();

export function captureAuthSession() {
  return { generation, shared: acknowledgedShared };
}

export function isCurrentAuthSession(captured: ReturnType<typeof captureAuthSession>): boolean {
  return (
    captured.generation === generation &&
    captured.shared === acknowledgedShared &&
    captured.shared === sharedGeneration()
  );
}

export function advanceAuthSession(broadcast = true): void {
  generation += 1;
  if (broadcast) {
    try {
      const next = crypto.randomUUID();
      localStorage.setItem(AUTH_SESSION_KEY, next);
      acknowledgedShared = next;
    } catch {
      // 저장소가 제한돼도 현재 탭의 인증 전환은 구분한다.
      acknowledgedShared = sharedGeneration();
    }
  } else {
    acknowledgedShared = sharedGeneration();
  }
}

export class StaleAuthResponseError extends Error {
  constructor() {
    super("이전 로그인에서 시작한 요청입니다. 현재 계정에서 다시 확인하세요");
    this.name = "StaleAuthResponseError";
  }
}

export function assertCurrentAuthSession(captured: ReturnType<typeof captureAuthSession>): void {
  if (!isCurrentAuthSession(captured)) throw new StaleAuthResponseError();
}

let cookieQueue: Promise<unknown> = Promise.resolve();

/** 인증 쿠키를 바꾸는 응답과 계정 조회를 탭 사이에서도 순서대로 처리한다. */
export function withAuthCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  const captured = captureAuthSession();
  const run = async () => {
    assertCurrentAuthSession(captured);
    return operation();
  };
  const next = async (): Promise<T> =>
    navigator.locks ? navigator.locks.request("sooljang-auth-cookie", run) : run();
  const result = cookieQueue.then(next, next);
  cookieQueue = result.catch(() => undefined);
  return result;
}
