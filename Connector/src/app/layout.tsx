import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeplAI",
  description: "From repository to reliable deployment with AI-assisted security, infrastructure, and runtime workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
