import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNativeBarcodeDetectorSupported, startScanning } from "@/barcode/scanner";

function fakeStream(): { stream: MediaStream; track: { stop: ReturnType<typeof vi.fn> } } {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("@zxing/browser");
});

describe("isNativeBarcodeDetectorSupported", () => {
  it("BarcodeDetector 가 없으면 false", () => {
    expect(isNativeBarcodeDetectorSupported()).toBe(false);
  });

  it("BarcodeDetector 가 있으면 true", () => {
    vi.stubGlobal("BarcodeDetector", class {});
    expect(isNativeBarcodeDetectorSupported()).toBe(true);
  });
});

describe("startScanning — 네이티브 BarcodeDetector 경로", () => {
  it("카메라를 붙이고 첫 감지에서 콜백을 부른 뒤, stop 이 트랙을 정지시킨다", async () => {
    const { stream, track } = fakeStream();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(stream);
    const detect = vi.fn().mockResolvedValue([{ rawValue: "8801234567890", format: "ean_13" }]);
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect = detect;
      },
    );

    const video = document.createElement("video");
    const onDetect = vi.fn();

    const controller = await startScanning(video, onDetect);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: "environment" },
    });
    expect(video.srcObject).toBe(stream);
    await vi.waitFor(() => expect(onDetect).toHaveBeenCalledWith("8801234567890"));

    controller.stop();
    expect(track.stop).toHaveBeenCalled();
  });

  it("빈 프레임은 무시하고 다음 프레임에서 다시 시도한다", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(
      fakeStream().stream,
    );
    const detect = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ rawValue: "96385074", format: "ean_8" }]);
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect = detect;
      },
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    const onDetect = vi.fn();
    await startScanning(document.createElement("video"), onDetect);

    await vi.waitFor(() => expect(onDetect).toHaveBeenCalledWith("96385074"));
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("카메라 권한이 거부되면 그대로 실패한다", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Permission denied"),
    );
    vi.stubGlobal("BarcodeDetector", class {});

    await expect(startScanning(document.createElement("video"), vi.fn())).rejects.toThrow(
      "Permission denied",
    );
  });
});

describe("startScanning — ZXing 폴백 경로", () => {
  it("BarcodeDetector 가 없으면 @zxing/browser 로 감지한다", async () => {
    const stop = vi.fn();
    vi.doMock("@zxing/browser", () => ({
      BrowserMultiFormatReader: class {
        async decodeFromVideoDevice(
          _deviceId: string | undefined,
          _video: HTMLVideoElement,
          callback: (
            result: { getText(): string } | undefined,
            error: undefined,
            controls: { stop: () => void },
          ) => void,
        ) {
          callback({ getText: () => "123456789012" }, undefined, { stop });
          return { stop };
        }
      },
    }));

    const onDetect = vi.fn();
    const controller = await startScanning(document.createElement("video"), onDetect);

    expect(onDetect).toHaveBeenCalledWith("123456789012");
    // 감지되면 활성 컨트롤이 즉시 멈춘다.
    expect(stop).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
