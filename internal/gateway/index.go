package gateway

// indexHTML is the browser page: a small chat client over the API. It asks for the token once
// and keeps it in the browser's session storage.
const indexHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kitties</title>
<style>
:root{--bg:#0f0f14;--fg:#e8e8f0;--muted:#8a8aa0;--card:#1a1a24;--accent:#ff8fab;--line:#2a2a38}
@media (prefers-color-scheme:light){:root{--bg:#fafafc;--fg:#1a1a24;--muted:#66667a;--card:#fff;--accent:#d6336c;--line:#e2e2ea}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;display:grid;grid-template-columns:260px 1fr;height:100vh}
aside{border-right:1px solid var(--line);padding:16px;overflow:auto}main{display:flex;flex-direction:column;min-width:0}
h1{font-size:18px;margin:0 0 12px}h2{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 6px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.item{padding:8px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}.item:hover,.item.on{background:var(--card)}
.status{font-size:11px;color:var(--muted)}#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:720px;padding:10px 14px;border-radius:12px;background:var(--card);white-space:pre-wrap}.msg.user{align-self:flex-end;background:var(--accent);color:#fff}
.msg b{display:block;font-size:12px;color:var(--muted);margin-bottom:2px}.msg.user b{color:#ffe0ea}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--line)}input,textarea{flex:1;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit}
label{display:block;font-size:13px;margin:6px 0}.empty{color:var(--muted);padding:16px}
@media(max-width:720px){body{grid-template-columns:1fr}aside{display:none}}
</style>
</head>
<body>
<aside>
<h1>🐱 Kitties</h1>
<h2>Chats</h2><div id="chats"></div>
<button class="ghost" id="newchat">New chat</button>
<h2>Kitties</h2><div id="kitties"></div>
<button class="ghost" id="newkitty">New kitty</button>
</aside>
<main>
<div id="log"><div class="empty">Pick a chat, or start one with the kitties you want in it.</div></div>
<form id="send"><input id="text" placeholder="Say something… (@name picks who answers in a group)" autocomplete="off"><button>Send</button></form>
</main>
<script>
let token=sessionStorage.getItem('kitties.token')||'';let chat=null;
async function localToken(){try{const r=await fetch('/v1/local-token');if(r.ok){const j=await r.json();if(j.token){token=j.token;sessionStorage.setItem('kitties.token',token);}}}catch(e){}}
async function api(method,path,body){
  if(!token){await localToken();}
  if(!token){token=prompt('Gateway access token:')||'';sessionStorage.setItem('kitties.token',token);}
  const r=await fetch(path,{method,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const j=await r.json().catch(()=>({}));
  if(r.status===401){sessionStorage.removeItem('kitties.token');token='';throw new Error('wrong token');}
  if(!r.ok)throw new Error(j.error||r.statusText);return j;}
const $=s=>document.querySelector(s);
async function refresh(){
  const [k,c]=await Promise.all([api('GET','/v1/kitties'),api('GET','/v1/chats')]);
  $('#kitties').innerHTML=(k.kitties||[]).map(x=>'<div class="item"><span>'+x.name+'</span><span class="status">'+x.status+(x.desktop?' · <a href="/v1/kitties/'+x.id+'/screenshot?token='+encodeURIComponent(token)+'" target="_blank">shot</a>':'')+'</span></div>').join('')||'<div class="status">none yet</div>';
  $('#chats').innerHTML=(c.chats||[]).map(x=>'<div class="item'+(chat===x.id?' on':'')+'" data-id="'+x.id+'"><span>'+x.title+'</span><span class="status">'+x.members.length+'</span></div>').join('')||'<div class="status">none yet</div>';
  document.querySelectorAll('#chats .item').forEach(e=>e.onclick=()=>open(e.dataset.id));
}
function render(turns){const log=$('#log');log.innerHTML='';for(const t of turns){const d=document.createElement('div');d.className='msg '+(t.from==='user'?'user':'');d.innerHTML='<b>'+t.from+'</b>'+esc(t.text)+(t.calls?'<div class="status">used: '+t.calls.map(c=>c.name).join(', ')+'</div>':'');log.appendChild(d);}log.scrollTop=log.scrollHeight;}
function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function open(id){chat=id;const j=await api('GET','/v1/chats/'+id);render(j.chat.turns||[]);refresh();}
$('#send').onsubmit=async e=>{e.preventDefault();const text=$('#text').value.trim();if(!text||!chat)return;$('#text').value='';
  const j=await api('GET','/v1/chats/'+chat);render([...(j.chat.turns||[]),{from:'user',text}]);
  try{await api('POST','/v1/chats/'+chat+'/messages',{text});}catch(err){alert(err.message);}open(chat);};
$('#newchat').onclick=async()=>{const k=await api('GET','/v1/kitties');const names=(k.kitties||[]).map(x=>x.name);
  const pick=prompt('Kitties for this chat (comma separated):\n'+names.join(', '));if(!pick)return;
  try{const j=await api('POST','/v1/chats',{members:pick.split(',').map(s=>s.trim()).filter(Boolean)});open(j.chat.id);}catch(err){alert(err.message);}};
$('#newkitty').onclick=async()=>{const name=prompt('Name (lowercase, dashes):');if(!name)return;const persona=prompt('Persona (optional):')||'';
  try{await api('POST','/v1/kitties',{name,soul:{persona}});refresh();}catch(err){alert(err.message);}};
refresh().catch(err=>alert(err.message));setInterval(()=>refresh().catch(()=>{}),15000);
</script>
</body>
</html>
`
