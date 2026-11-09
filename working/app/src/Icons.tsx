import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "feed"
  | "sites"
  | "plus"
  | "refresh"
  | "external"
  | "trash"
  | "alert"
  | "close"
  | "check"
  | "clock"
  | "arrow";
type Props = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  size?: number;
};

/** Original decorative line icons. Give the containing control an accessible name. */
export function Icon({ name, size = 20, ...props }: Props) {
  const paths: Record<IconName, ReactNode> = {
    feed: (
      <>
        <rect x="4" y="3.5" width="16" height="17" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    sites: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 10a8 8 0 0 0-13.7-4L3.5 9M3.5 4v5h5M4 14a8 8 0 0 0 13.7 4l2.8-3M20.5 20v-5h-5" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6M20 4l-9 9M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
      </>
    ),
    trash: (
      <>
        <path d="M4 6h16M9 6V3.5h6V6M6 6l1 14h10l1-14M10 10v6M14 10v6" />
      </>
    ),
    alert: (
      <>
        <path d="m10.3 4-8 14A1.4 1.4 0 0 0 3.5 20h17a1.4 1.4 0 0 0 1.2-2l-8-14a2 2 0 0 0-3.4 0Z" />
        <path d="M12 8v5M12 16.5h.01" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
