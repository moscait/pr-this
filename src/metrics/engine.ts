// Parses source text with tree-sitter and measures it. Grammars load lazily, one per language, on first use.

import { Language, Parser } from 'web-tree-sitter';
import type { FileMetrics } from '../shared/types';
import { GrammarStore, languageOf, type GrammarId } from './grammars';
import { measureTree } from './measure';

/** Files larger than this are not measured (generated or minified code, data files). */
export const MAX_MEASURE_BYTES = 1024 * 1024;

export class MetricsError extends Error {}

export class MetricsEngine {
  private ready?: Promise<void>;
  private languages = new Map<GrammarId, Promise<Language>>();
  private parsers = new Map<GrammarId, Parser>();

  /** @param runtimeWasm path of `web-tree-sitter.wasm`, the parser runtime shipped with the extension. */
  constructor(
    private readonly runtimeWasm: string,
    readonly grammars: GrammarStore,
  ) {}

  private init(): Promise<void> {
    this.ready ??= Parser.init({ locateFile: () => this.runtimeWasm }).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private language(id: GrammarId): Promise<Language> {
    let p = this.languages.get(id);
    if (!p) {
      p = this.init()
        .then(() => this.grammars.load(id))
        .then((bytes) => Language.load(bytes));
      p.catch(() => this.languages.delete(id)); // let a failed download be retried next time
      this.languages.set(id, p);
    }
    return p;
  }

  private async parser(id: GrammarId): Promise<Parser> {
    const lang = await this.language(id);
    let p = this.parsers.get(id);
    if (!p) {
      p = new Parser();
      p.setLanguage(lang);
      this.parsers.set(id, p);
    }
    return p;
  }

  /** Measure `source` as the language of `filePath`; throws `MetricsError` for files metrics can't cover. */
  async measure(filePath: string, source: string): Promise<FileMetrics> {
    const lang = languageOf(filePath);
    if (!lang) throw new MetricsError('Metrics are not available for this file type.');
    if (Buffer.byteLength(source) > MAX_MEASURE_BYTES) throw new MetricsError('The file is too large to measure (over 1 MB).');
    const parser = await this.parser(lang.grammar);
    const tree = parser.parse(source);
    if (!tree) throw new MetricsError("The file couldn't be parsed.");
    try {
      return measureTree(tree.rootNode, source, lang.language);
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    for (const p of this.parsers.values()) p.delete();
    this.parsers.clear();
  }
}
