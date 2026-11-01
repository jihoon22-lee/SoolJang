import type { View } from "@/router";

/** 주 탭 아이콘. 글자 라벨을 대신하지 않고 곁들이므로 보조 기술에는 숨긴다. */
const PATHS: Partial<Record<View, string>> = {
  home: "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z",
  products:
    "M10 3h4v3.2c0 .5.2 1 .6 1.4l.8.8c.4.4.6.9.6 1.4V19a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9.8c0-.5.2-1 .6-1.4l.8-.8c.4-.4.6-.9.6-1.4zM8 13h8",
  stats: "M5 20v-8M12 20V5M19 20v-5M3.5 20h17",
  interests: "M7 4h10a1 1 0 0 1 1 1v15l-6-3.8L6 20V5a1 1 0 0 1 1-1z",
  discover: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.2 15.2 20 20",
};

export function NavIcon({ view }: { view: View }) {
  const path = PATHS[view];
  if (!path) return null;
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
