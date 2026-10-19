const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Keep recent timestamps compact; older sessions use an unambiguous local date. */
export function sessionRecency(value: string | null, now = Date.now()): string {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "Unknown date";
  const elapsed = Math.max(0, now - time);
  if (elapsed > 3 * DAY) {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  const minutes = Math.floor(elapsed / MINUTE);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
