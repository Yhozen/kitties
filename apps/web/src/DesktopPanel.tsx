import {useEffect,useState} from 'preact/hooks';
import {call} from './next-api';
import WSDesktop from './WSDesktop';
interface Desktop {state:{phase:string;generation:number;checkpoint?:{name:string;at:number};operation?:{id:string;kind:string}}|null;channel:{guestConnected:boolean;viewers:number}}
const labels:Record<string,string>={absent:'Tu escritorio está listo para crearse.',starting:'Preparando tu escritorio…',ready:'Escritorio listo',draining:'Guardando el trabajo…',archiving:'Guardando un punto de recuperación…',sleeping:'Tu escritorio está dormido.',restoring:'Recuperando tu escritorio…',deleting:'Guardando y eliminando el escritorio…',deleted:'El escritorio se ha eliminado.',attention:'El escritorio necesita atención.'};
export default function DesktopPanel({id,onClose}:{id:string;onClose:()=>void}){
 const [desktop,setDesktop]=useState<Desktop>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const refresh=()=>call(api=>api.computers.get({params:{id}})).then(value=>setDesktop(value as Desktop));
 useEffect(()=>{let active=true;const load=()=>{void call(api=>api.computers.get({params:{id}})).then(value=>{if(active)setDesktop(value as Desktop)}).catch(()=>{if(active)setError('No se pudo comprobar el escritorio.')})};load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer)}},[id]);
 const operate=async(operation:'start'|'sleep'|'restore'|'delete'|'resume')=>{
   setBusy(true);setError('');try{await call(api=>api.computers.operate({params:{id,operation},payload:{operationId:operation==='resume'&&desktop?.state?.operation?desktop.state.operation.id:crypto.randomUUID()}}));await refresh()}catch{setError('No se pudo completar la operación. Puedes reintentar.')}finally{setBusy(false)}
 };
 const state=desktop?.state,phase=state?.phase??'absent',working=!!state?.operation;
 return <section><header class="desktop-lifecycle"><strong>{labels[phase]??phase}</strong><button onClick={onClose}>Cerrar</button></header>{error&&<p role="alert" class="next-error">{error}</p>}
 {desktop?.channel.guestConnected&&phase==='ready'?<><WSDesktop id={id} onClose={onClose}/><footer class="desktop-lifecycle"><button disabled={busy||working} onClick={()=>void operate('sleep')}>Dormir y guardar</button></footer></>:<div class="next-welcome"><p>{labels[phase]??'Comprobando el escritorio…'}</p>{!working&&['absent','sleeping','deleted'].includes(phase)&&<button class="primary" disabled={busy} onClick={()=>void operate('start')}>{phase==='sleeping'?'Despertar':'Crear escritorio'}</button>}{working&&<button disabled={busy} onClick={()=>void operate('resume')}>Reintentar preparación</button>}</div>}
 {state?.checkpoint&&<footer class="desktop-lifecycle"><span>Última recuperación: {new Date(state.checkpoint.at).toLocaleString()}</span>{phase==='sleeping'&&<button disabled={busy||working} onClick={()=>void operate('restore')}>Recuperar en un nuevo escritorio</button>}</footer>}
 </section>
}
