"use client";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-danger bg-danger-bg px-4 py-4 text-danger">
      <h1 className="text-lg font-medium">This page could not be loaded</h1>
      <p className="mt-2 text-sm leading-6">{error.message || "An unexpected error occurred."}</p>
      {error.digest ? <p className="mt-1 font-mono text-xs">Reference {error.digest}</p> : null}
      <button type="button" onClick={() => retry()} className="mt-4 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground">
        Try again
      </button>
    </div>
  );
}
