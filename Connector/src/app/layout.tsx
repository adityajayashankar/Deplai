import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: "DeplAI",
  description: "From repository to reliable deployment with AI-assisted security, infrastructure, and runtime workflows.",
  openGraph: {
    title: "DeplAI",
    description: "From repository to reliable deployment with AI-assisted security, infrastructure, and runtime workflows.",
    images: [{ url: "/deplai-logo.png", width: 512, height: 512, alt: "DeplAI" }],
  },
  twitter: {
    card: "summary",
    title: "DeplAI",
    description: "From repository to reliable deployment with AI-assisted security, infrastructure, and runtime workflows.",
    images: ["/deplai-logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <Script
          id="deplai-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('deplai-theme')==='inverted'){document.documentElement.setAttribute('data-deplai-theme','inverted');}}catch(e){}})();`,
          }}
        />
        {children}
        <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="lazyOnload" />
      </body>
    </html>
  );
}
