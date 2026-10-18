import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { expect, it } from "vitest";
import { lazyPage } from "@/lazyPage";

it("나눈 화면을 불러오면 그 화면을 그린다", async () => {
  const Page = lazyPage(async () => () => <p>통계 화면</p>);
  render(
    <Suspense fallback={<p>불러오는 중</p>}>
      <Page />
    </Suspense>,
  );

  expect(await screen.findByText("통계 화면")).toBeInTheDocument();
});

it("배포 뒤 옛 파일을 찾지 못하면 빈 화면 대신 새로고침을 안내한다", async () => {
  const Page = lazyPage<object>(() => Promise.reject(new TypeError("Failed to fetch module")));
  render(
    <Suspense fallback={<p>불러오는 중</p>}>
      <Page />
    </Suspense>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("화면을 불러오지 못했습니다");
  expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
});
