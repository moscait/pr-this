import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, NODE_W, NODE_H } from '../../webview-ui/src/layout';
import { normalizeOverview, normalizeFileDetail } from '../ai/prompts';
import type { ChangeSession } from '../shared/types';

test('layoutGraph creates non-overlapping layers for DAG', () => {
  const components = [
    { id: 'ui', name: 'UI', kind: 'ui', status: 'modified' as const, description: '', files: ['src/ui.tsx'] },
    { id: 'api', name: 'API Client', kind: 'api', status: 'added' as const, description: '', files: ['src/api.ts'] },
    { id: 'db', name: 'Database', kind: 'db', status: 'context' as const, description: '', files: ['src/db.ts'] },
  ];
  const flows = [
    { from: 'ui', to: 'api', label: 'calls', order: 1 },
    { from: 'api', to: 'db', label: 'queries', order: 2 },
  ];

  const layout = layoutGraph(components, flows);
  assert.equal(layout.nodes.size, 3);
  assert.equal(layout.edges.length, 2);

  const ui = layout.nodes.get('ui')!;
  const api = layout.nodes.get('api')!;
  const db = layout.nodes.get('db')!;

  assert.ok(ui.x < api.x, 'UI should precede API horizontally');
  assert.ok(api.x < db.x, 'API should precede DB horizontally');
  assert.ok(layout.width > NODE_W * 3);
  assert.ok(layout.height >= NODE_H);
});

test('normalizeOverview assigns orphaned files and sanitizes risk levels', () => {
  const mockSession: ChangeSession = {
    id: 'test-session',
    repoRoot: '/mock',
    repoName: 'mock',
    scope: { kind: 'working' },
    title: 'Uncommitted',
    subtitle: 'test',
    commits: [],
    files: [
      { path: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, binary: false, hunks: [] },
      { path: 'src/util.ts', status: 'added', additions: 5, deletions: 0, binary: false, hunks: [] },
    ],
    additions: 6,
    deletions: 0,
    leftRef: 'HEAD',
  };

  const rawOverview = {
    headline: 'Added utility functions',
    summary: 'Created helper utils',
    risk: { level: 'HIGH', reasons: ['Potential edge case'] },
    components: [
      { id: 'utils', name: 'Utils', files: ['src/util.ts'] },
    ],
    flows: [],
  };

  const normalized = normalizeOverview(rawOverview, mockSession);
  assert.equal(normalized.headline, 'Added utility functions');
  assert.equal(normalized.risk.level, 'high');
  // 'src/main.ts' was not listed under components, so an 'other' component should be synthesized
  const mainFile = normalized.files.find((f) => f.path === 'src/main.ts');
  assert.ok(mainFile);
  assert.ok(mainFile.component);
  assert.ok(normalized.components.some((c) => c.id === mainFile.component));
});

test('normalizeFileDetail clamps invalid hunk indexes', () => {
  const mockFile = {
    path: 'test.ts',
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    binary: false,
    hunks: [
      { index: 1, header: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
    ],
  };

  const rawDetail = {
    narrative: 'Updated logic',
    hunks: [
      { index: 1, title: 'Valid hunk', explanation: 'Fixed issue', severity: 'info' },
      { index: 99, title: 'Out of bounds', explanation: 'Ghost hunk', severity: 'warn' },
    ],
  };

  const normalized = normalizeFileDetail(rawDetail, mockFile);
  assert.equal(normalized.narrative, 'Updated logic');
  assert.equal(normalized.hunks.length, 1);
  assert.equal(normalized.hunks[0].index, 1);
});

