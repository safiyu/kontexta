import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Manrope, Saira } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/theme-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});
const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-title",
  display: "swap",
});
// Title face for the Blueprint theme (.blueprint overrides --font-title in globals.css).
const saira = Saira({
  subsets: ["latin"],
  variable: "--font-saira",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kontexta",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} ${manrope.variable} ${saira.variable} font-sans antialiased`}
      >
        <ThemeProvider>
          {children}
          <Toaster
            position="bottom-right"
            gap={8}
            offset={24}
            toastOptions={{
              style: {
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
              },
              className: "text-sm",
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
