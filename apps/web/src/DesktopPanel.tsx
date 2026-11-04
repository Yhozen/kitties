import { t } from "./i18n";
import {useEffect,useRef,useState} from 'preact/hooks';
import {call} from './next-api';
import WSDesktop from './WSDesktop';
import {waitForDesktopIdle} from './desktop-idle';
interface Desktop {state:{phase:string;generation:number;checkpoint?:{name:string;at:number};operation?:{id:string;kind:string}}|null;channel:{guestConnected:boolean;viewers:number}}
const labels:Record<string,string>={absent:t("Your desktop is ready to be created."),starting:t("Preparing your desktop…"),ready:t("Desktop ready"),draining:t("Saving your work…"),archiving:t("Saving a recovery point…"),sleeping:t("Your desktop is asleep."),restoring:t("Restoring your desktop…"),deleting:t("Saving and deleting the desktop…"),deleted:t("The desktop was deleted."),attention:t("The desktop needs attention.")};
export default function DesktopPanel({id,onClose}:{id:string;onClose:()=>void}){
 const [desktop,setDesktop]=useState<Desktop>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [viewerPaused,setViewerPaused]=useState(false);
 const operationController=useRef<AbortController|undefined>(undefined);
 useEffect(()=>()=>operationController.current?.abort(),[id]);
 const refresh=()=>call(api=>api.computers.get({params:{id}})).then(value=>setDesktop(value as Desktop));
 useEffect(()=>{let active=true;const load=()=>{void call(api=>api.computers.get({params:{id}})).then(value=>{if(active)setDesktop(value as Desktop)}).catch(()=>{if(active)setError(t("Could not check the desktop."))})};load();const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer)}},[id]);
 const operate=async(operation:'start'|'sleep'|'restore'|'delete'|'resume')=>{
   if(operationController.current)return;
   const controller=new AbortController();operationController.current=controller;
   setBusy(true);setError('');
   try{
     if(operation==='sleep'){
       // Unmounting WSDesktop releases the grant, discards queued input and closes
       // both control and video sockets, including reconnect timers.
       setViewerPaused(true);
       await waitForDesktopIdle(()=>call(api=>api.computers.get({params:{id}})).then(value=>value as Desktop),controller.signal);
     }
     controller.signal.throwIfAborted();
     await call(api=>api.computers.operate({params:{id,operation},payload:{operationId:operation==='resume'&&desktop?.state?.operation?desktop.state.operation.id:crypto.randomUUID()}}));await refresh();
   }catch{if(!controller.signal.aborted)setError(t("Could not complete the operation. You can try again."));}
   finally{operationController.current=undefined;if(!controller.signal.aborted)setBusy(false);}
 };
 const state=desktop?.state,phase=state?.phase??'absent',working=!!state?.operation;
 return <section><header class="desktop-lifecycle"><strong>{labels[phase]??phase}</strong><button onClick={onClose}>{t("Close")}</button></header>{error&&<p role="alert" class="next-error">{error}</p>}
 {desktop?.channel.guestConnected&&phase==='ready'?<>{!viewerPaused&&<WSDesktop id={id} onClose={onClose}/>}<footer class="desktop-lifecycle">{viewerPaused&&<button disabled={busy||working} onClick={()=>setViewerPaused(false)}>{t("Open desktop")}</button>}<button disabled={busy||working} onClick={()=>void operate('sleep')}>{t("Sleep and save")}</button></footer></>:<div class="next-welcome"><p>{labels[phase]??t("Checking the desktop…")}</p>{!working&&['absent','sleeping','deleted'].includes(phase)&&<button class="primary" disabled={busy} onClick={()=>{setViewerPaused(false);void operate(phase==='sleeping'?'restore':'start');}}>{phase==='sleeping'?t("Wake up"):t("Create desktop")}</button>}{working&&<button disabled={busy} onClick={()=>void operate('resume')}>{t("Retry preparation")}</button>}</div>}
 {state?.checkpoint&&<footer class="desktop-lifecycle"><span>Última recuperación: {new Date(state.checkpoint.at).toLocaleString()}</span>{phase==='sleeping'&&<button disabled={busy||working} onClick={()=>void operate('restore')}>{t("Restore to a new desktop")}</button>}</footer>}
 </section>
}
