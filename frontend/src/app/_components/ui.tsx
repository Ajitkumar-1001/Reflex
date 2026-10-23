import type { ReactNode } from "react";

const TONES: Record<string, string> = {
  COMPLETE: "bg-ok-bg text-ok",
  verified_success: "bg-ok-bg text-ok",
  approved: "bg-ok-bg text-ok",
  passed: "bg-ok-bg text-ok",
  helped: "bg-ok-bg text-ok",
  FAILED: "bg-danger-bg text-danger",
  verified_failure: "bg-danger-bg text-danger",
  denied: "bg-danger-bg text-danger",
  failed: "bg-danger-bg text-danger",
  hurt: "bg-danger-bg text-danger",
  expired: "bg-danger-bg text-danger",
  rejected: "bg-danger-bg text-danger",
  BLOCKED: "bg-warn-bg text-warn",
  blocked: "bg-warn-bg text-warn",
  candidate: "bg-warn-bg text-warn",
  pending: "bg-warn-bg text-warn",
  quarantined: "bg-warn-bg text-warn",
  REVIEW_REQUIRED: "bg-warn-bg text-warn",
  demoted: "bg-warn-bg text-warn",
  INCONCLUSIVE: "bg-info-bg text-info",
  inconclusive: "bg-info-bg text-info",
  degraded: "bg-info-bg text-info",
  hybrid: "bg-info-bg text-info",
};

export function StatusBadge({ value }: { value: string }) {
  const tone = TONES[value] ?? "bg-card text-foreground ring-1 ring-border";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{value}</span>;
}

export function PageHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <header className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-muted">{lede}</p>
    </header>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-lg font-medium">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-4 py-8">
      <h2 className="text-base font-medium">{title}</h2>
      <div className="mt-2 max-w-2xl text-sm leading-6 text-muted">{children}</div>
    </div>
  );
}

export function ErrorState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-danger bg-danger-bg px-4 py-4 text-danger">
      <h2 className="text-base font-medium">{title}</h2>
      <div className="mt-2 text-sm leading-6">{children}</div>
    </div>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <p role="status" className="text-sm text-muted">
      {label}
    </p>
  );
}

export function TableFrame({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-lg border border-border bg-card">{children}</div>;
}

export function tableClassName(): string {
  return "w-full min-w-[36rem] border-collapse text-left text-sm";
}

export function thClassName(): string {
  return "px-3 py-2 font-medium text-muted";
}

export function tdClassName(): string {
  return "border-t border-border px-3 py-2 align-top";
}
