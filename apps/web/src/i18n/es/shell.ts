import type { Dictionary } from "../../i18n";

// The page's frame: sidebar, header, welcome, composer, sign-in, confirmations and the new chat,
// new kitty, kitty and gateway dialogs.
const dict: Dictionary = {
  // Required marks
  Required: "Obligatorio",

  // Sign-in
  "sign in to this gateway": "inicia sesión en este gateway",
  Token: "Token",
  "the gateway's token": "el token del gateway",
  "Checking…": "Comprobando…",
  "Sign in": "Iniciar sesión",
  "the token": "el token",
  "The token stays on the server: this browser keeps only a session that you can end with Sign out.":
    "El token se queda en el servidor: este navegador solo guarda una sesión que puedes terminar con Cerrar sesión.",

  // Composer
  "A kitty is working on its desktop…": "Un kitty está trabajando en su escritorio…",
  "Say something to the team; @name picks who answers":
    "Escríbele algo al equipo; @nombre elige quién responde",
  "Say something…": "Escribe algo…",
  Stop: "Detener",
  Send: "Enviar",

  // Welcome
  "Give your kitties a brain": "Dale un cerebro a tus kitties",
  "Add a model from a provider you have an account with (Claude, OpenAI, Gemini…), or Ollama to run free models on this computer.":
    "Agrega un modelo de un proveedor donde tengas cuenta (Claude, OpenAI, Gemini…), u Ollama para usar modelos gratis en esta computadora.",
  "Add a model": "Agregar un modelo",
  "Create your first kitty": "Crea tu primer kitty",
  "Give it a name, a personality and a look. It starts working at once.":
    "Dale un nombre, una personalidad y un aspecto. Empieza a trabajar de inmediato.",
  "Create a kitty": "Crear un kitty",
  "Start a chat": "Iniciar un chat",
  "Ask it anything, or give it a task. Several kitties in one chat work as a team.":
    "Pregúntale lo que quieras o dale una tarea. Varios kitties en un mismo chat trabajan en equipo.",
  "Welcome to Kitties": "Te damos la bienvenida a Kitties",
  "No chat open": "No hay ningún chat abierto",
  "One step to get your kitties working.":
    "Falta un paso para que tus kitties se pongan a trabajar.",
  "{count} steps to get your kitties working.":
    "Faltan {count} pasos para que tus kitties se pongan a trabajar.",
  "Pick a chat on the left, or start a new one. In a group, write @name to pick who answers.":
    "Elige un chat a la izquierda o empieza uno nuevo. En un grupo, escribe @nombre para elegir quién responde.",
  "New chat": "Nuevo chat",
  "Connect a service": "Conectar un servicio",
  "Get alerts on your phone": "Recibe avisos en tu teléfono",

  // Sidebar
  Chats: "Chats",
  "No chats yet.": "Todavía no hay chats.",
  help: "ayuda",
  goal: "meta",
  Kitties: "Kitties",
  "No kitties yet.": "Todavía no hay kitties.",
  "New kitty": "Nuevo kitty",
  Approvals: "Aprobaciones",
  "{count} waiting": "{count} en espera",
  Library: "Biblioteca",
  Settings: "Ajustes",
  Theme: "Tema",
  "Sign out": "Cerrar sesión",

  // Header and banners
  You: "Tú",
  "Something broke in the page: {message}": "Algo se rompió en la página: {message}",
  "Something failed: {message}": "Algo falló: {message}",
  'Delete the chat "{title}"?': "¿Borrar el chat «{title}»?",
  Menu: "Menú",
  group: "grupo",
  working: "trabajando",
  offline: "sin conexión",
  connected: "conectado",
  "Delete chat": "Borrar chat",
  Dismiss: "Descartar",
  "The gateway did not answer or refused the token.": "El gateway no respondió o rechazó el token.",

  // New chat
  "A chat is a conversation with your kitties, and there is none yet. Create a kitty first, then chat with it.":
    "Un chat es una conversación con tus kitties, y todavía no tienes ninguno. Primero crea un kitty y luego chatea con él.",
  "Pick one kitty, or several for a group that works as a team.":
    "Elige un kitty, o varios para un grupo que trabaje en equipo.",
  "Title (optional)": "Título (opcional)",
  "Launch planning": "Planear el lanzamiento",
  "Start group chat": "Iniciar chat grupal",
  "Start chat": "Iniciar chat",
  "a kitty": "un kitty",

  // New kitty
  "A kitty needs a brain to think with, and there is no model yet. Add one in Settings (it takes a minute: pick a provider and paste its key), then come back.":
    "Un kitty necesita un cerebro para pensar, y todavía no hay ningún modelo. Agrega uno en Ajustes (toma un minuto: elige un proveedor y pega su clave) y luego vuelve.",
  "{name} was created, but {why}": "{name} se creó, pero {why}",
  Name: "Nombre",
  "There is already a kitty called ": "Ya hay un kitty llamado ",
  ": pick another name.": ": elige otro nombre.",
  "It will be called ": "Se llamará ",
  " (lowercase letters, digits and dashes).": " (letras minúsculas, números y guiones).",
  "Who is it?": "¿Quién es?",
  "a planner who keeps the team on track": "alguien organizado que mantiene al equipo en marcha",
  "A line about its job and character. Empty makes a helpful all-rounder.":
    "Una línea sobre su trabajo y su carácter. Si lo dejas vacío, será un ayudante para todo.",
  "How does it talk?": "¿Cómo habla?",
  "calm and structured": "tranquilo y ordenado",
  Looks: "Aspecto",
  Brain: "Cerebro",
  "the default model": "el modelo predeterminado",
  "Let it use my connections ({list}, and the ones I add later)":
    "Dejar que use mis conexiones ({list}, y las que agregue después)",
  "Give it a computer of its own (a desktop with a browser it can use)":
    "Darle su propia computadora (un escritorio con un navegador que pueda usar)",
  "Needs Docker running on the gateway's machine. Without it the kitty still thinks, talks and uses connections.":
    "Necesita Docker funcionando en la máquina del gateway. Sin él, el kitty igual piensa, habla y usa conexiones.",
  "Docker is not installed on the gateway's machine. Install Docker Desktop to give kitties a computer; without it they still think, talk and use connections.":
    "Docker no está instalado en la máquina del gateway. Instala Docker Desktop para darles una computadora a los kitties; sin él igual piensan, hablan y usan conexiones.",
  "Docker is installed but not running. Open Docker Desktop and wait for it to start; the option unlocks by itself.":
    "Docker está instalado pero apagado. Abre Docker Desktop y espera a que inicie; la opción se habilita sola.",
  "Creating…": "Creando…",
  Create: "Crear",
  "a name": "un nombre",
  "a name no other kitty has": "un nombre que ningún otro kitty tenga",

  // Kitty: basics
  "{name} may use {connection}.": "{name} puede usar {connection}.",
  "{name} no longer uses {connection}.": "{name} ya no usa {connection}.",
  "{name} now thinks with {model}.": "{name} ahora piensa con {model}.",
  "no model": "sin modelo",
  Personality: "Personalidad",
  "Saved.": "Guardado.",
  "Save personality": "Guardar personalidad",
  Connections: "Conexiones",
  "None yet. Add services in Settings, Connections, and choose the kitties that may use them.":
    "Todavía ninguna. Agrega servicios en Ajustes, Conexiones, y elige qué kitties pueden usarlos.",
  "Every connection, including the ones you add later":
    "Todas las conexiones, incluidas las que agregues después",
  "{name} uses no connection.": "{name} no usa ninguna conexión.",
  "{name} may use every connection.": "{name} puede usar todas las conexiones.",
  "All, new ones too": "Todas, también las nuevas",

  // Kitty: drawer
  Configuration: "Configuración",
  "looks, brain, personality, connections, limits and memory":
    "aspecto, cerebro, personalidad, conexiones, límites y memoria",
  done: "listo",
  Desktop: "Escritorio",
  "brain only, no desktop": "solo cerebro, sin escritorio",
  refresh: "actualizar",
  "Chat with {name}": "Chatear con {name}",
  Start: "Iniciar",
  "Remove {name} and its container?": "¿Eliminar a {name} y su contenedor?",

  // Gateway connection
  "The address has to be like http://192.168.1.20:7488 or https://kitties.example.com.":
    "La dirección debe ser como http://192.168.1.20:7488 o https://kitties.example.com.",
  "This address is plain http: the token would travel unencrypted. Use https.":
    "Esta dirección es http sin cifrar: el token viajaría sin protección. Usa https.",
  "the address": "la dirección",
  "The app is a remote for the Kitties gateway running on your computer or server. Type its address on the network and its token.":
    "La app es un control remoto para el gateway de Kitties que corre en tu computadora o servidor. Escribe su dirección en la red y su token.",
  "Let the gateway listen on the network, not only on the computer:":
    "Haz que el gateway escuche en la red, no solo en la computadora:",
  " (or a server with HTTPS, see DEPLOY.md).": " (o un servidor con HTTPS, mira DEPLOY.md).",
  "The address is the computer's, like": "La dirección es la de la computadora, por ejemplo",
  "The token is in ": "El token está en ",
  " on that computer.": " en esa computadora.",
  "The address of the kitties gateway. On this machine the token is found on its own (the gateway leaves it in ":
    "La dirección del gateway de kitties. En esta máquina el token se encuentra solo (el gateway lo deja en ",
  "); a remote gateway needs the token it printed when it started.":
    "); un gateway remoto necesita el token que mostró al iniciar.",
  " Leave the address empty when this page is served by the gateway itself.":
    " Deja la dirección vacía cuando esta página la sirve el mismo gateway.",
  Address: "Dirección",
  " (optional)": " (opcional)",
  " (remote gateways only)": " (solo gateways remotos)",
  "paste the gateway's token": "pega el token del gateway",
  "found on this machine when empty": "si lo dejas vacío, se busca en esta máquina",
  Connect: "Conectar",
  Gateway: "Gateway",
};

export default dict;
