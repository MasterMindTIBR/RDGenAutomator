import { createFileRoute } from '@tanstack/react-router';
import { AllRequests } from '@/components/rdgen/dashboard';
export const Route=createFileRoute('/requests/')({head:()=>({meta:[{title:'Todas as solicitações — RDGen Automator'},{name:'description',content:'Histórico completo de solicitações de build com filtros.'},{property:'og:title',content:'Todas as solicitações — RDGen Automator'},{property:'og:description',content:'Histórico completo de solicitações de build com filtros.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:AllRequests});
