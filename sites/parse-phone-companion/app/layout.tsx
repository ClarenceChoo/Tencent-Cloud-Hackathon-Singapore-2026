import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parse · Phone companion",
  description: "Scan a team dashboard QR and send live audio from your phone. No ChatGPT sign-in is needed on the phone.",
  icons: {
    icon: "/brand/parse-aurora-mark.png",
    shortcut: "/brand/parse-aurora-mark.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
