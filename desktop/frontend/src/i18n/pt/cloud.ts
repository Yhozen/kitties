import type { Dictionary } from "../../i18n";

const dict: Dictionary = {
  "Too many inputs are waiting. Wait for them to finish.":
    "Há ações demais na fila. Aguarde até terminarem.",
  "Tasks are disabled until you choose Start.":
    "As tarefas estão desativadas até você escolher Iniciar.",
  "Browser-session export saved {when}.": "Exportação das sessões do navegador salva {when}.",
  "No separate browser-session export yet.":
    "Ainda não há uma exportação separada das sessões do navegador.",
  "Export browser sessions": "Exportar sessões do navegador",

  "Encrypted backups": "Backups criptografados",
  "Recovery copies are saved separately from the live gateway and cloud computers. Seven daily and four weekly copies are kept.":
    "As cópias de recuperação são salvas separadamente do gateway ativo e dos computadores na nuvem. São mantidas sete cópias diárias e quatro semanais.",
  "Backup in progress. New tasks will resume when the recovery copy is captured.":
    "Backup em andamento. As novas tarefas serão retomadas quando a cópia de recuperação for capturada.",
  "A backup is overdue. Back up now or check the last error.":
    "Um backup está atrasado. Faça um backup agora ou confira o último erro.",
  "Last successful backup: {when}.": "Último backup concluído: {when}.",
  "No successful backup yet.": "Nenhum backup foi concluído ainda.",
  "Backup in progress.": "Cópia de segurança em andamento.",
  "Starting backup…": "Iniciando backup…",
  "Back up now": "Fazer backup agora",
  "A private cloud computer that keeps files, browser sessions and installed apps between tasks.":
    "Um computador privado na nuvem que mantém arquivos, sessões do navegador e aplicativos instalados entre tarefas.",
  "A saved recovery checkpoint is available.": "Há um ponto de recuperação salvo disponível.",
  "Boat · cloud computer": "Boat · computador na nuvem",
  "Close desktop view": "Fechar a visualização da área de trabalho",
  "Delete recovery checkpoint": "Excluir ponto de recuperação",
  "No saved recovery checkpoint yet. A successful sleep or stop creates one.":
    "Ainda não há um ponto de recuperação salvo. Ele é criado ao suspender ou parar o computador com sucesso.",
  "Open desktop": "Abrir área de trabalho",
  "Open the desktop to view and control this computer.":
    "Abra a área de trabalho para ver e controlar este computador.",
  "Permanently delete {name}'s saved recovery checkpoint? Recovery from this checkpoint will no longer be possible. Independent backups remain until their retention expires.":
    "Excluir permanentemente o ponto de recuperação salvo de {name}? Não será mais possível recuperar a partir dele. Os backups independentes permanecem até o prazo de retenção expirar.",
  "Removing this kitty keeps its recovery checkpoint. Independent backups follow the configured retention.":
    "Remover este kitty mantém seu ponto de recuperação. Os backups independentes seguem a retenção configurada.",
  "Saving and stopping the computer…": "Salvando e parando o computador…",
  "Saving the computer before sleep…": "Salvando o computador antes de suspender…",
  Sleep: "Suspender",
  "Sleep saves this computer and lets tasks wake it. Stop keeps it off until you choose Start. Apps may restart when it wakes.":
    "Suspender salva este computador e permite que as tarefas o despertem. Parar o mantém desligado até você escolher Iniciar. Os aplicativos podem reiniciar ao despertar.",
  "Starting the computer…": "Iniciando o computador…",
  "Stopped. Tasks will not wake this kitty until you choose Start.":
    "Parado. As tarefas não despertarão este kitty até você escolher Iniciar.",
  "The cloud computer service is unavailable. Check the gateway's Boat configuration.":
    "O serviço de computadores na nuvem está indisponível. Verifique a configuração do Boat no gateway.",
  "The desktop will be available when this operation finishes.":
    "A área de trabalho estará disponível quando esta operação terminar.",
  "The gateway restarted during this task. Review its last actions before continuing.":
    "O gateway reiniciou durante esta tarefa. Revise suas últimas ações antes de continuar.",
  "Check which actions completed before the interruption, then continue. Do not repeat actions that already succeeded.":
    "Verifique quais ações foram concluídas antes da interrupção e então continue. Não repita ações que já tiveram sucesso.",
  "Remove {name} and its cloud computer? Its saved recovery checkpoint will be kept.":
    "Remover {name} e seu computador na nuvem? Seu ponto de recuperação salvo será mantido.",
  "Remove {name} and permanently delete its VM disk, including its files and installed apps?":
    "Remover {name} e excluir permanentemente o disco da máquina virtual, incluindo seus arquivos e aplicativos instalados?",
  "Manage retained recovery checkpoints in Settings → Preferences.":
    "Gerencie os pontos de recuperação mantidos em Configurações → Preferências.",
  "Recovery checkpoints": "Pontos de recuperação",
  "Removing a cloud kitty keeps its saved computer here. Delete its checkpoint only when you no longer need that recovery copy.":
    "Ao remover um kitty na nuvem, seu computador salvo é mantido aqui. Exclua o ponto de recuperação somente quando não precisar mais dessa cópia.",
  "No recovery checkpoints saved.": "Não há pontos de recuperação salvos.",
  "Kitty removed": "Kitty removido",
  "Computer retained": "Computador mantido",
  "Recovery operation in progress": "Operação de recuperação em andamento",
  "Saved {when}.": "Salvo {when}.",
  "Remove the kitty before deleting its recovery checkpoint.":
    "Remova o kitty antes de excluir seu ponto de recuperação.",
  "Refresh checkpoints": "Atualizar pontos de recuperação",
};

export default dict;
