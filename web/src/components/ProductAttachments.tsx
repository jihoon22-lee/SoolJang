import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { API_PREFIX, authApi, request } from "@/api/client";
import type { AttachmentResponse } from "@/api/types";

export function ProductAttachments({
  productId,
  offline,
}: {
  productId: string;
  offline: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>첨부 이미지</summary>
      {open &&
        (offline ? (
          <p className="notice">첨부 이미지는 온라인에서 열 수 있습니다.</p>
        ) : (
          <AttachmentList key={productId} productId={productId} />
        ))}
    </details>
  );
}

function AttachmentList({ productId }: { productId: string }) {
  const me = useQuery({ queryKey: ["auth", "me"], queryFn: ({ signal }) => authApi.me(signal) });
  const userId = me.data?.id;
  const attachments = useQuery({
    queryKey: ["product-attachments", userId, productId],
    queryFn: ({ signal }) =>
      request<AttachmentResponse[]>("/attachments", {
        params: { product_id: productId },
        cache: "no-store",
        signal,
      }),
    enabled: Boolean(userId),
    gcTime: 0,
  });
  if (me.isError || attachments.isError)
    return (
      <p role="alert" className="alert">
        첨부 목록을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.
      </p>
    );
  if (attachments.isPending) return <output>첨부 이미지를 불러오는 중…</output>;
  if (attachments.data.length === 0)
    return <p className="muted">이 제품에 첨부한 이미지가 없습니다.</p>;
  return (
    <div>
      {attachments.data.map((attachment) => (
        <AttachmentImage key={`${userId}:${attachment.id}`} attachment={attachment} />
      ))}
    </div>
  );
}

function AttachmentImage({ attachment }: { attachment: AttachmentResponse }) {
  const [failed, setFailed] = useState(false);
  const url = `${API_PREFIX}/attachments/${encodeURIComponent(attachment.id)}/content`;
  const description = attachment.caption || attachment.original_filename || "첨부 이미지";
  return (
    <figure className="mt-2" style={{ marginInline: 0 }}>
      {failed ? (
        <p className="notice" role="alert">
          이미지를 표시할 수 없습니다. 원본 열기로 다시 확인하세요.
        </p>
      ) : (
        <img
          src={url}
          alt={description}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          style={{ display: "block", maxWidth: "100%", maxHeight: 320, objectFit: "contain" }}
        />
      )}
      <figcaption className="mt-1" style={{ overflowWrap: "anywhere" }}>
        {description}{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
          원본 열기
        </a>
      </figcaption>
    </figure>
  );
}
