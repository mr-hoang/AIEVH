import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./globals.css";
import { FAVICON } from "@/lib/brand";
import { Shell } from "@/components/Shell";
import { StaleChunkGuard } from "@/components/StaleChunkGuard";
import { LanguageProvider } from "@/lib/i18n";
import { EventsProvider } from "@/lib/useEvents";

export const metadata: Metadata = {
  title: "AIEV - Mr Hoàng",
  description: "Edit video tự động bằng AI",
  // Data URI biên dịch vào bundle chứ không trỏ tới /brand/favicon.png: chép đè
  // file trong public/ không đổi được favicon của ứng dụng nữa. Xem
  // scripts/build-brand.mjs.
  icons: { icon: FAVICON },
};

/** Chống FOUC: áp data-theme trước khi paint. Mặc định light. */
const THEME_SCRIPT = `try{if(localStorage.getItem("theme")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <StaleChunkGuard />
        <LanguageProvider>
          <EventsProvider>
            <Shell>{children}</Shell>
          </EventsProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
