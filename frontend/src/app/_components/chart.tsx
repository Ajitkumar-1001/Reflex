import { formatRate } from "@/client/views";
import type { ChartBar } from "@/client/views";

export function ArmChart({ bars }: { bars: readonly ChartBar[] }) {
  const summary = bars
    .map((bar) => `${bar.label}: memory-off ${formatRate(bar.armA)}, memory-on ${formatRate(bar.armB)}`)
    .join(". ");
  const width = 640;
  const height = 230;
  const group = width / Math.max(1, bars.length);
  const plotTop = 28;
  const plotHeight = 140;

  return (
    <figure className="rounded-lg border border-border bg-card p-4">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
        <title>Memory-off versus memory-on rates</title>
        <line x1="32" x2={width - 16} y1={plotTop + plotHeight} y2={plotTop + plotHeight} stroke="var(--border)" />
        {bars.map((bar, index) => {
          const center = index * group + group / 2;
          const aHeight = Math.max(0, Math.min(1, bar.armA)) * plotHeight;
          const bHeight = Math.max(0, Math.min(1, bar.armB)) * plotHeight;
          return (
            <g key={bar.metric}>
              <rect x={center - 36} y={plotTop + plotHeight - aHeight} width="28" height={aHeight} fill="var(--bar-a)" />
              <rect x={center + 8} y={plotTop + plotHeight - bHeight} width="28" height={bHeight} fill="var(--bar-b)" />
              <text x={center - 22} y={plotTop + plotHeight - aHeight - 8} textAnchor="middle" fontSize="12" fill="currentColor">
                {formatRate(bar.armA)}
              </text>
              <text x={center + 22} y={plotTop + plotHeight - bHeight - 8} textAnchor="middle" fontSize="12" fill="currentColor">
                {formatRate(bar.armB)}
              </text>
              <text x={center} y={plotTop + plotHeight + 28} textAnchor="middle" fontSize="13" fill="currentColor">
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 bg-bar-a" aria-hidden="true" />A, memory off
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 bg-bar-b" aria-hidden="true" />B, memory on
        </span>
      </figcaption>
    </figure>
  );
}
