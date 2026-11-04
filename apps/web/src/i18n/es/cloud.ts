import type { Dictionary } from "../../i18n";

const dict: Dictionary = {
  "Too many inputs are waiting. Wait for them to finish.":
    "Hay demasiadas acciones pendientes. Espera a que terminen.",
  "Tasks are disabled until you choose Start.":
    "Las tareas están desactivadas hasta que elijas Iniciar.",
  "Browser-session export saved {when}.": "Exportación de sesiones del navegador guardada {when}.",
  "No separate browser-session export yet.":
    "Aún no hay una exportación independiente de las sesiones del navegador.",
  "Export browser sessions": "Exportar sesiones del navegador",

  "Encrypted backups": "Copias de seguridad cifradas",
  "Recovery copies are saved separately from the live gateway and cloud computers. Seven daily and four weekly copies are kept.":
    "Las copias de recuperación se guardan separadas del gateway activo y de los ordenadores en la nube. Se conservan siete copias diarias y cuatro semanales.",
  "Backup in progress. New tasks will resume when the recovery copy is captured.":
    "Copia en curso. Las tareas nuevas se reanudarán cuando se haya capturado la copia de recuperación.",
  "A backup is overdue. Back up now or check the last error.":
    "Hay una copia de seguridad pendiente. Haz una copia ahora o revisa el último error.",
  "Last successful backup: {when}.": "Última copia completada: {when}.",
  "No successful backup yet.": "Aún no se ha completado ninguna copia de seguridad.",
  "Backup in progress.": "Copia de seguridad en curso.",
  "Starting backup…": "Iniciando copia…",
  "Back up now": "Hacer copia ahora",
  "A private cloud computer that keeps files, browser sessions and installed apps between tasks.":
    "Un ordenador privado en la nube que conserva archivos, sesiones del navegador y aplicaciones instaladas entre tareas.",
  "A saved recovery checkpoint is available.": "Hay un punto de recuperación guardado disponible.",
  "Boat · cloud computer": "Boat · ordenador en la nube",
  "Close desktop view": "Cerrar la vista del escritorio",
  "Delete recovery checkpoint": "Eliminar punto de recuperación",
  "No saved recovery checkpoint yet. A successful sleep or stop creates one.":
    "Aún no hay un punto de recuperación guardado. Se crea al suspender o detener correctamente el ordenador.",
  "Open desktop": "Abrir escritorio",
  "Open the desktop to view and control this computer.":
    "Abre el escritorio para ver y controlar este ordenador.",
  "Permanently delete {name}'s saved recovery checkpoint? Recovery from this checkpoint will no longer be possible. Independent backups remain until their retention expires.":
    "¿Eliminar permanentemente el punto de recuperación guardado de {name}? Ya no será posible recuperarlo desde ese punto. Las copias independientes se conservan hasta que venza su plazo de retención.",
  "Removing this puppy keeps its recovery checkpoint. Independent backups follow the configured retention.":
    "Eliminar este perrito conserva su punto de recuperación. Las copias independientes siguen el plazo de retención configurado.",
  "Saving and stopping the computer…": "Guardando y deteniendo el ordenador…",
  "Saving the computer before sleep…": "Guardando el ordenador antes de suspenderlo…",
  Sleep: "Suspender",
  "Sleep saves this computer and lets tasks wake it. Stop keeps it off until you choose Start. Apps may restart when it wakes.":
    "Suspender guarda este ordenador y permite que las tareas lo despierten. Detener lo mantiene apagado hasta que elijas Iniciar. Las aplicaciones pueden reiniciarse al despertar.",
  "Starting the computer…": "Iniciando el ordenador…",
  "Stopped. Tasks will not wake this puppy until you choose Start.":
    "Detenido. Las tareas no despertarán este perrito hasta que elijas Iniciar.",
  "The cloud computer service is unavailable. Check the gateway's Boat configuration.":
    "El servicio de ordenadores en la nube no está disponible. Revisa la configuración de Boat del gateway.",
  "The desktop will be available when this operation finishes.":
    "El escritorio estará disponible cuando termine esta operación.",
  "The gateway restarted during this task. Review its last actions before continuing.":
    "El gateway se reinició durante esta tarea. Revisa sus últimas acciones antes de continuar.",
  "Check which actions completed before the interruption, then continue. Do not repeat actions that already succeeded.":
    "Comprueba qué acciones se completaron antes de la interrupción y luego continúa. No repitas las acciones que ya se completaron correctamente.",
  "Remove {name} and its cloud computer? Its saved recovery checkpoint will be kept.":
    "¿Eliminar {name} y su ordenador en la nube? Se conservará su punto de recuperación guardado.",
  "Remove {name} and permanently delete its VM disk, including its files and installed apps?":
    "¿Eliminar {name} y borrar permanentemente el disco de su máquina virtual, incluidos sus archivos y aplicaciones instaladas?",
  "Manage retained recovery checkpoints in Settings → Preferences.":
    "Gestiona los puntos de recuperación conservados en Configuración → Preferencias.",
  "Recovery checkpoints": "Puntos de recuperación",
  "Removing a cloud puppy keeps its saved computer here. Delete its checkpoint only when you no longer need that recovery copy.":
    "Al eliminar un perrito en la nube, su ordenador guardado se conserva aquí. Elimina su punto de recuperación solo cuando ya no necesites esa copia.",
  "No recovery checkpoints saved.": "No hay puntos de recuperación guardados.",
  "Puppy removed": "Perrito eliminado",
  "Computer retained": "Ordenador conservado",
  "Recovery operation in progress": "Operación de recuperación en curso",
  "Saved {when}.": "Guardado {when}.",
  "Remove the puppy before deleting its recovery checkpoint.":
    "Elimina el perrito antes de borrar su punto de recuperación.",
  "Refresh checkpoints": "Actualizar puntos de recuperación",
};

export default dict;
