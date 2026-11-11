/** Shared duration formatting. Lives in core so budget/status wording stays
 * identical across hosts and loadable without harness dependencies. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const tenths = Math.round(ms / 100) / 10;
	if (tenths < 60) return `${tenths.toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}
