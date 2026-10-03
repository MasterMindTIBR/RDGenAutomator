/** The persisted job states are deliberately Portuguese product terms. */
export const jobStatuses = [
  'rascunho', 'enfileirado', 'iniciando', 'início_indeterminado',
  'aguardando_rdgen', 'falha_transitória', 'aguardando_retry',
  'baixando', 'validando', 'concluído', 'concluído_parcial', 'falhou', 'cancelado'
] as const;
export type JobStatus = typeof jobStatuses[number];

export const terminalJobStatuses = new Set<JobStatus>(['concluído', 'concluído_parcial', 'falhou', 'cancelado']);
const transitions: Record<JobStatus, readonly JobStatus[]> = {
  rascunho: ['enfileirado', 'cancelado'],
  enfileirado: ['iniciando', 'cancelado'],
  iniciando: ['aguardando_rdgen', 'início_indeterminado', 'falha_transitória', 'aguardando_retry', 'falhou', 'cancelado'],
  início_indeterminado: ['aguardando_rdgen', 'aguardando_retry', 'cancelado'],
  aguardando_rdgen: ['aguardando_rdgen', 'falha_transitória', 'baixando', 'falhou', 'cancelado'],
  falha_transitória: ['aguardando_retry', 'falhou', 'cancelado'],
  aguardando_retry: ['iniciando', 'cancelado'],
  baixando: ['validando', 'falhou', 'cancelado'],
  validando: ['concluído', 'concluído_parcial', 'falhou', 'cancelado'],
  concluído: [],
  concluído_parcial: [],
  falhou: [],
  cancelado: []
};

export function isJobStatus(value: string): value is JobStatus { return (jobStatuses as readonly string[]).includes(value); }
export function canTransition(from: JobStatus, to: JobStatus): boolean { return transitions[from].includes(to); }
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid job lifecycle transition: ${from} -> ${to}`);
}

export type RetryDisposition = 'transient' | 'terminal' | 'ambiguous_start';
export function retryDelayMs(attempt: number, baseMs = 30_000, maxMs = 15 * 60_000): number {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
}
