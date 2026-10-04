import { useParams, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { backend } from '@/lib/api';
import { useData } from '@/lib/api-provider';
import { platformLabel } from '@/lib/types';
import { Empty, Page, SectionHeading, Tag, prettyDate, profileName } from './shared';

export function CompanyDetail() {
  const { id } = useParams({ from: '/admin/companies/$id' });
  const { repository } = useData();
  const query = useQuery({ queryKey: ['company', id], queryFn: () => backend.company(id) });
  const detail = query.data;
  return <Page><div className="breadcrumb"><Link to="/admin/companies">ADMINISTRAÇÃO</Link><span>/</span> EMPRESA</div><div className="detail-back"><Link to="/admin/companies"><ArrowLeft size={15} /> Voltar às empresas</Link></div><SectionHeading eyebrow="ADMINISTRAÇÃO / EMPRESA" title={detail?.company.name ?? 'Empresa'} description="Histórico de solicitações e artefatos da última execução de cada perfil e plataforma." /><div className="jobs-list">
    {!detail && !query.isError && <Empty title="Carregando" description="Buscando o histórico da empresa." />}
    {query.isError && <Empty title="Empresa não encontrada" description="Esta empresa não está disponível." action={<Button asChild variant="outline"><Link to="/admin/companies">Voltar</Link></Button>} />}
    {detail && detail.requests.length === 0 && <Empty title="Sem solicitações" description="Esta empresa ainda não possui solicitações." />}
    {detail && detail.requests.map((request) => <article className="job-panel" key={request.id}><div className="job-top"><div className="job-title"><div><div className="job-title-line"><h3>{request.displayName}</h3><Tag>{request.technicalName}</Tag></div><small>Criada {prettyDate(request.createdAt)}</small></div></div></div><div className="job-body">
      {request.executions.length === 0 && <div className="progress-info"><small>EXECUÇÕES</small><p>Nenhum build concluído ainda.</p></div>}
      {request.executions.map((execution) => <div className="execution" key={`${execution.profile}-${execution.platform}`}><div className="execution-head"><strong>{profileName(execution.profile)} · {platformLabel[execution.platform as keyof typeof platformLabel] ?? execution.platform}</strong><span>{execution.status === 'concluído' ? 'Concluído' : 'Concluído parcial'}</span></div>{execution.artifacts.length === 0 && <small>Nenhum artefato disponível.</small>}{execution.artifacts.map((artifact) => <div className="artifact" key={artifact.id}><div><Download size={16} /><strong>{artifact.filename ?? `artefato-${artifact.id}`}</strong><small>{(Number(artifact.bytes) / 1048576).toFixed(1)} MB · SHA-256 {artifact.sha256.slice(0, 12)}…</small></div><Button variant="outline" size="sm" asChild><a href={repository.downloadUrl(artifact.id)}><Download /> Baixar</a></Button></div>)}</div>)}
    </div></article>)}
  </div></Page>;
}
