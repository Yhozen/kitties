import type { Dictionary } from "../../i18n";

// The chat, goals, journal, limits, approvals, memory, library, sign-in and the words for people.
const dict: Dictionary = {
  // Conversation
  "The kitty's display": "La pantalla del kitty",
  "Open the screenshot": "Abrir la captura de pantalla",
  "it did not work: {error}": "no funcionó: {error}",
  "Good answer": "Buena respuesta",
  "Not good": "No estuvo bien",
  "What was wrong": "Qué estuvo mal",
  "what was wrong? (it learns from this)": "¿qué estuvo mal? (aprende de esto)",
  send: "enviar",
  "{name} needs your help with this one.": "{name} necesita tu ayuda con esto.",
  steps: "pasos",
  "working on its computer…": "trabajando en su computadora…",
  "{input} → {output} tokens": "{input} → {output} tokens",
  "{input}→{output} tokens": "{input}→{output} tokens",
  "waiting for your yes: {action} ({connector})": "esperando tu sí: {action} ({connector})",
  "skill · {name}": "habilidad · {name}",
  "No chat open": "No hay ningún chat abierto",
  "Pick a chat on the left, or start one with the kitties you want in it. In a group, write @name to pick who answers.":
    "Elige un chat a la izquierda, o empieza uno con los kitties que quieras. En un grupo, escribe @nombre para elegir quién responde.",
  "Say hello to the team, or give them a task. Write @name to pick who answers.":
    "Saluda al equipo o dale una tarea. Escribe @nombre para elegir quién responde.",
  "Say hello, ask a question, or give it a task to work on.":
    "Saluda, haz una pregunta o dale una tarea para trabajar.",
  "thinking…": "pensando…",
  Screenshot: "Captura de pantalla",

  // The desktop column
  "Hide the screenshot": "Ocultar la captura",
  "Show the screenshot": "Ver la captura",
  Desktop: "Escritorio",
  Chat: "Chat",
  Tasks: "Tareas",
  "Show it on the desktop": "Verlo en el escritorio",
  "{n} steps on the desktop": "{n} pasos en el escritorio",

  "Previous screenshot": "Captura anterior",
  "Next screenshot": "Captura siguiente",
  "Resize the desktop column": "Cambiar el ancho de la columna del escritorio",
  "Drag to resize; double-click to reset":
    "Arrastra para cambiar el ancho; doble clic para restablecer",

  "Screenshots: use the left and right arrow keys": "Capturas: usa las flechas izquierda y derecha",

  // Steps of a desktop task
  "Opened {host}": "Abrió {host}",
  "Opened a page": "Abrió una página",
  "Clicked on the screen": "Hizo clic en la pantalla",
  "Double-clicked on the screen": "Hizo doble clic en la pantalla",
  "Moved the pointer": "Movió el puntero",
  "Typed “{text}”": "Escribió “{text}”",
  Typed: "Escribió",
  "Pressed {key}": "Presionó {key}",
  "Scrolled up": "Se desplazó hacia arriba",
  "Scrolled down": "Se desplazó hacia abajo",
  "Waited a moment": "Esperó un momento",
  "Looked at the screen": "Miró la pantalla",
  "Ran a program": "Ejecutó un programa",
  Finished: "Terminó",
  "a key": "una tecla",

  // Goals
  Goals: "Objetivos",
  "No goals yet: {name} only works when asked.":
    "Todavía no hay objetivos: {name} solo trabaja cuando se lo pides.",
  file: "archivo",
  paused: "en pausa",
  "on events from {names}": "con eventos de {names}",
  "next {time}": "próxima vez: {time}",
  "{n} run": "{n} ejecución",
  "{n} runs": "{n} ejecuciones",
  "run now": "ejecutar ahora",
  "open chat": "abrir chat",
  pause: "pausar",
  resume: "reanudar",
  "Remove the goal": "Eliminar el objetivo",
  Title: "Título",
  "Triage the new issues": "Revisar los issues nuevos",
  "What to do (optional)": "Qué hacer (opcional)",
  "Read each new issue, label it and answer the easy ones.":
    "Lee cada issue nuevo, ponle una etiqueta y responde los fáciles.",
  When: "Cuándo",
  "cron: minute hour day month weekday (leave empty for events only)":
    "cron: minuto hora día mes día-de-la-semana (déjalo vacío para usar solo eventos)",
  "Also when these services report something": "También cuando estos servicios avisen de algo",
  "A service posts to /v1/hooks/<connector> with the connector's incoming events secret.":
    "Un servicio envía a /v1/hooks/<connector> con el secreto de eventos entrantes de la conexión.",
  "Add goal": "Agregar objetivo",
  "the title": "el título",
  "New goal": "Nuevo objetivo",
  "every 15 min": "cada 15 min",
  hourly: "cada hora",
  "daily at 9": "todos los días a las 9",
  "weekdays at 9": "días de semana a las 9",
  "weekly (Mon)": "semanal (lun)",
  custom: "personalizado",

  // How a goal or a journal entry went
  done: "listo",
  running: "en curso",
  blocked: "bloqueado",
  failed: "falló",
  escalated: "escalado",
  delegated: "delegado",
  run: "ejecución",
  event: "evento",
  retry: "reintento",
  skipped: "omitido",
  recovered: "recuperado",

  // Journal
  Journal: "Diario",
  "Nothing yet.": "Nada todavía.",
  open: "abrir",

  // Limits & backup
  "Limits & backup": "Límites y respaldo",
  "How much one task may spend before {name} stops and says so, and how much it may spend in a day. Leave a box empty for the default.":
    "Cuánto puede gastar una tarea antes de que {name} se detenga y te avise, y cuánto puede gastar en un día. Deja una casilla vacía para usar el valor predeterminado.",
  "Tokens per task": "Tokens por tarea",
  "Seconds per task": "Segundos por tarea",
  "Rounds per task": "Rondas por tarea",
  "Retries (another way)": "Reintentos (de otra forma)",
  "Tokens per day": "Tokens por día",
  "Actions per day": "Acciones por día",
  "no limit": "sin límite",
  default: "predeterminado",
  "Backup (takes over a task {name} gives up on)": "Respaldo (toma una tarea que {name} abandona)",
  "nobody: ask me instead": "nadie: mejor pregúntame a mí",
  "When it wants to publish, send or spend": "Cuando quiera publicar, enviar o gastar",
  "act on its own, as far as the account allows":
    "actuar por su cuenta, hasta donde lo permita la cuenta",
  "ask me first (until I trust it with that)":
    "preguntarme primero (hasta que le tenga confianza para eso)",
  "Save limits": "Guardar límites",
  saved: "guardado",

  // Action limits
  "Action limits": "Límites de acciones",
  "{name} does what its connections allow. Tell it in a chat (“ask me before posting”) and it adds the limit here, or add one yourself.":
    "{name} hace lo que sus conexiones le permiten. Díselo en un chat (“pregúntame antes de publicar”) y agrega el límite aquí, o agrega uno tú.",
  remove: "quitar",
  Connection: "Conexión",
  "pick one": "elige una",
  Action: "Acción",
  everything: "todo",
  It: "Qué hace",
  "asks me first": "me pregunta primero",
  "never does it": "nunca lo hace",
  "Add limit": "Agregar límite",
  "a connection": "una conexión",

  // Approvals
  "wants to": "quiere hacer",
  "the exact request": "la solicitud exacta",
  "Why not? {name} reads this and learns from it.":
    "¿Por qué no? {name} lee esto y aprende de ello.",
  "too informal, wrong channel, not today…": "muy informal, canal equivocado, hoy no…",
  Back: "Volver",
  Reject: "Rechazar",
  Approve: "Aprobar",
  "From now on {name} does this without asking":
    "De ahora en adelante {name} hace esto sin preguntar",
  "Approve, don't ask again": "Aprobar y no volver a preguntar",
  "Reject…": "Rechazar…",
  allowed: "permitido",
  "asks first": "pregunta primero",
  never: "nunca",
  "anything on {connector}": "cualquier cosa en {connector}",
  "{action} on {connector}": "{action} en {connector}",
  Approvals: "Aprobaciones",
  "Actions that reach other people or move money wait here until you say yes. A kitty you keep saying yes to earns the right to do that kind of thing alone: sooner if you are relaxed, later if you are demanding.":
    "Las acciones que llegan a otras personas o mueven dinero esperan aquí hasta que digas que sí. Un kitty al que le sigues diciendo que sí se gana el derecho a hacer ese tipo de cosas solo: antes si eres relajado, más tarde si eres exigente.",
  "Waiting for you": "Esperándote",
  "Nothing is waiting.": "No hay nada esperando.",
  Limits: "Límites",
  Decided: "Decididas",
  approved: "aprobada",
  rejected: "rechazada",
  pending: "pendiente",

  // Memory
  "What {name} knows about you": "Lo que {name} sabe de ti",
  "How demanding you are": "Qué tan exigente eres",
  relaxed: "relajado",
  easygoing: "tranquilo",
  balanced: "equilibrado",
  demanding: "exigente",
  strict: "estricto",
  "let it follow my feedback ({up} up, {down} down)":
    "dejar que siga mis opiniones ({up} a favor, {down} en contra)",
  "On its way to acting alone": "En camino a actuar solo",
  "never alone for you": "nunca solo contigo",
  "{streak} of {needs} yeses in a row": "{streak} de {needs} síes seguidos",
  Today: "Hoy",
  tokens: "tokens",
  actions: "acciones",
  "of {max}": "de {max}",
  "(no limit)": "(sin límite)",
  Notes: "Notas",
  "Nothing yet. It learns from your thumbs, your yes and no, and what it notices.":
    "Nada todavía. Aprende de tus pulgares, de tus sí y tus no, y de lo que nota.",
  user: "personal",
  work: "trabajo",
  "You wrote it: a consolidation never drops it":
    "La escribiste tú: una consolidación nunca la borra",
  yours: "tuya",
  "Forget: {note}": "Olvidar: {note}",
  "Scope of the note": "Alcance de la nota",
  "about me": "sobre mí",
  "about the work": "sobre el trabajo",
  "Always answer in Spanish": "Responde siempre en español",
  "A note for it to keep": "Una nota para que la guarde",
  "Add note": "Agregar nota",
  "Its own brain merges the notes and the feedback into a short list":
    "Su propio cerebro junta las notas y las opiniones en una lista corta",
  "Consolidate now": "Consolidar ahora",
  "({n} new)": "({n} nuevas)",

  // Library
  Library: "Biblioteca",
  skills: "habilidades",
  artifacts: "archivos",
  "{n} proposed": "{n} propuestas",
  "Procedures the kitties read before a task and extend when they learn something. A proposal waits here until you accept it.":
    "Procedimientos que los kitties leen antes de una tarea y amplían cuando aprenden algo. Una propuesta espera aquí hasta que la aceptes.",
  "built in": "incluida",
  proposed: "propuesta",
  accept: "aceptar",
  "Delete {name}": "Borrar {name}",
  "Delete the skill {name}?": "¿Borrar la habilidad {name}?",
  Name: "Nombre",
  "Document (markdown)": "Documento (markdown)",
  Document: "Documento",
  "# Title\n\nWhat it is for.\n\n1. Step": "# Título\n\nPara qué sirve.\n\n1. Paso",
  "the name": "el nombre",
  "the document": "el documento",
  "Write a skill": "Escribir una habilidad",
  edit: "editar",
  "Close the skill": "Cerrar la habilidad",
  "Files the kitties saved for later: reports, tables, diagrams, drafts. Any kitty can read them in any chat; you can download or delete them.":
    "Archivos que los kitties guardaron para después: informes, tablas, diagramas, borradores. Cualquier kitty puede leerlos en cualquier chat; tú puedes descargarlos o borrarlos.",
  "by {name}": "de {name}",
  "{size} bytes": "{size} bytes",
  download: "descargar",
  "Delete {name}?": "¿Borrar {name}?",
  "Nothing saved yet. A kitty saves one with @artifact save, or a connector such as the diagram renderer does.":
    "Todavía no hay nada guardado. Un kitty guarda uno con @artifact save, o lo hace una conexión como el generador de diagramas.",
  "Close the artifact": "Cerrar el archivo",

  // Signing in with a subscription
  Copied: "Copiado",
  Copy: "Copiar",
  "the sign-in failed": "no se pudo iniciar sesión",
  "Claude Code is on this computer": "Claude Code está en esta computadora",
  "If it is not signed in yet, run this once in a terminal and follow the browser:":
    "Si todavía no inició sesión, ejecuta esto una vez en una terminal y sigue los pasos en el navegador:",
  "Signed in as {who}.": "Sesión iniciada como {who}.",
  "Signed in.": "Sesión iniciada.",
  "Your {plan} pays for the answers.": "Tu {plan} paga las respuestas.",
  "Sign out": "Cerrar sesión",
  "Works with {plans}.": "Funciona con {plans}.",
  "Install Claude Code on this computer:": "Instala Claude Code en esta computadora:",
  "how to install ↗": "cómo instalarlo ↗",
  "Sign it in once, in a terminal:": "Inicia sesión una vez, en una terminal:",
  "Looking…": "Buscando…",
  "Done: find Claude Code": "Listo: buscar Claude Code",
  "Install gcloud:": "Instala gcloud:",
  "Google Cloud project ID": "ID del proyecto de Google Cloud",
  "leave empty to use gcloud's quota project":
    "déjalo vacío para usar el proyecto de cuota de gcloud",
  "Checking…": "Comprobando…",
  "Use my Google login": "Usar mi cuenta de Google",
  "Opening…": "Abriendo…",
  "Sign in with {service}": "Iniciar sesión con {service}",
  "Type this code on GitHub:": "Escribe este código en GitHub:",
  "Open github.com ↗": "Abrir github.com ↗",
  "waiting for you…": "esperándote…",
  "Finish signing in in your browser, then come back: this changes by itself.":
    "Termina de iniciar sesión en tu navegador y vuelve: esto cambia solo.",
  "Open the page again ↗": "Abrir la página otra vez ↗",
  "Did the browser end on a page that does not load (localhost:1455)? Copy its whole address and paste it here:":
    "¿El navegador terminó en una página que no carga (localhost:1455)? Copia su dirección completa y pégala aquí:",
  "Address the browser landed on": "Dirección a la que llegó el navegador",
  "Use it": "Usarla",

  // Providers and sign-ins
  "Claude models: careful, strong at long tasks and tools.":
    "Modelos Claude: cuidadosos, fuertes en tareas largas y con herramientas.",
  "GPT models, the most widely used.": "Modelos GPT, los más usados.",
  "Gemini models, with a free tier to start.": "Modelos Gemini, con un nivel gratis para empezar.",
  "Ollama on this computer": "Ollama en esta computadora",
  "Free models that run on your own machine. No key needed.":
    "Modelos gratis que corren en tu propia máquina. No necesitas clave.",
  "Open models, hosted by Ollama.": "Modelos abiertos, alojados por Ollama.",
  "One key for hundreds of models.": "Una clave para cientos de modelos.",
  "Very fast open models.": "Modelos abiertos muy rápidos.",
  "DeepSeek models, low cost.": "Modelos DeepSeek, de bajo costo.",
  "Mistral models, from Europe.": "Modelos Mistral, de Europa.",
  "Qwen models through DashScope.": "Modelos Qwen a través de DashScope.",
  "OpenAI models tuned for code.": "Modelos de OpenAI ajustados para código.",
  "The models of your Copilot plan.": "Los modelos de tu plan de Copilot.",
  "Claude subscription": "Suscripción de Claude",
  "Claude on your Pro or Max plan, through Claude Code.":
    "Claude con tu plan Pro o Max, a través de Claude Code.",
  "Another server": "Otro servidor",
  "Anything that speaks the OpenAI API: LM Studio, vLLM, a company gateway.":
    "Cualquier cosa que hable la API de OpenAI: LM Studio, vLLM, la pasarela de una empresa.",
  "ChatGPT plan": "Plan de ChatGPT",
  "Plus, Pro, Business or Enterprise": "Plus, Pro, Business o Enterprise",
  "Sign in with your ChatGPT account: your plan pays for the answers, no API key or credits needed.":
    "Inicia sesión con tu cuenta de ChatGPT: tu plan paga las respuestas, sin clave de API ni créditos.",
  "Pro or Max": "Pro o Max",
  "Your Claude plan pays for the answers. Anthropic allows it only through its own Claude Code program: Kitties runs it for you, signed in with your account.":
    "Tu plan de Claude paga las respuestas. Anthropic solo lo permite a través de su propio programa Claude Code: Kitties lo ejecuta por ti, con tu cuenta.",
  "any Copilot plan, Free included": "cualquier plan de Copilot, incluido el gratis",
  "Sign in with GitHub: open the link, type the code shown here, and your Copilot plan pays for the answers.":
    "Inicia sesión con GitHub: abre el enlace, escribe el código que aparece aquí y tu plan de Copilot paga las respuestas.",
  "Google account": "Cuenta de Google",
  "a Google Cloud project": "un proyecto de Google Cloud",
  "Uses the Google login of the gcloud program on this computer, billed to your Cloud project.":
    "Usa la sesión de Google del programa gcloud en esta computadora, y se cobra a tu proyecto de Cloud.",
  "qwen.ai account": "Cuenta de qwen.ai",
  "Qwen ended its account sign-in on April 15, 2026. Use a DashScope (Alibaba Cloud Model Studio) API key instead.":
    "Qwen dejó de permitir el inicio de sesión con cuenta el 15 de abril de 2026. Usa una clave de API de DashScope (Alibaba Cloud Model Studio).",
  account: "cuenta",

  // Kinds of connections
  "Chat & messages": "Chat y mensajes",
  "Social media": "Redes sociales",
  "Calendar, reminders & contacts": "Calendario, recordatorios y contactos",
  "Home, news & weather": "Hogar, noticias y clima",
  Music: "Música",
  Code: "Código",
  Productivity: "Productividad",
  "Office & files": "Oficina y archivos",
  Finance: "Finanzas",
  Drawing: "Dibujo",
  Other: "Otros",

  // Lists of names: "mimi and tom"
  and: "y",

  // What went wrong, said plainly
  "It needs an API key: paste one in the form.":
    "Necesita una clave de API: pega una en el formulario.",
  "The key was refused: check that it is complete and still valid.":
    "La clave fue rechazada: revisa que esté completa y que siga siendo válida.",
  "The server did not answer: check the address, and that it is running.":
    "El servidor no respondió: revisa la dirección y que esté funcionando.",
  "That model name was not found at this provider: check its spelling.":
    "Ese nombre de modelo no existe en este proveedor: revisa cómo está escrito.",
  "The service did not accept the key or the sign-in: connect it again in Settings, Connections.":
    "El servicio no aceptó la clave ni el inicio de sesión: vuelve a conectarlo en Ajustes, Conexiones.",
  "The account is not allowed to do that: its permissions or its plan do not include it.":
    "La cuenta no puede hacer eso: sus permisos o su plan no lo incluyen.",
  "The service did not find it.": "El servicio no lo encontró.",
  "The service asks to wait a moment: too many requests in a short time.":
    "El servicio pide esperar un momento: demasiadas solicitudes en poco tiempo.",
  "The service is having trouble right now: try again in a while.":
    "El servicio tiene problemas en este momento: inténtalo de nuevo en un rato.",
  "The account is not connected any more: sign in again in Settings, Connections.":
    "La cuenta ya no está conectada: vuelve a iniciar sesión en Ajustes, Conexiones.",
  "The service took too long to answer: try again in a while.":
    "El servicio tardó demasiado en responder: inténtalo de nuevo en un rato.",
  "The service could not be reached: check the internet connection, or that it is running.":
    "No se pudo llegar al servicio: revisa la conexión a internet, o que esté funcionando.",
  "The desktop did not answer": "El escritorio no respondió",
  "{name}'s desktop": "Escritorio de {name}",
  "You have the controls: {name} waits": "Tienes el control: {name} espera",
  "Watching live": "Viendo en vivo",
  "Give it back to {name}": "Devolvérselo a {name}",
  "Take control": "Tomar el control",
  "Connecting to the desktop…": "Conectando con el escritorio…",
  "Click, drag, scroll and type on the picture; Ctrl+V pastes your own text.":
    "Haz clic, arrastra, usa la rueda y escribe sobre la imagen; Ctrl+V pega tu propio texto.",
  "Take control to click and type in it yourself, for what {name} cannot do alone (a password, a captcha). {name} waits meanwhile.":
    "Toma el control para hacer clic y escribir tú mismo, en lo que {name} no puede hacer solo (una contraseña, un captcha). Mientras tanto, {name} espera.",
  "See {name}'s desktop live, and take control of it":
    "Ver el escritorio de {name} en vivo y tomar el control",
  "Dragging: let go where it should end": "Arrastrando: suelta donde debe terminar",
  "Button down: let go to click, or move to drag":
    "Botón pulsado: suelta para hacer clic, o mueve para arrastrar",
  "Typing {n} characters…": "Escribiendo {n} caracteres…",
  "Sending to {name}'s desktop…": "Enviando al escritorio de {name}…",
  "Sent: waiting for the screen to change…": "Enviado: esperando a que la pantalla cambie…",
  "Ready: click, drag, scroll or type on the picture":
    "Listo: haz clic, arrastra, desplaza o escribe sobre la imagen",
  "Click the picture to take control": "Haz clic en la imagen para tomar el control",
  Enlarge: "Ampliar",
  Reduce: "Reducir",
  "Show less": "Ver menos",
  "Show {n} more": "Ver {n} más",
  "Start {name} to see its desktop live and take control of it.":
    "Inicia a {name} para ver su escritorio en vivo y tomar el control.",
  "Dragged on the screen": "Arrastró en la pantalla",
  "Looked at the open windows": "Revisó las ventanas abiertas",
  "Newer desktops are downloaded and installed by themselves when {name} is idle; its cookies, sessions and passwords come along.":
    "Los escritorios nuevos se descargan e instalan solos cuando {name} está inactivo; sus cookies, sesiones y contraseñas se conservan.",
  updated: "actualizado",
  "Update {name}'s desktop? It restarts. Its cookies, sessions and saved passwords are backed up first and put back in the new one.":
    "¿Actualizar el escritorio de {name}? Se reinicia. Antes se respaldan sus cookies, sesiones y contraseñas guardadas, y se ponen en el nuevo.",
  Update: "Actualizar",
  "A newer desktop is available for {name}.": "Hay un escritorio más nuevo para {name}.",
  "Update the desktop": "Actualizar el escritorio",
  "Cookies, sessions and passwords backed up {when}.":
    "Cookies, sesiones y contraseñas respaldadas {when}.",
  "Cookies, sessions and passwords are not backed up yet.":
    "Las cookies, sesiones y contraseñas aún no están respaldadas.",
  "Back up now": "Respaldar ahora",
  "The backup is sealed and kept away from the desktop, and goes back into it when it is made anew. It is also made when the desktop stops.":
    "El respaldo está cifrado y guardado lejos del escritorio, y vuelve a él cuando se rehace. También se hace cuando el escritorio se detiene.",
  Secrets: "Secretos",
  "Passwords and codes your kitties may type for you. A kitty is told only the names, and asks for one by name: the secret goes from here to its keyboard, and neither the kitty nor its AI model ever reads it. They are kept encrypted on the gateway.":
    "Contraseñas y códigos que tus kitties pueden escribir por ti. A un kitty solo se le dicen los nombres y pide uno por su nombre: el secreto va de aquí a su teclado, y ni el kitty ni su modelo de IA lo leen jamás. Se guardan cifrados en el gateway.",
  "No secrets yet. Save one below, or tick “it is a secret” when a kitty asks for help.":
    "Aún no hay secretos. Guarda uno abajo, o marca «es un secreto» cuando un kitty pida ayuda.",
  "Remove the secret {name}": "Eliminar el secreto {name}",
  "Remove the secret {name}?": "¿Eliminar el secreto {name}?",
  "May be used by {names}": "Pueden usarlo {names}",
  "Kitties that may use {name}": "Kitties que pueden usar {name}",
  "Shop password": "Contraseña de la tienda",
  "The secret": "El secreto",
  "Kitties that may use it": "Kitties que pueden usarlo",
  "Save the secret": "Guardar el secreto",
  "the secret": "el secreto",
  "Keep it for {name} under the name (optional)": "Guardarlo para {name} con el nombre (opcional)",
  "{name} needs your help": "{name} necesita tu ayuda",
  "What {name} sees": "Lo que ve {name}",
  "What {name} needs": "Lo que necesita {name}",
  "A code, a password, an answer…": "Un código, una contraseña, una respuesta…",
  "It is a secret: type it on its desktop, and do not show it to {name}":
    "Es un secreto: escríbelo en su escritorio y no se lo muestres a {name}",
  "Press Enter after": "Pulsar Enter después",
  "Type it on the desktop": "Escribirlo en el escritorio",
  "Tell {name}": "Decírselo a {name}",
  "Not now": "Ahora no",
  "You typed it on its desktop": "Lo escribiste en su escritorio",
  "You answered": "Respondiste",
  "You took the desktop and gave it back": "Tomaste el escritorio y lo devolviste",
  "Watch it as a GIF": "Verla como GIF",
  "Save the GIF": "Guardar el GIF",
  "The film could not be made.": "No se pudo hacer la película.",
  "Read the text on the screen": "Leyó el texto de la pantalla",
  "Read the page": "Leyó la página",
  "Clicked “{text}” on the page": "Hizo clic en «{text}» de la página",
  "Clicked on the page": "Hizo clic en la página",
  "Filled in a field of the page": "Rellenó un campo de la página",
  "Brought “{title}” to the front": "Puso “{title}” al frente",
  "Brought a window to the front": "Puso una ventana al frente",
  "Opened a program": "Abrió un programa",
  "Installed {apps}": "Instaló {apps}",
  "Installed programs": "Instaló programas",
  "Waited while you used the desktop": "Esperó mientras usabas el escritorio",
  "On {name}'s clipboard: paste it there with Ctrl+V.":
    "En el portapapeles de {name}: pégalo allí con Ctrl+V.",
  "{name}'s clipboard is empty.": "El portapapeles de {name} está vacío.",
  "Copied from {name}'s clipboard.": "Copiado del portapapeles de {name}.",
  "Here is {name}'s clipboard: copy it from the field.":
    "Este es el portapapeles de {name}: cópialo desde el campo.",
  "Text for {name}'s clipboard": "Texto para el portapapeles de {name}",
  Clipboard: "Portapapeles",
  "Send to {name}": "Enviar a {name}",
  "Copy from {name}": "Copiar de {name}",
  "{name} is waiting for you on its desktop.": "{name} te espera en su escritorio.",
  "The kitty": "El kitty",
  "Asked you for help: {reason}": "Te pidió ayuda: {reason}",
  "Asked you for help on its desktop": "Te pidió ayuda en su escritorio",
  "Desktop look": "Aspecto del escritorio",
  "{name}'s desktop now wears {theme}.": "El escritorio de {name} ahora usa {theme}.",
  "{name} ran out of budget for this task; it can go on from where it was.":
    "A {name} se le acabó el presupuesto de esta tarea; puede seguir desde donde quedó.",
  Continue: "Continuar",
  "Continue where you left off.": "Continúa desde donde quedaste.",
};

export default dict;
