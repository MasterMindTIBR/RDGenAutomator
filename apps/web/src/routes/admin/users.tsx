import { createFileRoute } from '@tanstack/react-router';
import { Users } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/users')({head:()=>({meta:[{title:'Usuários — RDGen Automator'},{name:'description',content:'Gerencie contas e papéis da equipe.'},{property:'og:title',content:'Usuários — RDGen Automator'},{property:'og:description',content:'Gerencie contas e papéis da equipe.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Users});
