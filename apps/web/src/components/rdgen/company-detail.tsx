import { useParams, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { backend } from '@/lib/api';
import { useData } from '@/lib/api-provider';
import { platformLabel, platforms, type Platform } from '@/lib/types';
import { artifactBytes } from './detail';
import { Empty, Page, SectionHeading } from './shared';

type ExecutionArtifact = { id: string; filename: string | null; bytes: string };
type Execution = { profile: string; platform: string; status: string; artifacts: ExecutionArtifact[] };

/** Button label: just the executable kind. Arch-only when the build has a single format (macOS, Android). */
function archRank(filename: string): number { return /x86_64/.test(filename) ? 0 : /aarch64/.test(filename) ? 1 : /armv7/.test(filename) ? 2 : 3; }
function archOf(filename: string): string { return /x86_64/.test(filename) ? 'x64' : /aarch64/.test(filename) ? 'ARM64' : /armv7/.test(filename) ? 'ARM' : ''; }
function extOf(filename: string): string { return filename.slice(filename.lastIndexOf('.') + 1).toUpperCase(); }
function variantLabels(artifacts: ExecutionArtifact[]): string[] {
  const exts = new Set(artifacts.map((artifact) => extOf(artifact.filename ?? '')));
  return artifacts.map((artifact) => {
    const file = artifact.filename ?? '';
    const arch = archOf(file);
    if (exts.size === 1) {
      if (extOf(file) === 'DMG') return arch === 'ARM64' ? 'Silicon (arm64)' : arch === 'x64' ? 'Intel (x64)' : arch || 'DMG';
      return arch || extOf(file);
    }
    return arch ? `${extOf(file)} ${arch}` : extOf(file);
  });
}

function WindowsGlyph() { return <svg viewBox="0 0 24 24" aria-hidden><path fill="#0078D4" d="M3 5.4 10.4 4.4v6.9H3zM11.4 4.2 21 3v8.3h-9.6zM3 12.3h7.4v6.9L3 18.2zM11.4 12.3H21v8.3l-9.6-1.2z" /></svg>; }
function LinuxGlyph() { return <svg viewBox="0 0 24 24" aria-hidden><ellipse cx="12" cy="14" rx="6.6" ry="8" fill="#16181d" /><ellipse cx="12" cy="8.2" rx="4" ry="3.7" fill="#16181d" /><ellipse cx="12" cy="9.3" rx="2.9" ry="2.5" fill="#fff" /><circle cx="10.9" cy="8.6" r=".55" fill="#16181d" /><circle cx="13.1" cy="8.6" r=".55" fill="#16181d" /><path d="M11 10.1h2l-1 1.5z" fill="#f5a623" /><ellipse cx="12" cy="15.6" rx="3.9" ry="4.8" fill="#fff" /><path d="M6.4 21.2l2.4-1.4M17.6 21.2l-2.4-1.4" stroke="#f5a623" strokeWidth="1.3" strokeLinecap="round" /></svg>; }
function MacGlyph() { return <svg viewBox="0 0 24 24" aria-hidden><path fill="#c8cdd3" d="M15.7 8.3c-.9-.1-1.9.4-2.5 1.2-.6.8-.8 1.8-.7 2.8 1 .1 2-.5 2.6-1.3.6-.8.8-1.8.6-2.7z" /><path fill="#c8cdd3" d="M12 11.6c.8-1 2-1.6 3.2-1.6 1.6 0 3 .9 3.7 2.3 1.3 2.3.7 5.8-1.1 8-.8 1-1.9 2-3.2 2-.6 0-1-.3-1.6-.3s-1 .3-1.6.3c-1.3 0-2.4-1-3.2-2-1.8-2.2-2.4-5.7-1.1-8 .7-1.4 2.1-2.3 3.7-2.3 1.2 0 2.4.6 3.2 1.6z" /></svg>; }
function AndroidGlyph() { return <svg viewBox="0 0 24 24" aria-hidden><path fill="#3DDC84" d="M6.5 9.8A5.5 5.5 0 0 1 17.5 9.8zM7.4 5.2 8.6 7.4M16.6 5.2 15.4 7.4" stroke="#3DDC84" strokeWidth="1.2" strokeLinecap="round" /><path fill="#3DDC84" d="M6 10.2h12a.8.8 0 0 1 .8.8v6.4a2 2 0 0 1-2 2H7.2a2 2 0 0 1-2-2V11a.8.8 0 0 1 .8-.8z" /><circle cx="9.6" cy="8.1" r=".7" fill="#0f1310" /><circle cx="14.4" cy="8.1" r=".7" fill="#0f1310" /><path d="M5.2 12.2v4M18.8 12.2v4" stroke="#3DDC84" strokeWidth="1.4" strokeLinecap="round" /></svg>; }
const glyph: Record<string, () => React.ReactElement> = { windows: WindowsGlyph, 'windows-x86': WindowsGlyph, linux: LinuxGlyph, macos: MacGlyph, android: AndroidGlyph };

export function CompanyDetail() {
  const { id } = useParams({ from: '/admin/companies/$id' });
  const { repository } = useData();
  const query = useQuery({ queryKey: ['company', id], queryFn: () => backend.company(id) });
  const detail = query.data;
  /** Latest completed execution per platform and profile: requests arrive newest first. */
  const latest = new Map<string, Execution>();
  if (detail) for (const request of detail.requests) for (const execution of request.executions) { const key = `${execution.platform}:${execution.profile}`; if (!latest.has(key)) latest.set(key, execution); }
  const present = platforms.filter((platform) => [...latest.keys()].some((key) => key.startsWith(`${platform}:`)));
  return <Page><div className="breadcrumb"><Link to="/admin/companies">ADMINISTRAÇÃO</Link><span>/</span> DOWNLOADS</div><div className="detail-back"><Link to="/admin/companies"><ArrowLeft size={15} /> Voltar às empresas</Link></div><SectionHeading eyebrow="ADMINISTRAÇÃO / DOWNLOADS" title={detail?.company.name ?? 'Empresa'} description="Instaladores da última build concluída de cada sistema." /><div className="downloads-grid">
    {!detail && !query.isError && <Empty title="Carregando" description="Buscando os builds da empresa." />}
    {query.isError && <Empty title="Empresa não encontrada" description="Esta empresa não está disponível." action={<Button asChild variant="outline"><Link to="/admin/companies">Voltar</Link></Button>} />}
    {detail && present.length === 0 && <Empty title="Sem builds concluídos" description="Os downloads aparecem quando a empresa tiver pelo menos um build concluído." />}
    {present.map((platform: Platform) => {
      const Glyph = glyph[platform] ?? WindowsGlyph;
      return <article className="download-tile" key={platform}>
        <div className="download-logo"><Glyph /></div>
        <h3>{platformLabel[platform]}</h3>
        {(['full', 'qs'] as const).map((profile) => {
          const artifacts = [...(latest.get(`${platform}:${profile}`)?.artifacts ?? [])].sort((a, b) => archRank(a.filename ?? '') - archRank(b.filename ?? ''));
          const labels = variantLabels(artifacts);
          return <div className="download-section" key={profile}>
            <div className="download-section-label"><span>{profile === 'full' ? 'FULL' : 'QS'}</span></div>
            <div className="download-actions">
              {artifacts.length === 0
                ? <small className="download-none">Sem build</small>
                : artifacts.map((artifact, index) => <Button key={artifact.id} variant="outline" size="sm" asChild><a href={repository.downloadUrl(artifact.id)} title={`${artifact.filename} · ${artifactBytes(Number(artifact.bytes))}`}><Download size={15} /> {labels[index]}</a></Button>)}
            </div>
          </div>;
        })}
      </article>;})}
  </div></Page>;
}
