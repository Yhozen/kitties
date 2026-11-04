import type { Dictionary } from "../../i18n";

// Settings: models, connections, notifications, preferences.
const dict: Dictionary = {
  // Tabs and dialog
  Settings: "Configurações",
  Models: "Modelos",
  Connections: "Conexões",
  Notifications: "Notificações",
  Gateway: "Gateway",
  Connection: "Conexão",
  Preferences: "Preferências",
  "Loading…": "Carregando…",
  "Settings could not be drawn: {error}. The gateway may be older than this app: update it and reopen.":
    "Não deu para mostrar as configurações: {error}. Talvez o gateway seja mais antigo que este app: atualize-o e abra de novo.",
  "More options": "Mais opções",

  // Models
  "Models are the brains your puppies think with. Add one to start; you can add others later and give each puppy the one it should use.":
    "Os modelos são o cérebro com que seus cachorrinhos pensam. Adicione um para começar; depois você pode adicionar outros e dar a cada cachorrinho o que ele deve usar.",
  "No model yet": "Nenhum modelo ainda",
  "Your puppies need a brain to think with. Add one from a provider you have an account with, or Ollama to run free models on this computer.":
    "Seus cachorrinhos precisam de um cérebro para pensar. Adicione um de um provedor onde você tem conta, ou o Ollama para usar modelos grátis neste computador.",
  "Add a model": "Adicionar um modelo",
  "Which provider?": "Qual provedor?",
  "Pick where the brain comes from. Pay with an API key, or sign in with a subscription you already have (Claude, ChatGPT, GitHub Copilot). Ollama on this computer is free.":
    "Escolha de onde vem o cérebro. Pague com uma chave de API ou entre com uma assinatura que você já tem (Claude, ChatGPT, GitHub Copilot). O Ollama neste computador é grátis.",
  "API key or your {plan}": "Chave de API ou seu {plan}",
  "{name} answered: it works.": "{name} respondeu: funciona.",
  "it did not answer": "não respondeu",
  "the API key": "a chave de API",
  "sign in": "entrar",
  "the model": "o modelo",
  change: "mudar",
  "How to pay for it": "Como pagar",
  "API key": "Chave de API",
  "Pay per use with a key": "Pague pelo uso com uma chave",
  "Not available": "Não disponível",
  "Sign in with your subscription": "Entre com sua assinatura",
  " (if the server asks for one)": " (se o servidor pedir)",
  "saved: leave empty to keep it": "salva: deixe vazio para manter",
  "The provider refused this key: check that it is complete and still valid.":
    "O provedor recusou esta chave: confira se está completa e ainda é válida.",
  "Check key": "Verificar chave",
  "Key accepted: {n} models available.": "Chave aceita: {n} modelos disponíveis.",
  "paste the key here": "cole a chave aqui",
  "Kept on your gateway and never shown again.":
    "Fica guardada no seu gateway e não aparece de novo.",
  "Get a key from {name} ↗": "Pegue uma chave em {name} ↗",
  "Server address": "Endereço do servidor",
  "Leave it empty when Ollama runs on this computer. ":
    "Deixe vazio se o Ollama roda neste computador. ",
  "The address of the server's API, usually ending in /v1. ":
    "O endereço da API do servidor, que costuma terminar em /v1. ",
  "Download Ollama ↗": "Baixar o Ollama ↗",
  Model: "Modelo",
  "model name": "nome do modelo",
  "Not sure? Keep the suggested one.": "Na dúvida? Fique com o sugerido.",
  "Name in Puppies": "Nome no Puppies",
  "How the puppies and the configuration file call it.":
    "Como os cachorrinhos e o arquivo de configuração o chamam.",
  "Only to reach it through a proxy or a compatible service.":
    "Só para chegar a ele por um proxy ou um serviço compatível.",
  "Longest answer (tokens)": "Resposta mais longa (tokens)",
  "Saved, but the test did not pass: ": "Salvo, mas o teste não passou: ",
  "Change something": "Mudar algo",
  "Saved without a passing test.": "Salvo sem passar no teste.",
  "Keep it anyway": "Manter mesmo assim",
  "Saving…": "Salvando…",
  "Checking…": "Verificando…",
  "Save and test": "Salvar e testar",
  "✓ It answered: it works.": "✓ Respondeu: funciona.",
  "no answer": "sem resposta",
  "{names} will switch to another model.": "{names} vai passar para outro modelo.",
  "No puppy uses it.": "Nenhum cachorrinho usa.",
  "Remove {name} ({model})? {what}": "Remover {name} ({model})? {what}",
  default: "padrão",
  "Used by {names}": "Usado por {names}",
  "No puppy uses it yet": "Nenhum cachorrinho usa ainda",
  " · from the configuration file": " · do arquivo de configuração",
  "Testing…": "Testando…",
  Test: "Testar",
  "Make default": "Tornar padrão",
  "Edit {name}": "Editar {name}",
  Edit: "Editar",
  "Remove {name}": "Remover {name}",

  // Connections
  "Connections let your puppies act in other services: send messages, read email, open issues, post. You choose which puppies may use each one, and they act as far as each account allows. To have a puppy ask you first, or never do something, tell it, or set it in its limits.":
    "As conexões deixam seus cachorrinhos agir em outros serviços: mandar mensagens, ler e-mails, abrir issues, publicar. Você escolhe quais cachorrinhos podem usar cada uma, e eles agem até onde cada conta permite. Para um cachorrinho perguntar antes, ou nunca fazer algo, diga isso a ele ou coloque nos limites dele.",
  "Your connections": "Suas conexões",
  "None yet: pick a service below.": "Nenhuma ainda: escolha um serviço abaixo.",
  "Add a connection": "Adicionar uma conexão",
  "Saved: now sign in.": "Salva: agora entre.",
  "{name} is saved: testing it…": "{name} foi salva: testando…",
  "Search services": "Buscar serviços",
  "Search: Slack, Gmail, GitHub, Stripe…": "Buscar: Slack, Gmail, GitHub, Stripe…",
  All: "Todos",
  "Nothing matches: try another word.": "Nada encontrado: tente outra palavra.",
  "Sign in with {name}": "Entrar com {name}",
  "App keys": "Chaves do app",
  Webhook: "Webhook",
  "Bot token": "Token do bot",
  "Access token": "Token de acesso",
  "API token": "Token de API",
  "API key or token": "Chave de API ou token",
  "Allow Puppies in your browser": "Permita o Puppies no seu navegador",
  "Through an app of yours": "Por um app seu",
  "Four keys from your app's page; they do not expire":
    "Quatro chaves da página do seu app; elas não expiram",
  "Posts to one channel, nothing to sign in": "Publica em um canal, sem precisar entrar",
  "Created in the service's settings": "Criado nas configurações do serviço",
  " (optional)": " (opcional)",
  "Keep the saved one": "Manter a salva",
  Clear: "Limpar",
  "removed when you save": "é removido ao salvar",
  "Sign out of {name}? The puppies stop using this account.":
    "Sair de {name}? Os cachorrinhos vão parar de usar esta conta.",
  "Sign out": "Sair",
  "How do you connect?": "Como você se conecta?",
  easiest: "o mais fácil",
  "✓ Signed in as {account}. The puppies use this account.":
    "✓ Você entrou como {account}. Os cachorrinhos usam esta conta.",
  "✓ Signed in. The puppies use this account.": "✓ Você entrou. Os cachorrinhos usam esta conta.",
  "Sign in again": "Entrar de novo",
  "{name} needs an app of your own for now: add this callback address to it, then paste its client id (and its secret, if it has one).":
    "Por enquanto, {name} precisa de um app seu: adicione este endereço de retorno nele e depois cole o client id (e o secret, se tiver).",
  "Waiting for the browser…": "Esperando o navegador…",
  "Finish signing in in your browser; this changes by itself.":
    "Termine de entrar no seu navegador; isto se atualiza sozinho.",
  "Sign in and allow Puppies. Nothing to copy.": "Entre e permita o Puppies. Nada para copiar.",
  "It opens your browser; this page follows by itself.":
    "Seu navegador vai abrir; esta página acompanha sozinha.",
  "Use an app of your own": "Usar um app seu",
  "Its callback address:": "O endereço de retorno dele:",
  "The token pasted here has expired: it lasts a short time. Sign in, or":
    "O token colado aqui expirou: ele dura pouco tempo. Entre, ou",
  "use the app keys, which do not expire": "use as chaves do app, que não expiram",
  "paste a new one": "cole um novo",
  ", and clear the old token so it does not stand in the way.":
    ", e limpe o token antigo para ele não atrapalhar.",
  "Which puppies may use it": "Quais cachorrinhos podem usar",
  "What the puppies can do with it": "O que os cachorrinhos podem fazer com ela",
  "What the puppies are told it is for": "Para que você diz aos cachorrinhos que ela serve",
  "uses the OAuth 1.0 keys": "usa as chaves OAuth 1.0",
  "uses a token": "usa um token",
  "uses a webhook": "usa um webhook",
  "token expired": "token expirado",
  "token expires in {time}": "o token expira em {time}",
  "signed in": "você entrou",
  "sign in needed": "precisa entrar",
  "What the puppies use to reach the account": "O que os cachorrinhos usam para acessar a conta",
  "A pasted token of this service lasts a short time: sign in, or use keys that do not expire":
    "Um token colado deste serviço dura pouco tempo: entre, ou use chaves que não expiram",
  "No puppy may use it yet": "Nenhum cachorrinho pode usar ainda",
  "✗ It does not work: {error}": "✗ Não funciona: {error}",
  "✓ It works as {account}.": "✓ Funciona como {account}.",
  "✓ It works.": "✓ Funciona.",
  "It cannot be tested without acting: it is tried the first time a puppy uses it.":
    "Não dá para testar sem fazer algo de verdade: ela é testada na primeira vez que um cachorrinho a usar.",
  "Sign in": "Entrar",
  "Remove the connection {name}? The puppies lose it too.":
    "Remover a conexão {name}? Os cachorrinhos também a perdem.",

  // Notifications
  "A puppy gave up and needs my help": "Um cachorrinho desistiu e precisa da minha ajuda",
  "An action is waiting for my yes": "Uma ação está esperando o meu sim",
  "A goal finished": "Um objetivo terminou",
  "A goal could not finish": "Um objetivo não conseguiu terminar",
  "A puppy's container was brought back": "O contêiner de um cachorrinho foi recuperado",
  "A puppy spent its day's tokens": "Um cachorrinho gastou os tokens do dia",
  "Saved.": "Salvo.",
  "Sent: look at your phone or channel.": "Enviado: olhe seu celular ou seu canal.",
  "It did not go through.": "Não foi enviado.",
  "Summary sent.": "Resumo enviado.",
  "The summary did not go through.": "O resumo não foi enviado.",
  "The puppies work while you are away. Choose how they reach you outside this window: a push to your phone is the quickest, and Telegram, Slack or email work too.":
    "Os cachorrinhos trabalham enquanto você está fora. Escolha como eles falam com você fora desta janela: uma notificação no celular é o mais rápido, e Telegram, Slack ou e-mail também servem.",
  "Get alerts on your phone": "Receba alertas no celular",
  "Install the free ntfy app on your phone, choose a topic name and subscribe to it. Then connect the same topic here.":
    "Instale o app grátis ntfy no seu celular, escolha um nome de tópico e se inscreva nele. Depois conecte o mesmo tópico aqui.",
  "Set up phone notifications": "Configurar notificações no celular",
  "Send through": "Enviar por",
  "nowhere: notifications are off": "nenhum lugar: as notificações estão desligadas",
  "Tell me when": "Me avise quando",
  "A summary of the last day, every day at": "Um resumo do último dia, todo dia às",
  none: "nenhum",
  "Send one now": "Enviar um agora",
  "What each puppy did, what it spent, and what waits for your yes. Leave it empty for no summary.":
    "O que cada cachorrinho fez, o que gastou e o que espera o seu sim. Deixe vazio para não receber resumo.",
  "Start it with my day: what is on the calendar, the reminders still to do and the weather, from my connections (calendar, reminders, weather).":
    "Começar com o meu dia: o que tem na agenda, os lembretes pendentes e o tempo, das minhas conexões (agenda, lembretes, tempo).",
  "Send a test": "Enviar um teste",

  // Preferences
  "Show technical details": "Mostrar detalhes técnicos",
  "What a puppy did exactly (coordinates, commands, results), the tokens each answer used, and errors as the services wrote them.":
    "O que um cachorrinho fez exatamente (coordenadas, comandos, resultados), os tokens que cada resposta usou e os erros do jeito que os serviços escreveram.",
  Language: "Idioma",
  "The system's language is used until you pick one.":
    "O idioma do sistema é usado até você escolher um.",
  "A desktop or Puppies was updated, or a new version is waiting":
    "Um desktop ou o Puppies foi atualizado, ou há uma versão nova esperando",
  "Puppies did not come back in a minute: restart it by hand.":
    "O Puppies não voltou em um minuto: reinicie-o manualmente.",
  "Update Puppies to {version}? It restarts in a moment; the puppies' desktops keep running.":
    "Atualizar o Puppies para {version}? Ele reinicia em instantes; as áreas de trabalho dos cachorrinhos continuam funcionando.",
  "Puppies {version}": "Puppies {version}",
  "it is the newest version": "é a versão mais nova",
  "Puppies {version} is available.": "O Puppies {version} está disponível.",
  "Update and restart": "Atualizar e reiniciar",
  "Updated to {version}: restarting…": "Atualizado para {version}: reiniciando…",
  "Look for a new version": "Procurar uma versão nova",
  "Looked {when}.": "Procurada {when}.",
  "Puppies does not look for new versions: turn it on with updates.gateway in the configuration.":
    "O Puppies não procura versões novas: ative com updates.gateway na configuração.",
  "Puppies looks for new versions and installs them by itself when nothing is in use.":
    "O Puppies procura versões novas e as instala sozinho quando nada está em uso.",
  "Puppies looks for new versions and tells you; you decide when to update.":
    "O Puppies procura versões novas e avisa você; você decide quando atualizar.",
  "This update is checked against its checksums only, which do not say who made it: set updates.public_key to require the release key's signature.":
    "Esta atualização é verificada apenas pelas somas de verificação, que não dizem quem a fez: defina updates.public_key para exigir a assinatura da chave dos releases.",
  "{version} did not hold here and Puppies went back to {current}: it is not offered again.":
    "{version} não se sustentou aqui e o Puppies voltou para {current}: não será oferecida de novo.",
};

export default dict;
