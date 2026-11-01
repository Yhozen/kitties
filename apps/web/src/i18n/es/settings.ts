import type { Dictionary } from "../../i18n";

// Settings: models, connections, notifications, preferences.
const dict: Dictionary = {
  // Tabs and dialog
  Settings: "Ajustes",
  Models: "Modelos",
  Connections: "Conexiones",
  Notifications: "Notificaciones",
  Gateway: "Gateway",
  Connection: "Conexión",
  Preferences: "Preferencias",
  "Loading…": "Cargando…",
  "Settings could not be drawn: {error}. The gateway may be older than this app: update it and reopen.":
    "No se pudieron mostrar los ajustes: {error}. Puede que el gateway sea más antiguo que esta app: actualízalo y vuelve a abrir.",
  "More options": "Más opciones",

  // Models
  "Models are the brains your kitties think with. Add one to start; you can add others later and give each kitty the one it should use.":
    "Los modelos son el cerebro con el que piensan tus kitties. Agrega uno para empezar; después puedes agregar otros y darle a cada kitty el que deba usar.",
  "No model yet": "Todavía no hay ningún modelo",
  "Your kitties need a brain to think with. Add one from a provider you have an account with, or Ollama to run free models on this computer.":
    "Tus kitties necesitan un cerebro para pensar. Agrega uno de un proveedor donde tengas cuenta, u Ollama para usar modelos gratis en esta computadora.",
  "Add a model": "Agregar un modelo",
  "Which provider?": "¿Qué proveedor?",
  "Pick where the brain comes from. Pay with an API key, or sign in with a subscription you already have (Claude, ChatGPT, GitHub Copilot). Ollama on this computer is free.":
    "Elige de dónde viene el cerebro. Paga con una clave de API o inicia sesión con una suscripción que ya tengas (Claude, ChatGPT, GitHub Copilot). Ollama en esta computadora es gratis.",
  "API key or your {plan}": "Clave de API o tu {plan}",
  "{name} answered: it works.": "{name} respondió: funciona.",
  "it did not answer": "no respondió",
  "the API key": "la clave de API",
  "sign in": "iniciar sesión",
  "the model": "el modelo",
  change: "cambiar",
  "How to pay for it": "Cómo pagarlo",
  "API key": "Clave de API",
  "Pay per use with a key": "Paga por uso con una clave",
  "Not available": "No disponible",
  "Sign in with your subscription": "Inicia sesión con tu suscripción",
  " (if the server asks for one)": " (si el servidor la pide)",
  "saved: leave empty to keep it": "guardada: déjalo vacío para conservarla",
  "The provider refused this key: check that it is complete and still valid.":
    "El proveedor rechazó esta clave: revisa que esté completa y siga vigente.",
  "Check key": "Comprobar clave",
  "Key accepted: {n} models available.": "Clave aceptada: {n} modelos disponibles.",
  "paste the key here": "pega la clave aquí",
  "Kept on your gateway and never shown again.":
    "Se guarda en tu gateway y no se vuelve a mostrar.",
  "Get a key from {name} ↗": "Consigue una clave de {name} ↗",
  "Server address": "Dirección del servidor",
  "Leave it empty when Ollama runs on this computer. ":
    "Déjala vacía si Ollama funciona en esta computadora. ",
  "The address of the server's API, usually ending in /v1. ":
    "La dirección de la API del servidor, que suele terminar en /v1. ",
  "Download Ollama ↗": "Descargar Ollama ↗",
  Model: "Modelo",
  "model name": "nombre del modelo",
  "Not sure? Keep the suggested one.": "¿No estás seguro? Deja el sugerido.",
  "Name in Kitties": "Nombre en Kitties",
  "How the kitties and the configuration file call it.":
    "Cómo lo llaman los kitties y el archivo de configuración.",
  "Only to reach it through a proxy or a compatible service.":
    "Solo para llegar a él a través de un proxy o un servicio compatible.",
  "Longest answer (tokens)": "Respuesta más larga (tokens)",
  "Saved, but the test did not pass: ": "Se guardó, pero la prueba no pasó: ",
  "Change something": "Cambiar algo",
  "Saved without a passing test.": "Se guardó sin pasar la prueba.",
  "Keep it anyway": "Conservarlo igual",
  "Saving…": "Guardando…",
  "Checking…": "Comprobando…",
  "Save and test": "Guardar y probar",
  "✓ It answered: it works.": "✓ Respondió: funciona.",
  "no answer": "sin respuesta",
  "{names} will switch to another model.": "Se le asignará otro modelo a {names}.",
  "No kitty uses it.": "Ningún kitty lo usa.",
  "Remove {name} ({model})? {what}": "¿Eliminar {name} ({model})? {what}",
  default: "predeterminado",
  "Used by {names}": "En uso por {names}",
  "No kitty uses it yet": "Ningún kitty lo usa todavía",
  " · from the configuration file": " · del archivo de configuración",
  "Testing…": "Probando…",
  Test: "Probar",
  "Make default": "Hacer predeterminado",
  "Edit {name}": "Editar {name}",
  Edit: "Editar",
  "Remove {name}": "Eliminar {name}",

  // Connections
  "Connections let your kitties act in other services: send messages, read email, open issues, post. You choose which kitties may use each one, and they act as far as each account allows. To have a kitty ask you first, or never do something, tell it, or set it in its limits.":
    "Las conexiones permiten que tus kitties actúen en otros servicios: enviar mensajes, leer correos, abrir issues, publicar. Tú eliges qué kitties pueden usar cada una, y actúan hasta donde lo permita cada cuenta. Para que un kitty te pregunte primero, o nunca haga algo, díselo o ponlo en sus límites.",
  "Your connections": "Tus conexiones",
  "None yet: pick a service below.": "Todavía ninguna: elige un servicio abajo.",
  "Add a connection": "Agregar una conexión",
  "Saved: now sign in.": "Guardada: ahora inicia sesión.",
  "{name} is saved: testing it…": "{name} se guardó: probando…",
  "Search services": "Buscar servicios",
  "Search: Slack, Gmail, GitHub, Stripe…": "Buscar: Slack, Gmail, GitHub, Stripe…",
  All: "Todos",
  "Nothing matches: try another word.": "No hay coincidencias: prueba con otra palabra.",
  "Sign in with {name}": "Iniciar sesión con {name}",
  "App keys": "Claves de la app",
  Webhook: "Webhook",
  "Bot token": "Token del bot",
  "Access token": "Token de acceso",
  "API token": "Token de API",
  "API key or token": "Clave de API o token",
  "Allow Kitties in your browser": "Permite Kitties en tu navegador",
  "Through an app of yours": "A través de una app tuya",
  "Four keys from your app's page; they do not expire":
    "Cuatro claves de la página de tu app; no vencen",
  "Posts to one channel, nothing to sign in": "Publica en un canal, sin iniciar sesión",
  "Created in the service's settings": "Se crea en los ajustes del servicio",
  " (optional)": " (opcional)",
  "Keep the saved one": "Conservar la guardada",
  Clear: "Borrar",
  "removed when you save": "se borra al guardar",
  "Sign out of {name}? The kitties stop using this account.":
    "¿Cerrar sesión en {name}? Los kitties dejarán de usar esta cuenta.",
  "Sign out": "Cerrar sesión",
  "How do you connect?": "¿Cómo te conectas?",
  easiest: "lo más fácil",
  "✓ Signed in as {account}. The kitties use this account.":
    "✓ Sesión iniciada como {account}. Los kitties usan esta cuenta.",
  "✓ Signed in. The kitties use this account.": "✓ Sesión iniciada. Los kitties usan esta cuenta.",
  "Sign in again": "Volver a iniciar sesión",
  "{name} needs an app of your own for now: add this callback address to it, then paste its client id (and its secret, if it has one).":
    "Por ahora, {name} necesita una app tuya: agrégale esta dirección de retorno y luego pega su client id (y su secreto, si tiene).",
  "Waiting for the browser…": "Esperando al navegador…",
  "Finish signing in in your browser; this changes by itself.":
    "Termina de iniciar sesión en tu navegador; esto se actualiza solo.",
  "Sign in and allow Kitties. Nothing to copy.":
    "Inicia sesión y permite Kitties. No hay nada que copiar.",
  "It opens your browser; this page follows by itself.":
    "Se abre tu navegador; esta página se actualiza sola.",
  "Use an app of your own": "Usar una app tuya",
  "Its callback address:": "Su dirección de retorno:",
  "The token pasted here has expired: it lasts a short time. Sign in, or":
    "El token que pegaste aquí venció: dura poco tiempo. Inicia sesión, o",
  "use the app keys, which do not expire": "usa las claves de la app, que no vencen",
  "paste a new one": "pega uno nuevo",
  ", and clear the old token so it does not stand in the way.":
    ", y borra el token viejo para que no estorbe.",
  "Which kitties may use it": "Qué kitties pueden usarla",
  "What the kitties can do with it": "Lo que los kitties pueden hacer con ella",
  "What the kitties are told it is for": "Para qué les dices a los kitties que sirve",
  "uses the OAuth 1.0 keys": "usa las claves OAuth 1.0",
  "uses a token": "usa un token",
  "uses a webhook": "usa un webhook",
  "token expired": "token vencido",
  "token expires in {time}": "el token vence en {time}",
  "signed in": "sesión iniciada",
  "sign in needed": "falta iniciar sesión",
  "What the kitties use to reach the account": "Lo que usan los kitties para entrar a la cuenta",
  "A pasted token of this service lasts a short time: sign in, or use keys that do not expire":
    "Un token pegado de este servicio dura poco tiempo: inicia sesión o usa claves que no vencen",
  "No kitty may use it yet": "Ningún kitty puede usarla todavía",
  "✗ It does not work: {error}": "✗ No funciona: {error}",
  "✓ It works as {account}.": "✓ Funciona como {account}.",
  "✓ It works.": "✓ Funciona.",
  "It cannot be tested without acting: it is tried the first time a kitty uses it.":
    "No se puede probar sin hacer algo: se prueba la primera vez que un kitty la usa.",
  "Sign in": "Iniciar sesión",
  "Remove the connection {name}? The kitties lose it too.":
    "¿Eliminar la conexión {name}? Los kitties también la pierden.",

  // Notifications
  "A kitty gave up and needs my help": "Un kitty se rindió y necesita mi ayuda",
  "An action is waiting for my yes": "Una acción espera mi aprobación",
  "A goal finished": "Se terminó un objetivo",
  "A goal could not finish": "Un objetivo no se pudo terminar",
  "A kitty's container was brought back": "Se recuperó el contenedor de un kitty",
  "A kitty spent its day's tokens": "Un kitty gastó los tokens de su día",
  "Saved.": "Guardado.",
  "Sent: look at your phone or channel.": "Enviado: mira tu teléfono o tu canal.",
  "It did not go through.": "No se pudo enviar.",
  "Summary sent.": "Resumen enviado.",
  "The summary did not go through.": "No se pudo enviar el resumen.",
  "The kitties work while you are away. Choose how they reach you outside this window: a push to your phone is the quickest, and Telegram, Slack or email work too.":
    "Los kitties trabajan mientras no estás. Elige cómo te avisan fuera de esta ventana: una notificación en tu teléfono es lo más rápido, y también sirven Telegram, Slack o el correo.",
  "Get alerts on your phone": "Recibe avisos en tu teléfono",
  "Install the free ntfy app on your phone, choose a topic name and subscribe to it. Then connect the same topic here.":
    "Instala la app gratuita ntfy en tu teléfono, elige un nombre de tema y suscríbete. Luego conecta ese mismo tema aquí.",
  "Set up phone notifications": "Configurar notificaciones en el teléfono",
  "Send through": "Enviar por",
  "nowhere: notifications are off": "ningún lado: las notificaciones están apagadas",
  "Tell me when": "Avísame cuando",
  "A summary of the last day, every day at": "Un resumen del último día, todos los días a las",
  none: "ninguno",
  "Send one now": "Enviar uno ahora",
  "What each kitty did, what it spent, and what waits for your yes. Leave it empty for no summary.":
    "Lo que hizo cada kitty, lo que gastó y lo que espera tu aprobación. Déjalo vacío para no recibir resumen.",
  "Start it with my day: what is on the calendar, the reminders still to do and the weather, from my connections (calendar, reminders, weather).":
    "Empezar con mi día: lo que hay en el calendario, los recordatorios pendientes y el clima, desde mis conexiones (calendario, recordatorios, clima).",
  "Send a test": "Enviar una prueba",

  // Preferences
  "Show technical details": "Mostrar detalles técnicos",
  "What a kitty did exactly (coordinates, commands, results), the tokens each answer used, and errors as the services wrote them.":
    "Lo que hizo un kitty exactamente (coordenadas, comandos, resultados), los tokens que usó cada respuesta y los errores tal como los escribieron los servicios.",
  Language: "Idioma",
  "The system's language is used until you pick one.":
    "Se usa el idioma del sistema hasta que elijas uno.",
  "A desktop or Kitties was updated, or a new version is waiting":
    "Se actualizó un escritorio o Kitties, o espera una versión nueva",
  "Kitties did not come back in a minute: restart it by hand.":
    "Kitties no volvió en un minuto: reinícialo a mano.",
  "Update Kitties to {version}? It restarts in a moment; the kitties' desktops keep running.":
    "¿Actualizar Kitties a {version}? Se reinicia en un momento; los escritorios de los kitties siguen funcionando.",
  "Kitties {version}": "Kitties {version}",
  "it is the newest version": "es la versión más nueva",
  "Kitties {version} is available.": "Kitties {version} está disponible.",
  "Update and restart": "Actualizar y reiniciar",
  "Updated to {version}: restarting…": "Actualizado a {version}: reiniciando…",
  "Look for a new version": "Buscar una versión nueva",
  "Looked {when}.": "Buscada {when}.",
  "Kitties does not look for new versions: turn it on with updates.gateway in the configuration.":
    "Kitties no busca versiones nuevas: actívalo con updates.gateway en la configuración.",
  "Kitties looks for new versions and installs them by itself when nothing is in use.":
    "Kitties busca versiones nuevas y las instala solo cuando nada está en uso.",
  "Kitties looks for new versions and tells you; you decide when to update.":
    "Kitties busca versiones nuevas y te avisa; tú decides cuándo actualizar.",
  "This update is checked against its checksums only, which do not say who made it: set updates.public_key to require the release key's signature.":
    "Esta actualización se comprueba solo con sus sumas de verificación, que no dicen quién la hizo: define updates.public_key para exigir la firma de la clave de los releases.",
  "{version} did not hold here and Kitties went back to {current}: it is not offered again.":
    "{version} no se sostuvo aquí y Kitties volvió a {current}: no se ofrece de nuevo.",
};

export default dict;
