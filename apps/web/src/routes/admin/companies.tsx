import { createFileRoute } from '@tanstack/react-router';
import { Companies } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/companies')({head:()=>({meta:[{title:'Empresas — RDGen Automator'},{name:'description',content:'Gerencie empresas e seus padrões de build.'},{property:'og:title',content:'Empresas — RDGen Automator'},{property:'og:description',content:'Gerencie empresas e seus padrões de build.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Companies});
