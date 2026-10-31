import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "중계고기파티 재고",
  description: "실시간 재고와 입고 검수",
  appleWebApp: {
    capable: true,
    title: "재고",
  },
};

export const viewport: Viewport = {
  themeColor: "#1e3329",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
