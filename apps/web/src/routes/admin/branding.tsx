import { createFileRoute } from '@tanstack/react-router';
import { Brandings } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/branding')({head:()=>({meta:[{title:'Branding — RDGen Automator'},{name:'description',content:'Identidades visuais de empresas para os clientes gerados.'},{property:'og:title',content:'Branding — RDGen Automator'},{property:'og:description',content:'Identidades visuais de empresas para os clientes gerados.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Brandings});
