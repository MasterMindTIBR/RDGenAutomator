import { createFileRoute } from '@tanstack/react-router';
import { Retention } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/retention')({head:()=>({meta:[{title:'Retenção e armazenamento — RDGen Automator'},{name:'description',content:'Defina períodos de retenção de arquivos.'},{property:'og:title',content:'Retenção e armazenamento — RDGen Automator'},{property:'og:description',content:'Defina períodos de retenção de arquivos.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Retention});
