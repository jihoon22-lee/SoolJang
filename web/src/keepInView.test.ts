import { afterEach, describe, expect, it, vi } from "vitest";
import { keepInView } from "@/keepInView";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** 위쪽 목록이 자라 페이지 크기가 바뀐 상황. 끊긴 관찰자는 실제처럼 알리지 않는다. */
  resize() {
    if (!this.disconnected) this.callback([], this as unknown as ResizeObserver);
  }
}

/** 목적지가 화면 위에서 `top.value` 만큼 떨어져 있고, 옮기면 0으로 돌아온다. */
function setup() {
  const top = { value: 0 };
  const main = document.createElement("main");
  const target = document.createElement("section");
  main.append(target);
  document.body.append(main);
  const scroll = vi.fn(() => {
    top.value = 0;
  });
  target.scrollIntoView = scroll;
  target.getBoundingClientRect = () => ({ top: top.value }) as DOMRect;
  return { top, main, target, scroll };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeResizeObserver.instances = [];
  document.body.replaceChildren();
});

describe("keepInView", () => {
  it("위쪽 목록이 늦게 자라 목적지가 밀리면 다시 화면 위로 옮긴다", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { top, main, target, scroll } = setup();

    keepInView(target);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    const [observer] = FakeResizeObserver.instances;
    expect(observer?.observed).toEqual([main]);

    observer?.resize();
    expect(scroll).toHaveBeenCalledOnce();

    top.value = 424;
    observer?.resize();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(top.value).toBe(0);
  });

  it.each([
    "pointerdown",
    "touchstart",
    "wheel",
    "keydown",
  ])("사용자가 %s 하면 더는 옮기지 않는다", (type) => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { top, target, scroll } = setup();
    keepInView(target);

    window.dispatchEvent(new Event(type));
    top.value = 300;
    FakeResizeObserver.instances[0]?.resize();

    expect(scroll).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
  });

  it("정해진 시간이 지나면 지켜보기를 멈춘다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { target } = setup();
    keepInView(target, 3_000);

    vi.advanceTimersByTime(2_900);
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(false);
    vi.advanceTimersByTime(100);
    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("돌려받은 함수로 바로 멈춘다", () => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { target } = setup();
    const release = keepInView(target);

    release();

    expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ResizeObserver 가 없으면 한 번만 옮긴다", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { target, scroll } = setup();

    const release = keepInView(target);
    release();

    expect(scroll).toHaveBeenCalledOnce();
  });
});
