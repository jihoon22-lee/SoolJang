import { useEffect, useRef, useState } from "react";

export function BottleQr({ code }: { code: string }) {
  const [path, setPath] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("@zxing/library")
      .then(({ BarcodeFormat, QRCodeWriter }) => {
        const bits = new QRCodeWriter().encode(code, BarcodeFormat.QR_CODE, 180, 180, new Map());
        const cells: string[] = [];
        for (let y = 0; y < bits.getHeight(); y++)
          for (let x = 0; x < bits.getWidth(); x++)
            if (bits.get(x, y)) cells.push(`M${x},${y}h1v1h-1z`);
        if (active) setPath(cells.join(""));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [code]);
  return (
    <figure>
      <svg role="img" aria-label="술장 내부 병 QR" viewBox="0 0 180 180" width="180" height="180">
        <rect width="180" height="180" fill="white" />
        <path d={path} fill="black" />
      </svg>
      <figcaption>
        <code>{code}</code>
        {failed && <p role="alert">QR을 만들지 못했습니다. 내부 병 문자열을 사용하세요.</p>}
        <p>로그인이 필요한 내부 병 식별자입니다. 제품 바코드와 다릅니다.</p>
      </figcaption>
    </figure>
  );
}

export function BottleQrCamera({ onScan }: { onScan: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const callback = useRef(onScan);
  callback.current = onScan;
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@zxing/browser")
      .then(async ({ BrowserQRCodeReader }) => {
        if (!video.current || cancelled) return;
        const reader = new BrowserQRCodeReader();
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          video.current,
          (result, _error, active) => {
            if (result && !cancelled) {
              active.stop();
              callback.current(result.getText());
            }
          },
        );
        stop = () => controls.stop();
        if (cancelled) stop();
      })
      .catch(() => {
        if (!cancelled) setError("카메라를 열지 못했습니다. 병 QR 문자열을 직접 입력하세요.");
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return (
    <div>
      <video ref={video} muted playsInline aria-label="병 QR 카메라" style={{ maxWidth: "100%" }} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
