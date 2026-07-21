import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Manrope, Saira } from "next/font/google";
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
// Title face for the opt-in Blueprint theme only (.blueprint overrides
// --font-title to this variable in globals.css).
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
