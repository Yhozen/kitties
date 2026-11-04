import type { Dictionary } from "../../i18n";

// What the gateway writes into a chat, and the notes about a kitty's own limits.
const dict: Dictionary = {
  "Limit set: {target} · {mode}": "Límite puesto: {target} · {mode}",
  "Limit lifted: {target}": "Límite quitado: {target}",
  undone: "deshecho",
  Undo: "Deshacer",
  "({name} could not answer: {why})": "({name} no pudo responder: {why})",
  "({name} could not finish: {why})": "({name} no pudo terminar: {why})",
  "({name} needs help: {why})": "({name} necesita ayuda: {why})",
  "(attempt {n} failed: {why}; trying another way)":
    "(el intento {n} falló: {why}; probando de otra forma)",
  "({name} finished without a word)": "({name} terminó sin decir nada)",
  "({name} had nothing to add)": "({name} no tenía nada que agregar)",
  "Approved and done: {what}": "Aprobado y hecho: {what}",
  "Approved, but it failed: {what}": "Aprobado, pero falló: {what}",
  "Rejected: {what}": "Rechazado: {what}",
  "Reason: {why}": "Motivo: {why}",
  "Handed over to {name}, who answered:": "Se lo pasé a {name}, que respondió:",
  "(From now on this kind of action goes ahead without asking.)":
    "(Desde ahora este tipo de acción se hace sin preguntar.)",
  "the service did not accept the key or the sign-in: connect it again in Settings, Connections":
    "el servicio no aceptó la clave o el inicio de sesión: vuelve a conectarlo en Ajustes, Conexiones",
  "the account is not allowed to do that: its permissions or its plan do not include it":
    "la cuenta no tiene permiso para eso: sus permisos o su plan no lo incluyen",
  "the service did not find it": "el servicio no lo encontró",
  "the service asks to wait a moment: too many requests in a short time":
    "el servicio pide esperar un momento: demasiadas solicitudes en poco tiempo",
  "the service is having trouble right now: try again in a while":
    "el servicio tiene problemas ahora mismo: inténtalo de nuevo en un rato",
  "the account is not connected any more: sign in again in Settings, Connections":
    "la cuenta ya no está conectada: vuelve a iniciar sesión en Ajustes, Conexiones",
  "it was stopped": "se detuvo",
  "the service took too long to answer: try again in a while":
    "el servicio tardó demasiado en responder: inténtalo de nuevo en un rato",
  "the service could not be reached: check the internet connection, or that it is running":
    "no se pudo llegar al servicio: revisa la conexión a internet, o que esté funcionando",
};

export default dict;
