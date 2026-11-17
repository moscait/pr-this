/**
 * Extract a JSON object from LLM output. Tolerates markdown fences, leading prose,
 * `<think>` blocks from reasoning models, and trailing commas.
 */
export function extractJson<T = unknown>(text: string): T {
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  // The fence regex stops at the first closing ```, which cuts the JSON short when one of its
  // string values contains a code fence. So when the first `{` lies inside the fence, parse
  // the whole text by brace matching; use the fenced block first only when prose before the
  // fence holds a stray `{`.
  const candidates = !fence || !fence[1].includes('{') ? [s] : s.indexOf('{') < fence.index ? [fence[1], s] : [s, fence[1]];
  let firstError: unknown;
  for (const c of candidates) {
    try {
      return parseFrom<T>(c);
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError;
}

function parseFrom<T>(s: string): T {
  const start = s.indexOf('{');
  if (start < 0) throw new Error('Model response did not contain JSON.');
  const end = findMatchingBrace(s, start);
  let body = end > 0 ? s.slice(start, end + 1) : s.slice(start);
  try {
    return JSON.parse(body) as T;
  } catch {
    body = body.replace(/,\s*([}\]])/g, '$1');
    return (end < 0 ? repairTruncated(body) : JSON.parse(body)) as T;
  }
}

function findMatchingBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Repair JSON cut off by a token limit: close what is open, and when that is still invalid
 * (cut inside a key, or after a key with no value), drop the last incomplete member and retry.
 */
function repairTruncated(s: string): unknown {
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      return JSON.parse(closeOpen(s));
    } catch (e) {
      const cut = lastSeparator(s);
      if (cut < 0) throw e;
      s = s.slice(0, cut);
    }
  }
  throw new Error('Model response contained truncated JSON that could not be repaired.');
}

/** Index of the last `,`, `{` or `[` outside a string, keeping an opening bracket itself. */
function lastSeparator(s: string): number {
  let inStr = false;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ',') last = i;
    else if (c === '{' || c === '[') last = i + 1;
  }
  return last > 0 && last < s.length ? last : -1;
}

/** Best-effort close of truncated JSON (e.g. output cut off by token limit). */
function closeOpen(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  return out + stack.reverse().join('');
}
