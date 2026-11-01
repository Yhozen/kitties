import type { Dictionary } from "../../i18n";

// What the gateway writes into a chat, and the notes about a kitty's own limits.
const dict: Dictionary = {
  "Limit set: {target} · {mode}": "Limite definido: {target} · {mode}",
  "Limit lifted: {target}": "Limite removido: {target}",
  undone: "desfeito",
  Undo: "Desfazer",
  "({name} could not answer: {why})": "({name} não conseguiu responder: {why})",
  "({name} could not finish: {why})": "({name} não conseguiu terminar: {why})",
  "({name} needs help: {why})": "({name} precisa de ajuda: {why})",
  "(attempt {n} failed: {why}; trying another way)":
    "(a tentativa {n} falhou: {why}; tentando de outro jeito)",
  "({name} finished without a word)": "({name} terminou sem dizer nada)",
  "({name} had nothing to add)": "({name} não tinha nada a acrescentar)",
  "Approved and done: {what}": "Aprovado e feito: {what}",
  "Approved, but it failed: {what}": "Aprovado, mas falhou: {what}",
  "Rejected: {what}": "Recusado: {what}",
  "Reason: {why}": "Motivo: {why}",
  "Handed over to {name}, who answered:": "Passei para {name}, que respondeu:",
  "(From now on this kind of action goes ahead without asking.)":
    "(A partir de agora esse tipo de ação é feito sem perguntar.)",
  "the service did not accept the key or the sign-in: connect it again in Settings, Connections":
    "o serviço não aceitou a chave ou o login: conecte de novo em Configurações, Conexões",
  "the account is not allowed to do that: its permissions or its plan do not include it":
    "a conta não tem permissão para isso: as permissões ou o plano dela não incluem",
  "the service did not find it": "o serviço não encontrou",
  "the service asks to wait a moment: too many requests in a short time":
    "o serviço pede para esperar um pouco: muitas solicitações em pouco tempo",
  "the service is having trouble right now: try again in a while":
    "o serviço está com problemas agora: tente de novo daqui a pouco",
  "the account is not connected any more: sign in again in Settings, Connections":
    "a conta não está mais conectada: entre de novo em Configurações, Conexões",
  "it was stopped": "foi interrompido",
  "the service took too long to answer: try again in a while":
    "o serviço demorou demais para responder: tente de novo daqui a pouco",
  "the service could not be reached: check the internet connection, or that it is running":
    "não foi possível chegar ao serviço: confira a conexão com a internet, ou se ele está funcionando",
};

export default dict;
