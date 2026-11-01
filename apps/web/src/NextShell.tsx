import { t, currentLang, setLang, LANGS, type Lang } from "./i18n";
import { useEffect, useRef, useState } from "preact/hooks";
import * as Schema from "effect/Schema";
import { call } from "./next-api";
import ChatgptPanel from "./ChatgptPanel";
import ConnectionsPanel from "./ConnectionsPanel";
import ApprovalsPanel from "./ApprovalsPanel";
import GoalsPanel from "./GoalsPanel";
import NotificationsPanel from "./NotificationsPanel";
import { type KittyView, type ChatView, type ProviderView, type ChatDetail, type MessageView } from "@kitties/domain/entities";
import PixelCat from "./PixelCat";
import { IconPlus, IconMonitor } from "./icons";
import DesktopPanel from "./DesktopPanel";
import { cycleMode } from "./theme";
import ReplayPanel from "./ReplayPanel";
import {MemoryPanel,LibraryPanel,VaultHelpPanel,RunsPanel,JournalPanel} from "./WorkspacePanel";
import "./next.css";

type Kitty=typeof KittyView.Type;
type Chat=typeof ChatView.Type;
type Provider=typeof ProviderView.Type;
type Message=typeof MessageView.Type;
const errorText=(error:unknown)=>error instanceof Error ? error.message : t("Could not complete the operation.");

export default function NextShell() {
  const [status,setStatus]=useState(t("Connecting…"));
  const [kitties,setKitties]=useState<readonly Kitty[]>([]),[chats,setChats]=useState<readonly Chat[]>([]),[providers,setProviders]=useState<readonly Provider[]>([]);
  const [selected,setSelected]=useState("");
  const [detail,setDetail]=useState<Schema.Schema.Type<typeof ChatDetail>>();
  const [messages,setMessages]=useState<readonly Message[]>([]);
  const [text,setText]=useState(""),[error,setError]=useState(""),[sending,setSending]=useState(false);
  const [panel,setPanel]=useState<"chat"|"settings"|"kitty"|"health"|"approvals"|"library"|"vault"|"goals">(()=>{const value=new URLSearchParams(location.search).get("panel");return value==="approvals"||value==="vault"||value==="settings"?value:"chat";});
  const [desktop,setDesktop]=useState("");
  const [chatgptEnabled,setChatgptEnabled]=useState(false);
  useEffect(()=>{void call(api=>api.signin.features()).then(value=>setChatgptEnabled(value.chatgpt)).catch(()=>{});},[]);
  const [backupId,setBackupId]=useState("");
  const [editChat,setEditChat]=useState(false),[replay,setReplay]=useState(false);
  const [editing,setEditing]=useState(""),[breed,setBreed]=useState("tabby"),[color,setColor]=useState("mint");
  const [limits,setLimits]=useState({max_rounds:12,retries:2,day_tokens:0,day_actions:0});
  const editKitty=(cat?:Kitty)=>{setEditing(cat?.id??"");setBackupId(cat?.backupId??"");setName(cat?.name??"");setSoul(cat?.soul??"Eres un asistente atento y práctico. Responde en el idioma de la persona.");setProviderId(cat?.providerId??"");setBreed(cat?.breed??"tabby");setColor(cat?.color??"mint");setLimits(cat?.limits??{max_rounds:12,retries:2,day_tokens:0,day_actions:0});setPanel("kitty");};
  const [name,setName]=useState(""),[soul,setSoul]=useState("Eres un asistente atento y práctico. Responde en el idioma de la persona."),[providerId,setProviderId]=useState("");
  const [providerName,setProviderName]=useState(""),[kind,setKind]=useState<Provider["kind"]>("openai"),[model,setModel]=useState(""),[baseUrl,setBaseUrl]=useState(""),[apiKey,setApiKey]=useState("");
  const [newChat,setNewChat]=useState(false),[chatTitle,setChatTitle]=useState(""),[members,setMembers]=useState<string[]>([]);
  const retry=useRef<{messageId:string;text:string;kittyId:string} | undefined>(undefined);
  const versions=useRef(new Map<string,number>());
  const end=useRef<HTMLDivElement>(null);
  const refresh=async()=>{
    const [health,cats,threads,brains]=await Promise.all([call(api=>api.system.health()),call(api=>api.kitties.list()),call(api=>api.chats.list()),call(api=>api.providers.list())]);
    setStatus(health.ok?t("Your space is ready."):t("Reconnecting…"));setKitties(cats);setChats(threads);setProviders(brains);
  };
  const attempt=(fn:()=>Promise<unknown>)=>{setError("");void fn().catch(e=>setError(errorText(e)));};
  useEffect(()=>{void refresh().catch(()=>setStatus(t("Offline. Open the app again when you are connected.")));},[]);
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
    const payload={name,soul,...(backupId?{backupId}:{}),...(providerId?{providerId}:{}),breed,color,limits};
    if(editing){await call(api=>api.kitties.save({params:{id:editing},payload}));await refresh();return;}
    const cat=await call(api=>api.kitties.create({payload}));
    setName("");await refresh();setPanel("chat");setMembers([cat.id]);setNewChat(true);
  };
  const createChat=async()=>{
    const payload={title:chatTitle || t("A new conversation"),members};
    const chat=editChat&&selected?await call(api=>api.chats.save({params:{id:selected},payload})):await call(api=>api.chats.create({payload}));
    setEditChat(false);
    await refresh();setDetail(await call(api=>api.chats.get({params:{id:chat.id}})));setSelected(chat.id);setNewChat(false);setChatTitle("");setPanel("chat");
  };
  const send=async()=>{
    if(!selected||!detail||!text.trim()||sending)return;
    const named=text.match(/^@([^\s]+)\s/),target=named?kitties.find(cat=>cat.name.toLowerCase()===named[1]!.toLowerCase() && detail.members.includes(cat.id))?.id:detail.members[0];
    if(!target){setError(t("Choose a kitty in this conversation with @name."));return;}
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
      <div class="next-section-title"><span>{t("Your team")}</span><button aria-label={t("Create kitty")} onClick={()=>editKitty()}><IconPlus/></button></div>
      {kitties.map(cat=><div class="next-cat" key={cat.id}><PixelCat breed={cat.breed || "tabby"} color={cat.color || "mint"} size={30}/><button onClick={()=>{setMembers([cat.id]);setNewChat(true);}}>{cat.name}<small>{cat.status==="running"?t("Awake"):t("Ready to help")}</small></button><button aria-label={`Editar ${cat.name}`} onClick={()=>editKitty(cat)}>⚙</button><button aria-label={`Abrir escritorio de ${cat.name}`} onClick={()=>setDesktop(cat.id)}><IconMonitor/></button></div>)}
      {!kitties.length && <p class="next-caption">{t("Create your first kitty to get started.")}</p>}
      <div class="next-section-title"><span>{t("Conversations")}</span><button aria-label={t("New conversation")} disabled={!kitties.length} onClick={()=>{setMembers(kitties.slice(0,1).map(cat=>cat.id));setNewChat(true);}}><IconPlus/></button></div>
      <nav>{chats.map(chat=><button key={chat.id} class={selected===chat.id?"active":""} onClick={()=>{setSelected(chat.id);setPanel("chat");}}>{chat.title}</button>)}</nav>
      <div class="next-sidebar-bottom"><button onClick={()=>setPanel("settings")}>{t("Settings")}</button><button onClick={()=>setPanel("health")}>{t("Health")}</button><button onClick={()=>setPanel("approvals")}>{t("Approvals")}</button><button onClick={()=>setPanel("goals")}>{t("Goals")}</button><button onClick={()=>setPanel("library")}>{t("Library")}</button><button onClick={()=>setPanel("vault")}>{t("Help and vault")}</button><select aria-label="Language" value={currentLang()} onChange={event=>setLang(event.currentTarget.value as Lang)}>{LANGS.map(lang=><option value={lang.id}>{lang.label}</option>)}</select><button aria-label={t("Change theme")} onClick={cycleMode}>◐</button></div>
    </aside>
    <main class="next-main">
      {error&&<p class="next-error" role="alert">{error}<button onClick={()=>setError("")}>×</button></p>}
      {panel==="chat" && <>
        <header class="next-header"><h2>{detail?.title || t("A space to get things done")}</h2>{detail&&<span>{detail.members.map(id=>kitties.find(cat=>cat.id===id)?.name).filter(Boolean).join(" · ")}</span>}{detail&&<><button onClick={()=>{setEditChat(true);setChatTitle(detail.title);setMembers([...detail.members]);setNewChat(true);}}>{t("Edit conversation")}</button><button onClick={()=>setReplay(!replay)}>{t("Replay")}</button><button onClick={()=>attempt(async()=>{await call(a=>a.chats.remove({params:{id:selected}}));setSelected("");setDetail(undefined);await refresh();})}>{t("Delete conversation")}</button></>}</header>{replay&&selected&&<ReplayPanel chatId={selected}/>}
        {!selected?<div class="next-welcome"><PixelCat breed="tabby" color="mint" size={100}/><h2>{t("What shall we do today?")}</h2><p>{t("Each kitty has a personality, tools and a desktop of its own.")}</p><button class="primary" onClick={()=>editKitty()}>{t("Create a kitty")}</button></div>:<>
          <div class="next-conversation" aria-live="polite">{messages.map(message=><article key={message.id} class="next-turn"><div class="next-user"><strong>{t("You")}</strong><p>{message.payload.text}</p></div><div class="next-answer"><strong>{kitties.find(cat=>cat.id===message.payload.kittyId)?.name || "Kitty"}</strong><p>{message.answer || (message.status==="queued"?t("Queued…"):message.status==="cancelled"?t("Cancelled."):t("Thinking…"))}</p>{["queued","running"].includes(message.status)&&<button onClick={()=>attempt(()=>call(api=>api.chats.cancel({params:{id:selected},payload:{messageId:message.id}})))}>{t("Cancel")}</button>}{message.status==="completed"&&<span>{(["up","down"] as const).map(rating=><button aria-label={rating==="up"?t("Helpful"):t("Improve response")} onClick={()=>attempt(()=>call(a=>a.workspace.feedback({params:{id:selected,message:message.id},payload:{rating,note:""}})))}>{rating==="up"?"👍":"👎"}</button>)}</span>}{message.status==="running"&&<button onClick={()=>attempt(()=>call(api=>api.chats.resume({params:{id:selected},payload:{messageId:message.id}})))}>{t("Continue")}</button>}</div></article>)}<div ref={end}/></div>
          <form class="next-composer" onSubmit={e=>{e.preventDefault();attempt(send);}}><textarea aria-label={t("Message")} placeholder="Escribe una tarea. Usa @nombre en los grupos." value={text} onInput={e=>setText(e.currentTarget.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();attempt(send);}}}/><button class="primary" disabled={sending||!text.trim()}>{t("Send ↑")}</button></form>
        </>}
      </>}
      {panel==="kitty"&&<section class="next-form"><h2>{editing?t("Your companion"):t("A new companion")}</h2><p>{t("Give your kitty a name and tell it how to help.")}</p><form onSubmit={e=>{e.preventDefault();attempt(createKitty);}}><label>{t("Name")}<input required maxLength={80} value={name} onInput={e=>setName(e.currentTarget.value)}/></label><label>{t("Personality")}<textarea value={soul} onInput={e=>setSoul(e.currentTarget.value)} rows={7}/></label><label>{t("Model")}<select value={providerId} onChange={e=>setProviderId(e.currentTarget.value)}><option value="">{t("Choose later")}</option>{providers.map(p=><option value={p.id}>{p.name} · {p.model}</option>)}</select></label><label>{t("Backup kitty")}<select value={backupId} onChange={e=>setBackupId(e.currentTarget.value)}><option value="">{t("Ask me for help")}</option>{kitties.filter(cat=>cat.id!==editing).map(cat=><option value={cat.id}>{cat.name}</option>)}</select></label><div class="next-two"><label>Avatar<select value={breed} onChange={e=>setBreed(e.currentTarget.value)}>{["tabby","siamese","tuxedo","calico","black"].map(b=><option value={b}>{b}</option>)}</select></label><label>Color<select value={color} onChange={e=>setColor(e.currentTarget.value)}>{["mint","peach","lavender","blue","rose"].map(c=><option value={c}>{c}</option>)}</select></label></div><fieldset><legend>{t("Limits")}</legend>{(Object.keys(limits) as (keyof typeof limits)[]).map(key=><label>{({max_rounds:t("Rounds per turn"),retries:t("Retries"),day_tokens:t("Daily tokens (0 = unlimited)"),day_actions:t("Daily actions (0 = unlimited)")})[key]}<input type="number" min={key==="max_rounds"?1:0} max={key==="max_rounds"?100:key==="retries"?5:undefined} value={limits[key]} onInput={e=>setLimits({...limits,[key]:Number(e.currentTarget.value)})}/></label>)}</fieldset><button class="primary">{editing?t("Save kitty"):t("Create kitty")}</button></form>{editing&&<><MemoryPanel id={editing}/><JournalPanel id={editing}/><button onClick={()=>attempt(async()=>{await call(a=>a.kitties.remove({params:{id:editing}}));setEditing("");setPanel("chat");await refresh();})}>{t("Delete kitty")}</button></>}</section>}
      {panel==="settings"&&<section class="next-form"><h2>{t("Models and connections")}</h2><p>{t("Keys are encrypted. Each kitty can use a different provider.")}</p>{providers.map(p=><div class="next-provider" key={p.id}><strong>{p.name}</strong><span>{p.kind} · {p.model}</span><small>{p.hasKey?t("Key saved"):t("Key required")}</small><button onClick={()=>attempt(async()=>{await call(api=>api.providers.remove({params:{id:p.id}}));await refresh();})}>{t("Remove")}</button></div>)}<h3>{t("Add model")}</h3><form onSubmit={e=>{e.preventDefault();attempt(saveProvider);}}><label>{t("Name")}<input required value={providerName} onInput={e=>setProviderName(e.currentTarget.value)}/></label><label>{t("Provider")}<select value={kind} onChange={e=>setKind(e.currentTarget.value as Provider["kind"])}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option><option value="gemini">Gemini</option>{chatgptEnabled&&<option value="chatgpt">ChatGPT</option>}<option value="compat">{t("OpenAI compatible")}</option></select></label><label>{t("Model")}<input required value={model} onInput={e=>setModel(e.currentTarget.value)} placeholder={t("Model name")}/></label>{kind!=="chatgpt"&&<label>{t("API key")}<input required type="password" autoComplete="off" value={apiKey} onInput={e=>setApiKey(e.currentTarget.value)}/></label>}<details><summary>{t("More options")}</summary><label>{t("Provider address")}<input type="url" value={baseUrl} onInput={e=>setBaseUrl(e.currentTarget.value)} placeholder="https://…"/></label></details><button class="primary">{t("Save model")}</button></form>{chatgptEnabled&&<ChatgptPanel providers={providers}/>}<ConnectionsPanel/><NotificationsPanel/></section>}
      {panel==="approvals"&&<ApprovalsPanel kitties={kitties}/>}
      {panel==="goals"&&<GoalsPanel kitties={kitties} onChat={id=>{setSelected(id);setPanel("chat");attempt(refresh);}}/>}
      {panel==="library"&&<LibraryPanel/>}
      {panel==="vault"&&<VaultHelpPanel openDesktop={setDesktop}/>}
      {panel==="health"&&<section class="next-form"><h2>{t("Workspace health")}</h2><p>{status}</p><dl><dt>Kitties</dt><dd>{kitties.length}</dd><dt>{t("Conversations")}</dt><dd>{chats.length}</dd><dt>{t("Models")}</dt><dd>{providers.length}</dd><dt>{t("Desktops")}</dt><dd>Boat</dd></dl><button onClick={()=>attempt(refresh)}>{t("Refresh")}</button><RunsPanel/><p><a href="/cdn-cgi/access/logout">{t("Sign out")}</a></p></section>}
    </main>
    {newChat&&<div class="next-overlay"><section class="next-dialog"><button class="next-close" aria-label={t("Close")} onClick={()=>{setNewChat(false);setEditChat(false);}}>×</button><h2>{editChat?t("Edit conversation"):t("New conversation")}</h2><form onSubmit={e=>{e.preventDefault();attempt(createChat);}}><label>{t("Title")}<input value={chatTitle} onInput={e=>setChatTitle(e.currentTarget.value)}/></label><fieldset><legend>{t("Participants")}</legend>{kitties.map(cat=><label class="next-check"><input type="checkbox" checked={members.includes(cat.id)} onChange={e=>setMembers(e.currentTarget.checked?[...members,cat.id]:members.filter(id=>id!==cat.id))}/>{cat.name}</label>)}</fieldset><button class="primary" disabled={!members.length}>{t("Start")}</button></form></section></div>}
    {desktop&&<div class="next-overlay"><section class="next-desktop"><DesktopPanel id={desktop} onClose={()=>setDesktop("")}/></section></div>}
  </div>;
}
