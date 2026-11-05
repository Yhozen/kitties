import type { Preferences } from "@kitties/device/DevicePreferences";

const translations = {
  en: {
    title: "Your skill library",
    preferences: "Device preferences",
    language: "Language",
    theme: "Appearance",
    system: "Use device setting",
    light: "Light",
    dark: "Dark",
    save: "Save preferences",
    preferenceStatus: "Preference status",
    preview: "Save explicitly to keep these preferences on this device.",
    unsaved: "Changes are previewed here. Save to keep them on this device.",
    saving: "Saving preferences…",
    saved: "Preferences saved on this device.",
    saveInvalid: "Preferences could not be saved. Choose valid values and try again.",
    saveUnavailable: "Preferences could not be saved on this device. Try again.",
    saveTimeout: "Saving preferences timed out. Try again to confirm them on this device.",
    loadInvalid:
      "Stored preferences were invalid. Safe defaults are shown; nothing was overwritten.",
    loadUnavailable:
      "Stored preferences could not be read. Safe defaults are shown; nothing was overwritten.",
    loadTimeout: "Reading preferences timed out. Safe defaults are shown; nothing was overwritten.",
    checking: "Connecting to your library…",
    denied:
      "Sign in to open your library. In a browser, sign in in a new tab, then try again here.",
    unavailable: "Your library is unavailable. Try connecting again.",
    notReady:
      "Your library is not ready yet. An administrator must finish preparing it before you can connect.",
    changed:
      "Library authority changed. Reload to start a new session; previous requests will not be replayed.",
    signIn: "Sign in",
    signInTab: "Sign in in a new tab",
    home: "Return to Kitties",
    navigation: "Kitties navigation",
  },
  es: {
    title: "Tu biblioteca de habilidades",
    preferences: "Preferencias del dispositivo",
    language: "Idioma",
    theme: "Apariencia",
    system: "Usar ajuste del dispositivo",
    light: "Claro",
    dark: "Oscuro",
    save: "Guardar preferencias",
    preferenceStatus: "Estado de las preferencias",
    preview: "Guarda explícitamente para conservar estas preferencias en este dispositivo.",
    unsaved: "Los cambios se muestran aquí. Guarda para conservarlos en este dispositivo.",
    saving: "Guardando preferencias…",
    saved: "Preferencias guardadas en este dispositivo.",
    saveInvalid:
      "No se pudieron guardar las preferencias. Elige valores válidos e inténtalo de nuevo.",
    saveUnavailable:
      "No se pudieron guardar las preferencias en este dispositivo. Inténtalo de nuevo.",
    saveTimeout:
      "Se agotó el tiempo para guardar. Inténtalo de nuevo para confirmar las preferencias.",
    loadInvalid:
      "Las preferencias guardadas no eran válidas. Se muestran valores seguros; no se sobrescribió nada.",
    loadUnavailable:
      "No se pudieron leer las preferencias. Se muestran valores seguros; no se sobrescribió nada.",
    loadTimeout:
      "Se agotó el tiempo para leer las preferencias. Se muestran valores seguros; no se sobrescribió nada.",
    checking: "Conectando con tu biblioteca…",
    denied:
      "Inicia sesión para abrir tu biblioteca. En el navegador, inicia sesión en otra pestaña y vuelve a intentarlo aquí.",
    unavailable: "Tu biblioteca no está disponible. Intenta conectarte de nuevo.",
    notReady:
      "Tu biblioteca aún no está lista. Un administrador debe terminar de prepararla antes de conectar.",
    changed:
      "La autoridad de la biblioteca cambió. Recarga para iniciar otra sesión; no se repetirán las solicitudes anteriores.",
    signIn: "Iniciar sesión",
    signInTab: "Iniciar sesión en otra pestaña",
    home: "Volver a Kitties",
    navigation: "Navegación de Kitties",
  },
  pt: {
    title: "Sua biblioteca de habilidades",
    preferences: "Preferências do dispositivo",
    language: "Idioma",
    theme: "Aparência",
    system: "Usar configuração do dispositivo",
    light: "Claro",
    dark: "Escuro",
    save: "Salvar preferências",
    preferenceStatus: "Estado das preferências",
    preview: "Salve explicitamente para manter estas preferências neste dispositivo.",
    unsaved: "As alterações aparecem aqui. Salve para mantê-las neste dispositivo.",
    saving: "Salvando preferências…",
    saved: "Preferências salvas neste dispositivo.",
    saveInvalid:
      "Não foi possível salvar as preferências. Escolha valores válidos e tente novamente.",
    saveUnavailable: "Não foi possível salvar as preferências neste dispositivo. Tente novamente.",
    saveTimeout: "O tempo para salvar terminou. Tente novamente para confirmar as preferências.",
    loadInvalid:
      "As preferências salvas eram inválidas. Valores seguros são exibidos; nada foi sobrescrito.",
    loadUnavailable:
      "Não foi possível ler as preferências. Valores seguros são exibidos; nada foi sobrescrito.",
    loadTimeout:
      "O tempo para ler as preferências terminou. Valores seguros são exibidos; nada foi sobrescrito.",
    checking: "Conectando à sua biblioteca…",
    denied:
      "Entre para abrir sua biblioteca. No navegador, entre em outra aba e tente novamente aqui.",
    unavailable: "Sua biblioteca está indisponível. Tente conectar novamente.",
    notReady:
      "Sua biblioteca ainda não está pronta. Um administrador deve terminar de prepará-la antes da conexão.",
    changed:
      "A autoridade da biblioteca mudou. Recarregue para iniciar outra sessão; as solicitações anteriores não serão repetidas.",
    signIn: "Entrar",
    signInTab: "Entrar em outra aba",
    home: "Voltar ao Kitties",
    navigation: "Navegação do Kitties",
  },
};

export const copy = (language: Preferences["language"]) => translations[language];
