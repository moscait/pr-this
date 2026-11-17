/** Maximum image size embedded as a data URI for previewing in the webview (5 MB). */
export const MAX_PREVIEW_IMAGE_BYTES = 5 * 1024 * 1024;

/** Format byte count into human-readable B, KB, or MB string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
