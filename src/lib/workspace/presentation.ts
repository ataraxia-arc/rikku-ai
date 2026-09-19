export function formatUtcDate(value: string | null) {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not reported";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatUtcTimestamp(value: string | null) {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Not reported";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} UTC`;
}

export function formatCoverage(earliest: string | null, latest: string | null) {
  if (!earliest || !latest) return "Coverage not reported";
  const start = new Date(earliest);
  const end = new Date(latest);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return "Coverage not reported";
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const long = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return start.getUTCFullYear() === end.getUTCFullYear()
    ? `${short.format(start)} – ${long.format(end)}`
    : `${long.format(start)} – ${long.format(end)}`;
}

export function formatRecordCount(value: number) {
  return value.toLocaleString("en-US");
}
