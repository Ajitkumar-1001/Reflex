import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Nav } from "./_components/nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Reflex", template: "%s · Reflex" },
  description: "Read-only explorer for Reflex runs, memories, approvals, and paired evaluations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground"
        >
          Skip to content
        </a>
        <header className="border-b border-border">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Link href="/" className="rounded-md">
              <span className="block text-lg font-semibold tracking-tight">Reflex</span>
              <span className="block text-xs text-muted">Experience explorer</span>
            </Link>
            <Nav />
          </div>
        </header>
        <div id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
          {children}
        </div>
        <footer className="border-t border-border">
          <p className="mx-auto w-full max-w-6xl px-4 py-4 text-xs leading-5 text-muted">
            Read-only view of the Phase 1 in-memory store. Approve and deny go through the in-memory Phase 2 approval
            service.
          </p>
        </footer>
      </body>
    </html>
  );
}
