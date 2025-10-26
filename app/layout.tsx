export const metadata = {
  title: "Card Extractor",
  description: "Detect and crop multiple cards from a scanned image",
};

import "./globals.css";
import React from "react";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
