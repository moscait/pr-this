// Tree-sitter grammars for code metrics, downloaded on first use and verified against pinned checksums.
// The extension ships without them so it stays small; nothing is downloaded until the user turns a language on.

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { MetricsLanguage } from '../shared/types';

export type GrammarId = 'java' | 'javascript' | 'typescript' | 'tsx' | 'c_sharp';

export interface GrammarSource {
  /** Grammar release the file comes from. */
  version: string;
  /** File name in the release and in the cache. */
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

const release = (repo: string, version: string, file: string) =>
  `https://github.com/tree-sitter/${repo}/releases/download/v${version}/${file}`;

/**
 * Official release assets of each grammar. The checksums match the `.wasm` files in the same versions of the npm
 * packages (`tree-sitter-java`, …), so both sources agree. To update one, change the version, then the URL's file
 * size and SHA-256 together (`shasum -a 256 <file>`), and bump `METRICS_VERSION` in `./measure.ts`.
 */
export const GRAMMARS: Record<GrammarId, GrammarSource> = {
  java: {
    version: '0.23.5',
    file: 'tree-sitter-java.wasm',
    url: release('tree-sitter-java', '0.23.5', 'tree-sitter-java.wasm'),
    sha256: '4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4',
    bytes: 414641,
  },
  javascript: {
    version: '0.25.0',
    file: 'tree-sitter-javascript.wasm',
    url: release('tree-sitter-javascript', '0.25.0', 'tree-sitter-javascript.wasm'),
    sha256: '5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240',
    bytes: 411770,
  },
  typescript: {
    version: '0.23.2',
    file: 'tree-sitter-typescript.wasm',
    url: release('tree-sitter-typescript', '0.23.2', 'tree-sitter-typescript.wasm'),
    sha256: '778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d',
    bytes: 1413849,
  },
  tsx: {
    version: '0.23.2',
    file: 'tree-sitter-tsx.wasm',
    url: release('tree-sitter-typescript', '0.23.2', 'tree-sitter-tsx.wasm'),
    sha256: '79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8',
    bytes: 1445638,
  },
  c_sharp: {
    version: '0.23.5',
    file: 'tree-sitter-c_sharp.wasm',
    url: release('tree-sitter-c-sharp', '0.23.5', 'tree-sitter-c_sharp.wasm'),
    sha256: '6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40',
    bytes: 5350581,
  },
};

export const LANGUAGE_LABELS: Record<MetricsLanguage, string> = {
  java: 'Java',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  csharp: 'C#',
};

const EXTENSIONS: Record<string, { language: MetricsLanguage; grammar: GrammarId }> = {
  '.java': { language: 'java', grammar: 'java' },
  '.js': { language: 'javascript', grammar: 'javascript' },
  '.mjs': { language: 'javascript', grammar: 'javascript' },
  '.cjs': { language: 'javascript', grammar: 'javascript' },
  '.jsx': { language: 'javascript', grammar: 'javascript' },
  '.ts': { language: 'typescript', grammar: 'typescript' },
  '.mts': { language: 'typescript', grammar: 'typescript' },
  '.cts': { language: 'typescript', grammar: 'typescript' },
  '.tsx': { language: 'typescript', grammar: 'tsx' },
  '.cs': { language: 'csharp', grammar: 'c_sharp' },
};

/** The language and grammar for a path, by extension; undefined when metrics don't cover it. `.d.ts` files hold no code. */
export function languageOf(filePath: string): { language: MetricsLanguage; grammar: GrammarId } | undefined {
  const lower = filePath.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(lower)) return undefined;
  return EXTENSIONS[path.posix.extname(lower)];
}

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

export class GrammarError extends Error {}

/**
 * Downloads grammars into `dir` once and hands out their bytes. A cached file is checked against its checksum each
 * time it is loaded, so a damaged or replaced file is downloaded again instead of being run.
 */
export class GrammarStore {
  private inflight = new Map<GrammarId, Promise<Uint8Array>>();

  constructor(
    private readonly dir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The grammar's bytes, downloading it if it is not cached yet. */
  load(id: GrammarId): Promise<Uint8Array> {
    let p = this.inflight.get(id);
    if (!p) {
      p = this.loadOnce(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /** True when the grammar is already downloaded (it is not verified here). */
  async cached(id: GrammarId): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir, GRAMMARS[id].file));
      return true;
    } catch {
      return false;
    }
  }

  private async loadOnce(id: GrammarId): Promise<Uint8Array> {
    const src = GRAMMARS[id];
    const file = path.join(this.dir, src.file);
    try {
      const buf = new Uint8Array(await fs.readFile(file));
      if (sha256(buf) === src.sha256) return buf;
      await fs.rm(file, { force: true });
    } catch {
      /* not cached yet */
    }
    const buf = await this.download(src);
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
    return buf;
  }

  private async download(src: GrammarSource): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchImpl(src.url, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new GrammarError(`Couldn't download the parser (${(e as Error).message}). Check your network connection.`);
    }
    if (!res.ok) throw new GrammarError(`Couldn't download the parser: the server returned ${res.status}.`);
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared !== src.bytes) throw new GrammarError('The downloaded parser is not the expected size, so it was not used.');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== src.bytes || sha256(buf) !== src.sha256) {
      throw new GrammarError("The downloaded parser doesn't match its pinned checksum, so it was not used.");
    }
    return buf;
  }
}
