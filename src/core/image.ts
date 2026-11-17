import * as path from 'path';
import type { ImageDiff, ImageSide } from '../shared/types';
import { formatBytes, MAX_PREVIEW_IMAGE_BYTES } from '../shared/format';

export { formatBytes, MAX_PREVIEW_IMAGE_BYTES };

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};


export function imageMimeType(filePath: string): string | undefined {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

export function isImagePath(filePath: string): boolean {
  return imageMimeType(filePath) !== undefined;
}

/** Extract pixel width and height from PNG, GIF, JPEG, WebP, BMP, ICO, or SVG headers. */
export function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === 'image/png' && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (mime === 'image/gif' && buf.length >= 10 && buf.subarray(0, 3).toString('ascii') === 'GIF') {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
    if (mime === 'image/bmp' && buf.length >= 26 && buf.subarray(0, 2).toString('ascii') === 'BM') {
      const width = buf.readInt32LE(18);
      const height = Math.abs(buf.readInt32LE(22));
      if (width > 0 && height > 0) return { width, height };
    }
    if (mime === 'image/x-icon' && buf.length >= 8 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
      const width = buf[6] === 0 ? 256 : buf[6];
      const height = buf[7] === 0 ? 256 : buf[7];
      if (width > 0 && height > 0) return { width, height };
    }
    if (mime === 'image/webp' && buf.length >= 30 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      } else if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        const width = (b & 0x3fff) + 1;
        const height = ((b >> 14) & 0x3fff) + 1;
        if (width > 0 && height > 0) return { width, height };
      } else if (chunk === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf.readUIntLE(24, 3);
        const height = 1 + buf.readUIntLE(27, 3);
        if (width > 0 && height > 0) return { width, height };
      }
    }
    if (mime === 'image/jpeg' && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 8 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          if (width > 0 && height > 0) return { width, height };
          break;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
    if (mime === 'image/svg+xml') {
      const head = buf.subarray(0, 4096).toString('utf8');
      const svgTag = /<svg\b[^>]*>/i.exec(head)?.[0];
      if (svgTag) {
        const w = /\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i.exec(svgTag);
        const h = /\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)(?:px)?\s*["']/i.exec(svgTag);
        if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
        const vb = /\bviewBox\s*=\s*["']\s*-?\d+(?:\.\d+)?[\s,]+-?\d+(?:\.\d+)?[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*["']/i.exec(svgTag);
        if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
      }
    }
  } catch {
    /* ignore malformed header */
  }
  return undefined;
}

/** Build an `ImageSide` metadata + optional data URI from raw file bytes. */
export function buildImageSide(
  buf: Buffer | undefined,
  filePath: string,
  includeDataUri = true,
  bytesOverride?: number,
  unavailable?: 'too-large' | 'unreadable' | 'symlink',
): ImageSide | undefined {
  const mime = imageMimeType(filePath);
  if (!mime) return undefined;
  const bytes = bytesOverride ?? buf?.length ?? 0;
  if (!buf && bytes === 0 && !unavailable) return undefined;
  const dims = buf ? parseImageDimensions(buf, mime) : undefined;
  const tooLarge = bytes > MAX_PREVIEW_IMAGE_BYTES;
  const effectiveUnavailable = unavailable ?? (tooLarge ? 'too-large' : undefined);
  const dataUri =
    includeDataUri && !effectiveUnavailable && buf && buf.length <= MAX_PREVIEW_IMAGE_BYTES
      ? `data:${mime};base64,${buf.toString('base64')}`
      : undefined;
  return {
    mime,
    bytes,
    width: dims?.width,
    height: dims?.height,
    dataUri,
    ...(effectiveUnavailable ? { unavailable: effectiveUnavailable } : {}),
  };
}

/** Pure helper to build the full `ImageDiff` with base64 data URIs for webview preview. */
export function buildImagePreview(
  filePath: string,
  beforeBuf?: Buffer,
  afterBuf?: Buffer,
  oldPath?: string,
  beforeUnavailable?: 'too-large' | 'unreadable' | 'symlink',
  afterUnavailable?: 'too-large' | 'unreadable' | 'symlink',
  beforeBytes?: number,
  afterBytes?: number,
): ImageDiff | undefined {
  const before =
    beforeBuf || beforeUnavailable
      ? buildImageSide(beforeBuf, oldPath ?? filePath, true, beforeBytes, beforeUnavailable)
      : undefined;
  const after =
    afterBuf || afterUnavailable
      ? buildImageSide(afterBuf, filePath, true, afterBytes, afterUnavailable)
      : undefined;
  if (!before && !after) return undefined;
  return { before, after };
}

/** Format a concise human/LLM description of an image's before/after metadata. */
export function describeImageMeta(before?: ImageSide, after?: ImageSide): string {
  const fmt = (s: ImageSide) => {
    const kind = s.mime.replace('image/', '').replace('+xml', '').toUpperCase();
    const dim = s.width && s.height ? ` ${s.width}×${s.height}px` : '';
    return `${kind}${dim} (${formatBytes(s.bytes)})`;
  };
  if (before && after) return `image ${fmt(before)} -> ${fmt(after)}`;
  if (after) return `added image ${fmt(after)}`;
  if (before) return `deleted image ${fmt(before)}`;
  return 'image file';
}
