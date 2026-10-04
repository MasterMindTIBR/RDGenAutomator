import type { FetchLike } from './rdgen-provider.js';

/** The only Actions origin RDGen emits; anything else is ignored, never fetched. */
const actionRunUrl = /^https:\/\/github\.com\/bryangerlach\/rdgen\/actions\/runs\/(\d+)\/?$/;

/** Returns the validated numeric run ID of an exact RDGen Actions run URL, or undefined. */
export function extractActionRunId(actionUrl: string | undefined): string | undefined {
  if (!actionUrl) return undefined;
  const match = actionRunUrl.exec(actionUrl);
  return match ? match[1] : undefined;
}

export function canonicalActionRunUrl(runId: string): string {
  return `https://github.com/bryangerlach/rdgen/actions/runs/${runId}`;
}

export type ActionSnapshotStatus = 'queued' | 'in_progress' | 'completed';
export type NormalizedActionSnapshot = {
  runId: string;
  status: ActionSnapshotStatus | null;
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  activeStep: string | null;
  /** floor(terminal steps / all named steps * 100); null when the payload is empty or incomplete. */
  percentage: number | null;
  complete: boolean;
  failedSteps: string[];
};

type RawStep = { name?: unknown; status?: unknown; conclusion?: unknown };
type RawJob = { status?: unknown; conclusion?: unknown; steps?: unknown };
/** One page of the public Actions jobs endpoint, still untrusted. */
export type ActionJobsPage = { total_count?: unknown; jobs?: unknown };

const stepTerminalConclusions: Record<string, true> = { success: true, failure: true, skipped: true, cancelled: true, action_required: true };
/**
 * Normalizes every fetched jobs page into one snapshot. `exhausted` reports that
 * pagination reached the end (fetched jobs cover total_count); pages whose `jobs`
 * member is missing or malformed force `complete` false so callers never guess.
 */
export function normalizeActionJobs(runId: string, pages: readonly ActionJobsPage[], options: { exhausted: boolean }): NormalizedActionSnapshot {
  const jobs: RawJob[] = []; let pagesWellFormed = true; let fetched = 0; let total: number | null = null;
  for (const page of pages) {
    if (!page || !Array.isArray(page.jobs)) { pagesWellFormed = false; continue; }
    if (typeof page.total_count === 'number' && total === null) total = page.total_count;
    fetched += (page.jobs as unknown[]).length;
    for (const job of page.jobs as RawJob[]) jobs.push(job && typeof job === 'object' ? job : {});
  }
  const complete = options.exhausted && pagesWellFormed && pages.length > 0 && (total === null || fetched >= total);
  let namedSteps = 0; let terminalSteps = 0; let activeStep: string | null = null; const failedSteps: string[] = [];
  let anyInProgress = false; let anyQueued = false; let jobsWithSteps = 0;
  for (const job of jobs) {
    const status = typeof job.status === 'string' ? job.status : '';
    if (status === 'in_progress') anyInProgress = true;
    else if (status === 'queued') anyQueued = true;
    if (!Array.isArray(job.steps)) continue;
    jobsWithSteps += 1;
    for (const step of job.steps as RawStep[]) {
      const name = step && typeof step.name === 'string' && step.name.trim() ? step.name : null;
      const conclusion = step && typeof step.conclusion === 'string' ? step.conclusion : null;
      const stepStatus = step && typeof step.status === 'string' ? step.status : '';
      if (!name) continue;
      namedSteps += 1;
      if (stepTerminalConclusions[conclusion ?? ''] === true || stepStatus === 'completed') terminalSteps += 1;
      if (stepStatus === 'in_progress' && activeStep === null) activeStep = name;
      if (conclusion === 'failure') failedSteps.push(name);
    }
  }
  const allJobsTerminal = jobs.length > 0 && jobs.every((job) => job.status === 'completed');
  const status: ActionSnapshotStatus | null = complete && jobs.length > 0 ? (anyInProgress ? 'in_progress' : allJobsTerminal ? 'completed' : anyQueued ? 'queued' : 'in_progress') : null;
  const conclusion = complete && allJobsTerminal
    ? (failedSteps.length > 0 ? 'failure' : jobs.some((job) => job.conclusion === 'cancelled') ? 'cancelled' : 'success')
    : null;
  let percentage: number | null = null;
  if (complete && namedSteps > 0 && jobsWithSteps === jobs.length) {
    percentage = Math.floor((terminalSteps / namedSteps) * 100);
    if (!allJobsTerminal) percentage = Math.min(percentage, 99);
  }
  return { runId, status, conclusion, activeStep, percentage, complete, failedSteps };
}

export type ActionFetchFailure = 'rate_limited' | 'not_found' | 'timeout' | 'unavailable' | 'protocol';
export type ActionFetchResult = { ok: true; snapshot: NormalizedActionSnapshot } | { ok: false; failure: ActionFetchFailure };

/** Fetches the public jobs endpoint for one run, aborting after the configured timeout and paginating to exhaustion. */
export class ActionJobsClient {
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly perPage: number;
  private readonly maxPages: number;
  constructor(options: { fetch?: FetchLike; timeoutMs?: number; perPage?: number; maxPages?: number } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.perPage = Math.min(100, Math.max(1, options.perPage ?? 100));
    this.maxPages = options.maxPages ?? 20;
  }
  async fetchSnapshot(runId: string): Promise<ActionFetchResult> {
    if (!/^\d+$/.test(runId)) return { ok: false, failure: 'protocol' };
    const pages: ActionJobsPage[] = []; let fetched = 0; let total: number | null = null; let exhausted = false;
    for (let page = 1; page <= this.maxPages; page += 1) {
      const url = `https://api.github.com/repos/bryangerlach/rdgen/actions/runs/${runId}/jobs?per_page=${this.perPage}&page=${page}`;
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try { response = await this.fetch(url, { signal: controller.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'rdgen-automator' } }); }
      catch { return { ok: false, failure: 'timeout' }; }
      finally { clearTimeout(abort); }
      if (response.status === 403 || response.status === 429) return { ok: false, failure: 'rate_limited' };
      if (response.status === 404) return { ok: false, failure: 'not_found' };
      if (!response.ok) return { ok: false, failure: 'unavailable' };
      let body: unknown;
      try { body = await response.json(); }
      catch { return { ok: false, failure: 'protocol' }; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, failure: 'protocol' };
      const parsed = body as ActionJobsPage;
      pages.push(parsed);
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs.length : 0;
      fetched += jobs;
      if (typeof parsed.total_count === 'number' && total === null) total = parsed.total_count;
      if (jobs < this.perPage || (total !== null && fetched >= total)) { exhausted = true; break; }
    }
    if (!exhausted) return { ok: false, failure: 'protocol' };
    return { ok: true, snapshot: normalizeActionJobs(runId, pages, { exhausted: true }) };
  }
}

/** The snapshot persisted when a run has never been observed successfully. */
export function emptyActionSnapshot(runId: string): NormalizedActionSnapshot {
  return { runId, status: null, conclusion: null, activeStep: null, percentage: null, complete: false, failedSteps: [] };
}

/**
 * The single source-verified infrastructure step whose failure is safe to retry
 * automatically: it is deterministic provider setup, not user configuration.
 */
export const workflowInfrastructureSteps: readonly string[] = ['Install vcpkg dependencies'];

export type WorkflowFailureClassification =
  | { retryable: true }
  | { retryable: false; reason: 'rdgen_succeeded' | 'no_snapshot' | 'incomplete' | 'unrecognized' };

/** A failure may auto-retry only when RDGen failed, GitHub data is complete, and every failed step is allowlisted infrastructure. */
export function classifyWorkflowFailure(input: { rdgenFailed: boolean; snapshot?: NormalizedActionSnapshot }): WorkflowFailureClassification {
  if (!input.rdgenFailed) return { retryable: false, reason: 'rdgen_succeeded' };
  const snapshot = input.snapshot;
  if (!snapshot) return { retryable: false, reason: 'no_snapshot' };
  if (!snapshot.complete) return { retryable: false, reason: 'incomplete' };
  if (snapshot.failedSteps.length === 0 || !snapshot.failedSteps.every((step) => workflowInfrastructureSteps.includes(step))) return { retryable: false, reason: 'unrecognized' };
  return { retryable: true };
}
