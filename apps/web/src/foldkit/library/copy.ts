import type { Language } from "./model.ts";

const english = {
  title: "Library",
  description: "Only accepted skills become part of your puppies’ instructions.",
  skills: "Your skills",
  empty: "No skills yet. Propose your first instructions below.",
  propose: "Propose skill",
  name: "Name",
  instructions: "Instructions",
  nameHelp: "Use a name with 1–80 characters, including a visible character.",
  bodyHelp: "Up to 64,000 characters. Review before accepting.",
  accepted: "Accepted",
  proposed: "Proposed",
  removed: "Removed",
  review: "Review",
  accept: "Accept",
  remove: "Remove",
  detail: "Review instructions",
  choose: "Choose a skill to review its full instructions.",
  missing: "This skill is no longer available.",
  loading: "Loading the library…",
  reading: "Loading confirmed instructions…",
  connected: "Live library",
  offline: "Connection interrupted. Changes are disabled; your draft is kept in this screen.",
  reconnect: "Reconnect",
  reconnecting: "Connecting…",
  unknown: "The result is unknown. Retry the same request to find out whether it was saved.",
  retry: "Retry same request",
  sending: "Sending request…",
  confirming: "Saved. Waiting for the current library…",
  saved: "Saved to your library.",
  rejected: "The library refused this request. Review the latest instructions before trying again.",
  invalid: "Check the name and instructions before proposing.",
  counter: "This screen needs to be reopened before sending another request.",
  expired: "Your session needs authentication. Changes are disabled and your draft is kept.",
  signingIn: "Waiting for authentication…",
  signIn: "Sign in again",
  changed:
    "The library authority changed. Reopen the library in the current session; this request will not be replayed into it.",
  denied: "Authentication was denied. Sign in with the library owner account.",
  unavailable: "Authentication is unavailable. Your draft and unresolved request are kept.",
  notReady: "The library is not ready yet. Reconnect after its import completes.",
  detailError:
    "Instructions could not be confirmed. Reconnect to review them before changing this skill.",
};

type Copy = typeof english;

const spanish: Copy = {
  title: "Biblioteca",
  description: "Solo las habilidades aceptadas forman parte de las instrucciones de tus perritos.",
  skills: "Tus habilidades",
  empty: "Aún no hay habilidades. Propón tus primeras instrucciones abajo.",
  propose: "Proponer habilidad",
  name: "Nombre",
  instructions: "Instrucciones",
  nameHelp: "Usa un nombre de 1 a 80 caracteres, con al menos un carácter visible.",
  bodyHelp: "Hasta 64.000 caracteres. Revísalas antes de aceptar.",
  accepted: "Aceptada",
  proposed: "Propuesta",
  removed: "Eliminada",
  review: "Revisar",
  accept: "Aceptar",
  remove: "Eliminar",
  detail: "Revisar instrucciones",
  choose: "Elige una habilidad para revisar todas sus instrucciones.",
  missing: "Esta habilidad ya no está disponible.",
  loading: "Cargando la biblioteca…",
  reading: "Cargando instrucciones confirmadas…",
  connected: "Biblioteca en directo",
  offline:
    "Se interrumpió la conexión. Los cambios están desactivados; tu borrador sigue en esta pantalla.",
  reconnect: "Reconectar",
  reconnecting: "Conectando…",
  unknown: "Se desconoce el resultado. Reintenta la misma solicitud para saber si se guardó.",
  retry: "Reintentar la misma solicitud",
  sending: "Enviando solicitud…",
  confirming: "Guardado. Esperando la biblioteca actual…",
  saved: "Guardado en tu biblioteca.",
  rejected:
    "La biblioteca rechazó esta solicitud. Revisa las instrucciones actuales antes de volver a intentarlo.",
  invalid: "Revisa el nombre y las instrucciones antes de proponer.",
  counter: "Vuelve a abrir esta pantalla antes de enviar otra solicitud.",
  expired:
    "Tu sesión necesita autenticación. Los cambios están desactivados y tu borrador se conserva.",
  signingIn: "Esperando la autenticación…",
  signIn: "Volver a iniciar sesión",
  changed:
    "Cambió la autoridad de la biblioteca. Ábrela de nuevo en la sesión actual; esta solicitud no se repetirá en ella.",
  denied: "Autenticación denegada. Inicia sesión con la cuenta propietaria de la biblioteca.",
  unavailable:
    "La autenticación no está disponible. Se conservan tu borrador y la solicitud pendiente.",
  notReady: "La biblioteca aún no está lista. Reconecta cuando termine la importación.",
  detailError:
    "No se pudieron confirmar las instrucciones. Reconecta para revisarlas antes de cambiar esta habilidad.",
};

const portuguese: Copy = {
  title: "Biblioteca",
  description: "Apenas habilidades aceitas fazem parte das instruções dos seus cachorrinhos.",
  skills: "Suas habilidades",
  empty: "Ainda não há habilidades. Proponha suas primeiras instruções abaixo.",
  propose: "Propor habilidade",
  name: "Nome",
  instructions: "Instruções",
  nameHelp: "Use um nome de 1 a 80 caracteres, com pelo menos um caractere visível.",
  bodyHelp: "Até 64.000 caracteres. Revise antes de aceitar.",
  accepted: "Aceita",
  proposed: "Proposta",
  removed: "Removida",
  review: "Revisar",
  accept: "Aceitar",
  remove: "Remover",
  detail: "Revisar instruções",
  choose: "Escolha uma habilidade para revisar todas as instruções.",
  missing: "Esta habilidade não está mais disponível.",
  loading: "Carregando a biblioteca…",
  reading: "Carregando instruções confirmadas…",
  connected: "Biblioteca ao vivo",
  offline:
    "A conexão foi interrompida. As alterações estão desativadas; seu rascunho continua nesta tela.",
  reconnect: "Reconectar",
  reconnecting: "Conectando…",
  unknown: "O resultado é desconhecido. Repita a mesma solicitação para saber se foi salva.",
  retry: "Repetir a mesma solicitação",
  sending: "Enviando solicitação…",
  confirming: "Salvo. Aguardando a biblioteca atual…",
  saved: "Salvo na sua biblioteca.",
  rejected:
    "A biblioteca recusou esta solicitação. Revise as instruções atuais antes de tentar novamente.",
  invalid: "Confira o nome e as instruções antes de propor.",
  counter: "Reabra esta tela antes de enviar outra solicitação.",
  expired:
    "Sua sessão precisa de autenticação. As alterações estão desativadas e seu rascunho foi mantido.",
  signingIn: "Aguardando autenticação…",
  signIn: "Entrar novamente",
  changed:
    "A autoridade da biblioteca mudou. Reabra a biblioteca na sessão atual; esta solicitação não será repetida nela.",
  denied: "Autenticação negada. Entre com a conta proprietária da biblioteca.",
  unavailable:
    "A autenticação está indisponível. Seu rascunho e a solicitação pendente foram mantidos.",
  notReady: "A biblioteca ainda não está pronta. Reconecte após a importação terminar.",
  detailError:
    "Não foi possível confirmar as instruções. Reconecte para revisá-las antes de alterar esta habilidade.",
};

export const copy = (language: Language): Copy =>
  ({ en: english, es: spanish, pt: portuguese })[language];
