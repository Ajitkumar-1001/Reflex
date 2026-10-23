"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/runs", label: "Runs" },
  { href: "/memories", label: "Memories" },
  { href: "/approvals", label: "Approvals" },
  { href: "/evaluation", label: "Evaluation" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary">
      <ul className="flex flex-wrap gap-2">
        {LINKS.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex rounded-full px-3 py-1.5 text-sm font-medium ${
                  current ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-border"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
