import { useEffect, useRef, useState } from "preact/hooks";
import * as Schema from "effect/Schema";
import { call } from "./next-api";
import ConnectionsPanel from "./ConnectionsPanel";
import ApprovalsPanel from "./ApprovalsPanel";
import GoalsPanel from "./GoalsPanel";
import NotificationsPanel from "./NotificationsPanel";
import { type KittyView, type ChatView, type ProviderView, type ChatDetail, type MessageView } from "@kitties/domain/entities";
import PixelCat from "./PixelCat";
import { IconPlus, IconMonitor } from "./icons";
import DesktopPanel from "./DesktopPanel";
import { cycleMode } from "./theme";
import {MemoryPanel,LibraryPanel,VaultHelpPanel,RunsPanel} from "./WorkspacePanel";
import "./next.css";

type Kitty=typeof KittyView.Type;
type Chat=typeof ChatView.Type;
type Provider=typeof ProviderView.Type;
type Message=typeof MessageView.Type;
const errorText=(error:unknown)=>error instanceof Error ? error.message : "No se pudo completar la operación.";

export default function NextShell() {
  const [status,setStatus]=useState("Conectando…");
  const [kitties,setKitties]=useState<readonly Kitty[]>([]),[chats,setChats]=useState<readonly Chat[]>([]),[providers,setProviders]=useState<readonly Provider[]>([]);
  const [selected,setSelected]=useState("");
  const [detail,setDetail]=useState<Schema.Schema.Type<typeof ChatDetail>>();
  const [messages,setMessages]=useState<readonly Message[]>([]);
  const [text,setText]=useState(""),[error,setError]=useState(""),[sending,setSending]=useState(false);
  const [panel,setPanel]=useState<"chat"|"settings"|"kitty"|"health"|"approvals"|"library"|"vault"|"goals">(()=>{const value=new URLSearchParams(location.search).get("panel");return value==="approvals"||value==="vault"||value==="settings"?value:"chat";});
  const [desktop,setDesktop]=useState("");
  const [editing,setEditing]=useState(""),[breed,setBreed]=useState("tabby"),[color,setColor]=useState("mint");
  const [limits,setLimits]=useState({max_rounds:12,retries:2,day_tokens:0,day_actions:0});
  const editKitty=(cat?:Kitty)=>{setEditing(cat?.id??"");setName(cat?.name??"");setSoul(cat?.soul??"Eres un asistente atento y práctico. Responde en el idioma de la persona.");setProviderId(cat?.providerId??"");setBreed(cat?.breed??"tabby");setColor(cat?.color??"mint");setLimits(cat?.limits??{max_rounds:12,retries:2,day_tokens:0,day_actions:0});setPanel("kitty");};
  const [name,setName]=useState(""),[soul,setSoul]=useState("Eres un asistente atento y práctico. Responde en el idioma de la persona."),[providerId,setProviderId]=useState("");
  const [providerName,setProviderName]=useState(""),[kind,setKind]=useState<Provider["kind"]>("openai"),[model,setModel]=useState(""),[baseUrl,setBaseUrl]=useState(""),[apiKey,setApiKey]=useState("");
  const [newChat,setNewChat]=useState(false),[chatTitle,setChatTitle]=useState(""),[members,setMembers]=useState<string[]>([]);
  const retry=useRef<{messageId:string;text:string;kittyId:string} | undefined>(undefined);
  const versions=useRef(new Map<string,number>());
  const end=useRef<HTMLDivElement>(null);
  const refresh=async()=>{
    const [health,cats,threads,brains]=await Promise.all([call(api=>api.system.health()),call(api=>api.kitties.list()),call(api=>api.chats.list()),call(api=>api.providers.list())]);
    setStatus(health.ok?"Tu espacio está listo.":"Reconectando…");setKitties(cats);setChats(threads);setProviders(brains);
  };
  const attempt=(fn:()=>Promise<unknown>)=>{setError("");void fn().catch(e=>setError(errorText(e)));};
  useEffect(()=>{void refresh().catch(()=>setStatus("Sin conexión. Vuelve a abrir la app cuando tengas conexión."));},[]);
  useEffect(()=>{
    if(!selected)return;
    let active=true,events:EventSource|undefined;
    versions.current.clear();
    void call(api=>api.chats.get({params:{id:selected}})).then(chat=>{
      if(!active)return;setDetail(chat);setMessages(chat.messages);
      events=new EventSource(`/v1/chats/${selected}/events?after=${chat.cursor}`);
      events.onmessage=e=>{
        const event=JSON.parse(e.data);
        setMessages(current=>{
          if(event.type==="message")return current.some(m=>m.id===event.messageId)?current:[...current,{id:event.messageId,payload:{chatId:selected,messageId:event.messageId,text:event.text,kittyId:event.kittyId},status:"queued",answer:"",at:Date.now(),run_id:null}];
          if(event.type==="round_reset"){versions.current.set(event.messageId,event.attempt);return current.map(m=>m.id===event.messageId?{...m,status:"running",answer:event.prefix??""}:m);}
          if(event.type==="delta" && versions.current.get(event.messageId)===event.attempt)return current.map(m=>m.id===event.messageId?{...m,answer:m.answer+event.text}:m);
          if(["completed","cancelled","failed"].includes(event.type))return current.map(m=>m.id===event.messageId?{...m,status:event.type}:m);
          return current;
        });
      };
    }).catch(e=>setError(errorText(e)));
    return()=>{active=false;events?.close();};
  },[selected]);
  useEffect(()=>end.current?.scrollIntoView({behavior:"smooth",block:"end"}),[messages]);
  const createKitty=async()=>{
    const payload={name,soul,...(providerId?{providerId}:{}),breed,color,limits};
    if(editing){await call(api=>api.kitties.save({params:{id:editing},payload}));await refresh();return;}
    const cat=await call(api=>api.kitties.create({payload}));
    setName("");await refresh();setPanel("chat");setMembers([cat.id]);setNewChat(true);
  };
  const createChat=async()=>{
    const chat=await call(api=>api.chats.create({payload:{title:chatTitle || "Una nueva conversación",members}}));
    await refresh();setSelected(chat.id);setNewChat(false);setChatTitle("");setPanel("chat");
  };
  const send=async()=>{
    if(!selected||!detail||!text.trim()||sending)return;
    const named=text.match(/^@([^\s]+)\s/),target=named?kitties.find(cat=>cat.name.toLowerCase()===named[1]!.toLowerCase() && detail.members.includes(cat.id))?.id:detail.members[0];
    if(!target){setError("Elige un kitty de esta conversación con @nombre.");return;}
    const body=retry.current?.text===text && retry.current.kittyId===target?retry.current:{messageId:crypto.randomUUID(),text,kittyId:target};retry.current=body;
    setSending(true);
    try{await call(api=>api.chats.send({params:{id:selected},payload:body}));setText("");retry.current=undefined;}finally{setSending(false);}
  };
  const saveProvider=async()=>{
    await call(api=>api.providers.save({params:{id:crypto.randomUUID()},payload:{name:providerName,kind,model,...(baseUrl?{baseUrl}:{}),apiKey}}));
    setApiKey("");setProviderName("");setModel("");await refresh();
  };
  return <div class="next-app">
    <aside class="next-sidebar">
      <button class="next-brand" onClick={()=>setPanel("chat")}><PixelCat breed="tabby" color="mint" size={40}/><h1>Kitties</h1></button>
      <p class="next-caption" role="status">{status}</p>
      <div class="next-section-title"><span>Tu equipo</span><button aria-label="Crear kitty" onClick={()=>editKitty()}><IconPlus/></button></div>
      {kitties.map(cat=><div class="next-cat" key={cat.id}><PixelCat breed={cat.breed || "tabby"} color={cat.color || "mint"} size={30}/><button onClick={()=>{setMembers([cat.id]);setNewChat(true);}}>{cat.name}<small>{cat.status==="running"?"Despierto":"Listo para ayudarte"}</small></button><button aria-label={`Editar ${cat.name}`} onClick={()=>editKitty(cat)}>⚙</button><button aria-label={`Abrir escritorio de ${cat.name}`} onClick={()=>setDesktop(cat.id)}><IconMonitor/></button></div>)}
      {!kitties.length && <p class="next-caption">Crea tu primer kitty para empezar.</p>}
      <div class="next-section-title"><span>Conversaciones</span><button aria-label="Nueva conversación" disabled={!kitties.length} onClick={()=>{setMembers(kitties.slice(0,1).map(cat=>cat.id));setNewChat(true);}}><IconPlus/></button></div>
      <nav>{chats.map(chat=><button key={chat.id} class={selected===chat.id?"active":""} onClick={()=>{setSelected(chat.id);setPanel("chat");}}>{chat.title}</button>)}</nav>
      <div class="next-sidebar-bottom"><button onClick={()=>setPanel("settings")}>Ajustes</button><button onClick={()=>setPanel("health")}>Estado</button><button onClick={()=>setPanel("approvals")}>Aprobaciones</button><button onClick={()=>setPanel("goals")}>Objetivos</button><button onClick={()=>setPanel("library")}>Biblioteca</button><button onClick={()=>setPanel("vault")}>Ayuda y bóveda</button><button aria-label="Cambiar tema" onClick={cycleMode}>◐</button></div>
    </aside>
    <main class="next-main">
      {error&&<p class="next-error" role="alert">{error}<button onClick={()=>setError("")}>×</button></p>}
      {panel==="chat" && <>
        <header class="next-header"><h2>{detail?.title || "Un espacio para hacer cosas"}</h2>{detail&&<span>{detail.members.map(id=>kitties.find(cat=>cat.id===id)?.name).filter(Boolean).join(" · ")}</span>}</header>
        {!selected?<div class="next-welcome"><PixelCat breed="tabby" color="mint" size={100}/><h2>¿Qué hacemos hoy?</h2><p>Cada kitty tiene su personalidad, sus herramientas y su propio escritorio.</p><button class="primary" onClick={()=>editKitty()}>Crear un kitty</button></div>:<>
          <div class="next-conversation" aria-live="polite">{messages.map(message=><article key={message.id} class="next-turn"><div class="next-user"><strong>Tú</strong><p>{message.payload.text}</p></div><div class="next-answer"><strong>{kitties.find(cat=>cat.id===message.payload.kittyId)?.name || "Kitty"}</strong><p>{message.answer || (message.status==="queued"?"En cola…":message.status==="cancelled"?"Cancelado.":"Pensando…")}</p>{["queued","running"].includes(message.status)&&<button onClick={()=>attempt(()=>call(api=>api.chats.cancel({params:{id:selected},payload:{messageId:message.id}})))}>Cancelar</button>}{message.status==="completed"&&<span>{(["up","down"] as const).map(rating=><button aria-label={rating==="up"?"Me ayudó":"Mejorar respuesta"} onClick={()=>attempt(()=>call(a=>a.workspace.feedback({params:{id:selected,message:message.id},payload:{rating,note:""}})))}>{rating==="up"?"👍":"👎"}</button>)}</span>}{message.status==="running"&&<button onClick={()=>attempt(()=>call(api=>api.chats.resume({params:{id:selected},payload:{messageId:message.id}})))}>Continuar</button>}</div></article>)}<div ref={end}/></div>
          <form class="next-composer" onSubmit={e=>{e.preventDefault();attempt(send);}}><textarea aria-label="Mensaje" placeholder="Escribe una tarea. Usa @nombre en los grupos." value={text} onInput={e=>setText(e.currentTarget.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();attempt(send);}}}/><button class="primary" disabled={sending||!text.trim()}>Enviar ↑</button></form>
        </>}
      </>}
      {panel==="kitty"&&<section class="next-form"><h2>{editing?"Tu compañero":"Un nuevo compañero"}</h2><p>Dale un nombre y cuéntale cómo quieres que te ayude.</p><form onSubmit={e=>{e.preventDefault();attempt(createKitty);}}><label>Nombre<input required maxLength={80} value={name} onInput={e=>setName(e.currentTarget.value)}/></label><label>Personalidad<textarea value={soul} onInput={e=>setSoul(e.currentTarget.value)} rows={7}/></label><label>Modelo<select value={providerId} onChange={e=>setProviderId(e.currentTarget.value)}><option value="">Elegir más tarde</option>{providers.map(p=><option value={p.id}>{p.name} · {p.model}</option>)}</select></label><div class="next-two"><label>Avatar<select value={breed} onChange={e=>setBreed(e.currentTarget.value)}>{["tabby","siamese","tuxedo","calico","black"].map(b=><option value={b}>{b}</option>)}</select></label><label>Color<select value={color} onChange={e=>setColor(e.currentTarget.value)}>{["mint","peach","lavender","blue","rose"].map(c=><option value={c}>{c}</option>)}</select></label></div><fieldset><legend>Límites</legend>{(Object.keys(limits) as (keyof typeof limits)[]).map(key=><label>{({max_rounds:"Rondas por turno",retries:"Reintentos",day_tokens:"Tokens por día (0 = sin límite)",day_actions:"Acciones por día (0 = sin límite)"})[key]}<input type="number" min={key==="max_rounds"?1:0} max={key==="max_rounds"?100:key==="retries"?5:undefined} value={limits[key]} onInput={e=>setLimits({...limits,[key]:Number(e.currentTarget.value)})}/></label>)}</fieldset><button class="primary">{editing?"Guardar kitty":"Crear kitty"}</button></form>{editing&&<><MemoryPanel id={editing}/><button onClick={()=>attempt(async()=>{await call(a=>a.kitties.remove({params:{id:editing}}));setEditing("");setPanel("chat");await refresh();})}>Eliminar kitty</button></>}</section>}
      {panel==="settings"&&<section class="next-form"><h2>Modelos y conexiones</h2><p>Las claves se guardan cifradas. Puedes usar un proveedor diferente para cada kitty.</p>{providers.map(p=><div class="next-provider" key={p.id}><strong>{p.name}</strong><span>{p.kind} · {p.model}</span><small>{p.hasKey?"Clave guardada":"Falta la clave"}</small><button onClick={()=>attempt(async()=>{await call(api=>api.providers.remove({params:{id:p.id}}));await refresh();})}>Eliminar</button></div>)}<h3>Añadir modelo</h3><form onSubmit={e=>{e.preventDefault();attempt(saveProvider);}}><label>Nombre<input required value={providerName} onInput={e=>setProviderName(e.currentTarget.value)}/></label><label>Proveedor<select value={kind} onChange={e=>setKind(e.currentTarget.value as Provider["kind"])}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option><option value="gemini">Gemini</option><option value="compat">Compatible con OpenAI</option></select></label><label>Modelo<input required value={model} onInput={e=>setModel(e.currentTarget.value)} placeholder="Nombre del modelo"/></label><label>Clave API<input required type="password" autoComplete="off" value={apiKey} onInput={e=>setApiKey(e.currentTarget.value)}/></label><details><summary>Más opciones</summary><label>Dirección del proveedor<input type="url" value={baseUrl} onInput={e=>setBaseUrl(e.currentTarget.value)} placeholder="https://…"/></label></details><button class="primary">Guardar modelo</button></form><ConnectionsPanel/><NotificationsPanel/></section>}
      {panel==="approvals"&&<ApprovalsPanel kitties={kitties}/>}
      {panel==="goals"&&<GoalsPanel kitties={kitties} onChat={id=>{setSelected(id);setPanel("chat");attempt(refresh);}}/>}
      {panel==="library"&&<LibraryPanel/>}
      {panel==="vault"&&<VaultHelpPanel openDesktop={setDesktop}/>}
      {panel==="health"&&<section class="next-form"><h2>Estado del espacio</h2><p>{status}</p><dl><dt>Kitties</dt><dd>{kitties.length}</dd><dt>Conversaciones</dt><dd>{chats.length}</dd><dt>Modelos</dt><dd>{providers.length}</dd><dt>Escritorios</dt><dd>Boat</dd></dl><button onClick={()=>attempt(refresh)}>Actualizar</button><RunsPanel/><p><a href="/cdn-cgi/access/logout">Cerrar sesión</a></p></section>}
    </main>
    {newChat&&<div class="next-overlay"><section class="next-dialog"><button class="next-close" aria-label="Cerrar" onClick={()=>setNewChat(false)}>×</button><h2>Nueva conversación</h2><form onSubmit={e=>{e.preventDefault();attempt(createChat);}}><label>Título<input value={chatTitle} onInput={e=>setChatTitle(e.currentTarget.value)}/></label><fieldset><legend>Quién participa</legend>{kitties.map(cat=><label class="next-check"><input type="checkbox" checked={members.includes(cat.id)} onChange={e=>setMembers(e.currentTarget.checked?[...members,cat.id]:members.filter(id=>id!==cat.id))}/>{cat.name}</label>)}</fieldset><button class="primary" disabled={!members.length}>Empezar</button></form></section></div>}
    {desktop&&<div class="next-overlay"><section class="next-desktop"><DesktopPanel id={desktop} onClose={()=>setDesktop("")}/></section></div>}
  </div>;
}
