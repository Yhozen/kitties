import RecoveryPanel from "./RecoveryPanel";
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
import PuppyAvatar, { PuppyPicker } from "./PuppyAvatar";
import { DEFAULT_BREED, DEFAULT_COAT } from "./puppies";
import { IconPlus, IconMonitor } from "./icons";
import DesktopPanel from "./DesktopPanel";
import { cycleMode } from "./theme";
import ReplayPanel from "./ReplayPanel";
import { applyChatEvent, type ChatEvent } from "./chat-events";
import {MemoryPanel,LibraryPanel,VaultHelpPanel,RunsPanel,JournalPanel} from "./WorkspacePanel";
import "./next.css";

type Kitty=typeof KittyView.Type;

type Chat=typeof ChatView.Type;

type Provider=typeof ProviderView.Type;

type Message=typeof MessageView.Type;

const errorText=(error:unknown)=>error instanceof Error ? error.message : t("Could not complete the operation.");

export default function NextShell() {
  const [version,setVersion]=useState(""),[status,setStatus]=useState(t("Connecting…"));
  const [kitties,setKitties]=useState<readonly Kitty[]>([]),[chats,setChats]=useState<readonly Chat[]>([]),[providers,setProviders]=useState<readonly Provider[]>([]);
  const [selected,setSelected]=useState("");
  const [detail,setDetail]=useState<Schema.Schema.Type<typeof ChatDetail>>();
  const [messages,setMessages]=useState<readonly Message[]>([]);
  const [text,setText]=useState(""),[error,setError]=useState(""),[sending,setSending]=useState(false);

  const [panel,setPanel]=useState<"chat"|"settings"|"kitty"|"health"|"approvals"|"library"|"vault"|"goals">(()=>{const value=new URLSearchParams(location.search).get("panel");

return value==="approvals"||value==="vault"||value==="settings"?value:"chat";});

  const [desktop,setDesktop]=useState("");
  const [chatgptEnabled,setChatgptEnabled]=useState(false);
  useEffect(()=>{void call(api=>api.signin.features()).then(value=>setChatgptEnabled(value.chatgpt)).catch(()=>{});},[]);
  const [backupId,setBackupId]=useState("");
  const [editChat,setEditChat]=useState(false),[replay,setReplay]=useState(false);
  const [editing,setEditing]=useState(""),[breed,setBreed]=useState<string>(DEFAULT_BREED),[color,setColor]=useState<string>(DEFAULT_COAT);
  const [limits,setLimits]=useState({max_rounds:12,retries:2,day_tokens:0,day_actions:0});
  const editKitty=(cat?:Kitty)=>{setEditing(cat?.id??"");setBackupId(cat?.backupId??"");setName(cat?.name??"");setSoul(cat?.soul??"Eres un asistente atento y práctico. Responde en el idioma de la persona.");setProviderId(cat?.providerId??"");setBreed(cat?.breed??DEFAULT_BREED);setColor(cat?.color??DEFAULT_COAT);setLimits(cat?.limits??{max_rounds:12,retries:2,day_tokens:0,day_actions:0});setPanel("kitty");};
  const [name,setName]=useState(""),[soul,setSoul]=useState("Eres un asistente atento y práctico. Responde en el idioma de la persona."),[providerId,setProviderId]=useState("");
  const [providerName,setProviderName]=useState(""),[kind,setKind]=useState<Provider["kind"]>("openai"),[model,setModel]=useState(""),[baseUrl,setBaseUrl]=useState(""),[apiKey,setApiKey]=useState("");
  const [newChat,setNewChat]=useState(false),[chatTitle,setChatTitle]=useState(""),[members,setMembers]=useState<string[]>([]);
  const retry=useRef<{messageId:string;text:string;kittyId:string} | undefined>(undefined);
  const selection=useRef("");
  const [loadingEarlier,setLoadingEarlier]=useState(false);
  const skipScroll=useRef(false);
  const end=useRef<HTMLDivElement>(null);

  const refresh=async()=>{
    const [health,cats,threads,brains]=await Promise.all([call(api=>api.system.health()),call(api=>api.kitties.list()),call(api=>api.chats.list()),call(api=>api.providers.list())]);
    setVersion(health.version);setStatus(health.ok?t("Your space is ready."):t("Reconnecting…"));setKitties(cats);setChats(threads);setProviders(brains);
  };

  const attempt=(fn:()=>Promise<unknown>)=>{setError("");void fn().catch(e=>setError(errorText(e)));};

  useEffect(()=>{void refresh().catch(()=>setStatus(t("Offline. Open the app again when you are connected.")));},[]);
  useEffect(()=>{
    selection.current=selected;setDetail(undefined);setMessages([]);setLoadingEarlier(false);

    if(!selected)return;
    let active=true,events:EventSource|undefined;
    void call(api=>api.chats.get({params:{id:selected},query:{}})).then(chat=>{
      if(!active)return;setDetail(chat);setMessages(chat.messages);
      let cursor=chat.cursor;
      events=new EventSource(`/v1/chats/${selected}/events?after=${chat.cursor}`);
      events.onmessage=e=>{
        if(!active)return;
        const seq=Number(e.lastEventId);

        if(!Number.isSafeInteger(seq)||seq<=cursor)return;
        cursor=seq;
        const event=JSON.parse(e.data) as ChatEvent;
        setMessages(current=>active?applyChatEvent(current,event,selected):current);
      };
    }).catch(e=>{if(active)setError(errorText(e));});

    return()=>{active=false;events?.close();};
  },[selected]);

  const loadEarlier=async()=>{
    if(loadingEarlier||!messages.length)return;
    const id=selected;
    setLoadingEarlier(true);

    try{
      const page=await call(api=>api.chats.get({params:{id},query:{before:messages[0]!.id}}));

      if(selection.current!==id)return;
      skipScroll.current=true;
      setMessages(current=>[...page.messages.filter(m=>!current.some(value=>value.id===m.id)),...current]);
      setDetail(current=>current?.id===id?{...current,hasMore:page.hasMore}:current);
    }finally{if(selection.current===id)setLoadingEarlier(false);}
  };

  useEffect(()=>{if(skipScroll.current){skipScroll.current=false;

return;}

end.current?.scrollIntoView({behavior:"smooth",block:"end"});},[messages]);
  // A kitty cheers for a moment when one of its answers completes while you watch.
  const seen=useRef(new Map<string,string>()),cheers=useRef<ReturnType<typeof setTimeout>[]>([]),[cheering,setCheering]=useState<ReadonlySet<string>>(new Set());
  useEffect(()=>{
    const done=messages.filter(m=>m.status==="completed"&&["queued","running"].includes(seen.current.get(m.id)??"")).map(m=>m.id);

    for(const m of messages)seen.current.set(m.id,m.status);

    if(!done.length)return;
    setCheering(current=>new Set([...current,...done]));
    cheers.current.push(setTimeout(()=>setCheering(current=>new Set([...current].filter(id=>!done.includes(id)))),3000));
  },[messages]);
  useEffect(()=>()=>cheers.current.forEach(clearTimeout),[]);
  const moodOf=(kittyId:string)=>messages.some(m=>m.payload.kittyId===kittyId&&["queued","running"].includes(m.status))?"thinking":messages.some(m=>m.payload.kittyId===kittyId&&cheering.has(m.id))?"happy":"idle";

  const createKitty=async()=>{
    const payload={name,soul,...(backupId?{backupId}:{}),...(providerId?{providerId}:{}),breed,color,limits};

    if(editing){await call(api=>api.kitties.save({params:{id:editing},payload}));await refresh();

return;}

    const cat=await call(api=>api.kitties.create({payload}));
    setName("");await refresh();setPanel("chat");setMembers([cat.id]);setNewChat(true);
  };

  const createChat=async()=>{
    const payload={title:chatTitle || t("A new conversation"),members};
    const chat=editChat&&selected?await call(api=>api.chats.save({params:{id:selected},payload})):await call(api=>api.chats.create({payload}));
    setEditChat(false);
    await refresh();setDetail(await call(api=>api.chats.get({params:{id:chat.id},query:{}})));setSelected(chat.id);setNewChat(false);setChatTitle("");setPanel("chat");
  };

  const send=async()=>{
    if(!selected||!detail||!text.trim()||sending)return;
    const named=text.match(/^@([^\s]+)\s/),target=named?kitties.find(cat=>cat.name.toLowerCase()===named[1]!.toLowerCase() && detail.members.includes(cat.id))?.id:detail.members[0];

    if(!target){setError(t("Choose a puppy in this conversation with @name."));

return;}

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
      <button class="next-brand" onClick={()=>setPanel("chat")}><PuppyAvatar size={40}/><h1>Puppies</h1></button>
      <p class="next-caption" role="status">{status}</p>
      <div class="next-section-title"><span>{t("Your team")}</span><button aria-label={t("Create puppy")} onClick={()=>editKitty()}><IconPlus/></button></div>
      {kitties.map(cat=><div class="next-cat" key={cat.id}><PuppyAvatar breed={cat.breed} color={cat.color} size={34} mood={moodOf(cat.id)}/><button onClick={()=>{setMembers([cat.id]);setNewChat(true);}}>{cat.name}<small>{cat.status==="running"?t("Awake"):t("Ready to help")}</small></button><button aria-label={`Editar ${cat.name}`} onClick={()=>editKitty(cat)}>⚙</button><button aria-label={`Abrir escritorio de ${cat.name}`} onClick={()=>setDesktop(cat.id)}><IconMonitor/></button></div>)}
      {!kitties.length && <p class="next-caption">{t("Create your first puppy to get started.")}</p>}
      <div class="next-section-title"><span>{t("Conversations")}</span><button aria-label={t("New conversation")} disabled={!kitties.length} onClick={()=>{setMembers(kitties.slice(0,1).map(cat=>cat.id));setNewChat(true);}}><IconPlus/></button></div>
      <nav>{chats.map(chat=><button key={chat.id} class={selected===chat.id?"active":""} onClick={()=>{setSelected(chat.id);setPanel("chat");}}>{chat.title}</button>)}</nav>
      <div class="next-sidebar-bottom"><button onClick={()=>setPanel("settings")}>{t("Settings")}</button><button onClick={()=>setPanel("health")}>{t("Health")}</button><button onClick={()=>setPanel("approvals")}>{t("Approvals")}</button><button onClick={()=>setPanel("goals")}>{t("Goals")}</button><button onClick={()=>setPanel("library")}>{t("Library")}</button><button onClick={()=>setPanel("vault")}>{t("Help and vault")}</button><select aria-label="Language" value={currentLang()} onChange={event=>setLang(event.currentTarget.value as Lang)}>{LANGS.map(lang=><option value={lang.id}>{lang.label}</option>)}</select><button aria-label={t("Change theme")} onClick={cycleMode}>◐</button></div>
    </aside>
    <main class="next-main">
      {error&&<p class="next-error" role="alert">{error}<button onClick={()=>setError("")}>×</button></p>}
      {panel==="chat" && <>
        <header class="next-header"><h2>{detail?.title || t("A space to get things done")}</h2>{detail&&<span>{detail.members.map(id=>kitties.find(cat=>cat.id===id)?.name).filter(Boolean).join(" · ")}</span>}{detail&&<><button onClick={()=>{setEditChat(true);setChatTitle(detail.title);setMembers([...detail.members]);setNewChat(true);}}>{t("Edit conversation")}</button><button onClick={()=>setReplay(!replay)}>{t("Replay")}</button><button onClick={()=>attempt(async()=>{await call(a=>a.chats.remove({params:{id:selected}}));setSelected("");setDetail(undefined);await refresh();})}>{t("Delete conversation")}</button></>}</header>{replay&&selected&&<ReplayPanel chatId={selected}/>}
        {!selected?<div class="next-welcome"><PuppyAvatar size={140}/><h2>{t("What shall we do today?")}</h2><p>{t("Each puppy has a personality, tools and a desktop of its own.")}</p><button class="primary" onClick={()=>editKitty()}>{t("Create a puppy")}</button></div>:<>
          <div class="next-conversation" aria-live="polite">{detail?.hasMore&&<button disabled={loadingEarlier} onClick={()=>attempt(loadEarlier)}>{t("Load earlier messages")}</button>}{messages.map((message,index)=><article key={message.id} class="next-turn"><div class="next-user"><strong>{t("You")}</strong><p>{message.payload.text}</p></div><div class="next-answer"><strong>{(()=>{const cat=kitties.find(cat=>cat.id===message.payload.kittyId);const busy=["queued","running"].includes(message.status);

return <><PuppyAvatar breed={cat?.breed} color={cat?.color} size={28} still={!busy&&index<messages.length-1&&!cheering.has(message.id)} mood={busy?"thinking":cheering.has(message.id)?"happy":"idle"}/>{cat?.name || "Puppy"}</>;})()}</strong><p>{message.answer || (message.status==="queued"?t("Queued…"):message.status==="cancelled"?t("Cancelled."):t("Thinking…"))}</p>{["queued","running"].includes(message.status)&&<button onClick={()=>attempt(()=>call(api=>api.chats.cancel({params:{id:selected},payload:{messageId:message.id}})))}>{t("Cancel")}</button>}{message.status==="completed"&&<span>{(["up","down"] as const).map(rating=><button aria-label={rating==="up"?t("Helpful"):t("Improve response")} onClick={()=>attempt(()=>call(a=>a.workspace.feedback({params:{id:selected,message:message.id},payload:{rating,note:""}})))}>{rating==="up"?"👍":"👎"}</button>)}</span>}{message.status==="running"&&<button onClick={()=>attempt(()=>call(api=>api.chats.resume({params:{id:selected},payload:{messageId:message.id}})))}>{t("Continue")}</button>}</div></article>)}<div ref={end}/></div>
          <form class="next-composer" onSubmit={e=>{e.preventDefault();attempt(send);}}><textarea aria-label={t("Message")} placeholder="Escribe una tarea. Usa @nombre en los grupos." value={text} onInput={e=>setText(e.currentTarget.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();attempt(send);}}}/><button class="primary" disabled={sending||!text.trim()}>{t("Send ↑")}</button></form>
        </>}
      </>}
      {panel==="kitty"&&<section class="next-form"><h2>{editing?t("Your companion"):t("A new companion")}</h2><p>{t("Give your puppy a name and tell it how to help.")}</p><form onSubmit={e=>{e.preventDefault();attempt(createKitty);}}><label>{t("Name")}<input required maxLength={80} value={name} onInput={e=>setName(e.currentTarget.value)}/></label><label>{t("Personality")}<textarea value={soul} onInput={e=>setSoul(e.currentTarget.value)} rows={7}/></label><label>{t("Model")}<select value={providerId} onChange={e=>setProviderId(e.currentTarget.value)}><option value="">{t("Choose later")}</option>{providers.map(p=><option value={p.id}>{p.name} · {p.model}</option>)}</select></label><label>{t("Backup puppy")}<select value={backupId} onChange={e=>setBackupId(e.currentTarget.value)}><option value="">{t("Ask me for help")}</option>{kitties.filter(cat=>cat.id!==editing).map(cat=><option value={cat.id}>{cat.name}</option>)}</select></label><fieldset class="next-avatar"><legend>{t("Avatar")}</legend><PuppyPicker breed={breed} color={color} onChange={pick=>{setBreed(pick.breed);setColor(pick.color);}}/></fieldset><fieldset><legend>{t("Limits")}</legend>{(Object.keys(limits) as (keyof typeof limits)[]).map(key=><label>{({max_rounds:t("Rounds per turn"),retries:t("Retries"),day_tokens:t("Daily tokens (0 = unlimited)"),day_actions:t("Daily actions (0 = unlimited)")})[key]}<input type="number" min={key==="max_rounds"?1:0} max={key==="max_rounds"?100:key==="retries"?5:undefined} value={limits[key]} onInput={e=>setLimits({...limits,[key]:Number(e.currentTarget.value)})}/></label>)}</fieldset><button class="primary">{editing?t("Save puppy"):t("Create puppy")}</button></form>{editing&&<><MemoryPanel id={editing}/><JournalPanel id={editing}/><button onClick={()=>attempt(async()=>{await call(a=>a.kitties.remove({params:{id:editing}}));setEditing("");setPanel("chat");await refresh();})}>{t("Delete puppy")}</button></>}</section>}
      {panel==="settings"&&<section class="next-form"><h2>{t("Models and connections")}</h2><p>{t("Keys are encrypted. Each puppy can use a different provider.")}</p>{providers.map(p=><div class="next-provider" key={p.id}><strong>{p.name}</strong><span>{p.kind} · {p.model}</span><small>{p.kind==="chatgpt"?t("ChatGPT sign-in"):p.hasKey?t("Key saved"):t("Key required")}</small><button onClick={()=>attempt(async()=>{await call(api=>api.providers.remove({params:{id:p.id}}));await refresh();})}>{t("Remove")}</button></div>)}<h3>{t("Add model")}</h3><form onSubmit={e=>{e.preventDefault();attempt(saveProvider);}}><label>{t("Name")}<input required value={providerName} onInput={e=>setProviderName(e.currentTarget.value)}/></label><label>{t("Provider")}<select value={kind} onChange={e=>setKind(e.currentTarget.value as Provider["kind"])}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openrouter">OpenRouter</option><option value="gemini">Gemini</option>{chatgptEnabled&&<option value="chatgpt">ChatGPT</option>}<option value="compat">{t("OpenAI compatible")}</option></select></label><label>{t("Model")}<input required value={model} onInput={e=>setModel(e.currentTarget.value)} placeholder={t("Model name")}/></label>{kind!=="chatgpt"&&<label>{t("API key")}<input required type="password" autoComplete="off" value={apiKey} onInput={e=>setApiKey(e.currentTarget.value)}/></label>}<details><summary>{t("More options")}</summary><label>{t("Provider address")}<input type="url" value={baseUrl} onInput={e=>setBaseUrl(e.currentTarget.value)} placeholder="https://…"/></label></details><button class="primary">{t("Save model")}</button></form><ChatgptPanel/><ConnectionsPanel/><NotificationsPanel/></section>}
      {panel==="approvals"&&<ApprovalsPanel kitties={kitties}/>}
      {panel==="goals"&&<GoalsPanel kitties={kitties} onChat={id=>{setSelected(id);setPanel("chat");attempt(refresh);}}/>}
      {panel==="library"&&<LibraryPanel/>}
      {panel==="vault"&&<VaultHelpPanel openDesktop={setDesktop}/>}
      {panel==="health"&&<section class="next-form"><h2>{t("Workspace health")}</h2><p>{status}</p><p>{t("Version")}: {version}</p><dl><dt>Puppies</dt><dd>{kitties.length}</dd><dt>{t("Conversations")}</dt><dd>{chats.length}</dd><dt>{t("Models")}</dt><dd>{providers.length}</dd><dt>{t("Desktops")}</dt><dd>Boat</dd></dl><button onClick={()=>attempt(refresh)}>{t("Refresh")}</button><RunsPanel/><RecoveryPanel/><p><a href="/cdn-cgi/access/logout">{t("Sign out")}</a></p></section>}
    </main>
    {newChat&&<div class="next-overlay"><section class="next-dialog"><button class="next-close" aria-label={t("Close")} onClick={()=>{setNewChat(false);setEditChat(false);}}>×</button><h2>{editChat?t("Edit conversation"):t("New conversation")}</h2><form onSubmit={e=>{e.preventDefault();attempt(createChat);}}><label>{t("Title")}<input value={chatTitle} onInput={e=>setChatTitle(e.currentTarget.value)}/></label><fieldset><legend>{t("Participants")}</legend>{kitties.map(cat=><label class="next-check"><input type="checkbox" checked={members.includes(cat.id)} onChange={e=>setMembers(e.currentTarget.checked?[...members,cat.id]:members.filter(id=>id!==cat.id))}/>{cat.name}</label>)}</fieldset><button class="primary" disabled={!members.length}>{t("Start")}</button></form></section></div>}
    {desktop&&<div class="next-overlay"><section class="next-desktop"><DesktopPanel key={desktop} id={desktop} onClose={()=>setDesktop("")}/></section></div>}
  </div>;
}
