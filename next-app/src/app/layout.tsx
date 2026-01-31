import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sharp Dashboard',
  description: 'Clawdbot Control Panel',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
