import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShareSafe — Clean screenshots before you share",
  description:
    "Review and redact sensitive details from screenshots locally in your browser. No accounts, no image uploads.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
