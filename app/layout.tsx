import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: '家谱',
  applicationName: '家谱',
  description: '支持多本独立族谱的家族资料管理网站',
  openGraph: {
    title: '家谱',
    description: '支持多本独立族谱的家族资料管理网站',
    siteName: '家谱',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: '家谱',
    description: '支持多本独立族谱的家族资料管理网站',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
