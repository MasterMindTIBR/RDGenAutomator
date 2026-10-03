import { createFileRoute } from '@tanstack/react-router';
import { Page } from '@/components/rdgen/shared';
export const Route=createFileRoute('/')({head:()=>({meta:[{title:'Acesso — RDGen Automator'},{name:'description',content:'Acesse o painel de builds personalizados RustDesk.'},{property:'og:title',content:'Acesso — RDGen Automator'},{property:'og:description',content:'Painel de builds personalizados RustDesk.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:()=> <Page>{null}</Page>});
