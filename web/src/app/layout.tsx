import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "중계고기파티 재고",
  description: "실물 검수 · 재고관리",
  appleWebApp: {
    capable: true,
    title: "재고",
  },
};

export const viewport: Viewport = {
  themeColor: "#163028",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
