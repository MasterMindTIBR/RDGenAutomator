import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { groupJobsByProfile, JobPanel, jobTelemetry } from './detail';
import type { UiJob as Job } from '@/lib/api-provider';
import { terminalJobStatuses, type ActionTelemetry, type Attempt, type JobStatus, type Platform, type Profile } from '@/lib/types';

const { mockRepository, motionState } = vi.hoisted(() => ({
  mockRepository: {
    externalLinks: vi.fn(async () => ({ statusUrl: 'https://rdgen.example/check', actionUrl: 'https://github.com/bryangerlach/rdgen/actions/runs/1' })),
    downloadUrl: (id: string) => `/download/${id}`
  },
  motionState: { reduced: false }
}));
vi.mock('@/lib/api-provider', () => ({ useData: () => ({ repository: mockRepository, data: {} }) }));
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => motionState.reduced };
});

const telemetry: ActionTelemetry = { source: 'https://github.com/bryangerlach/rdgen/actions/runs/1', observedAt: '2026-10-04T00:00:00Z', stale: false, fetchError: null, complete: true, status: 'in_progress', conclusion: null, step: 'Install vcpkg dependencies', percentage: 42 };

function attempt(number: number, actionTelemetry: ActionTelemetry | null = telemetry): Attempt {
  return { id: `attempt-${number}`, number, status: 'aguardando_rdgen' as JobStatus, actionTelemetry, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-uuid-1', profile: 'full' as Profile, platform: 'windows' as Platform, version: '1.4.9', status: 'aguardando_rdgen' as JobStatus, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', attempts: [attempt(1)], artifacts: [], requestId: 'req-1', startedAt: '2026-10-04T00:00:00Z', progress: 'Aguardando', ...overrides
  };
}

describe('jobTelemetry', () => {
  it('returns the newest attempt telemetry and null when absent', () => {
    expect(jobTelemetry(makeJob())).toEqual(telemetry);
    expect(jobTelemetry(makeJob({ attempts: [attempt(1, null)] }))).toBeNull();
  });
});

describe('groupJobsByProfile', () => {
  it('groups jobs into profile sections with the fixed platform order', () => {
    const shuffled: Job[] = [
      makeJob({ id: 'a', profile: 'full', platform: 'linux' }),
      makeJob({ id: 'b', profile: 'qs', platform: 'macos' }),
      makeJob({ id: 'c', profile: 'full', platform: 'windows' }),
      makeJob({ id: 'd', profile: 'qs', platform: 'android' }),
      makeJob({ id: 'e', profile: 'full', platform: 'windows-x86' })
    ];
    const sections = groupJobsByProfile(shuffled);
    expect(sections.map((s) => s.profile)).toEqual(['full', 'qs']);
    expect(sections[0]?.jobs.map((j) => j.platform)).toEqual(['windows', 'windows-x86', 'linux']);
    expect(sections[1]?.jobs.map((j) => j.platform)).toEqual(['android', 'macos']);
  });
});

describe('JobPanel', () => {
  it('never renders the job UUID', async () => {
    render(<JobPanel job={makeJob()} own={true} />);
    await screen.findByText('Status RDGen');
    expect(screen.queryByText(/job-uuid-1/i)).toBeNull();
    expect(screen.queryByText(/attempt-1/i)).toBeNull();
  });

  it('opens one status dialog without any external marker', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobPanel job={makeJob()} own={true} />);
    fireEvent.click(await screen.findByText('Status RDGen'));
    expect(screen.getByText('Abrir RDGen')).toBeTruthy();
    expect(screen.getByText('Abrir GitHub Actions')).toBeTruthy();
    expect(screen.queryByText(/externo/i)).toBeNull();
    fireEvent.click(screen.getByText('Abrir RDGen'));
    expect(open).toHaveBeenCalledWith('https://rdgen.example/check', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('animates active work only when motion is allowed', async () => {
    const first = render(<JobPanel job={makeJob()} own={true} />);
    await screen.findByText('Status RDGen');
    expect(screen.getByTestId('activity').className).toBe('activity-pulse');
    first.unmount();
    motionState.reduced = true;
    try {
      render(<JobPanel job={makeJob({ id: 'job-uuid-2' })} own={true} />);
      await screen.findByText('Status RDGen');
      const activity = screen.getByTestId('activity');
      expect(activity.getAttribute('data-reduced-motion')).toBe('true');
      expect(activity.className).toBe('activity-static');
    } finally { motionState.reduced = false; }
  });
});

describe('terminalJobStatuses', () => {
  it('covers every terminal state the polling stops on', () => {
    expect(['concluído', 'concluído_parcial', 'falhou', 'cancelado'].every((s) => terminalJobStatuses.includes(s as JobStatus))).toBe(true);
    expect(terminalJobStatuses).not.toContain('aguardando_rdgen');
  });
});
