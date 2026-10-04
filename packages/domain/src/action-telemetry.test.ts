import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionJobsClient, canonicalActionRunUrl, classifyWorkflowFailure, extractActionRunId, normalizeActionJobs, type ActionJobsPage } from './action-telemetry.js';

function page(jobs: Array<Record<string, unknown>>, total: number): ActionJobsPage { return { total_count: total, jobs }; }
function step(name: string, status: string, conclusion: string | null): Record<string, unknown> { return { name, status, conclusion }; }
function job(status: string, conclusion: string | null, steps: Array<Record<string, unknown>>): Record<string, unknown> { return { id: 1, name: 'build', status, conclusion, steps }; }

test('action URL validation accepts only the exact RDGen repository run route', () => {
  assert.equal(extractActionRunId('https://github.com/bryangerlach/rdgen/actions/runs/37219299194'), '37219299194');
  assert.equal(extractActionRunId('https://github.com/bryangerlach/rdgen/actions/runs/37219299194/'), '37219299194');
  assert.equal(extractActionRunId(undefined), undefined);
  assert.equal(extractActionRunId('https://github.com/other/rdgen/actions/runs/1'), undefined);
  assert.equal(extractActionRunId('https://github.com/bryangerlach/rdgen/actions/runs/1?extra=2'), undefined);
  assert.equal(extractActionRunId('https://github.com/bryangerlach/rdgen/actions/runs/not-a-number'), undefined);
  assert.equal(extractActionRunId('https://evil.example/github.com/bryangerlach/rdgen/actions/runs/1'), undefined);
  assert.equal(canonicalActionRunUrl('5'), 'https://github.com/bryangerlach/rdgen/actions/runs/5');
});

test('normalize aggregates paginated complete terminal jobs into a hundred-percent failure snapshot', () => {
  const first = page([job('completed', 'failure', [step('Set up job', 'completed', 'success'), step('Install vcpkg dependencies', 'completed', 'failure')])], 2);
  const second = page([job('completed', 'success', [step('Build', 'completed', 'success')])], 2);
  const snapshot = normalizeActionJobs('7', [first, second], { exhausted: true });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.conclusion, 'failure');
  assert.equal(snapshot.percentage, 100);
  assert.equal(snapshot.activeStep, null);
  assert.deepEqual(snapshot.failedSteps, ['Install vcpkg dependencies']);
});

test('normalize reports pending progress with active step and a capped percentage', () => {
  const snapshot = normalizeActionJobs('7', [page([job('in_progress', null, [step('Set up job', 'completed', 'success'), step('Install vcpkg dependencies', 'in_progress', null), step('Build', 'queued', null), step('Package', 'queued', null)])], 1)], { exhausted: true });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.status, 'in_progress');
  assert.equal(snapshot.activeStep, 'Install vcpkg dependencies');
  assert.equal(snapshot.percentage, 25);
  const allStepsDone = normalizeActionJobs('7', [page([job('in_progress', null, [step('Set up job', 'completed', 'success'), step('Install vcpkg dependencies', 'completed', 'success')])], 1)], { exhausted: true });
  assert.equal(allStepsDone.percentage, 99);
});

test('normalize keeps parallel jobs honest and reports unknown for empty or incomplete payloads', () => {
  const parallel = normalizeActionJobs('7', [page([job('completed', 'success', [step('A', 'completed', 'success')]), job('in_progress', null, [step('B', 'in_progress', null)])], 2)], { exhausted: true });
  assert.equal(parallel.status, 'in_progress');
  assert.equal(parallel.percentage, 50);
  assert.equal(parallel.conclusion, null);
  const empty = normalizeActionJobs('7', [page([], 0)], { exhausted: true });
  assert.equal(empty.status, null);
  assert.equal(empty.percentage, null);
  assert.equal(empty.complete, true);
  const missingSteps = normalizeActionJobs('7', [page([{ id: 1, status: 'completed', conclusion: 'failure' }], 1)], { exhausted: true });
  assert.equal(missingSteps.complete, true);
  assert.equal(missingSteps.percentage, null);
  const malformed = normalizeActionJobs('7', [{ total_count: 1 }], { exhausted: true });
  assert.equal(malformed.complete, false);
  assert.equal(malformed.percentage, null);
});

test('classification retries only complete all-vcpkg failures', () => {
  const vcpkg = normalizeActionJobs('7', [page([job('completed', 'failure', [step('Install vcpkg dependencies', 'completed', 'failure')])], 1)], { exhausted: true });
  assert.deepEqual(classifyWorkflowFailure({ rdgenFailed: true, snapshot: vcpkg }), { retryable: true });
  const mixed = normalizeActionJobs('7', [page([job('completed', 'failure', [step('Install vcpkg dependencies', 'completed', 'failure'), step('Build', 'completed', 'failure')])], 1)], { exhausted: true });
  assert.deepEqual(classifyWorkflowFailure({ rdgenFailed: true, snapshot: mixed }), { retryable: false, reason: 'unrecognized' });
  assert.deepEqual(classifyWorkflowFailure({ rdgenFailed: true, snapshot: { ...vcpkg, complete: false } }), { retryable: false, reason: 'incomplete' });
  assert.deepEqual(classifyWorkflowFailure({ rdgenFailed: true }), { retryable: false, reason: 'no_snapshot' });
  assert.deepEqual(classifyWorkflowFailure({ rdgenFailed: false, snapshot: vcpkg }), { retryable: false, reason: 'rdgen_succeeded' });
});

function jsonResponse(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('jobs client paginates to exhaustion and normalizes the aggregate', async () => {
  const urls: string[] = [];
  const client = new ActionJobsClient({ perPage: 1, fetch: async (input: string) => { urls.push(input); const url = new URL(input); const pageNumber = Number(url.searchParams.get('page')); return pageNumber === 1 ? jsonResponse(page([job('completed', 'success', [step('A', 'completed', 'success')])], 2)) : jsonResponse(page([job('completed', 'success', [step('B', 'completed', 'success')])], 2)); } });
  const result = await client.fetchSnapshot('9');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.snapshot.percentage, 100);
    assert.equal(result.snapshot.conclusion, 'success');
  }
  assert.equal(urls.length, 2);
  assert.equal(urls.every((url) => url.startsWith('https://api.github.com/repos/bryangerlach/rdgen/actions/runs/9/jobs?')), true);
});

test('jobs client maps rate limits and timeouts to sanitized failures', async () => {
  const limited = new ActionJobsClient({ fetch: async () => new Response('rate limit', { status: 403 }) });
  assert.deepEqual(await limited.fetchSnapshot('9'), { ok: false, failure: 'rate_limited' });
  const missing = new ActionJobsClient({ fetch: async () => new Response('{}', { status: 404 }) });
  assert.deepEqual(await missing.fetchSnapshot('9'), { ok: false, failure: 'not_found' });
  const broken = new ActionJobsClient({ fetch: async () => new Response('nope', { status: 200 }) });
  assert.deepEqual(await broken.fetchSnapshot('9'), { ok: false, failure: 'protocol' });
  const hung = new ActionJobsClient({ timeoutMs: 20, fetch: (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  assert.deepEqual(await hung.fetchSnapshot('9'), { ok: false, failure: 'timeout' });
  assert.equal(await new ActionJobsClient().fetchSnapshot('not-numeric').then((value) => value.ok), false);
});
