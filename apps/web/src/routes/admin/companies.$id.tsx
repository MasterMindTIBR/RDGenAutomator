import { createFileRoute } from '@tanstack/react-router';
import { CompanyDetail } from '@/components/rdgen/company-detail';
export const Route=createFileRoute('/admin/companies/$id')({head:()=>({meta:[{title:'Downloads da empresa — RDGen Automator'},{name:'description',content:'Instaladores da última build de cada sistema.'},{property:'og:title',content:'Downloads da empresa — RDGen Automator'},{property:'og:description',content:'Instaladores da última build de cada sistema.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:CompanyDetail});
