import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/rdgen/dashboard';
export const Route=createFileRoute('/dashboard')({head:()=>({meta:[{title:'Solicitações — RDGen Automator'},{name:'description',content:'Acompanhe solicitações e jobs de builds RustDesk.'},{property:'og:title',content:'Solicitações — RDGen Automator'},{property:'og:description',content:'Acompanhe solicitações e jobs de builds RustDesk.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Dashboard});
