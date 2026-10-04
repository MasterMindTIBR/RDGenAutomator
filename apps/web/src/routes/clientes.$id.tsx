import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { publicApi, ApiError } from '@/lib/api';
import { platformLabel } from '@/lib/types';
import { SkeletonRows, Empty } from '@/components/rdgen/shared';

function profileName(p: string) { return p === 'full' ? 'Full' : 'QuickSupport'; }

function PublicCompanyDetail() {
  const { id } = Route.useParams();
  const detail = useQuery({ queryKey: ['public-company', id], queryFn: () => publicApi.company(id) });
  return <div className="public-wrap"><div className="public-content">
    <div className="public-back"><Link to="/clientes"><ArrowLeft size={15} /> Voltar aos clientes</Link></div>
    {detail.isLoading ? <SkeletonRows /> : <>
      <div className="public-head">
        {detail.data?.company.hasLogo ? <img src={`/api/backend/public/companies/${id}/logo`} alt="" style={{ width: 56, height: 56, objectFit: 'contain', marginBottom: 14 }} /> : null}
        <h1>{detail.data?.company.name}</h1>
        <p>Escolha a plataforma e o perfil correspondente para baixar o cliente RustDesk.</p>
      </div>
      {(detail.data?.downloads.length ?? 0) === 0 ? <Empty title="Nenhum download disponível" description="Esta empresa ainda não tem um build pronto para download público." /> : <div className="artifacts">
        {detail.data!.downloads.map((d) => <div className="artifact" key={d.id}>
          <div><Download size={16} /><strong>{profileName(d.profile)} · {platformLabel[d.platform as keyof typeof platformLabel] ?? d.platform}</strong><small>{(d.bytes / 1048576).toFixed(1)} MB · SHA-256 {d.sha256.slice(0, 12)}…</small></div>
          <Button variant="outline" size="sm" asChild><a href={`/api/backend/public/companies/${id}/download/${d.id}`}><Download /> Baixar</a></Button>
        </div>)}
      </div>}
    </>}
  </div></div>;
}

export const Route = createFileRoute('/clientes/$id')({
  head: () => ({ meta: [{ title: 'Download do cliente — RDGen Automator' }, { name: 'description', content: 'Baixe o cliente RustDesk configurado para sua empresa.' }, { property: 'og:title', content: 'Download do cliente — RDGen Automator' }, { property: 'og:description', content: 'Baixe o cliente RustDesk configurado para sua empresa.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary' }] }),
  component: PublicCompanyDetail,
  loader: async ({ params }) => { try { await publicApi.company(params.id); } catch (error) { if (error instanceof ApiError && error.status === 404) throw notFound(); } return null; }
});
