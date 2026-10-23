import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="mt-2 text-sm leading-6 text-muted">That run or memory is not in this project.</p>
      <p className="mt-4">
        <Link href="/" className="text-sm font-medium underline underline-offset-2">
          Back to the dashboard
        </Link>
      </p>
    </div>
  );
}
