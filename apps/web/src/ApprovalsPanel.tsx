import {useState,useEffect} from 'preact/hooks';
import type {ApprovalView} from '@kitties/domain/entities';
import RulesPanel from "./RulesPanel";
import type {KittyView} from "@kitties/domain/entities";
import {call} from './next-api';
type Approval=typeof ApprovalView.Type;
export default function ApprovalsPanel({kitties}:{kitties:readonly typeof KittyView.Type[]}){
  const [items,setItems]=useState<readonly Approval[]>([]),[error,setError]=useState('');
  const refresh=()=>call(api=>api.approvals.list()).then(setItems);
  useEffect(()=>{void refresh().catch(()=>setError('No se pudieron cargar las aprobaciones.'));const poll=setInterval(()=>void refresh().catch(()=>{}),5000);return()=>clearInterval(poll);},[]);
  const decide=async(item:Approval,approved:boolean)=>{try{await call(api=>api.approvals.decide({params:{id:item.id},payload:{approved,digest:item.digest}}));await refresh();}catch{setError('Esta aprobación ya terminó o caducó.');}};
  return <section class='next-form'><h2>Aprobaciones</h2><p>Al decidir, el kitty continúa la tarea automáticamente.</p>{error&&<p role='alert'>{error}</p>}{!items.some(item=>item.status==='pending')&&<p>No hay acciones esperando tu decisión.</p>}{items.filter(item=>item.status==='pending').map(item=><article class='next-provider' key={item.id}><strong>{item.tool}</strong><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.preview}</pre><small>Caduca {new Date(item.expiresAt).toLocaleTimeString()}</small><div><button class='primary' onClick={()=>void decide(item,true)}>Aprobar</button><button onClick={()=>void decide(item,false)}>Denegar</button></div></article>)}<RulesPanel kitties={kitties}/></section>;
}
