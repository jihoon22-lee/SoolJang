/**
 * 바코드 스캐너 추상화.
 *
 * 네이티브 `BarcodeDetector` 를 우선 쓰고, 지원하지 않는 브라우저(Firefox·데스크톱
 * Safari 등)는 `@zxing/browser` 로 폴백한다(`docs/plan.md` Task 16 산출물).
 *
 * 카메라·`BarcodeDetector` 는 실제 하드웨어가 있어야 동작해 이 저장소의 자동화 테스트
 * 환경(jsdom)에서는 검증할 수 없다 — 그래서 이 파일은 최대한 얇게 유지하고, UI 쪽은
 * `startScanning` 을 주입받는 구조로 만들어 감지 **이후** 로직(조회·저장)만 자동
 * 테스트로 검증한다.
 */

export interface ScannerController {
  stop(): void;
}

export type BarcodeDetectedHandler = (rawValue: string) => void;

//: EAN-13·EAN-8·UPC-A·UPC-E — `application/barcodes.py` 가 다루는 형식과 맞춘다.
const SUPPORTED_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

export function isNativeBarcodeDetectorSupported(): boolean {
  return typeof window !== "undefined" && typeof window.BarcodeDetector !== "undefined";
}

/** 비디오 엘리먼트에 후면 카메라를 붙이고 지속적으로 바코드를 감지한다. */
export async function startScanning(
  video: HTMLVideoElement,
  onDetect: BarcodeDetectedHandler,
): Promise<ScannerController> {
  if (isNativeBarcodeDetectorSupported()) {
    return startNativeScanning(video, onDetect);
  }
  return startZXingScanning(video, onDetect);
}

async function startNativeScanning(
  video: HTMLVideoElement,
  onDetect: BarcodeDetectedHandler,
): Promise<ScannerController> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
  });
  video.srcObject = stream;
  await video.play();

  const BarcodeDetectorCtor = window.BarcodeDetector;
  if (!BarcodeDetectorCtor) {
    throw new Error("이 브라우저는 BarcodeDetector 를 지원하지 않습니다");
  }
  const detector = new BarcodeDetectorCtor({ formats: SUPPORTED_FORMATS });
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      const first = codes[0];
      if (first?.rawValue) {
        onDetect(first.rawValue);
        return; // 한 번 감지하면 멈춘다 — 다시 스캔하려면 호출부가 재시작한다.
      }
    } catch {
      // 프레임 하나를 못 읽은 것은 무시하고 다음 프레임을 시도한다.
    }
    requestAnimationFrame(() => void tick());
  };
  void tick();

  return {
    stop: () => {
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

async function startZXingScanning(
  video: HTMLVideoElement,
  onDetect: BarcodeDetectedHandler,
): Promise<ScannerController> {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader();
  const controls = await reader.decodeFromVideoDevice(
    undefined,
    video,
    (result, _error, activeControls) => {
      if (result) {
        onDetect(result.getText());
        activeControls.stop();
      }
    },
  );
  return { stop: () => controls.stop() };
}
