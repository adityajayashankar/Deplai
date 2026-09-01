import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Deplai Owner Console',
  description: 'Private owner control plane',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
