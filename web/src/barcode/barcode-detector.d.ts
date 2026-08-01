/**
 * `BarcodeDetector` 는 실험적 웹 API 라 TypeScript DOM lib 에 타입이 없다. 이 저장소가
 * 필요한 최소한만 선언한다.
 */

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
