import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, buildDiffDigest, unquotePath, globToRegExp } from '../core/diff';
import { extractJson } from '../core/json';

test('unquotePath handles plain and escaped paths', () => {
  assert.equal(unquotePath('src/file.ts'), 'src/file.ts');
  assert.equal(unquotePath('"src/with space.ts"'), 'src/with space.ts');
  assert.equal(unquotePath('"path/with\\ttab"'), 'path/with\ttab');
});

test('globToRegExp matches wildcards correctly', () => {
  const re = globToRegExp('**/package-lock.json');
  assert.ok(re.test('package-lock.json'));
  assert.ok(re.test('packages/core/package-lock.json'));
  assert.ok(!re.test('package.json'));

  const minRe = globToRegExp('**/*.min.js');
  assert.ok(minRe.test('bundle.min.js'));
  assert.ok(minRe.test('dist/assets/vendor.min.js'));
  assert.ok(!minRe.test('bundle.js'));
});

test('parseDiff parses multi-file unified diff', () => {
  const diffSample = `diff --git a/src/hello.ts b/src/hello.ts
index 1111111..2222222 100644
--- a/src/hello.ts
+++ b/src/hello.ts
@@ -1,3 +1,4 @@
 export function hello() {
-  console.log("old");
+  console.log("new");
+  return true;
 }
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line 1
+line 2
`;

  const files = parseDiff(diffSample);
  assert.equal(files.length, 2);

  assert.equal(files[0].path, 'src/hello.ts');
  assert.equal(files[0].status, 'modified');
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].lines.length, 5);

  assert.equal(files[1].path, 'new.txt');
  assert.equal(files[1].status, 'added');
  assert.equal(files[1].additions, 2);
  assert.equal(files[1].deletions, 0);
});

test('extractJson parses clean JSON, fenced JSON, and reasoning outputs', () => {
  const clean = '{"headline": "test", "keyChanges": ["one"]}';
  assert.deepEqual(extractJson(clean), { headline: 'test', keyChanges: ['one'] });

  const fenced = 'Here is the result:\n```json\n{"summary": "great"}\n```\nHope it helps!';
  assert.deepEqual(extractJson(fenced), { summary: 'great' });

  const thinking = '<think>I should output JSON</think>\n```\n{"score": 42}\n```';
  assert.deepEqual(extractJson(thinking), { score: 42 });

  const trailingComma = '{"items": [1, 2, ], }';
  assert.deepEqual(extractJson(trailingComma), { items: [1, 2] });
});

test('buildDiffDigest respects char budget', () => {
  const diffSample = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,1 +1,1 @@
-old
+new
`;
  const files = parseDiff(diffSample);
  const digest = buildDiffDigest(files, 500);
  assert.ok(digest.includes('file.ts'));
  assert.ok(digest.includes('+new'));
});

