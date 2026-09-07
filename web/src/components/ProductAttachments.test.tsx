import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentResponse } from "@/api/types";
import { ProductAttachments } from "@/components/ProductAttachments";
import { authenticatedRoutes, renderWithQuery, stubRoutes } from "@/testing";

const attachment: AttachmentResponse = {
  id: "image-one",
  kind: "label",
  original_filename: "합성 라벨.png",
  content_type: "image/png",
  byte_size: 69,
  caption: "합성 복구 라벨",
  product_id: "product-one",
  bottle_id: null,
  tasting_session_id: null,
};
afterEach(() => vi.unstubAllGlobals());

async function open() {
  await userEvent.click(screen.getByText("첨부 이미지", { selector: "summary" }));
}

describe("제품 첨부 열람", () => {
  it("펼칠 때만 계정별 목록을 읽고 인증된 원본 주소를 표시한다", async () => {
    const { spy, calls } = stubRoutes([
      ...authenticatedRoutes(),
      { match: "/attachments?", body: [attachment] },
    ]);
    renderWithQuery(<ProductAttachments productId="product-one" offline={false} />);
    expect(calls).toEqual([]);
    await open();
    expect(await screen.findByAltText("합성 복구 라벨")).toHaveAttribute(
      "src",
      "/api/v1/attachments/image-one/content",
    );
    expect(screen.getByRole("link", { name: "원본 열기" })).toHaveAttribute(
      "href",
      "/api/v1/attachments/image-one/content",
    );
    const call = spy.mock.calls.find(([url]) => String(url).includes("/attachments?"));
    expect(call?.[1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("오프라인에서는 캐시된 이미지도 표시하지 않고 요청하지 않는다", async () => {
    const { calls } = stubRoutes([...authenticatedRoutes()]);
    renderWithQuery(<ProductAttachments productId="product-one" offline />);
    await open();
    expect(screen.getByText("첨부 이미지는 온라인에서 열 수 있습니다.")).toBeInTheDocument();
    expect(calls).toEqual([]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("비어 있는 목록과 조회 실패를 구분한다", async () => {
    stubRoutes([...authenticatedRoutes(), { match: "/attachments?", body: [] }]);
    const { unmount } = renderWithQuery(
      <ProductAttachments productId="product-one" offline={false} />,
    );
    await open();
    expect(await screen.findByText("이 제품에 첨부한 이미지가 없습니다.")).toBeInTheDocument();
    unmount();
    stubRoutes([
      ...authenticatedRoutes(),
      { match: "/attachments?", status: 404, body: { detail: "없음" } },
    ]);
    renderWithQuery(<ProductAttachments productId="product-one" offline={false} />);
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent("첨부 목록을 불러오지 못했습니다");
  });

  it("표시하지 못하는 원본에는 안내와 원본 열기를 남긴다", async () => {
    stubRoutes([...authenticatedRoutes(), { match: "/attachments?", body: [attachment] }]);
    renderWithQuery(<ProductAttachments productId="product-one" offline={false} />);
    await open();
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByRole("alert")).toHaveTextContent("이미지를 표시할 수 없습니다");
    expect(screen.getByRole("link", { name: "원본 열기" })).toBeInTheDocument();
  });

  it("caption이 없으면 파일명, 둘 다 없으면 일반 설명을 사용한다", async () => {
    stubRoutes([
      ...authenticatedRoutes(),
      {
        match: "/attachments?",
        body: [
          { ...attachment, caption: null },
          { ...attachment, id: "image-two", caption: null, original_filename: null },
        ],
      },
    ]);
    renderWithQuery(<ProductAttachments productId="product-one" offline={false} />);
    await open();
    expect(await screen.findByAltText("합성 라벨.png")).toBeInTheDocument();
    expect(screen.getByAltText("첨부 이미지")).toBeInTheDocument();
  });

  it("온라인에서 오프라인으로 바뀌면 기존 원본을 내린다", async () => {
    stubRoutes([...authenticatedRoutes(), { match: "/attachments?", body: [attachment] }]);
    const { rerender } = renderWithQuery(
      <ProductAttachments productId="product-one" offline={false} />,
    );
    await open();
    await screen.findByRole("img");
    rerender(<ProductAttachments productId="product-one" offline />);
    await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
  });
});
