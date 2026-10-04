import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { publicApi } from '@/lib/api';
import { SkeletonRows, Empty } from '@/components/rdgen/shared';

function PublicCompanies() {
  const companies = useQuery({ queryKey: ['public-companies'], queryFn: publicApi.companies });
  return <div className="public-wrap"><div className="public-content">
    <div className="public-head"><div className="brand-mark"><span /></div><h1>Clientes disponíveis</h1><p>Selecione sua empresa para baixar o cliente RustDesk já configurado para o seu ambiente.</p></div>
    {companies.isLoading ? <SkeletonRows /> : (companies.data?.companies ?? []).length === 0 ? <Empty title="Nenhum cliente disponível" description="Nenhuma empresa publicou um build para download público no momento." /> : <div className="public-company-list">
      {companies.data!.companies.map((c) => <Link key={c.id} to="/clientes/$id" params={{ id: c.id }} className="public-company-row">
        {c.brandingId ? <img src={`/api/backend/public/companies/${c.id}/logo`} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <Building2 size={24} />}
        <strong>{c.name}</strong>
      </Link>)}
    </div>}
  </div></div>;
}

export const Route = createFileRoute('/clientes/')({
  head: () => ({ meta: [{ title: 'Clientes disponíveis — RDGen Automator' }, { name: 'description', content: 'Baixe o cliente RustDesk configurado para sua empresa.' }, { property: 'og:title', content: 'Clientes disponíveis — RDGen Automator' }, { property: 'og:description', content: 'Baixe o cliente RustDesk configurado para sua empresa.' }, { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary' }] }),
  component: PublicCompanies
});
