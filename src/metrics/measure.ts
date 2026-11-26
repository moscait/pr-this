// Deterministic code metrics from a tree-sitter syntax tree: per-function cyclomatic complexity, length, nesting and
// parameter count, plus line counts. The counting follows the usual McCabe rules (as ESLint's `complexity` rule,
// lizard and most IDE plug-ins do), so numbers are comparable with those tools.

import type { Node } from 'web-tree-sitter';
import type { FileMetrics, FunctionMetrics, MetricsLanguage } from '../shared/types';

/**
 * Bump when counting rules or grammars change, so cached results computed with the old rules are not mixed with new ones.
 */
export const METRICS_VERSION = 1;

interface Rules {
  /** Nodes that start a new function. */
  functions: Set<string>;
  /** Nodes that add one decision point. */
  decisions: Set<string>;
  /** Binary operators that add one decision point. */
  logical: Set<string>;
  /** Control structures that add a level of nesting. */
  nesting: Set<string>;
  /** Type declarations whose name qualifies the functions inside them. */
  types: Set<string>;
  comments: Set<string>;
  /** Extra decision points a node adds beyond `decisions` (e.g. each `case` in a C# switch section). */
  extraDecisions?: (n: Node) => number;
  name: (n: Node) => string;
  params: (n: Node) => number;
}

const set = (...xs: string[]) => new Set(xs);

const text = (n: Node | null | undefined) => n?.text ?? '';
const named = (n: Node | null | undefined) => (n ? n.namedChildren.filter((c): c is Node => !!c) : []);

/** The name of a function that has none of its own: the variable, property or field it is assigned to. */
function assignedName(n: Node): string {
  const p = n.parent;
  if (!p) return '(anonymous)';
  switch (p.type) {
    case 'variable_declarator':
    case 'public_field_definition':
    case 'field_definition':
      return text(p.childForFieldName('name') ?? p.childForFieldName('property')) || '(anonymous)';
    case 'pair':
      return text(p.childForFieldName('key')) || '(anonymous)';
    case 'assignment_expression':
      return text(p.childForFieldName('left')) || '(anonymous)';
    default:
      return '(anonymous)';
  }
}

const JS_FUNCTIONS = set(
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
);

const jsRules = (extraTypes: string[]): Rules => ({
  functions: JS_FUNCTIONS,
  decisions: set('if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_case', 'catch_clause', 'ternary_expression'),
  logical: set('&&', '||', '??'),
  nesting: set('if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'catch_clause'),
  types: set('class_declaration', 'class', ...extraTypes),
  comments: set('comment', 'html_comment'),
  name: (n) => text(n.childForFieldName('name')) || assignedName(n),
  params: (n) => {
    if (n.childForFieldName('parameter')) return 1; // `x => …`
    return named(n.childForFieldName('parameters')).filter((c) => !c.type.includes('comment')).length;
  },
});

const javaRules: Rules = {
  // Lambdas count toward the method that contains them, as in most Java tools.
  functions: set('method_declaration', 'constructor_declaration', 'compact_constructor_declaration'),
  decisions: set('if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause', 'ternary_expression'),
  logical: set('&&', '||'),
  nesting: set('if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'switch_expression', 'catch_clause'),
  types: set('class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'),
  comments: set('line_comment', 'block_comment'),
  // `case X:` and `case X ->` labels carry a value or pattern; `default` has none.
  extraDecisions: (n) => (n.type === 'switch_label' && n.namedChildCount > 0 ? 1 : 0),
  name: (n) => text(n.childForFieldName('name')),
  params: (n) => named(n.childForFieldName('parameters')).filter((c) => c.type === 'formal_parameter' || c.type === 'spread_parameter').length,
};

/** C# accessor names read `Property.get`; the property may be an indexer or event. */
function csName(n: Node): string {
  switch (n.type) {
    case 'accessor_declaration': {
      const owner = n.parent?.parent;
      const ownerName = owner?.type === 'indexer_declaration' ? 'this[]' : text(owner?.childForFieldName('name'));
      return `${ownerName || '(property)'}.${text(n.childForFieldName('name')) || n.child(0)?.text || 'accessor'}`;
    }
    case 'destructor_declaration':
      return `~${text(n.childForFieldName('name'))}`;
    case 'operator_declaration':
      return `operator ${text(n.childForFieldName('operator'))}`;
    case 'conversion_operator_declaration':
      return `operator ${text(n.childForFieldName('type'))}`;
    default:
      return text(n.childForFieldName('name'));
  }
}

const csRules: Rules = {
  // Lambdas and anonymous methods count toward the member that contains them.
  functions: set(
    'method_declaration',
    'constructor_declaration',
    'destructor_declaration',
    'operator_declaration',
    'conversion_operator_declaration',
    'local_function_statement',
    'accessor_declaration',
  ),
  decisions: set('if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'catch_clause', 'conditional_expression'),
  logical: set('&&', '||', '??'),
  nesting: set('if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'switch_statement', 'switch_expression', 'catch_clause'),
  types: set('class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'),
  comments: set('comment'),
  extraDecisions: (n) => {
    // Each `case` label in a switch section, and each switch-expression arm except the `_` discard.
    if (n.type === 'switch_section') return n.children.filter((c) => c?.type === 'case').length;
    if (n.type === 'switch_expression_arm') return n.namedChild(0)?.type === 'discard' ? 0 : 1;
    return 0;
  },
  name: csName,
  params: (n) => named(n.childForFieldName('parameters')).filter((c) => c.type === 'parameter').length,
};

export const RULES: Record<MetricsLanguage, Rules> = {
  java: javaRules,
  javascript: jsRules([]),
  typescript: jsRules(['abstract_class_declaration', 'interface_declaration']),
  csharp: csRules,
};

/** True for an `if` that is the `else` branch of another `if`: `else if` adds a decision but not a nesting level. */
function isElseIf(n: Node): boolean {
  if (n.type !== 'if_statement') return false;
  const p = n.parent;
  if (!p) return false;
  if (p.type === 'else_clause') return p.parent?.type === 'if_statement'; // JavaScript / TypeScript
  return p.type === 'if_statement' && p.childForFieldName('alternative')?.id === n.id; // Java / C#
}

interface FnCtx {
  m: FunctionMetrics;
}

/** Measure a parsed file. `source` must be the text the tree was parsed from. */
export function measureTree(root: Node, source: string, language: MetricsLanguage): FileMetrics {
  const rules = RULES[language];
  const functions: FunctionMetrics[] = [];
  let topLevel = 0;
  const commentRanges: [number, number, number, number][] = []; // startIndex, endIndex, startRow, endRow

  const walk = (n: Node, fn: FnCtx | undefined, depth: number, scope: string[]) => {
    if (rules.comments.has(n.type)) {
      commentRanges.push([n.startIndex, n.endIndex, n.startPosition.row, n.endPosition.row]);
      return;
    }
    // Declarations without a body (abstract and interface methods, `get;` auto-accessors) have no code to measure.
    if (rules.functions.has(n.type) && n.childForFieldName('body')) {
      const name = rules.name(n) || '(anonymous)';
      const m: FunctionMetrics = {
        name: [...scope, name].join('.'),
        line: n.startPosition.row + 1,
        lines: n.endPosition.row - n.startPosition.row + 1,
        complexity: 1,
        nesting: 0,
        params: rules.params(n),
      };
      functions.push(m);
      for (const c of n.children) if (c) walk(c, { m }, 0, scope);
      return;
    }
    let add = rules.decisions.has(n.type) ? 1 : 0;
    if (n.type === 'binary_expression' && rules.logical.has(n.childForFieldName('operator')?.type ?? '')) add++;
    add += rules.extraDecisions?.(n) ?? 0;
    if (add) {
      if (fn) fn.m.complexity += add;
      else topLevel += add;
    }
    let d = depth;
    if (rules.nesting.has(n.type) && !isElseIf(n)) {
      d++;
      if (fn && d > fn.m.nesting) fn.m.nesting = d;
    }
    const childScope = rules.types.has(n.type) ? [...scope, text(n.childForFieldName('name')) || '(anonymous)'] : scope;
    for (const c of n.children) if (c) walk(c, fn, d, childScope);
  };
  walk(root, undefined, 0, []);

  // Line counts: blank out comments, then a line is code if anything but whitespace is left on it.
  const chars = source.split('');
  const commentRows = new Set<number>();
  for (const [start, end, r0, r1] of commentRanges) {
    for (let i = start; i < end && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
    for (let r = r0; r <= r1; r++) commentRows.add(r);
  }
  const lines = chars.join('').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // final newline
  const code = lines.filter((l) => l.trim()).length;

  functions.sort((a, b) => a.line - b.line);
  return {
    lines: lines.length,
    code,
    comments: commentRows.size,
    functions,
    complexity: topLevel + functions.reduce((s, f) => s + f.complexity, 0),
    syntaxErrors: root.hasError,
  };
}
