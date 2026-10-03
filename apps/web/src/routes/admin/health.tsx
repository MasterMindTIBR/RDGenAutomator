import { createFileRoute } from '@tanstack/react-router';
import { Health } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/health')({head:()=>({meta:[{title:'Saúde do sistema — RDGen Automator'},{name:'description',content:'Acompanhe o estado atual dos serviços.'},{property:'og:title',content:'Saúde do sistema — RDGen Automator'},{property:'og:description',content:'Acompanhe o estado atual dos serviços.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Health});
