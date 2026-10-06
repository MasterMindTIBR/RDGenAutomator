import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ArrowUpRight, ChevronDown, Clock, Download, ExternalLink, RotateCcw, ShieldAlert, XCircle } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useData, type UiJob as Job } from '@/lib/api-provider';
import { platformLabel, platforms, terminalJobStatuses, type ActionTelemetry, type Platform, type Profile } from '@/lib/types';
import { confirmSwal } from '@/lib/swal';
import { Checkbox, Dialog, Empty, Page, SectionHeading, Status, Tag, prettyDate, profileName } from './shared';

const platformOrder: Platform[] = [...platforms];

/** The newest attempt carrying GitHub telemetry is the source of truth for progress. */
export function jobTelemetry(job: Job): ActionTelemetry | null {
  for (const attempt of job.attempts) if (attempt.actionTelemetry) return attempt.actionTelemetry;
  return null;
}

/** Human-readable artifact size; real builds are tens of MB, seeded fixtures may be tiny. */
export function artifactBytes(bytes: number): string { return bytes >= 10485760 ? `${(bytes / 1048576).toFixed(0)} MB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

/** Compact elapsed time for the card meta row: 4h, 2d, or a date for anything older. */
export function shortAgo(value: string): string { const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000); if (minutes < 1) return 'agora'; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; const days = Math.floor(hours / 24); if (days < 7) return `${days}d`; return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }); }

/** Jobs grouped into ordered profile sections with platforms in fixed product order. */
export function groupJobsByProfile(jobs: Job[]): Array<{ profile: Profile; jobs: Job[] }> {
  const order: Profile[] = ['full', 'qs'];
  return order
    .filter((profile) => jobs.some((job) => job.profile === profile))
    .map((profile) => ({ profile, jobs: jobs.filter((job) => job.profile === profile).sort((a, b) => platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform)) }));
}

function StatusDialog({ statusUrl, actionUrl, onClose }: { statusUrl: string | undefined; actionUrl: string | undefined; onClose: () => void }) {
  const open = (url?: string) => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); };
  return <Dialog title="Status do build" onClose={onClose}>
    <p className="dialog-description">Escolha onde acompanhar este build.</p>
    <div className="status-dialog-actions">
      {statusUrl && <Button variant="outline" onClick={() => open(statusUrl)}><ExternalLink size={16} /> Abrir RDGen</Button>}
      {actionUrl && <Button variant="outline" onClick={() => open(actionUrl)}><ArrowUpRight size={16} /> Abrir GitHub Actions</Button>}
    </div>
  </Dialog>;
}

function TelemetryZone({ telemetry, fallback }: { telemetry: ActionTelemetry | null; fallback: string }) {
  if (!telemetry) return <div className="progress-info"><small>PROGRESSO DO RDGEN</small><p>{fallback}</p></div>;
  const pct = telemetry.percentage ?? 0;
  return <div className="telemetry-zone" data-testid="telemetry">
    <div className="telemetry-head"><small>GITHUB ACTIONS</small>{telemetry.stale && <span className="stale-badge">dados desatualizados</span>}</div>
    <div className="telemetry-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
    <div className="telemetry-meta">
      <span>{telemetry.step ?? (telemetry.complete ? 'Concluído' : 'Aguardando dados do GitHub')}</span>
      {telemetry.percentage !== null && <strong>{telemetry.percentage}%</strong>}
    </div>
  </div>;
}

export function JobPanel({ job, own }: { job: Job; own: boolean }) {
  const { repository } = useData();
  const reduceMotion = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [statusOpen, setStatusOpen] = useState(false);
  const [links, setLinks] = useState<{ statusUrl?: string; actionUrl?: string }>({});
  const retry = ['falhou', 'aguardando_retry', 'início_indeterminado', 'concluído_parcial'].includes(job.status);
  const cancel = ['rascunho', 'enfileirado', 'iniciando', 'aguardando_rdgen'].includes(job.status);
  const active = !terminalJobStatuses.includes(job.status);
  const telemetry = jobTelemetry(job);
  useEffect(() => { if (own) void repository.externalLinks(job.id).then(setLinks).catch(() => undefined); }, [own, job.id, repository]);
  async function action(type: 'reconcile' | 'retry' | 'cancel') { const messages = { reconcile: 'Reconciliar este build com o serviço externo?', retry: 'Reenviar este job? Se o início anterior não foi confirmado, isso pode duplicar um build externo.', cancel: 'Cancelar este job?' }; if (!(await confirmSwal(messages[type]))) return; setBusy(true); try { await repository.jobAction(job.id, type, type === 'reconcile' ? { uuid: job.id, filename: `artifact-${job.id}`, platform: job.platform } : type === 'retry' ? { riskConfirmed: true } : undefined); toast.success(type === 'reconcile' ? 'Reconciliação registrada' : type === 'retry' ? 'Nova tentativa enfileirada' : 'Job cancelado'); } finally { setBusy(false); } }
  return <article className="job-panel"><div className="job-top"><div className="job-title"><div className="job-icon">{job.profile === 'full' ? 'F' : 'Q'}</div><div><div className="job-title-line"><h3>{platformLabel[job.platform]}</h3><Tag>v{job.version}</Tag></div><small>Criado {prettyDate(job.createdAt)}</small></div></div><div className="job-status-cell"><Status status={job.status} />{active && <span className={reduceMotion ? 'activity-static' : 'activity-pulse'} data-reduced-motion={String(reduceMotion)} data-testid="activity" aria-hidden />}</div></div><div className="job-body"><TelemetryZone telemetry={telemetry} fallback={job.progress} /><div className="job-meta"><div><small>TENTATIVA ATUAL</small><strong>#{job.attempts[0]?.number || 1}</strong></div><div><small>ATUALIZADO</small><strong className="updated-short" title={new Date(job.updatedAt).toLocaleString('pt-BR')}><Clock size={12} /> {shortAgo(job.updatedAt)}</strong></div></div></div>{job.status === 'início_indeterminado' && <div className="warning-strip"><ShieldAlert size={17} /> O início do build não foi confirmado. Reconcilie antes de tentar novamente para evitar duplicação externa.</div>}{job.artifacts.length > 0 && <div className="artifacts"><div className="mini-heading">ARTEFATOS DISPONÍVEIS {job.status === 'concluído_parcial' && <span>· resultado parcial</span>}</div>{job.artifacts.map((artifact) => <div className="artifact" key={artifact.id}><div><strong>{artifact.fileName}</strong><small>{artifactBytes(artifact.sizeBytes)}</small></div><Button variant="outline" size="sm" asChild><a href={repository.downloadUrl(artifact.id)} aria-label={`Baixar ${artifact.fileName}`} title={`Baixar ${artifact.fileName}`}><Download size={15} /></a></Button></div>)}</div>}
    <div className="job-footer"><Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}><ChevronDown size={15} className={open ? 'rotate-180' : ''} /> Histórico de tentativas ({job.attempts.length})</Button><div className="job-actions">{own && (links.statusUrl || links.actionUrl) && <Button variant="ghost" size="sm" onClick={() => setStatusOpen(true)}><ExternalLink /> Status RDGen</Button>}{own && job.status === 'início_indeterminado' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void action('reconcile')}><RotateCcw /> Reconciliar</Button>}{own && retry && <Button variant="outline" size="sm" disabled={busy} onClick={() => void action('retry')}><RotateCcw /> Retry manual</Button>}{own && cancel && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action('cancel')}><XCircle /> Cancelar</Button>}</div></div>{open && <div className="attempts">{[...job.attempts].reverse().map((attempt) => <div className="attempt" key={attempt.id}><div className="attempt-marker" /><strong>Tentativa #{attempt.number}</strong><Status status={attempt.status} /><span>{attempt.stage || attempt.errorCode || '—'}</span>{attempt.actionTelemetry && <span className="attempt-telemetry">{attempt.actionTelemetry.step ?? '—'} · {attempt.actionTelemetry.percentage ?? '—'}%</span>}<small>{prettyDate(attempt.createdAt)} · atualizado {prettyDate(attempt.updatedAt)}</small></div>)}</div>}{statusOpen && <StatusDialog statusUrl={links.statusUrl} actionUrl={links.actionUrl} onClose={() => setStatusOpen(false)} />}</article>;
}

export function RequestDetail() {
  const { id } = useParams({ from: '/requests/$id' });
  const { data, currentUser, repository } = useData();
  const navigate = useNavigate();
  const request = data.requests.find((r) => r.id === id);
  const [busy, setBusy] = useState(false);
  const [bulkScope, setBulkScope] = useState<'all' | 'failed'>('failed');
  const [publishing, setPublishing] = useState(false);
  const [pubUsers, setPubUsers] = useState<Record<string, boolean>>({});
  const [pubGroups, setPubGroups] = useState<Record<string, boolean>>({});
  if (!request || !(currentUser?.role === 'administrator' || request.canManage === true || request.visibility === 'published')) return <Page><Empty title="Solicitação não encontrada" description="Esta solicitação não está disponível para sua conta." action={<Button asChild variant="outline"><Link to="/dashboard">Voltar</Link></Button>} /></Page>;
  const own = currentUser?.role === 'administrator' || request.canManage === true;
  const jobs = data.jobs.filter((j) => j.requestId === id);
  async function withdraw() { setBusy(true); try { await repository.visibility(id, 'private'); toast.success('Solicitação ocultada'); } finally { setBusy(false); } }
  async function publish(e: FormEvent) { e.preventDefault(); setBusy(true); try { await repository.visibility(id, 'published', { userIds: Object.keys(pubUsers).filter((k) => pubUsers[k]), groupIds: Object.keys(pubGroups).filter((k) => pubGroups[k]) }); toast.success('Solicitação publicada'); setPublishing(false); } finally { setBusy(false); } }
  async function bulk(action: 'retry' | 'reconcile') { if (!(await confirmSwal(action === 'retry' ? 'Retry em lote?' : 'Reconciliar em lote?', { text: action === 'retry' ? 'Reenviará os jobs com falha desta solicitação, podendo duplicar builds externos.' : 'Marcará os jobs com início indeterminado como falha.', danger: action === 'reconcile', confirmText: 'Confirmar' }))) return; setBusy(true); try { const result = await repository.bulkAction(id, action, bulkScope); toast.success(`${result.acted} job(s) atualizado(s).`); } finally { setBusy(false); } }
  async function cloneRequest() { setBusy(true); try { const { token } = await repository.cloneDraft(id); navigate({ to: '/new', search: { clone: token } }); } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Não foi possível clonar esta solicitação.'); } finally { setBusy(false); } }
  const sections = groupJobsByProfile(jobs);
  return <Page><div className="breadcrumb"><Link to="/dashboard">DASHBOARD</Link><span>/</span> {request.displayName.toUpperCase()}</div><div className="detail-back"><Link to="/dashboard"><ArrowLeft size={15} /> Voltar às solicitações</Link></div><SectionHeading eyebrow={`SOLICITAÇÃO / ${request.technicalName.toUpperCase()}`} title={request.displayName} description={`criada por ${data.users.find((u) => u.id === request.creatorId)?.email ?? 'usuário'} · ${prettyDate(request.createdAt)}`} action={own ? <div className="heading-buttons">{request.visibility === 'private' ? <Button variant="outline" onClick={() => setPublishing(true)}>Publicar solicitação</Button> : <Button variant="outline" disabled={busy} onClick={() => void withdraw()}>Ocultar solicitação</Button>}<Button variant="outline" disabled={busy} onClick={() => void cloneRequest()}>Clonar solicitação</Button><select value={bulkScope} onChange={e => setBulkScope(e.target.value as 'all' | 'failed')} aria-label="Escopo da ação em lote" style={{ width: 150 }}><option value="all">Todos os jobs</option><option value="failed">Apenas falhos</option></select><Button variant="outline" disabled={busy} onClick={() => void bulk('retry')}>Retry em lote</Button><Button variant="outline" disabled={busy} onClick={() => void bulk('reconcile')}>Reconciliar em lote</Button></div> : undefined} /><div className="detail-summary"><div><small>VISIBILIDADE</small><strong><span className={`visibility-dot ${request.visibility}`} />{request.visibility === 'private' ? 'Privada' : 'Publicada'}</strong></div><div><small>SERVIDOR</small><strong>{data.servers.find((s) => s.id === request.serverId)?.name || 'Indisponível'}</strong></div><div><small>PERFIS</small><strong>{request.profiles?.map(profileName).join(' + ') || '—'}</strong></div><div><small>JOBS CRIADOS</small><strong>{jobs.length.toString().padStart(2, '0')}</strong></div></div>{sections.map((section) => <section key={section.profile} className="profile-section"><div className="section-title"><div><h2>{profileName(section.profile)}</h2><span>Plataformas desta solicitação</span></div></div><div className="jobs-list">{section.jobs.map((job) => <JobPanel key={job.id} job={job} own={Boolean(own)} />)}</div></section>)}{publishing && <Dialog title="Publicar solicitação" onClose={() => setPublishing(false)}><form className="form-stack" onSubmit={publish}><div className="hint">Deixe tudo desmarcado para publicar para todos. Marque usuários ou grupos para restringir o acesso.</div><div className="form-section"><div className="section-kicker">USUÁRIOS</div><div className="toggle-grid">{data.users.filter((u) => u.status === 'active').map((u) => <Checkbox key={u.id} checked={!!pubUsers[u.id]} onChange={(checked) => setPubUsers({ ...pubUsers, [u.id]: checked })} label={u.name || u.email} className="toggle-option" />)}</div></div><div className="form-section"><div className="section-kicker">GRUPOS</div><div className="toggle-grid">{data.groups.map((g) => <Checkbox key={g.id} checked={!!pubGroups[g.id]} onChange={(checked) => setPubGroups({ ...pubGroups, [g.id]: checked })} label={g.name} className="toggle-option" />)}</div></div><div className="modal-actions"><Button variant="outline" type="button" onClick={() => setPublishing(false)}>Cancelar</Button><Button type="submit" disabled={busy}>Publicar</Button></div></form></Dialog>}</Page>;
}
