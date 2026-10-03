import { createFileRoute } from '@tanstack/react-router';
import { Groups } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/groups')({head:()=>({meta:[{title:'Grupos — RDGen Automator'},{name:'description',content:'Agrupe usuários para publicar solicitações de forma seletiva.'},{property:'og:title',content:'Grupos — RDGen Automator'},{property:'og:description',content:'Agrupe usuários para publicar solicitações de forma seletiva.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Groups});
