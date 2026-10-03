import { createFileRoute } from '@tanstack/react-router';
import { Servers } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/servers')({head:()=>({meta:[{title:'Servidores RustDesk — RDGen Automator'},{name:'description',content:'Gerencie servidores RustDesk cadastrados.'},{property:'og:title',content:'Servidores RustDesk — RDGen Automator'},{property:'og:description',content:'Gerencie servidores RustDesk cadastrados.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Servers});
