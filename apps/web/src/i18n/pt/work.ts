import type { Dictionary } from "../../i18n";

// The chat, goals, journal, limits, approvals, memory, library, sign-in and the words for people.
const dict: Dictionary = {
  // Conversation
  "The kitty's display": "A tela do kitty",
  "Open the screenshot": "Abrir a captura de tela",
  "it did not work: {error}": "não funcionou: {error}",
  "Good answer": "Boa resposta",
  "Not good": "Não ficou bom",
  "What was wrong": "O que estava errado",
  "what was wrong? (it learns from this)": "o que estava errado? (ele aprende com isso)",
  send: "enviar",
  "{name} needs your help with this one.": "{name} precisa da sua ajuda com isto.",
  steps: "passos",
  "working on its computer…": "trabalhando no computador dele…",
  "{input} → {output} tokens": "{input} → {output} tokens",
  "{input}→{output} tokens": "{input}→{output} tokens",
  "waiting for your yes: {action} ({connector})": "esperando o seu sim: {action} ({connector})",
  "skill · {name}": "habilidade · {name}",
  "No chat open": "Nenhum chat aberto",
  "Pick a chat on the left, or start one with the kitties you want in it. In a group, write @name to pick who answers.":
    "Escolha um chat à esquerda, ou comece um com os kitties que você quiser. Em um grupo, escreva @nome para escolher quem responde.",
  "Say hello to the team, or give them a task. Write @name to pick who answers.":
    "Diga oi para a equipe ou passe uma tarefa. Escreva @nome para escolher quem responde.",
  "Say hello, ask a question, or give it a task to work on.":
    "Diga oi, faça uma pergunta ou passe uma tarefa para ele.",
  "thinking…": "pensando…",
  Screenshot: "Captura de tela",

  // The desktop column
  "Hide the screenshot": "Ocultar a captura",
  "Show the screenshot": "Ver a captura",
  Desktop: "Área de trabalho",
  Chat: "Chat",
  Tasks: "Tarefas",
  "Show it on the desktop": "Ver na área de trabalho",
  "{n} steps on the desktop": "{n} passos na área de trabalho",

  "Previous screenshot": "Captura anterior",
  "Next screenshot": "Próxima captura",
  "Resize the desktop column": "Mudar a largura da coluna da área de trabalho",
  "Drag to resize; double-click to reset":
    "Arraste para mudar a largura; clique duplo para restaurar",

  "Screenshots: use the left and right arrow keys": "Capturas: use as setas esquerda e direita",

  // Steps of a desktop task
  "Opened {host}": "Abriu {host}",
  "Opened a page": "Abriu uma página",
  "Clicked on the screen": "Clicou na tela",
  "Double-clicked on the screen": "Deu um clique duplo na tela",
  "Moved the pointer": "Moveu o ponteiro",
  "Typed “{text}”": "Digitou “{text}”",
  Typed: "Digitou",
  "Pressed {key}": "Apertou {key}",
  "Scrolled up": "Rolou para cima",
  "Scrolled down": "Rolou para baixo",
  "Waited a moment": "Esperou um momento",
  "Looked at the screen": "Olhou a tela",
  "Ran a program": "Rodou um programa",
  Finished: "Terminou",
  "a key": "uma tecla",

  // Goals
  Goals: "Objetivos",
  "No goals yet: {name} only works when asked.":
    "Nenhum objetivo ainda: {name} só trabalha quando você pede.",
  file: "arquivo",
  paused: "pausado",
  "on events from {names}": "com eventos de {names}",
  "next {time}": "próxima vez: {time}",
  "{n} run": "{n} execução",
  "{n} runs": "{n} execuções",
  "run now": "executar agora",
  "open chat": "abrir chat",
  pause: "pausar",
  resume: "retomar",
  "Remove the goal": "Remover o objetivo",
  Title: "Título",
  "Triage the new issues": "Organizar as issues novas",
  "What to do (optional)": "O que fazer (opcional)",
  "Read each new issue, label it and answer the easy ones.":
    "Leia cada issue nova, coloque uma etiqueta e responda as fáceis.",
  When: "Quando",
  "cron: minute hour day month weekday (leave empty for events only)":
    "cron: minuto hora dia mês dia-da-semana (deixe vazio para usar só eventos)",
  "Also when these services report something": "Também quando estes serviços avisarem algo",
  "A service posts to /v1/hooks/<connector> with the connector's incoming events secret.":
    "Um serviço envia para /v1/hooks/<connector> com o segredo de eventos de entrada da conexão.",
  "Add goal": "Adicionar objetivo",
  "the title": "o título",
  "New goal": "Novo objetivo",
  "every 15 min": "a cada 15 min",
  hourly: "a cada hora",
  "daily at 9": "todo dia às 9",
  "weekdays at 9": "dias úteis às 9",
  "weekly (Mon)": "semanal (seg)",
  custom: "personalizado",

  // How a goal or a journal entry went
  done: "pronto",
  running: "rodando",
  blocked: "bloqueado",
  failed: "falhou",
  escalated: "escalado",
  delegated: "delegado",
  run: "execução",
  event: "evento",
  retry: "nova tentativa",
  skipped: "pulado",
  recovered: "recuperado",

  // Journal
  Journal: "Diário",
  "Nothing yet.": "Nada ainda.",
  open: "abrir",

  // Limits & backup
  "Limits & backup": "Limites e reserva",
  "How much one task may spend before {name} stops and says so, and how much it may spend in a day. Leave a box empty for the default.":
    "Quanto uma tarefa pode gastar antes de {name} parar e avisar, e quanto pode gastar em um dia. Deixe um campo vazio para usar o padrão.",
  "Tokens per task": "Tokens por tarefa",
  "Seconds per task": "Segundos por tarefa",
  "Rounds per task": "Rodadas por tarefa",
  "Retries (another way)": "Novas tentativas (de outro jeito)",
  "Tokens per day": "Tokens por dia",
  "Actions per day": "Ações por dia",
  "no limit": "sem limite",
  default: "padrão",
  "Backup (takes over a task {name} gives up on)":
    "Reserva (assume uma tarefa que {name} abandonar)",
  "nobody: ask me instead": "ninguém: pergunte para mim",
  "When it wants to publish, send or spend": "Quando quiser publicar, enviar ou gastar",
  "act on its own, as far as the account allows": "agir sozinho, até onde a conta permitir",
  "ask me first (until I trust it with that)": "me perguntar antes (até eu confiar nele para isso)",
  "Save limits": "Salvar limites",
  saved: "salvo",

  // Action limits
  "Action limits": "Limites de ações",
  "{name} does what its connections allow. Tell it in a chat (“ask me before posting”) and it adds the limit here, or add one yourself.":
    "{name} faz o que as conexões dele permitem. Diga isso em um chat (“me pergunte antes de publicar”) e ele adiciona o limite aqui, ou adicione um você mesmo.",
  remove: "remover",
  Connection: "Conexão",
  "pick one": "escolha uma",
  Action: "Ação",
  everything: "tudo",
  It: "O que faz",
  "asks me first": "me pergunta antes",
  "never does it": "nunca faz",
  "Add limit": "Adicionar limite",
  "a connection": "uma conexão",

  // Approvals
  "wants to": "quer",
  "the exact request": "o pedido exato",
  "Why not? {name} reads this and learns from it.":
    "Por que não? {name} lê isto e aprende com isso.",
  "too informal, wrong channel, not today…": "informal demais, canal errado, hoje não…",
  Back: "Voltar",
  Reject: "Recusar",
  Approve: "Aprovar",
  "From now on {name} does this without asking": "De agora em diante {name} faz isto sem perguntar",
  "Approve, don't ask again": "Aprovar e não perguntar de novo",
  "Reject…": "Recusar…",
  allowed: "permitido",
  "asks first": "pergunta antes",
  never: "nunca",
  "anything on {connector}": "qualquer coisa em {connector}",
  "{action} on {connector}": "{action} em {connector}",
  Approvals: "Aprovações",
  "Actions that reach other people or move money wait here until you say yes. A kitty you keep saying yes to earns the right to do that kind of thing alone: sooner if you are relaxed, later if you are demanding.":
    "Ações que chegam a outras pessoas ou movimentam dinheiro esperam aqui até você dizer sim. Um kitty para quem você continua dizendo sim ganha o direito de fazer esse tipo de coisa sozinho: mais cedo se você for tranquilo, mais tarde se for exigente.",
  "Waiting for you": "Esperando você",
  "Nothing is waiting.": "Nada esperando.",
  Limits: "Limites",
  Decided: "Decididas",
  approved: "aprovada",
  rejected: "recusada",
  pending: "pendente",

  // Memory
  "What {name} knows about you": "O que {name} sabe sobre você",
  "How demanding you are": "O quanto você é exigente",
  relaxed: "relaxado",
  easygoing: "tranquilo",
  balanced: "equilibrado",
  demanding: "exigente",
  strict: "rigoroso",
  "let it follow my feedback ({up} up, {down} down)":
    "deixar seguir minhas avaliações ({up} positivas, {down} negativas)",
  "On its way to acting alone": "A caminho de agir sozinho",
  "never alone for you": "nunca sozinho com você",
  "{streak} of {needs} yeses in a row": "{streak} de {needs} sins seguidos",
  Today: "Hoje",
  tokens: "tokens",
  actions: "ações",
  "of {max}": "de {max}",
  "(no limit)": "(sem limite)",
  Notes: "Notas",
  "Nothing yet. It learns from your thumbs, your yes and no, and what it notices.":
    "Nada ainda. Ele aprende com seus joinhas, seus sins e nãos, e com o que percebe.",
  user: "pessoal",
  work: "trabalho",
  "You wrote it: a consolidation never drops it": "Você escreveu: uma consolidação nunca a apaga",
  yours: "sua",
  "Forget: {note}": "Esquecer: {note}",
  "Scope of the note": "Alcance da nota",
  "about me": "sobre mim",
  "about the work": "sobre o trabalho",
  "Always answer in Spanish": "Responda sempre em português",
  "A note for it to keep": "Uma nota para ele guardar",
  "Add note": "Adicionar nota",
  "Its own brain merges the notes and the feedback into a short list":
    "O próprio cérebro dele junta as notas e as avaliações em uma lista curta",
  "Consolidate now": "Consolidar agora",
  "({n} new)": "({n} novas)",

  // Library
  Library: "Biblioteca",
  skills: "habilidades",
  artifacts: "arquivos",
  "{n} proposed": "{n} propostas",
  "Procedures the kitties read before a task and extend when they learn something. A proposal waits here until you accept it.":
    "Procedimentos que os kitties leem antes de uma tarefa e ampliam quando aprendem algo. Uma proposta espera aqui até você aceitar.",
  "built in": "incluída",
  proposed: "proposta",
  accept: "aceitar",
  "Delete {name}": "Excluir {name}",
  "Delete the skill {name}?": "Excluir a habilidade {name}?",
  Name: "Nome",
  "Document (markdown)": "Documento (markdown)",
  Document: "Documento",
  "# Title\n\nWhat it is for.\n\n1. Step": "# Título\n\nPara que serve.\n\n1. Passo",
  "the name": "o nome",
  "the document": "o documento",
  "Write a skill": "Escrever uma habilidade",
  edit: "editar",
  "Close the skill": "Fechar a habilidade",
  "Files the kitties saved for later: reports, tables, diagrams, drafts. Any kitty can read them in any chat; you can download or delete them.":
    "Arquivos que os kitties guardaram para depois: relatórios, tabelas, diagramas, rascunhos. Qualquer kitty pode ler em qualquer chat; você pode baixar ou excluir.",
  "by {name}": "de {name}",
  "{size} bytes": "{size} bytes",
  download: "baixar",
  "Delete {name}?": "Excluir {name}?",
  "Nothing saved yet. A kitty saves one with @artifact save, or a connector such as the diagram renderer does.":
    "Nada guardado ainda. Um kitty guarda um com @artifact save, ou uma conexão como o gerador de diagramas faz isso.",
  "Close the artifact": "Fechar o arquivo",

  // Signing in with a subscription
  Copied: "Copiado",
  Copy: "Copiar",
  "the sign-in failed": "não deu para entrar",
  "Claude Code is on this computer": "O Claude Code está neste computador",
  "If it is not signed in yet, run this once in a terminal and follow the browser:":
    "Se ainda não entrou, rode isto uma vez em um terminal e siga o navegador:",
  "Signed in as {who}.": "Você entrou como {who}.",
  "Signed in.": "Você entrou.",
  "Your {plan} pays for the answers.": "Seu {plan} paga as respostas.",
  "Sign out": "Sair",
  "Works with {plans}.": "Funciona com {plans}.",
  "Install Claude Code on this computer:": "Instale o Claude Code neste computador:",
  "how to install ↗": "como instalar ↗",
  "Sign it in once, in a terminal:": "Entre uma vez, em um terminal:",
  "Looking…": "Procurando…",
  "Done: find Claude Code": "Pronto: procurar o Claude Code",
  "Install gcloud:": "Instale o gcloud:",
  "Google Cloud project ID": "ID do projeto do Google Cloud",
  "leave empty to use gcloud's quota project": "deixe vazio para usar o projeto de cota do gcloud",
  "Checking…": "Verificando…",
  "Use my Google login": "Usar minha conta do Google",
  "Opening…": "Abrindo…",
  "Sign in with {service}": "Entrar com {service}",
  "Type this code on GitHub:": "Digite este código no GitHub:",
  "Open github.com ↗": "Abrir github.com ↗",
  "waiting for you…": "esperando você…",
  "Finish signing in in your browser, then come back: this changes by itself.":
    "Termine de entrar no seu navegador e volte: isto muda sozinho.",
  "Open the page again ↗": "Abrir a página de novo ↗",
  "Did the browser end on a page that does not load (localhost:1455)? Copy its whole address and paste it here:":
    "O navegador parou em uma página que não carrega (localhost:1455)? Copie o endereço inteiro dela e cole aqui:",
  "Address the browser landed on": "Endereço onde o navegador parou",
  "Use it": "Usar",

  // Providers and sign-ins
  "Claude models: careful, strong at long tasks and tools.":
    "Modelos Claude: cuidadosos, fortes em tarefas longas e com ferramentas.",
  "GPT models, the most widely used.": "Modelos GPT, os mais usados.",
  "Gemini models, with a free tier to start.": "Modelos Gemini, com um plano grátis para começar.",
  "Ollama on this computer": "Ollama neste computador",
  "Free models that run on your own machine. No key needed.":
    "Modelos grátis que rodam na sua própria máquina. Não precisa de chave.",
  "Open models, hosted by Ollama.": "Modelos abertos, hospedados pelo Ollama.",
  "One key for hundreds of models.": "Uma chave para centenas de modelos.",
  "Very fast open models.": "Modelos abertos muito rápidos.",
  "DeepSeek models, low cost.": "Modelos DeepSeek, de baixo custo.",
  "Mistral models, from Europe.": "Modelos Mistral, da Europa.",
  "Qwen models through DashScope.": "Modelos Qwen pelo DashScope.",
  "OpenAI models tuned for code.": "Modelos da OpenAI ajustados para código.",
  "The models of your Copilot plan.": "Os modelos do seu plano do Copilot.",
  "Claude subscription": "Assinatura do Claude",
  "Claude on your Pro or Max plan, through Claude Code.":
    "O Claude no seu plano Pro ou Max, pelo Claude Code.",
  "Another server": "Outro servidor",
  "Anything that speaks the OpenAI API: LM Studio, vLLM, a company gateway.":
    "Qualquer coisa que fale a API da OpenAI: LM Studio, vLLM, o gateway de uma empresa.",
  "ChatGPT plan": "Plano do ChatGPT",
  "Plus, Pro, Business or Enterprise": "Plus, Pro, Business ou Enterprise",
  "Sign in with your ChatGPT account: your plan pays for the answers, no API key or credits needed.":
    "Entre com sua conta do ChatGPT: seu plano paga as respostas, sem precisar de chave de API nem créditos.",
  "Pro or Max": "Pro ou Max",
  "Your Claude plan pays for the answers. Anthropic allows it only through its own Claude Code program: Kitties runs it for you, signed in with your account.":
    "Seu plano do Claude paga as respostas. A Anthropic só permite isso pelo próprio programa Claude Code: o Kitties roda ele para você, conectado com a sua conta.",
  "any Copilot plan, Free included": "qualquer plano do Copilot, incluindo o Free",
  "Sign in with GitHub: open the link, type the code shown here, and your Copilot plan pays for the answers.":
    "Entre com o GitHub: abra o link, digite o código mostrado aqui e seu plano do Copilot paga as respostas.",
  "Google account": "Conta do Google",
  "a Google Cloud project": "um projeto do Google Cloud",
  "Uses the Google login of the gcloud program on this computer, billed to your Cloud project.":
    "Usa o login do Google do programa gcloud neste computador, cobrado no seu projeto do Cloud.",
  "qwen.ai account": "Conta do qwen.ai",
  "Qwen ended its account sign-in on April 15, 2026. Use a DashScope (Alibaba Cloud Model Studio) API key instead.":
    "O Qwen deixou de permitir entrar com conta em 15 de abril de 2026. Use uma chave de API do DashScope (Alibaba Cloud Model Studio).",
  account: "conta",

  // Kinds of connections
  "Chat & messages": "Chat e mensagens",
  "Social media": "Redes sociais",
  "Calendar, reminders & contacts": "Agenda, lembretes e contatos",
  "Home, news & weather": "Casa, notícias e tempo",
  Music: "Música",
  Code: "Código",
  Productivity: "Produtividade",
  "Office & files": "Escritório e arquivos",
  Finance: "Finanças",
  Drawing: "Desenho",
  Other: "Outros",

  // Lists of names: "mimi and tom"
  and: "e",

  // What went wrong, said plainly
  "It needs an API key: paste one in the form.":
    "Precisa de uma chave de API: cole uma no formulário.",
  "The key was refused: check that it is complete and still valid.":
    "A chave foi recusada: confira se ela está completa e ainda é válida.",
  "The server did not answer: check the address, and that it is running.":
    "O servidor não respondeu: confira o endereço e se ele está rodando.",
  "That model name was not found at this provider: check its spelling.":
    "Esse nome de modelo não existe neste provedor: confira como está escrito.",
  "The service did not accept the key or the sign-in: connect it again in Settings, Connections.":
    "O serviço não aceitou a chave nem a entrada: conecte de novo em Configurações, Conexões.",
  "The account is not allowed to do that: its permissions or its plan do not include it.":
    "A conta não pode fazer isso: as permissões ou o plano dela não incluem isso.",
  "The service did not find it.": "O serviço não encontrou.",
  "The service asks to wait a moment: too many requests in a short time.":
    "O serviço pede para esperar um pouco: muitos pedidos em pouco tempo.",
  "The service is having trouble right now: try again in a while.":
    "O serviço está com problemas agora: tente de novo daqui a pouco.",
  "The account is not connected any more: sign in again in Settings, Connections.":
    "A conta não está mais conectada: entre de novo em Configurações, Conexões.",
  "The service took too long to answer: try again in a while.":
    "O serviço demorou demais para responder: tente de novo daqui a pouco.",
  "The service could not be reached: check the internet connection, or that it is running.":
    "Não deu para acessar o serviço: confira a conexão com a internet, ou se ele está rodando.",
  "The desktop did not answer": "A área de trabalho não respondeu",
  "{name}'s desktop": "Área de trabalho de {name}",
  "You have the controls: {name} waits": "Você está no controle: {name} espera",
  "Watching live": "Assistindo ao vivo",
  "Give it back to {name}": "Devolver para {name}",
  "Take control": "Assumir o controle",
  "Connecting to the desktop…": "Conectando à área de trabalho…",
  "Click, drag, scroll and type on the picture; Ctrl+V pastes your own text.":
    "Clique, arraste, role e digite sobre a imagem; Ctrl+V cola o seu próprio texto.",
  "Take control to click and type in it yourself, for what {name} cannot do alone (a password, a captcha). {name} waits meanwhile.":
    "Assuma o controle para clicar e digitar você mesmo, no que {name} não consegue fazer sozinho (uma senha, um captcha). Enquanto isso, {name} espera.",
  "See {name}'s desktop live, and take control of it":
    "Ver a área de trabalho de {name} ao vivo e assumir o controle",
  "Dragging: let go where it should end": "Arrastando: solte onde deve terminar",
  "Button down: let go to click, or move to drag":
    "Botão pressionado: solte para clicar, ou mova para arrastar",
  "Typing {n} characters…": "Digitando {n} caracteres…",
  "Sending to {name}'s desktop…": "Enviando para a área de trabalho de {name}…",
  "Sent: waiting for the screen to change…": "Enviado: aguardando a tela mudar…",
  "Ready: click, drag, scroll or type on the picture":
    "Pronto: clique, arraste, role ou digite sobre a imagem",
  "Click the picture to take control": "Clique na imagem para assumir o controle",
  Enlarge: "Ampliar",
  Reduce: "Reduzir",
  "Show less": "Ver menos",
  "Show {n} more": "Ver mais {n}",
  "Start {name} to see its desktop live and take control of it.":
    "Inicie {name} para ver a área de trabalho ao vivo e assumir o controle.",
  "Dragged on the screen": "Arrastou na tela",
  "Looked at the open windows": "Olhou as janelas abertas",
  "Newer desktops are downloaded and installed by themselves when {name} is idle; its cookies, sessions and passwords come along.":
    "As áreas de trabalho novas são baixadas e instaladas sozinhas quando {name} está ocioso; seus cookies, sessões e senhas são mantidos.",
  updated: "atualizado",
  "Update {name}'s desktop? It restarts. Its cookies, sessions and saved passwords are backed up first and put back in the new one.":
    "Atualizar a área de trabalho de {name}? Ela reinicia. Antes, seus cookies, sessões e senhas salvas são copiados e colocados na nova.",
  Update: "Atualizar",
  "A newer desktop is available for {name}.": "Há uma área de trabalho mais nova para {name}.",
  "Update the desktop": "Atualizar a área de trabalho",
  "Cookies, sessions and passwords backed up {when}.": "Cookies, sessões e senhas copiados {when}.",
  "Cookies, sessions and passwords are not backed up yet.":
    "Cookies, sessões e senhas ainda não foram copiados.",
  "Back up now": "Copiar agora",
  "The backup is sealed and kept away from the desktop, and goes back into it when it is made anew. It is also made when the desktop stops.":
    "A cópia é criptografada e guardada longe da área de trabalho, e volta a ela quando é refeita. Também é feita quando a área de trabalho para.",
  Secrets: "Segredos",
  "Passwords and codes your kitties may type for you. A kitty is told only the names, and asks for one by name: the secret goes from here to its keyboard, and neither the kitty nor its AI model ever reads it. They are kept encrypted on the gateway.":
    "Senhas e códigos que seus kitties podem digitar por você. Um kitty só recebe os nomes e pede um pelo nome: o segredo vai daqui para o teclado dele, e nem o kitty nem o modelo de IA o leem jamais. Ficam guardados criptografados no gateway.",
  "No secrets yet. Save one below, or tick “it is a secret” when a kitty asks for help.":
    "Ainda não há segredos. Salve um abaixo, ou marque «é um segredo» quando um kitty pedir ajuda.",
  "Remove the secret {name}": "Remover o segredo {name}",
  "Remove the secret {name}?": "Remover o segredo {name}?",
  "May be used by {names}": "Podem usar: {names}",
  "Kitties that may use {name}": "Kitties que podem usar {name}",
  "Shop password": "Senha da loja",
  "The secret": "O segredo",
  "Kitties that may use it": "Kitties que podem usá-lo",
  "Save the secret": "Salvar o segredo",
  "the secret": "o segredo",
  "Keep it for {name} under the name (optional)": "Guardar para {name} com o nome (opcional)",
  "{name} needs your help": "{name} precisa da sua ajuda",
  "What {name} sees": "O que {name} vê",
  "What {name} needs": "O que {name} precisa",
  "A code, a password, an answer…": "Um código, uma senha, uma resposta…",
  "It is a secret: type it on its desktop, and do not show it to {name}":
    "É um segredo: digite-o na área de trabalho dele e não o mostre a {name}",
  "Press Enter after": "Pressionar Enter depois",
  "Type it on the desktop": "Digitar na área de trabalho",
  "Tell {name}": "Dizer a {name}",
  "Not now": "Agora não",
  "You typed it on its desktop": "Você digitou na área de trabalho dele",
  "You answered": "Você respondeu",
  "You took the desktop and gave it back": "Você assumiu a área de trabalho e a devolveu",
  "Watch it as a GIF": "Ver como GIF",
  "Save the GIF": "Salvar o GIF",
  "The film could not be made.": "Não foi possível fazer o filme.",
  "Read the text on the screen": "Leu o texto da tela",
  "Read the page": "Leu a página",
  "Clicked “{text}” on the page": "Clicou em «{text}» na página",
  "Clicked on the page": "Clicou na página",
  "Filled in a field of the page": "Preencheu um campo da página",
  "Brought “{title}” to the front": "Trouxe “{title}” para a frente",
  "Brought a window to the front": "Trouxe uma janela para a frente",
  "Opened a program": "Abriu um programa",
  "Installed {apps}": "Instalou {apps}",
  "Installed programs": "Instalou programas",
  "Waited while you used the desktop": "Esperou enquanto você usava a área de trabalho",
  "On {name}'s clipboard: paste it there with Ctrl+V.":
    "Na área de transferência de {name}: cole lá com Ctrl+V.",
  "{name}'s clipboard is empty.": "A área de transferência de {name} está vazia.",
  "Copied from {name}'s clipboard.": "Copiado da área de transferência de {name}.",
  "Here is {name}'s clipboard: copy it from the field.":
    "Esta é a área de transferência de {name}: copie do campo.",
  "Text for {name}'s clipboard": "Texto para a área de transferência de {name}",
  Clipboard: "Área de transferência",
  "Send to {name}": "Enviar para {name}",
  "Copy from {name}": "Copiar de {name}",
  "{name} is waiting for you on its desktop.": "{name} está esperando você na área de trabalho.",
  "The kitty": "O kitty",
  "Asked you for help: {reason}": "Pediu sua ajuda: {reason}",
  "Asked you for help on its desktop": "Pediu sua ajuda na área de trabalho",
  "Desktop look": "Aparência da área de trabalho",
  "{name}'s desktop now wears {theme}.": "A área de trabalho de {name} agora usa {theme}.",
  "{name} ran out of budget for this task; it can go on from where it was.":
    "{name} ficou sem orçamento para esta tarefa; pode continuar de onde parou.",
  Continue: "Continuar",
  "Continue where you left off.": "Continue de onde parou.",
};

export default dict;
