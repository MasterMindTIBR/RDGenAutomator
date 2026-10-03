import { createFileRoute } from '@tanstack/react-router';
import { Presets } from '@/components/rdgen/admin';
export const Route=createFileRoute('/admin/presets')({head:()=>({meta:[{title:'Presets — RDGen Automator'},{name:'description',content:'Configure presets Full e QuickSupport.'},{property:'og:title',content:'Presets — RDGen Automator'},{property:'og:description',content:'Configure presets Full e QuickSupport.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:Presets});
