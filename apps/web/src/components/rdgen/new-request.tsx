import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, ImagePlus, Info, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useData } from '@/lib/api-provider';
import { platforms as allPlatforms, platformLabel, type Images, type Profile } from '@/lib/types';
import { Page, SectionHeading, prettyDate, profileName } from './shared';
function compressImage(file: File, maxDimension = 1024): Promise<string> { const { promise, resolve, reject } = Promise.withResolvers<string>(); const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); const scale = Math.min(1, maxDimension / Math.max(img.width, img.height)); const width = Math.max(1, Math.round(img.width * scale)); const height = Math.max(1, Math.round(img.height * scale)); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); if (!ctx) { reject(new Error('Canvas unavailable')); return; } ctx.drawImage(img, 0, 0, width, height); resolve(canvas.toDataURL('image/png')); }; img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Invalid image')); }; img.src = url; return promise; }
export function ImageUpload({label,value,onChange,required=false}:{label:string;value:string|undefined;onChange:(value:string|undefined)=>void;required?:boolean}){const [error,setError]=useState('');async function upload(e:ChangeEvent<HTMLInputElement>){const file=e.target.files?.[0];if(!file)return;if(file.type!=='image/png'){setError('Selecione um arquivo PNG.');return}if(file.size>25*1024*1024){setError('Arquivo muito grande (máx. 25 MB).');return}setError('');try{onChange(await compressImage(file,1024))}catch{setError('Não foi possível processar a imagem.')}}return <div className="upload-slot"><div className="upload-preview">{value?<img src={value} alt={`Prévia: ${label}`}/>:<ImagePlus size={24}/>}</div><div><strong>{label}{required?' *':''}</strong><small>PNG · redimensionado automaticamente</small><label className="upload-link">{value?'Substituir':'Escolher arquivo'}<input type="file" accept="image/png" onChange={upload} hidden/></label>{value&&<Button variant="ghost" size="sm" onClick={()=>onChange(undefined)} aria-label={`Remover ${label}`}><X size={13}/></Button>}{error&&<span className="field-error">{error}</span>}</div></div>}
const steps = ['Identidade', 'Perfis & presets', 'Plataformas', 'Identidade visual', 'Segurança', 'Revisão'];

function PasswordInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <label className="password-label">{label}
      <div className="password-field">
        <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder="Deixe em branco para não definir" maxLength={128} />
        <Button type="button" variant="ghost" size="icon" onClick={() => setShow(x => !x)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>{show ? <EyeOff /> : <Eye />}</Button>
      </div>
    </label>
  );
}

export function NewRequest() {
  const { data, currentUser, repository } = useData();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [technicalName, setTechnicalName] = useState('');
  const [serverId, setServerId] = useState(data.servers[0]?.id || '');
  const [profiles, setProfiles] = useState<Profile[]>(['full']);
  const [presets, setPresets] = useState<Record<Profile, string | undefined>>({ full: data.presets.find(p => p.profile === 'full')?.id, qs: data.presets.find(p => p.profile === 'qs')?.id });
  const [brandingId, setBrandingId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [version, setVersion] = useState(data.releases.find(r => r !== 'nightly') || data.releases[0] || '');
  const [refreshing, setRefreshing] = useState(false);
  const [images, setImages] = useState<Images>({});
  const [password, setPassword] = useState('');
  const [separate, setSeparate] = useState(false);
  const [passwordQs, setPasswordQs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const branding = data.brandings.find(b => b.id === brandingId);
  function selectCompany(id: string) {
    setCompanyId(id);
    const company = data.companies.find(c => c.id === id);
    if (company) {
      setServerId(company.serverId);
      setBrandingId(company.brandingId || '');
      setPresets(prev => ({ full: company.presetFullId || prev.full, qs: company.presetQsId || prev.qs }));
    }
  }
  const both = profiles.length === 2;
  const jobs = profiles.length * platforms.length;

  useEffect(() => { if (step === 0 && !serverId && data.servers[0]) setServerId(data.servers[0].id); }, [data.servers, serverId, step]);
  useEffect(() => { if (!data.releases.includes(version) && data.releases[0]) setVersion(data.releases[0]); }, [data.releases, version]);
  useEffect(() => { setPresets((prev) => { let changed = false; const next = { ...prev }; for (const profile of profiles) { if (!next[profile]) { const found = data.presets.find((preset) => preset.profile === profile)?.id; if (found) { next[profile] = found; changed = true; } } } return changed ? next : prev; }); }, [data.presets, profiles]);

  async function refreshReleases() { setRefreshing(true); await repository.refreshReleases(); setRefreshing(false); toast.success('Lista de versões atualizada'); }

  function next() {
    let issue = '';
    if (step === 0 && (!displayName.trim() || !technicalName.trim() || !serverId)) issue = 'Preencha o nome exibido, nome técnico e servidor.';
    else if (step === 0 && !/^[a-z0-9][a-z0-9._-]*$/i.test(technicalName.trim())) issue = 'Use apenas letras, números, ponto, hífen ou sublinhado no nome técnico.';
    if (step === 1 && (profiles.length === 0 || profiles.some(p => !presets[p]))) issue = 'Selecione pelo menos um perfil com preset.';
    if (step === 2 && (platforms.length === 0 || !version)) issue = 'Selecione pelo menos um sistema operacional e uma versão.';
    setError(issue);
    if (!issue) { if (step === 4 && !idempotencyKey) setIdempotencyKey(globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`); setStep(s => Math.min(5, s + 1)); }
  }

  async function create() {
    if (!currentUser) return;
    setBusy(true);
    try {
      const finalImages: Images = { ...(branding?.images ?? {}), ...Object.fromEntries(Object.entries(images).filter(([, v]) => v)) };
      const id = await repository.createRequest({ displayName: displayName.trim(), technicalName: technicalName.trim(), serverId, profiles, platforms, version, ...(brandingId ? { brandingId } : {}), ...(companyId ? { companyId } : {}), images: finalImages, presetIds: Object.fromEntries(Object.entries(presets).filter(([k, v]) => v && profiles.includes(k as Profile))) as Partial<Record<Profile, string>>, password: !both || !separate ? password || undefined : undefined, profilePasswords: both && separate ? { full: password || undefined, qs: passwordQs || undefined } : undefined, idempotencyKey });
      setPassword(''); setPasswordQs('');
      toast.success(`${jobs} jobs criados`);
      navigate({ to: '/requests/$id', params: { id } });
    } finally { setBusy(false); }
  }

  const setImage = (key: keyof Images, value?: string) => setImages(prev => ({ ...prev, [key]: value }));
  const passwordSummary = !both || !separate ? (password ? 'Senha permanente definida' : 'Sem senha permanente') : `Full: ${password ? 'definida' : 'sem senha'} · QuickSupport: ${passwordQs ? 'definida' : 'sem senha'}`;

  return <Page>
    <div className="breadcrumb">WORKSPACE <span>/</span> NOVA SOLICITAÇÃO</div>
    <SectionHeading eyebrow="CONFIGURAR BUILD" title="Nova solicitação" description="Configure os clientes personalizados e revise cada combinação antes de criar." />
    <div className="wizard">
      <div className="step-rail">{steps.map((name, i) => <Button key={name} variant="ghost" className={`step-item ${i === step ? 'selected' : ''} ${i < step ? 'completed' : ''}`} onClick={() => { if (i < step) { setStep(i); setError(''); } }}><span className="step-number">{i < step ? <Check size={14} /> : String(i + 1).padStart(2, '0')}</span><span>{name}{(i === 3 || i === 4) ? <small style={{ display: 'block', opacity: .6 }}>opcional</small> : null}</span></Button>)}</div>
      <div className="wizard-main">
        <div className="wizard-top"><span>ETAPA {String(step + 1).padStart(2, '0')} / 06</span><div className="step-track"><i style={{ width: `${((step + 1) / 6) * 100}%` }} /></div></div>

        {step === 0 && <section className="wizard-section"><div className="section-kicker">01 / GERAL & SERVIDOR</div><h2>Identidade do cliente</h2><p>Defina como o aplicativo será apresentado e a qual servidor irá se conectar.</p>
          {data.companies.length > 0 && <div className="preset-choice" style={{ marginTop: 0 }}><div className="mini-heading">EMPRESA / OPCIONAL</div><select value={companyId} onChange={e => selectCompany(e.target.value)}><option value="">Nenhuma — configurar manualmente</option>{data.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Selecionar uma empresa preenche servidor, branding e presets automaticamente.</small><div className="form-divider" /></div>}
          <div className="form-grid"><label>Nome exibido *<input value={displayName} maxLength={80} placeholder="Ex.: Acme Support" onChange={e => setDisplayName(e.target.value)} /></label><label>Nome técnico do executável *<input value={technicalName} maxLength={80} placeholder="Ex.: acme-support" onChange={e => setTechnicalName(e.target.value)} /></label></div>
          <div className="form-divider" /><h3>Servidor RustDesk</h3>
          {data.servers.length === 0 ? <div className="hint"><Info size={16} /> Nenhum servidor configurado. <Link to="/admin/servers">Clique aqui para definir.</Link></div> : <div className="option-grid">{data.servers.map(s => <Button key={s.id} variant="ghost" className={`option-card ${serverId === s.id ? 'chosen' : ''}`} onClick={() => setServerId(s.id)}><span className="option-radio" /><span><strong>{s.name}</strong><small>{s.host}:{s.port}</small></span></Button>)}</div>}
        </section>}

        {step === 1 && <section className="wizard-section"><div className="section-kicker">02 / PERFIS & PRESETS</div><h2>Escolha os perfis</h2><p>Selecione Full, QuickSupport ou ambos, o preset de permissões de cada um.</p>
          <div className="profile-grid">{(['full', 'qs'] as Profile[]).map(p => <Button key={p} variant="ghost" className={`profile-card ${profiles.includes(p) ? 'chosen' : ''}`} onClick={() => setProfiles(old => old.includes(p) ? old.filter(x => x !== p) : [...old, p])}><span className="profile-letter">{p === 'full' ? 'F' : 'QS'}</span><strong>{profileName(p)}</strong><small>{p === 'full' ? 'Instalação permanente e acesso completo' : 'Suporte pontual com permissões limitadas'}</small><span className="option-radio" /></Button>)}</div>
          {profiles.map(p => { const preset = data.presets.find(x => x.id === presets[p]); const options = data.presets.filter(x => x.profile === p); return <div className="preset-choice" key={p}><div className="mini-heading">PRESET DE PERMISSÕES / {profileName(p).toUpperCase()}</div>{options.length === 0 ? <div className="hint"><Info size={16} /> Nenhum preset {profileName(p)} configurado. <Link to="/admin/presets">Clique aqui para definir.</Link></div> : <select value={presets[p] || ''} onChange={e => setPresets(prev => ({ ...prev, [p]: e.target.value }))}>{options.map(x => <option key={x.id} value={x.id}>{x.name} · v{x.version}</option>)}</select>}{preset && <div className="preset-preview"><div><span>Direção</span><strong>{preset.config.direction}</strong></div><div><span>Instalação</span><strong>{preset.config.install ? 'Habilitada' : 'Desabilitada'}</strong></div><div><span>Configurações</span><strong>{preset.config.settings ? 'Habilitadas' : 'Restritas'}</strong></div><div><span>Aprovação</span><strong>{preset.config.approval}</strong></div><div><span>Permissões</span><strong>{Object.values(preset.config.permissions).filter(Boolean).length} habilitadas</strong></div></div>}</div>; })}
        </section>}

        {step === 2 && <section className="wizard-section"><div className="section-kicker">03 / PLATAFORMA & VERSÃO</div><h2>Sistemas e versão</h2><p>Marque os sistemas operacionais e escolha a versão do RustDesk entre as releases disponíveis no RDGen.</p>
          <div className="target-grid">{allPlatforms.map(os => <label key={os} className={`target-option ${platforms.includes(os) ? 'chosen' : ''}`}><input type="checkbox" checked={platforms.includes(os)} onChange={() => setPlatforms(old => old.includes(os) ? old.filter(x => x !== os) : [...old, os])} /><span className="check-square"><Check size={13} /></span><span><strong>{platformLabel[os]}</strong></span></label>)}</div>
          <div className="form-divider" />
          <div className="form-grid"><label>Versão do RustDesk *<select value={version} onChange={e => setVersion(e.target.value)}>{data.releases.map(r => <option key={r} value={r}>{r === 'nightly' ? 'nightly (instável)' : r}</option>)}</select><small>{data.releases.length} releases · consultado {prettyDate(data.releasesCheckedAt)}</small></label><div style={{ alignSelf: 'end' }}><Button type="button" variant="outline" disabled={refreshing} onClick={refreshReleases}><RefreshCw className={refreshing ? 'animate-spin' : ''} /> Atualizar versões</Button></div></div>
          <div className="hint"><Info size={16} /> {jobs} jobs serão criados com a seleção atual.</div>
        </section>}

        {step === 3 && <section className="wizard-section"><div className="section-kicker">04 / VISUAL · OPCIONAL</div><h2>Identidade visual</h2><p>{branding ? `As imagens do branding "${branding.name}" serão usadas. Envie arquivos aqui apenas para substituí-las.` : 'Escolha um branding de empresa, envie os PNGs da marca ou continue sem eles.'}</p>
          <div className="preset-choice"><div className="mini-heading">BRANDING DA EMPRESA / OPCIONAL</div><select value={brandingId} onChange={e => setBrandingId(e.target.value)}><option value="">Nenhum — enviar imagens abaixo</option>{data.brandings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>{data.brandings.length === 0 && <div className="hint"><Info size={16} /> Nenhum branding configurado. Você pode continuar sem um ou <Link to="/admin/branding">clicar aqui para criar um agora</Link>.</div>}{branding && <div className="preset-preview"><div><span>Empresa</span><strong>{branding.company}</strong></div><div><span>Tema</span><strong>{branding.theme}</strong></div><div><span>Imagens</span><strong>{[branding.images.icon && 'Ícone', branding.images.logo && 'Logo', branding.images.privacy && 'Privacidade'].filter(Boolean).join(' · ') || 'Nenhuma'}</strong></div></div>}</div>
          <div className="uploads"><ImageUpload label="Ícone do app" value={images.icon ?? branding?.images.icon} onChange={v => setImage('icon', v)} /><ImageUpload label="Logo do app" value={images.logo ?? branding?.images.logo} onChange={v => setImage('logo', v)} /><ImageUpload label="Tela de privacidade customizada" value={images.privacy ?? branding?.images.privacy} onChange={v => setImage('privacy', v)} /></div>
        </section>}

        {step === 4 && <section className="wizard-section"><div className="section-kicker">05 / SEGURANÇA · OPCIONAL</div><h2>Senha permanente</h2><p>Opcional. Sem senha, o acesso depende do modo de aprovação do preset.</p>
          {both && <label className="toggle-option" style={{ marginBottom: 16 }}><input type="checkbox" checked={separate} onChange={e => setSeparate(e.target.checked)} />Usar senhas separadas para Full e QuickSupport</label>}
          {both && separate ? <div className="form-grid"><PasswordInput label="Senha · Full" value={password} onChange={setPassword} /><PasswordInput label="Senha · QuickSupport" value={passwordQs} onChange={setPasswordQs} /></div> : <PasswordInput label="Senha permanente" value={password} onChange={setPassword} />}
          <div className="notice"><ShieldCheck size={19} /><div><strong>Envio para o serviço de build</strong><p>A senha, a chave do servidor e os arquivos visuais serão enviados ao RDGen com segurança.</p></div></div>
        </section>}

        {step === 5 && <section className="wizard-section"><div className="section-kicker">06 / REVISÃO</div><h2>Revise antes de criar</h2><p>Uma solicitação privada com {jobs} jobs independentes será criada.</p>
          <div className="review-summary"><div><small>CLIENTE</small><strong>{displayName}</strong><span>{technicalName}</span></div><div><small>SERVIDOR</small><strong>{data.servers.find(s => s.id === serverId)?.name}</strong></div><div><small>IDENTIDADE VISUAL</small><strong>{branding ? branding.name : 'Sem branding'}</strong><span>{[(images.logo ?? branding?.images.logo) && 'Logo', (images.icon ?? branding?.images.icon) && 'Ícone', (images.privacy ?? branding?.images.privacy) && 'Privacidade'].filter(Boolean).join(' · ') || 'Sem imagens'}</span></div><div><small>SEGURANÇA</small><strong>{passwordSummary}</strong></div></div>
          <div className="mini-heading">MATRIZ DE JOBS / {jobs} BUILDS · v{version}</div>
          <div className="review-matrix">{profiles.flatMap(p => platforms.map(os => <div key={`${p}-${os}`}><span>{profileName(p)}</span><span>{os} · {version}</span><code>{technicalName}-{p}-{os.toLowerCase().replaceAll(' ', '-')}</code></div>))}</div>
          <div className="notice"><Info size={18} /><div><strong>Diferenças entre perfis</strong><p>{profiles.map(p => `${profileName(p)}: ${data.presets.find(x => x.id === presets[p])?.config.install ? 'instalação permitida' : 'sem instalação'}, ${data.presets.find(x => x.id === presets[p])?.config.approval}`).join(' · ')}. A senha não será exibida após a confirmação.</p></div></div>
        </section>}

        {error && <div role="alert" className="field-error wizard-error">{error}</div>}
        <div className="wizard-footer">{step > 0 ? <Button variant="ghost" onClick={() => { setStep(step - 1); setError(''); }}><ArrowLeft /> Voltar</Button> : <span />}{step < 5 ? <Button onClick={next}>{(step === 3 || step === 4) ? 'Continuar / pular' : 'Continuar'} <ArrowRight /></Button> : <Button disabled={busy} onClick={create}>{busy ? 'Criando...' : 'Criar solicitação'} <Plus /></Button>}</div>
      </div>
    </div>
  </Page>;
}
