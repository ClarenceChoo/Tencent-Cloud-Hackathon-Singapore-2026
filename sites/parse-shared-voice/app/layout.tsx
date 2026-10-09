import type { Metadata } from "next";
import "./globals.css";
import "./care/care.css";
import "./care/integrated.css";
import "./care/dashboardNavigation.css";

export const metadata: Metadata = {
  title: "Parse · Care dashboard",
  description: "Your private Parse dashboard, with phone pairing, reviewed voice updates, timeline and care views.",
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
