/**
 * 자주 쓰지 않는 화면을 따로 불러오는 `React.lazy` 래퍼.
 *
 * 나뉜 파일도 서비스 워커가 앱 셸과 함께 미리 받아 두므로 오프라인에서도 열린다. 다만 서비스
 * 워커가 아직 없는 첫 방문 탭이 배포 뒤 옛 파일 이름을 찾으면 실패한다 — 빈 화면 대신
 * 새로고침을 안내한다.
 */

import { type ComponentType, lazy } from "react";
import { InlineError } from "@/components/StatusViews";

function PageLoadFailed() {
  return (
    <InlineError
      message="화면을 불러오지 못했습니다. 새 버전이 배포되었거나 연결이 끊겼을 수 있습니다."
      onRetry={() => window.location.reload()}
    />
  );
}

export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch {
      return { default: PageLoadFailed as ComponentType<P> };
    }
  });
}
