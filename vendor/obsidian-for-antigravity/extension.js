const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { detectVaults, getActiveOrConfiguredVault } = require('./src/vault-detector');
const syncEngine = require('./src/sync-engine');
const { installSkillAndRules } = require('./src/skill-installer');

let statusBarItem;
let currentWebviewView = null;

function getWorkspaceRoot() {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  return null;
}

function openInObsidianApp(vaultName, notePath) {
  const encVault = encodeURIComponent(vaultName);
  let cleanNote = (notePath || '00_Agente/SOUL').replace(/\\/g, '/');
  if (cleanNote.endsWith('.md')) cleanNote = cleanNote.slice(0, -3);
  const encFile = encodeURIComponent(cleanNote);
  const uri = `obsidian://open?vault=${encVault}&file=${encFile}`;

  try {
    vscode.env.openExternal(vscode.Uri.parse(uri)).then(success => {
      if (!success) {
        fallbackOpenUri(uri);
      }
    }, () => {
      fallbackOpenUri(uri);
    });
  } catch (e) {
    fallbackOpenUri(uri);
  }
}

function fallbackOpenUri(uri) {
  if (process.platform === 'win32') {
    exec(`start "" "${uri}"`, () => {});
  } else if (process.platform === 'darwin') {
    exec(`open "${uri}"`, () => {});
  } else {
    exec(`xdg-open "${uri}"`, () => {});
  }
}

function updateStatusBar(vault) {
  if (!statusBarItem) return;
  if (vault && vault.exists) {
    statusBarItem.text = `$(book) Obsidian: ${vault.name}`;
    statusBarItem.tooltip = t('statusbar_connected', { path: vault.path });
    statusBarItem.command = 'antigravityObsidian.openHub';
    statusBarItem.show();
  } else {
    statusBarItem.text = `$(book) Obsidian: Offline`;
    statusBarItem.tooltip = t('statusbar_no_vault');
    statusBarItem.command = 'antigravityObsidian.selectVault';
    statusBarItem.show();
  }
}

// Inline SVGs (Zero emojis)
const SVGS = {
  crystal: `<svg class="svg-icon" viewBox="0 0 24 24"><polygon points="12,2 18,7 15,22 12,18 9,22 6,7"/></svg>`,
  vault: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><polygon points="6 2 18 2 22 8 12 22 2 8 6 2"/><line x1="2" y1="8" x2="22" y2="8"/><polyline points="12 22 8 8 10 2"/><polyline points="12 22 16 8 14 2"/></svg>`,
  brain: `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 2a4.5 4.5 0 0 0-4.5 4.5c0 .7.16 1.37.45 1.96A4.5 4.5 0 0 0 4 12.5a4.5 4.5 0 0 0 2.2 3.9A4.5 4.5 0 0 0 10.5 21a4.5 4.5 0 0 0 1.5-.26A4.5 4.5 0 0 0 13.5 21a4.5 4.5 0 0 0 4.3-4.6 4.5 4.5 0 0 0 2.2-3.9 4.5 4.5 0 0 0-3.95-4.04c.29-.59.45-1.26.45-1.96A4.5 4.5 0 0 0 12 2z"/></svg>`,
  zap: `<svg class="svg-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  network: `<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  sync: `<svg class="svg-icon" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  open: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  copy: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  plus: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  search: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  settings: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  globe: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  save: `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  dashboard: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  check: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`,
  trash: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  alert: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  history: `<svg class="svg-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  folder: `<svg class="svg-icon" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  lock: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  upload: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  download: `<svg class="svg-icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
};

// ---------------------------------------------------------------------------
// UI strings (server-side translations for HTML template + command messages).
// The webview's own I18N dict in media/main.js only covers [data-i18n] elements;
// everything else is resolved here at generation time. Supported: es/en/fr.
// de/zh/ja fall back to English for these strings.
// ---------------------------------------------------------------------------
const UI_STRINGS = {
  select_folder: { es: 'Seleccionar carpeta', en: 'Select folder', fr: 'Sélectionner un dossier' },
  language: { es: 'Idioma', en: 'Language', fr: 'Langue' },
  copy_path: { es: 'Copiar ruta', en: 'Copy path', fr: 'Copier le chemin' },
  configure: { es: 'Configurar', en: 'Configure', fr: 'Configurer' },
  obsidian_not_detected: { es: 'Obsidian no detectado en tu sistema', en: 'Obsidian not detected on your system', fr: 'Obsidian non détecté sur ce système' },
  obsidian_install_hint: { es: 'Para activar el Segundo Cerebro IA y la memoria persistente, instala Obsidian o selecciona manualmente la carpeta de tu Vault.', en: 'To enable the AI Second Brain and persistent memory, install Obsidian or manually select your Vault folder.', fr: 'Pour activer le Second Cerveau IA et la mémoire persistante, installe Obsidian ou sélectionne manuellement le dossier de ton Vault.' },
  btn_install_obsidian: { es: 'Instalar Obsidian', en: 'Install Obsidian', fr: 'Installer Obsidian' },
  btn_select_vault: { es: 'Seleccionar Vault...', en: 'Select Vault...', fr: 'Sélectionner le Vault...' },
  sessions_index: { es: 'Índice de Sesiones', en: 'Sessions Index', fr: 'Index des Sessions' },
  projects_index: { es: 'Índice de Proyectos', en: 'Projects Index', fr: 'Index des Projets' },
  skills_index_missing: { es: 'El Índice de Skills aún no se ha generado.', en: 'The Skills Index has not been generated yet.', fr: "L'index des skills n'a pas encore été généré." },
  tab_tools: { es: 'Herramientas', en: 'Tools', fr: 'Outils' },
  soul_default_desc: { es: '— Ingeniero senior autónomo, resolutivo, directo y CERO emojis', en: '— Autonomous senior engineer, decisive, direct, ZERO emojis', fr: '— Ingénieur senior autonome, résolu, direct et ZÉRO emoji' },
  soul_callsign_label: { es: 'Te llama:', en: 'Calls you:', fr: "Il t'appelle :" },
  soul_callsign_hint: { es: '(La IA siempre te llamará por este nombre en cada chat)', en: '(The AI will always call you by this name in every chat)', fr: "(L'IA t'appellera par ce nom dans chaque chat)" },
  btn_edit_identity: { es: 'Editar Identidad', en: 'Edit Identity', fr: "Modifier l'identité" },
  personality: { es: 'Personalidad', en: 'Personality', fr: 'Personnalité' },
  hermes_loop_title: { es: 'Hermes Closed Loop — Memoria Acotada', en: 'Hermes Closed Loop — Bounded Memory', fr: 'Hermes Closed Loop — Mémoire Bornée' },
  hermes_loop_desc: { es: 'Cuotas estrictas para evitar la saturación del contexto, y playbooks procedurales vivos.', en: 'Strict quotas to prevent context saturation, plus living procedural playbooks.', fr: 'Quotas stricts pour éviter la saturation du contexte, et playbooks procéduraux vivants.' },
  v2_active: { es: 'V2 Activo', en: 'V2 Active', fr: 'V2 Actif' },
  skills_playbooks: { es: '01_Skills/ (Playbooks Vivos):', en: '01_Skills/ (Living Playbooks):', fr: '01_Skills/ (Playbooks vivants) :' },
  skills_versioned: { es: '{n} skills versionadas', en: '{n} versioned skills', fr: '{n} skills versionnées' },
  mcp_title: { es: 'Servidor MCP (Model Context Protocol)', en: 'MCP Server (Model Context Protocol)', fr: 'Serveur MCP (Model Context Protocol)' },
  mcp_active: { es: 'Activo', en: 'Active', fr: 'Actif' },
  mcp_disabled: { es: 'Desactivado', en: 'Disabled', fr: 'Désactivé' },
  mcp_not_installed: { es: 'No Instalado', en: 'Not Installed', fr: 'Non installé' },
  mcp_desc_enabled: { es: 'Herramientas MCP nativas activadas en Antigravity. Todos tus otros servidores MCP se preservan intactos.', en: 'Native MCP tools enabled in Antigravity. All your other MCP servers are preserved intact.', fr: 'Outils MCP natifs activés dans Antigravity. Tous tes autres serveurs MCP sont préservés intacts.' },
  mcp_desc_disabled: { es: 'Funciona vía Node CLI como fallback seguro. Puedes activar el servidor MCP en cualquier momento sin romper los otros servidores.', en: 'Works via Node CLI as a safe fallback. You can enable the MCP server anytime without breaking other servers.', fr: 'Fonctionne via Node CLI en fallback sûr. Tu peux activer le serveur MCP à tout moment sans casser les autres serveurs.' },
  btn_disable_mcp: { es: 'Desactivar MCP (Usar Node)', en: 'Disable MCP (Use Node)', fr: 'Désactiver MCP (utiliser Node)' },
  btn_disable_mcp_short: { es: 'Desactivar MCP', en: 'Disable MCP', fr: 'Désactiver MCP' },
  statusbar_connected: { es: 'Conectado a Obsidian: {path}', en: 'Connected to Obsidian: {path}', fr: 'Connecté à Obsidian : {path}' },
  statusbar_no_vault: { es: 'No se encontró ningún Vault activo.', en: 'No active Vault found.', fr: 'Aucun Vault actif trouvé.' },
  btn_install_mcp: { es: 'Instalar / Activar MCP', en: 'Install / Enable MCP', fr: 'Installer / Activer MCP' },
  active: { es: 'Activa', en: 'Active', fr: 'Active' },
  antipatterns: { es: '{n} trampas', en: '{n} traps', fr: '{n} pièges' },
  project_prefix: { es: 'Proyecto:', en: 'Project:', fr: 'Projet :' },
  graph_fit: { es: 'Ajustar', en: 'Fit', fr: 'Ajuster' },
  graph_fit_title: { es: 'Ajustar y centrar en pantalla', en: 'Fit and center on screen', fr: "Ajuster et centrer à l'écran" },
  zoom_in: { es: 'Acercar', en: 'Zoom in', fr: 'Zoom avant' },
  zoom_out: { es: 'Alejar', en: 'Zoom out', fr: 'Zoom arrière' },
  graph_restart: { es: 'Reiniciar simulación', en: 'Restart simulation', fr: 'Relancer la simulation' },
  open_in_obsidian: { es: 'Abrir en Obsidian', en: 'Open in Obsidian', fr: 'Ouvrir dans Obsidian' },
  legend_soul: { es: 'Alma', en: 'Soul', fr: 'Âme' },
  legend_memory: { es: 'Memoria', en: 'Memory', fr: 'Mémoire' },
  legend_projects: { es: 'Proyectos', en: 'Projects', fr: 'Projets' },
  legend_sessions: { es: 'Sesiones', en: 'Sessions', fr: 'Sessions' },
  lang_auto: { es: 'Automático / Detectar', en: 'Auto / Detect', fr: 'Automatique / Détecter' },
  settings_identity_title: { es: 'Identidad del Agente y Trato Personalizado:', en: 'Agent Identity & Custom Address:', fr: "Identité de l'Agent et Appellation Personnalisée :" },
  settings_identity_desc: { es: 'Configura el nombre de tu agente IA y cómo debe dirigirse a ti en todas las conversaciones técnicas.', en: "Configure your AI agent's name and how it should address you in all technical conversations.", fr: "Configure le nom de ton agent IA et comment il doit s'adresser à toi dans toutes les conversations techniques." },
  label_callsign: { es: 'Tu Nombre / Callsign (cómo te llama la IA):', en: 'Your Name / Callsign (what the AI calls you):', fr: "Ton nom / indicatif (comment l'IA t'appelle) :" },
  ph_callsign: { es: 'Ej: David, Jefe, Socio...', en: 'E.g.: David, Boss, Partner...', fr: 'Ex : David, Chef, Boss...' },
  label_ai_name: { es: 'Nombre del Agente de IA:', en: 'AI Agent Name:', fr: "Nom de l'agent IA :" },
  ph_ai_name: { es: 'Ej: Pedro, Hermes, Jarvis...', en: 'E.g.: Pedro, Hermes, Jarvis...', fr: 'Ex : Hermes, Jarvis, Pedro...' },
  label_personality: { es: 'Rasgos y Comportamiento:', en: 'Traits & Behavior:', fr: 'Traits et comportement :' },
  ph_personality: { es: 'Estilo y comportamiento...', en: 'Style and behavior...', fr: 'Style et comportement...' },
  personality_default: { es: 'Completamente autónomo y resolutivo: arregla los problemas de raíz, directo y sin rodeos.', en: 'Fully autonomous and decisive: fixes problems at the root, direct and no-nonsense.', fr: 'Complètement autonome et résolu : règle les problèmes à la racine, direct et sans détours.' },
  btn_save_identity: { es: 'Guardar Identidad y Trato', en: 'Save Identity & Address', fr: "Enregistrer l'identité" },
  none: { es: 'Ninguna', en: 'None', fr: 'Aucun' },
  git_active: { es: 'Git Auto-Commit: Activo en Vault', en: 'Git Auto-Commit: Active on Vault', fr: 'Git Auto-Commit : actif sur le Vault' },
  git_inactive: { es: 'Git en Vault: No inicializado (opcional)', en: 'Git in Vault: Not initialized (optional)', fr: 'Git dans le Vault : non initialisé (optionnel)' },
  git_active_desc: { es: 'Cada guardado importante genera un commit automático en el repo Git del vault.', en: 'Every important save generates an automatic commit in the vault’s Git repo.', fr: 'Chaque enregistrement important génère un commit automatique dans le dépôt Git du vault.' },
  git_inactive_desc: { es: 'Si inicializas un repo git en tu Vault, las notas guardan un historial de versiones automático.', en: 'If you initialize a git repo in your Vault, notes keep an automatic version history.', fr: 'Si tu initialises un dépôt git dans ton Vault, les notes gardent un historique de versions automatique.' },
  tools_title: { es: 'Instalar Herramienta desde GitHub', en: 'Install Tool from GitHub', fr: 'Installer un outil depuis GitHub' },
  tools_desc: { es: 'Pasa la URL de un repositorio de GitHub (ej: https://github.com/owner/repo). El sistema clonará el repo, detectará si es MCP o CLI, instalará dependencias con npm/pip y lo registrará para la IA.', en: 'Paste the URL of a GitHub repository (e.g.: https://github.com/owner/repo). The system will clone the repo, detect whether it is MCP or CLI, install dependencies with npm/pip and register it for the AI.', fr: "Colle l'URL d'un dépôt GitHub (ex : https://github.com/owner/repo). Le système clonera le dépôt, détectera s'il s'agit d'un MCP ou d'un CLI, installera les dépendances avec npm/pip et l'enregistrera pour l'IA." },
  btn_install: { es: 'Instalar', en: 'Install', fr: 'Installer' },
  tools_installed: { es: 'Herramientas Instaladas ({n})', en: 'Installed Tools ({n})', fr: 'Outils installés ({n})' },
  tools_none_title: { es: 'Cero herramientas por defecto', en: 'Zero tools by default', fr: 'Zéro outil par défaut' },
  tools_none_desc: { es: 'Ninguna herramienta instalada por ahora. Las herramientas se crean o instalan por la IA con el tiempo, o vía un repo de GitHub arriba.', en: 'No tools installed yet. Tools are created or installed by the AI over time, or via a GitHub repo above.', fr: "Aucun outil installé pour l'instant. Les outils sont créés ou installés par l'IA au fil du temps, ou via un dépôt GitHub ci-dessus." },
  uninstall_tool: { es: 'Desinstalar herramienta', en: 'Uninstall tool', fr: "Désinstaller l'outil" },
  no_description: { es: 'Sin descripción', en: 'No description', fr: 'Sans description' },
  skill_default_desc: { es: 'Skill viva automejorable', en: 'Living self-improving skill', fr: 'Skill vivante auto-améliorable' },
  cli_error: { es: 'Error ejecutando CLI', en: 'Error running CLI', fr: "Erreur d'exécution du CLI" },
  vault_configured: { es: 'Vault de Obsidian configurado: {name}', en: 'Obsidian Vault configured: {name}', fr: 'Vault Obsidian configuré : {name}' },
  no_vault: { es: 'Ningún Vault de Obsidian conectado.', en: 'No Obsidian Vault connected.', fr: 'Aucun Vault Obsidian connecté.' },
  identity_saved: { es: 'Identidad guardada: Agente "{ai}" | Te llama: "{user}"', en: 'Identity saved: Agent "{ai}" | Calls you: "{user}"', fr: 'Identité enregistrée — Agent : "{ai}" | Il t\'appelle : "{user}"' },
  skill_updated: { es: 'Skill de Obsidian actualizada para todos los chats.', en: 'Obsidian skill updated for all chats.', fr: 'Skill Obsidian mise à jour pour tous les chats.' },
  lang_switched: { es: 'Idioma cambiado a {lang}. Soul, Perfil y reglas de IA actualizadas.', en: 'Language switched to {lang}. Soul, Profile, and AI rules updated.', fr: 'Langue changée en {lang}. Soul, Profil et règles IA mis à jour.' },
  ai_config_saved: { es: 'Configuración de IA, idioma y perfil actualizados.', en: 'AI configuration, language and profile updated.', fr: 'Configuration IA, langue et profil mis à jour.' },
  reset_confirm: { es: '¿Seguro que quieres borrar toda la memoria y las notas sincronizadas en Obsidian para empezar de cero? Esta acción elimina las memorias anteriores y limpia el contexto acumulado de la IA.', en: 'Are you sure you want to erase all memory and synced notes in Obsidian to start over? This deletes previous memories and clears the accumulated AI context.', fr: "Sûr de vouloir effacer toute la mémoire et les notes synchronisées dans Obsidian pour repartir de zéro ? Cette action supprime les mémoires antérieures et nettoie le contexte accumulé de l'IA." },
  btn_reset_confirm: { es: 'Borrar Todo y Empezar de Cero', en: 'Erase Everything and Start Over', fr: 'Tout effacer et repartir de zéro' },
  cancel: { es: 'Cancelar', en: 'Cancel', fr: 'Annuler' },
  reset_done: { es: 'Memoria de Obsidian y contexto de IA reiniciados correctamente. Empezando de cero.', en: 'Obsidian memory and AI context reset successfully. Starting from scratch.', fr: 'Mémoire Obsidian et contexte IA réinitialisés. Repart à zéro.' },
  installing_tool: { es: 'Instalando herramienta desde GitHub...', en: 'Installing tool from GitHub...', fr: "Installation de l'outil depuis GitHub..." },
  tool_installed: { es: 'Herramienta "{name}" instalada correctamente.', en: 'Tool "{name}" installed successfully.', fr: 'Outil "{name}" installé correctement.' },
  tool_install_error: { es: 'Error al instalar herramienta: {err}', en: 'Error installing tool: {err}', fr: "Erreur d'installation de l'outil : {err}" },
  tool_uninstalled: { es: 'Herramienta "{name}" desinstalada.', en: 'Tool "{name}" uninstalled.', fr: 'Outil "{name}" désinstallé.' },
  tool_uninstall_error: { es: 'Error de desinstalación: {err}', en: 'Uninstall error: {err}', fr: 'Erreur de désinstallation : {err}' },
  auto_connected: { es: 'Obsidian for Antigravity: Conectado automáticamente ({name}). Tu Segundo Cerebro y memoria persistente están listos en todos tus chats.', en: 'Obsidian for Antigravity: Automatically connected ({name}). Your Second Brain and persistent memory are ready in all your chats.', fr: 'Obsidian for Antigravity : connecté automatiquement ({name}). Ton Second Cerveau et ta mémoire persistante sont prêts dans tous tes chats.' },
  no_vault_start: { es: 'Obsidian for Antigravity: no se pudo conectar automáticamente a un vault. Selecciona tu carpeta de vault para empezar.', en: 'Obsidian for Antigravity: could not automatically connect to a vault. Select your vault folder to get started.', fr: 'Obsidian for Antigravity : connexion automatique à un vault impossible. Sélectionne ton dossier de vault pour commencer.' },
  notes_saved_hint: { es: 'Tus notas están guardadas en "{path}". Si deseas visualizarlas en la app oficial de Obsidian, puedes descargarla gratis.', en: 'Your notes are saved in "{path}". To view them in the official Obsidian app, you can download it for free.', fr: 'Tes notes sont enregistrées dans "{path}". Pour les visualiser dans l\'app officielle d\'Obsidian, tu peux la télécharger gratuitement.' },
  download_obsidian: { es: 'Descargar Obsidian', en: 'Download Obsidian', fr: 'Télécharger Obsidian' },
  open_notes_folder: { es: 'Abrir Carpeta de Notas', en: 'Open Notes Folder', fr: 'Ouvrir le dossier des notes' },
  prompt_callsign: { es: '¿Cómo quieres que la IA te llame? (Tu nombre o tratamiento preferido)', en: 'What should the AI call you? (Your name or preferred address)', fr: "Comment veux-tu que l'IA t'appelle ? (Ton nom ou traitement préféré)" },
  prompt_ai_name: { es: '¿Qué nombre quieres darle al agente IA?', en: 'What name do you want to give the AI agent?', fr: "Quel nom veux-tu donner à l'agent IA ?" },
  sync_done: { es: 'Sincronización de Obsidian completada ({name}).', en: 'Obsidian sync completed ({name}).', fr: 'Synchronisation Obsidian terminée ({name}).' },
  memory_title_prompt: { es: 'Título de la Memoria / Solución Técnica', en: 'Memory Title / Technical Solution', fr: 'Titre de la mémoire / solution technique' },
  memory_title_ph: { es: 'Ej: Optimización SQLite WAL y concurrencia', en: 'E.g.: SQLite WAL optimization and concurrency', fr: 'Ex : optimisation SQLite WAL et concurrence' },
  memory_content_prompt: { es: 'Contenido / Detalles de la Solución', en: 'Content / Solution Details', fr: 'Contenu / détails de la solution' },
  memory_content_ph: { es: 'Escribe aquí los pasos o la solución...', en: 'Write the steps or solution here...', fr: 'Écris ici les étapes ou la solution...' },
  memory_saved: { es: 'Memoria "{title}" guardada en Obsidian.', en: 'Memory "{title}" saved in Obsidian.', fr: 'Mémoire "{title}" enregistrée dans Obsidian.' },
  skill_new_title: { es: 'Crear Nueva Skill de IA', en: 'Create New AI Skill', fr: 'Créer une nouvelle skill IA' },
  skill_name_prompt: { es: 'Nombre de la skill (ej: docker-deploy, nextjs-expert)', en: 'Skill name (e.g.: docker-deploy, nextjs-expert)', fr: 'Nom de la skill (ex : docker-deploy, nextjs-expert)' },
  skill_name_ph: { es: 'nombre-de-la-skill', en: 'skill-name', fr: 'nom-de-la-skill' },
  skill_desc_title: { es: 'Descripción de la Skill', en: 'Skill Description', fr: 'Description de la skill' },
  skill_desc_prompt: { es: '¿Qué hace esta skill y cuándo debe activarse?', en: 'What does this skill do and when should it activate?', fr: "Que fait cette skill et quand doit-elle s'activer ?" },
  skill_desc_ph: { es: 'Guía y procedimientos para...', en: 'Guide and procedures for...', fr: 'Guide et procédures pour...' },
  skill_scope_title: { es: 'Ámbito de la Skill', en: 'Skill Scope', fr: 'Portée de la skill' },
  scope_project: { es: 'Proyecto (.agents/skills/)', en: 'Project (.agents/skills/)', fr: 'Projet (.agents/skills/)' },
  skill_body: { es: 'Instrucciones operativas para el agente.', en: 'Operational instructions for the agent.', fr: "Instructions opérationnelles pour l'agent." },
  skill_created: { es: 'Skill "{name}" creada exitosamente.', en: 'Skill "{name}" created successfully.', fr: 'Skill "{name}" créée avec succès.' },
  soul_view_ai: { es: '$(sparkle) Ver Personalidad de la IA', en: '$(sparkle) View AI Personality', fr: "$(sparkle) Voir la personnalité de l'IA" },
  soul_view_user: { es: '$(account) Ver Perfil de Usuario', en: '$(account) View User Profile', fr: '$(account) Voir le profil utilisateur' },
  soul_view_soul: { es: '$(circuit-board) Ver Soul de Antigravity', en: '$(circuit-board) View Antigravity Soul', fr: '$(circuit-board) Voir le Soul de Antigravity' },
  soul_view_panel: { es: '$(eye) Abrir en Panel Lateral', en: '$(eye) Open in Side Panel', fr: '$(eye) Ouvrir dans le panneau latéral' },
  soul_pick_hint: { es: 'Elige qué vista Soul, Perfil o Personalidad consultar', en: 'Choose which Soul, Profile or Personality view to open', fr: 'Choisis quelle vue Soul, Profil ou Personnalité consulter' },
  file_not_found: { es: 'Archivo no encontrado: {name}', en: 'File not found: {name}', fr: 'Fichier introuvable : {name}' },
  calib_ai_title: { es: 'Calibrar Nombre del Agente IA', en: 'Calibrate AI Agent Name', fr: "Calibrer le nom de l'agent IA" },
  calib_ai_prompt: { es: '¿Cómo quieres llamar a tu agente IA? (ej: Hermes, Jarvis, Antigravity)', en: 'What do you want to call your AI agent? (e.g.: Hermes, Jarvis, Antigravity)', fr: 'Comment veux-tu appeler ton agent IA ? (ex : Hermes, Jarvis, Antigravity)' },
  calib_user_title: { es: 'Calibrar Trato hacia Ti', en: 'Calibrate How It Addresses You', fr: "Calibrer l'appellation" },
  calib_user_prompt: { es: '¿Cómo quieres que el agente se dirija a ti? (ej: Davis, Jefe, Comandante, Socio)', en: 'How should the agent address you? (e.g.: Davis, Boss, Commander, Partner)', fr: "Comment veux-tu que l'agent s'adresse à toi ? (ex : Davis, Chef, Commandant, Partenaire)" },
  calib_pers_title: { es: 'Calibrar Rasgos de Personalidad y Tono', en: 'Calibrate Personality Traits & Tone', fr: 'Calibrer les traits de personnalité et le ton' },
  calib_pers_prompt: { es: 'Describe los rasgos o estilo de comportamiento del agente', en: "Describe the agent's traits or behavior style", fr: "Décris les traits ou le style de comportement de l'agent" },
  calib_pers_default: { es: 'Ingeniero de software senior de élite, pragmático, quirúrgico, directo y cero emojis.', en: 'Elite senior software engineer, pragmatic, surgical, direct and zero emojis.', fr: "Ingénieur logiciel senior d'élite, pragmatique, chirurgical, direct et zéro emoji." },
  personality_calibrated: { es: 'Personalidad calibrada: "{ai}" te llamará "{user}".', en: 'Personality calibrated: "{ai}" will call you "{user}".', fr: 'Personnalité calibrée : "{ai}" t\'appellera "{user}".' },
  no_workspace: { es: 'Ningún espacio de trabajo (workspace) abierto actualmente.', en: 'No workspace currently open.', fr: 'Aucun espace de travail (workspace) ouvert actuellement.' },
  project_registered: { es: 'Proyecto "{name}" registrado en el Índice Unificado de Obsidian.', en: 'Project "{name}" registered in the Unified Obsidian Index.', fr: "Projet \"{name}\" enregistré dans l'index unifié d'Obsidian." },
  projects_index_missing: { es: 'El Índice de Proyectos aún no se ha generado.', en: 'The Projects Index has not been generated yet.', fr: "L'index des projets n'a pas encore été généré." },
  scanning: { es: 'Obsidian: Escaneando arquitectura viva del proyecto...', en: 'Obsidian: Scanning living project architecture...', fr: "Obsidian : analyse de l'architecture vivante du projet..." },
  scan_done: { es: 'Blueprint y arquitectura viva de "{name}" actualizados en Obsidian.', en: 'Blueprint and living architecture of "{name}" updated in Obsidian.', fr: 'Blueprint et architecture vivante de "{name}" mis à jour dans Obsidian.' },
  scan_error: { es: 'Error al escanear arquitectura: {err}', en: 'Error scanning architecture: {err}', fr: "Erreur lors de l'analyse de l'architecture : {err}" },
  session_title: { es: 'Guardar Checkpoint de Sesión: {name}', en: 'Save Session Checkpoint: {name}', fr: 'Enregistrer le checkpoint de session : {name}' },
  session_prompt: { es: 'Resumen conciso en una frase de los avances y decisiones clave', en: 'Concise one-sentence summary of progress and key decisions', fr: 'Résumé concis en une phrase des avancées et décisions clés' },
  session_ph: { es: 'Ej: Soporte de sesiones implementado y escaneo profundo de módulos', en: 'E.g.: Sessions support implemented and deep module scan', fr: 'Ex : support des sessions implémenté et scan profond des modules' },
  session_details_title: { es: 'Detalles Técnicos y Próximos Pasos (Opcional)', en: 'Technical Details & Next Steps (Optional)', fr: 'Détails techniques et prochaines étapes (optionnel)' },
  session_details_prompt: { es: 'Decisiones clave, módulos modificados o próximos pasos', en: 'Key decisions, modified modules or next steps', fr: 'Décisions clés, modules modifiés ou prochaines étapes' },
  session_details_ph: { es: 'Ej: Registrados nuevos comandos CLI, reglas actualizadas, empaquetado 1.7.0', en: 'E.g.: New CLI commands registered, rules updated, packaged 1.7.0', fr: 'Ex : nouvelles commandes CLI enregistrées, règles mises à jour, package 1.7.0' },
  session_saved: { es: 'Checkpoint de sesión guardado en Obsidian: "{name}".', en: 'Session checkpoint saved in Obsidian: "{name}".', fr: 'Checkpoint de session enregistré dans Obsidian : "{name}".' },
  session_error: { es: 'Error al guardar checkpoint de sesión: {err}', en: 'Error saving session checkpoint: {err}', fr: "Erreur lors de l'enregistrement du checkpoint de session : {err}" },
  export_title: { es: 'Exportar Vault Cifrado (.agvault)', en: 'Export Encrypted Vault (.agvault)', fr: 'Exporter le vault chiffré (.agvault)' },
  export_pwd_prompt: { es: 'Introduce una contraseña para cifrar el archivo en AES-256-GCM', en: 'Enter a password to encrypt the file with AES-256-GCM', fr: 'Entre un mot de passe pour chiffrer le fichier en AES-256-GCM' },
  confirm_pwd_title: { es: 'Confirmar Contraseña', en: 'Confirm Password', fr: 'Confirmer le mot de passe' },
  confirm_pwd_prompt: { es: 'Repite la contraseña', en: 'Repeat the password', fr: 'Répète le mot de passe' },
  pwd_mismatch: { es: 'Las contraseñas no coinciden.', en: 'Passwords do not match.', fr: 'Les mots de passe ne correspondent pas.' },
  vault_filter: { es: 'Vault de Antigravity Cifrado', en: 'Encrypted Antigravity Vault', fr: 'Vault Antigravity chiffré' },
  save_backup_title: { es: 'Guardar Archivo de Respaldo Cifrado', en: 'Save Encrypted Backup File', fr: 'Enregistrer le fichier de sauvegarde chiffré' },
  vault_exported: { es: 'Vault cifrado exportado exitosamente a: {name}', en: 'Encrypted vault exported successfully to: {name}', fr: 'Vault chiffré exporté avec succès vers : {name}' },
  export_error: { es: 'Error al exportar vault: {err}', en: 'Error exporting vault: {err}', fr: "Erreur lors de l'export du vault : {err}" },
  import_title: { es: 'Seleccionar Archivo .agvault para Restaurar', en: 'Select .agvault File to Restore', fr: 'Sélectionner le fichier .agvault à restaurer' },
  decrypt_title: { es: 'Descifrar e Importar Vault', en: 'Decrypt and Import Vault', fr: 'Déchiffrer et importer le vault' },
  decrypt_prompt: { es: 'Introduce la contraseña usada para cifrar el archivo', en: 'Enter the password used to encrypt the file', fr: 'Entre le mot de passe utilisé pour chiffrer le fichier' },
  vault_restored: { es: 'Vault restaurado: {n} notas recuperadas exitosamente.', en: 'Vault restored: {n} notes recovered successfully.', fr: 'Vault restauré : {n} notes récupérées avec succès.' },
  import_error: { es: 'Error al restaurar vault: {err}', en: 'Error restoring vault: {err}', fr: 'Erreur lors de la restauration du vault : {err}' },
  disconnected: { es: 'Obsidian: desconectado. No se encontró ningún vault activo.', en: 'Obsidian: disconnected. No active vault found.', fr: 'Obsidian : déconnecté. Aucun vault actif trouvé.' },
  status_connected: { es: 'Obsidian Conectado: {name}{stats}', en: 'Obsidian Connected: {name}{stats}', fr: 'Obsidian connecté : {name}{stats}' },
  stat_memories: { es: 'Memorias: {n}', en: 'Memories: {n}', fr: 'Mémoires : {n}' },
  stat_skills: { es: 'Skills: {n}', en: 'Skills: {n}', fr: 'Skills : {n}' },
  open_hub: { es: 'Abrir Hub', en: 'Open Hub', fr: 'Ouvrir le Hub' },
  sync_now: { es: 'Sincronizar', en: 'Sync', fr: 'Synchroniser' },
  mcp_enabled_msg: { es: 'Servidor MCP activado exitosamente en mcp_config.json. ({n} otros servidores MCP preservados intactos).', en: 'MCP server enabled successfully in mcp_config.json. ({n} other MCP servers preserved intact).', fr: 'Serveur MCP activé dans mcp_config.json. ({n} autres serveurs MCP préservés intacts).' },
  mcp_install_error: { es: 'Error al instalar servidor MCP: {err}', en: 'Error installing MCP server: {err}', fr: "Erreur d'installation du serveur MCP : {err}" },
  mcp_disabled_msg: { es: 'Servidor MCP desactivado. Antigravity usará los comandos Node CLI como fallback.', en: 'MCP server disabled. Antigravity will use Node CLI commands as fallback.', fr: 'Serveur MCP désactivé. Antigravity utilisera les commandes Node CLI en fallback.' },
  mcp_disable_fail: { es: 'No se pudo desactivar el servidor MCP.', en: 'Could not disable the MCP server.', fr: 'Impossible de désactiver le serveur MCP.' },
  mcp_disable_error: { es: 'Error al desactivar servidor MCP: {err}', en: 'Error disabling MCP server: {err}', fr: 'Erreur de désactivation du serveur MCP : {err}' },
  mcp_state_active: { es: 'Activo (Habilitado)', en: 'Active (Enabled)', fr: 'Actif (activé)' },
  mcp_state_disabled: { es: 'Desactivado (disabled: true)', en: 'Disabled (disabled: true)', fr: 'Désactivé (disabled: true)' },
  mcp_state_none: { es: 'No instalado', en: 'Not installed', fr: 'Non installé' },
  mcp_status_msg: { es: 'MCP Obsidian: {state}\nOtros servidores en mcp_config.json: {others}\nArchivo: {path}', en: 'Obsidian MCP: {state}\nOther servers in mcp_config.json: {others}\nFile: {path}', fr: 'MCP Obsidian : {state}\nAutres serveurs dans mcp_config.json : {others}\nFichier : {path}' },
  none_m: { es: 'Ninguno', en: 'None', fr: 'Aucun' },
  open_file: { es: 'Abrir Archivo', en: 'Open File', fr: 'Ouvrir le fichier' },
  mcp_status_error: { es: 'Error al consultar estado MCP: {err}', en: 'Error querying MCP status: {err}', fr: 'Erreur de consultation du statut MCP : {err}' },
  install_tool_title: { es: 'Instalar Herramienta para la IA desde GitHub', en: 'Install AI Tool from GitHub', fr: 'Installer un outil IA depuis GitHub' },
  install_tool_prompt: { es: 'Introduce la URL del repositorio de GitHub (ej: https://github.com/usuario/repo)', en: 'Enter the GitHub repository URL (e.g.: https://github.com/user/repo)', fr: "Entre l'URL du dépôt GitHub (ex : https://github.com/user/repo)" },
  no_tools_msg: { es: 'No hay herramientas instaladas para la IA. Puedes instalar herramientas desde GitHub usando el panel lateral.', en: 'No tools installed for the AI. You can install tools from GitHub using the side panel.', fr: "Aucun outil installé pour l'IA. Tu peux installer des outils depuis GitHub via le panneau latéral." },
  auto_checkpoint_summary: { es: 'Hito de trabajo: {n} archivo{s} editado{s} en {name}', en: 'Work milestone: {n} file{s} edited in {name}', fr: 'Étape de travail : {n} fichier{s} modifié{s} dans {name}' },
  auto_checkpoint_content: { es: 'Archivos editados en la sesión:\n- {files}\n\nRegistro automático continuo del estado de trabajo ({reason}).', en: 'Files edited in the session:\n- {files}\n\nContinuous automatic log of work state ({reason}).', fr: "Fichiers modifiés dans la session :\n- {files}\n\nJournal automatique continu de l'état de travail ({reason})." },
  auto_commit: { es: 'Sesión: {name} ({n} archivos)', en: 'Session: {name} ({n} files)', fr: 'Session : {name} ({n} fichiers)' },
  reason_inactivity: { es: 'inactividad tras guardado', en: 'inactivity after save', fr: 'inactivité après enregistrement' },
  reason_blur: { es: 'cambio de foco', en: 'focus change', fr: 'changement de focus' },
  reason_periodic: { es: 'temporizador periódico', en: 'periodic timer', fr: 'minuteur périodique' },
};

// Index/personality file names written by sync-engine differ per language.
const INDEX_NAMES = {
  sessions: { dir: '03_Sesiones', es: '00 Indice de Sesiones.md', en: '00 Sessions Index.md', fr: '00 Index des Sessions.md' },
  projects: { dir: '02_Proyectos', es: '00 Indice de Proyectos.md', en: '00 Projects Index.md', fr: '00 Index des Projets.md' },
  skills: { dir: '01_Skills', es: '00 Indice de Skills.md', en: '00 Skills Index.md', fr: '00 Index des Skills.md' },
};
const PERSONALITY_NAMES = { es: '00 Personalidad de la IA.md', en: '00 AI Personality.md', fr: '00 Personnalité IA.md' };

// UI translation language: 'es' | 'en' | 'fr' (de/zh/ja fall back to English
// for server-side strings; the webview dict still handles them via data-i18n).
function uiLang() {
  const conf = vscode.workspace.getConfiguration('antigravityObsidian').get('language') || 'auto';
  let lang = conf === 'auto' ? (vscode.env.language || 'en') : conf;
  lang = String(lang).toLowerCase().split(/[-_]/)[0];
  return ['es', 'fr'].includes(lang) ? lang : 'en';
}

// Map any configured/detected lang (auto, fr-FR, de, zh...) to the effective
// webview lang used for <html lang> and I18N lookups.
function effectiveUILang(configuredLang, ideLang) {
  if (configuredLang && configuredLang !== 'auto') return configuredLang;
  const l = String(ideLang || 'en').toLowerCase();
  return ['es', 'en', 'fr', 'de', 'zh', 'ja'].find(x => l.startsWith(x)) || 'en';
}

function t(key, params, lang) {
  const l = lang || uiLang();
  const dict = UI_STRINGS[key] || {};
  let s = dict[l] || dict.en || dict.es || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// Resolve a per-language vault file (index or personality): prefer the name
// matching `lang`, but accept whichever variant actually exists on disk.
// Returns { abs, rel } or null if the vault path is missing.
function findVaultFile(vaultPath, dir, names, lang) {
  if (!vaultPath) return null;
  const ordered = [names[lang] || names.en, names.es, names.en, names.fr]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  for (const name of ordered) {
    const abs = path.join(vaultPath, dir, name);
    if (fs.existsSync(abs)) return { abs, rel: `${dir}/${name}` };
  }
  const preferred = names[lang] || names.en;
  return { abs: path.join(vaultPath, dir, preferred), rel: `${dir}/${preferred}` };
}

function findIndexFile(vaultPath, kind, lang) {
  const n = INDEX_NAMES[kind];
  return findVaultFile(vaultPath, n.dir, n, lang);
}

function runObsidianCli(cliArgs, cwd) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(os.homedir(), '.gemini', 'config', 'skills', 'antigravity-obsidian', 'scripts', 'obsidian.js');
    const runnerSource = path.join(__dirname, 'src', 'obsidian-runner.js');
    const targetScript = fs.existsSync(scriptPath) ? scriptPath : runnerSource;
    const cmd = `node "${targetScript}" ${cliArgs}`;
    exec(cmd, { cwd: cwd || getWorkspaceRoot() || process.cwd() }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || (err && err.message) || t('cli_error')));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        resolve({ stdout, raw: true });
      }
    });
  });
}

async function promptSelectVault(onSuccess) {
  const folderUri = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t('btn_select_vault'),
  });

  if (folderUri && folderUri[0]) {
    const selectedPath = folderUri[0].fsPath;
    await vscode.workspace.getConfiguration('antigravityObsidian').update('vaultPath', selectedPath, vscode.ConfigurationTarget.Global);
    const newVault = getActiveOrConfiguredVault(selectedPath);
    const config = vscode.workspace.getConfiguration('antigravityObsidian');
    const configuredLang = config.get('language') || 'auto';
    const configuredUser = config.get('userName') || '';
    installSkillAndRules(selectedPath, { language: configuredLang, userName: configuredUser });
    syncEngine.syncAll(selectedPath, getWorkspaceRoot(), { language: configuredLang, userName: configuredUser });
    updateStatusBar(newVault);
    if (onSuccess) onSuccess();
    vscode.window.showInformationMessage(t('vault_configured', { name: newVault ? newVault.name : selectedPath }));
    return newVault;
  }
  return null;
}

class ObsidianPanelProvider {
  constructor(extensionUri, context) {
    this._extensionUri = extensionUri;
    this._context = context;
  }

  resolveWebviewView(webviewView) {
    currentWebviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const updateView = () => {
      webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    };

    // Auto-sync on panel open so everything is fresh immediately
    const config = vscode.workspace.getConfiguration('antigravityObsidian');
    const configuredPath = config.get('vaultPath');
    const configuredLang = config.get('language') || 'auto';
    const configuredUser = config.get('userName') || '';
    const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
    const vault = ensureOrCreateDefaultVault(configuredPath);
    const workspaceRoot = getWorkspaceRoot();

    if (vault && vault.exists) {
      try {
        syncEngine.syncAll(vault.path, workspaceRoot, { language: configuredLang, userName: configuredUser });
      } catch (e) {}
    }

    updateView();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const currentVault = ensureOrCreateDefaultVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const currentRoot = getWorkspaceRoot();
      const currentConfig = vscode.workspace.getConfiguration('antigravityObsidian');
      const activeLang = currentConfig.get('language') || 'auto';
      const activeUser = currentConfig.get('userName') || '';

      switch (message.type) {
        case 'syncNow': {
          if (currentVault && currentVault.path) {
            syncEngine.syncAll(currentVault.path, currentRoot, { language: activeLang, userName: activeUser });
            installSkillAndRules(currentVault.path, { language: activeLang, userName: activeUser });
            updateStatusBar(currentVault);
            updateView();
            webviewView.webview.postMessage({ type: 'syncComplete' });
          } else {
            vscode.window.showErrorMessage(t('no_vault'));
          }
          break;
        }

        case 'openHub': {
          if (currentVault && currentVault.path) {
            openInObsidianApp(currentVault.name, '00_Agente/SOUL');
          }
          break;
        }

        case 'openNote': {
          if (currentVault && currentVault.path && message.path) {
            openInObsidianApp(currentVault.name, message.path);
          }
          break;
        }

        case 'savePersonality': {
          const { userCallsign, aiName, personality } = message;
          const currentConfig = vscode.workspace.getConfiguration('antigravityObsidian');
          if (userCallsign) {
            await currentConfig.update('userCallsign', userCallsign, vscode.ConfigurationTarget.Global);
            await currentConfig.update('userName', userCallsign, vscode.ConfigurationTarget.Global);
          }
          if (aiName) {
            await currentConfig.update('aiName', aiName, vscode.ConfigurationTarget.Global);
          }
          if (personality) {
            await currentConfig.update('personality', personality, vscode.ConfigurationTarget.Global);
          }
          await currentConfig.update('personalityConfigured', true, vscode.ConfigurationTarget.Global);

          if (currentVault && currentVault.path) {
            syncEngine.ensurePersonality(currentVault.path, {
              userCallsign: userCallsign || activeUser,
              aiName: aiName || 'Pedro',
              personality,
              personalityConfigured: true,
              forceUpdate: true
            });
            installSkillAndRules(currentVault.path, {
              userCallsign: userCallsign || activeUser,
              aiName: aiName || 'Pedro',
              personality,
              personalityConfigured: true,
              userName: userCallsign || activeUser,
              language: activeLang
            });
            syncEngine.syncAll(currentVault.path, currentRoot, {
              userCallsign: userCallsign || activeUser,
              aiName: aiName || 'Pedro',
              userName: userCallsign || activeUser,
              language: activeLang
            });
            updateView();
            vscode.window.showInformationMessage(t('identity_saved', { ai: aiName || 'Pedro', user: userCallsign || 'David' }));
          }
          break;
        }

        case 'saveMemory': {
          if (currentVault && currentVault.path && message.data) {
            const saved = syncEngine.saveNewMemory(currentVault.path, {
              ...message.data,
              project: currentRoot ? path.basename(currentRoot) : null,
            });
            syncEngine.generateHub(currentVault.path, currentRoot, { language: activeLang, userName: activeUser });
            updateView();
            webviewView.webview.postMessage({ type: 'memorySaved', title: saved.title });
          }
          break;
        }

        case 'selectVault': {
          await promptSelectVault(() => {
            updateView();
          });
          break;
        }

        case 'reinstallSkill': {
          if (currentVault && currentVault.path) {
            installSkillAndRules(currentVault.path, { language: activeLang, userName: activeUser });
            vscode.window.showInformationMessage(t('skill_updated'));
            updateView();
          }
          break;
        }

        case 'setLanguage': {
          const newLang = message.language || 'auto';
          await vscode.workspace.getConfiguration('antigravityObsidian').update('language', newLang, vscode.ConfigurationTarget.Global);
          if (currentVault && currentVault.path) {
            syncEngine.ensureSoulAndProfile(currentVault.path, { language: newLang, userName: activeUser, forceUpdate: true });
            installSkillAndRules(currentVault.path, { language: newLang, userName: activeUser });
            syncEngine.generateHub(currentVault.path, currentRoot, { language: newLang, userName: activeUser });
            updateView();
            vscode.window.showInformationMessage(t('lang_switched', { lang: newLang.toUpperCase() }));
          }
          break;
        }

        case 'updateAiConfig': {
          const cfgData = message.data || message || {};
          const proactiveLookup = cfgData.proactiveLookup !== undefined ? !!cfgData.proactiveLookup : true;
          const autoSave = cfgData.autoSave !== undefined ? !!cfgData.autoSave : true;
          const language = cfgData.language !== undefined ? cfgData.language : activeLang;
          const userName = cfgData.userName !== undefined ? cfgData.userName : activeUser;

          await vscode.workspace.getConfiguration('antigravityObsidian').update('language', language, vscode.ConfigurationTarget.Global);
          if (userName !== undefined) {
            await vscode.workspace.getConfiguration('antigravityObsidian').update('userName', userName, vscode.ConfigurationTarget.Global);
          }

          if (currentVault && currentVault.path) {
            syncEngine.ensureSoulAndProfile(currentVault.path, { language, userName, forceUpdate: true });
            installSkillAndRules(currentVault.path, { proactiveLookup, autoSave, language, userName });
            syncEngine.generateHub(currentVault.path, currentRoot, { language, userName });
            vscode.window.showInformationMessage(t('ai_config_saved'));
            updateView();
          }
          break;
        }

        case 'resetAllData': {
          if (currentVault && currentVault.path) {
            const confirmLabel = t('btn_reset_confirm');
            const answer = await vscode.window.showWarningMessage(
              t('reset_confirm'),
              { modal: true },
              confirmLabel,
              t('cancel')
            );
            if (answer === confirmLabel) {
              syncEngine.resetAllData(currentVault.path, currentRoot);
              installSkillAndRules(currentVault.path);
              updateStatusBar(currentVault);
              updateView();
              vscode.window.showInformationMessage(t('reset_done'));
              webviewView.webview.postMessage({ type: 'resetComplete' });
            }
          } else {
            vscode.window.showErrorMessage(t('no_vault'));
          }
          break;
        }

        case 'showSessions': {
          if (currentVault && currentVault.path) {
            const idx = findIndexFile(currentVault.path, 'sessions', uiLang());
            if (idx && fs.existsSync(idx.abs)) {
              vscode.workspace.openTextDocument(idx.abs).then(doc => vscode.window.showTextDocument(doc, { preview: false }));
            } else if (idx) {
              openInObsidianApp(currentVault.name, idx.rel.replace(/\.md$/, ''));
            }
          }
          break;
        }

        case 'showProjects': {
          if (currentVault && currentVault.path) {
            const idx = findIndexFile(currentVault.path, 'projects', uiLang());
            if (idx && fs.existsSync(idx.abs)) {
              vscode.workspace.openTextDocument(idx.abs).then(doc => vscode.window.showTextDocument(doc, { preview: false }));
            } else if (idx) {
              openInObsidianApp(currentVault.name, idx.rel.replace(/\.md$/, ''));
            }
          }
          break;
        }

        case 'scanProject': {
          vscode.commands.executeCommand('antigravityObsidian.scanProject');
          break;
        }

        case 'saveSession': {
          vscode.commands.executeCommand('antigravityObsidian.saveSession');
          break;
        }

        case 'exportVault': {
          vscode.commands.executeCommand('antigravityObsidian.exportVault');
          break;
        }

        case 'importVault': {
          vscode.commands.executeCommand('antigravityObsidian.importVault');
          break;
        }

        case 'installMcp': {
          vscode.commands.executeCommand('antigravityObsidian.installMcp');
          break;
        }

        case 'disableMcp': {
          vscode.commands.executeCommand('antigravityObsidian.disableMcp');
          break;
        }

        case 'mcpStatus': {
          vscode.commands.executeCommand('antigravityObsidian.mcpStatus');
          break;
        }

        case 'installToolGithub': {
          if (!message.url) break;
          const toolsEngine = require('./src/tools-engine');
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('installing_tool'),
            cancellable: false
          }, async () => {
            try {
              const res = await toolsEngine.installFromGithub(message.url, {}, currentVault ? currentVault.path : null);
              vscode.window.showInformationMessage(t('tool_installed', { name: res.name }));
              updateView();
            } catch (err) {
              vscode.window.showErrorMessage(t('tool_install_error', { err: err.message }));
            }
          });
          break;
        }

        case 'uninstallTool': {
          if (!message.name) break;
          const toolsEngine = require('./src/tools-engine');
          try {
            const res = toolsEngine.uninstallTool(message.name, currentVault ? currentVault.path : null);
            vscode.window.showInformationMessage(t('tool_uninstalled', { name: message.name }));
            updateView();
          } catch (err) {
            vscode.window.showErrorMessage(t('tool_uninstall_error', { err: err.message }));
          }
          break;
        }

        case 'openNote': {
          if (message.note && currentVault && currentVault.path) {
            let noteRel = message.note;
            if (!noteRel.endsWith('.md')) noteRel += '.md';
            const fullPath = path.join(currentVault.path, noteRel);
            if (fs.existsSync(fullPath)) {
              vscode.workspace.openTextDocument(fullPath).then(doc => vscode.window.showTextDocument(doc, { preview: false }));
            } else {
              openInObsidianApp(currentVault.name, message.note.replace(/\.md$/, ''));
            }
          }
          break;
        }

        case 'openExternal': {
          if (message.url) {
            vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
        }

        case 'refresh': {
          updateView();
          break;
        }
      }
    });
  }

  _getHtmlForWebview(webview) {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

    const config = vscode.workspace.getConfiguration('antigravityObsidian');
    const configuredPath = config.get('vaultPath');
    const T = (k, p) => t(k, p); // server-side UI strings, resolved via configured language
    const detection = detectVaults();
    const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
    const vault = ensureOrCreateDefaultVault(configuredPath);
    const workspaceRoot = getWorkspaceRoot();

    let stats = { memories: 0, skills: 0, projects: 0, sessions: 0, hubExists: false };
    let memoryList = [];
    let skillList = [];
    let sessionList = [];
    let projectList = [];
    let toolsList = [];
    let graphData = { nodes: [], links: [] };
    let isVaultGit = false;

    try {
      const toolsEngine = require('./src/tools-engine');
      const toolsData = toolsEngine.listTools(vault ? vault.path : null);
      toolsList = toolsData.tools || [];
    } catch (e) {}

    let hermesQuotas = { userChars: 0, userLimit: 1500, userPercent: 0, memChars: 0, memLimit: 2500, memPercent: 0, skillsCount: 0 };

    if (vault && vault.path && fs.existsSync(vault.path)) {
      try {
        syncEngine.migrateToHermes(vault.path);
        hermesQuotas = syncEngine.getHermesQuotas(vault.path);
      } catch (e) {}

      try { stats = syncEngine.getVaultStats(vault.path); } catch (e) {}
      try { sessionList = syncEngine.listSessions(vault.path, { limit: 40 }); } catch (e) {}
      try { projectList = syncEngine.listProjects(vault.path); } catch (e) {}
      try { graphData = syncEngine.getGraphData(vault.path); } catch (e) {}
      isVaultGit = fs.existsSync(path.join(vault.path, '.git'));

      // Read memory list
      const memFolder = path.join(vault.path, '00_Agente', 'Memorias');
      if (fs.existsSync(memFolder)) {
        memoryList = fs.readdirSync(memFolder)
          .filter(f => f.endsWith('.md') && !f.startsWith('00'))
          .map(f => {
            const fp = path.join(memFolder, f);
            const content = fs.readFileSync(fp, 'utf8');
            const title = f.replace(/\.md$/, '');
            
            const catMatch = content.match(/category:\s*["']?([^"'\n]+)["']?/i);
            const category = catMatch ? catMatch[1] : 'general';

            const sumMatch = content.match(/> \[!NOTE\][^\n]*\n>\s*([^\n]+)/i) || content.match(/> \[!ABSTRACT\][^\n]*\n>\s*([^\n]+)/i);
            const summary = sumMatch ? sumMatch[1] : content.replace(/---[\s\S]*?---/, '').replace(/#+[^\n]+/g, '').trim().slice(0, 150);
            
            const fileStat = fs.statSync(fp);
            const dateStr = fileStat.mtime.toISOString().split('T')[0];

            return { title, summary, category, date: dateStr, relPath: `00_Agente/Memorias/${title}` };
          });
      }

      // Read skill list (both 01_Skills and Antigravity/Skills)
      const skiFolder = path.join(vault.path, '01_Skills');
      const legacySkiFolder = null;
      const targetSkiFolder = fs.existsSync(skiFolder) && fs.readdirSync(skiFolder).filter(f => f.endsWith('.md')).length > 0
        ? skiFolder
        : legacySkiFolder;

      if (targetSkiFolder && fs.existsSync(targetSkiFolder)) {
        skillList = fs.readdirSync(targetSkiFolder)
          .filter(f => f.endsWith('.md') && !f.startsWith('00'))
          .map(f => {
            const fp = path.join(targetSkiFolder, f);
            const content = fs.readFileSync(fp, 'utf8');
            const title = f.replace(/\.md$/, '');
            const versionMatch = content.match(/version:\s*([0-9.]+)/);
            const vStr = versionMatch ? ` (v${versionMatch[1]})` : '';
            const scopeMatch = content.match(/scope:\s*(\w+)/);
            const scope = scopeMatch ? scopeMatch[1] : 'global';
            const descMatch = content.match(/> - \*\*Descripción\*\*:\s*([^\n]+)/) || content.match(/## Procedimiento Operativo\s*\n([^\n]+)/) || content.match(/##\s*(?:Procédure|Procedure)\b[^\n]*\n([^\n]+)/i);
            const desc = (descMatch ? descMatch[1] : T('skill_default_desc')) + vStr;
            const relPath = `01_Skills/${title}.md`;
            return { title, desc, scope, relPath };
          });
      }
    }

    const isConnected = !!(vault && vault.exists);
    const vaultName = isConnected ? vault.name : 'Offline';
    const vaultPath = isConnected ? vault.path : T('select_folder');

    let proactiveLookup = true;
    let autoSave = true;
    const os = require('os');
    const globalConfigPath = path.join(os.homedir(), '.gemini', 'config', 'antigravity-obsidian.json');
    if (fs.existsSync(globalConfigPath)) {
      try {
        const gc = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
        if (gc.proactiveLookup !== undefined) proactiveLookup = !!gc.proactiveLookup;
        if (gc.autoSave !== undefined) autoSave = !!gc.autoSave;
      } catch (e) {}
    }

    const configuredLang = config.get('language') || 'auto';
    const configuredUser = config.get('userName') || '';
    const ideLang = (vscode.env.language || 'en').toLowerCase();
    const effectiveLang = effectiveUILang(configuredLang, ideLang);
    let effectiveUser = configuredUser;
    let personalityInfo = {};
    let mcpStatus = { installed: false };
    try { effectiveUser = syncEngine.resolveUserName(vault ? vault.path : null, configuredUser); } catch (e) {}
    try {
      personalityInfo = syncEngine.resolvePersonality(vault ? vault.path : null, {
        userName: configuredUser,
        aiName: config.get('aiName'),
        userCallsign: config.get('userCallsign'),
        personality: config.get('personality')
      }) || {};
    } catch (e) {}
    try { mcpStatus = syncEngine.getMcpStatus(vault ? vault.path : null) || { installed: false }; } catch (e) {}

    // Per-language vault file names (match whatever actually exists on disk)
    const sesIndexRel = (findIndexFile(vault ? vault.path : null, 'sessions', effectiveLang) || {}).rel || '03_Sesiones/00 Index des Sessions.md';
    const projIndexRel = (findIndexFile(vault ? vault.path : null, 'projects', effectiveLang) || {}).rel || '02_Proyectos/00 Index des Projets.md';
    const persFileRel = (findVaultFile(vault ? vault.path : null, '00_Agente', PERSONALITY_NAMES, effectiveLang) || {}).rel || '00_Agente/00 Personnalité IA.md';

    return `<!DOCTYPE html>
<html lang="${effectiveLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Obsidian for Antigravity</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <!-- Header -->
  <div class="app-header">
    <div class="brand-wrapper">
      <div class="brand-badge">
        ${SVGS.crystal}
      </div>
      <div class="brand-info">
        <h1 data-i18n="brand_title">Obsidian for Antigravity</h1>
        <p data-i18n="brand_subtitle">Antigravity Second Brain</p>
      </div>
    </div>
    <div class="header-right">
      <select class="lang-selector-compact lang-select" title="${T('language')}">
        <option value="auto" ${configuredLang === 'auto' ? 'selected' : ''}>Auto (${ideLang.toUpperCase()})</option>
        <option value="es" ${configuredLang === 'es' ? 'selected' : ''}>ES</option>
        <option value="en" ${configuredLang === 'en' ? 'selected' : ''}>EN</option>
        <option value="fr" ${configuredLang === 'fr' ? 'selected' : ''}>FR</option>
        <option value="de" ${configuredLang === 'de' ? 'selected' : ''}>DE</option>
        <option value="zh" ${configuredLang === 'zh' ? 'selected' : ''}>ZH</option>
        <option value="ja" ${configuredLang === 'ja' ? 'selected' : ''}>JA</option>
      </select>
      <div class="status-badge" title="Status">
        <div class="status-pulse" style="${isConnected ? '' : 'background:#ef4444;box-shadow:none;'}"></div>
        <span data-i18n="${isConnected ? 'online' : 'offline'}">${isConnected ? 'Online' : 'Offline'}</span>
      </div>
    </div>
  </div>

  <!-- Vault Connection Banner -->
  <div class="vault-card">
    <div class="vault-top">
      <div class="vault-title">
        ${SVGS.vault} <span>${vaultName}</span>
      </div>
      <div class="vault-actions">
        <button class="icon-btn" id="btn-copy-path" data-path="${vaultPath}" title="${T('copy_path')}">${SVGS.copy}</button>
        <button class="icon-btn" id="btn-change-vault" title="${T('configure')}">${SVGS.settings}</button>
      </div>
    </div>
    <div class="vault-path-badge" title="${vaultPath}">
      <span>${vaultPath}</span>
    </div>
  </div>

  ${!isConnected ? `
  <div class="obsidian-install-banner" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:14px;margin-bottom:12px;">
    <div style="display:flex;align-items:center;gap:8px;font-weight:600;color:#f87171;margin-bottom:6px;">
      ${SVGS.alert}
      <span>${T('obsidian_not_detected')}</span>
    </div>
    <div style="font-size:12px;line-height:1.5;color:var(--text-muted);margin-bottom:12px;">
      ${T('obsidian_install_hint')}
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn-action btn-gradient" id="btn-install-obsidian" style="flex:1;">
        ${SVGS.globe} <span>${T('btn_install_obsidian')}</span>
      </button>
      <button class="btn-action btn-outline" id="btn-select-vault-card" style="flex:1;">
        ${SVGS.vault} <span>${T('btn_select_vault')}</span>
      </button>
    </div>
  </div>
  ` : ''}

  <!-- Stats Row -->
  <div class="stats-row">
    <div class="stat-box active" data-tab="memoria">
      <div class="stat-num">${stats.memories}</div>
      <div class="stat-meta">${SVGS.brain} <span data-i18n="memories">Memorias</span></div>
    </div>
    <div class="stat-box" data-tab="skills">
      <div class="stat-num">${stats.skills}</div>
      <div class="stat-meta">${SVGS.zap} <span data-i18n="skills">Skills</span></div>
    </div>
    <div class="stat-box" data-tab="sesiones" id="stat-sessions" title="${T('sessions_index')}">
      <div class="stat-num">${stats.sessions || sessionList.length || 0}</div>
      <div class="stat-meta">${SVGS.history} <span data-i18n="sessions">Sesiones</span></div>
    </div>
    <div class="stat-box" data-tab="proyectos" id="stat-projects" title="${T('projects_index')}">
      <div class="stat-num">${stats.projects || projectList.length || 0}</div>
      <div class="stat-meta">${SVGS.folder} <span data-i18n="projects">Proyectos</span></div>
    </div>
  </div>

  <!-- Pill Tabs -->
  <div class="tabs-nav">
    <button class="tab-pill active" data-tab="panel">
      ${SVGS.dashboard}
      <span class="tab-text" data-i18n="tab_panel">Panel</span>
    </button>
    <button class="tab-pill" data-tab="memoria">
      ${SVGS.brain}
      <span class="tab-text" data-i18n="tab_memories">Memorias</span>
      <span class="tab-badge">${memoryList.length}</span>
    </button>
    <button class="tab-pill" data-tab="skills">
      ${SVGS.zap}
      <span class="tab-text" data-i18n="tab_skills">Skills</span>
      <span class="tab-badge">${skillList.length}</span>
    </button>
    <button class="tab-pill" data-tab="sesiones">
      ${SVGS.history}
      <span class="tab-text" data-i18n="tab_sessions">Sesiones</span>
      <span class="tab-badge">${sessionList.length}</span>
    </button>
    <button class="tab-pill" data-tab="proyectos">
      ${SVGS.folder}
      <span class="tab-text" data-i18n="tab_projects">Proyectos</span>
      <span class="tab-badge">${projectList.length}</span>
    </button>
    <button class="tab-pill" data-tab="grafo">
      ${SVGS.network}
      <span class="tab-text" data-i18n="tab_graph">Grafo</span>
    </button>
    <button class="tab-pill" data-tab="crear">
      ${SVGS.plus}
      <span class="tab-text" data-i18n="tab_create">Crear</span>
    </button>
    <button class="tab-pill" data-tab="herramientas">
      ${SVGS.zap}
      <span class="tab-text">${T('tab_tools')}</span>
      <span class="tab-badge">${toolsList.length}</span>
    </button>
    <button class="tab-pill" data-tab="ajustes">
      ${SVGS.settings}
      <span class="tab-text" data-i18n="tab_settings">Ajustes</span>
    </button>
  </div>

  <!-- TAB 1: PANEL / RESUMEN -->
  <div class="tab-pane active" id="pane-panel">
    <!-- Interactive Graph Card -->
    <div class="graph-preview-card" id="card-open-graph">
      <div class="graph-icon-wrap">${SVGS.network}</div>
      <div class="graph-title" data-i18n="graph_title">Explorar Grafo de Conocimiento</div>
      <div class="graph-desc" data-i18n="graph_desc">Abre Obsidian Graph View con todas tus notas interconectadas.</div>
    </div>

    <div class="action-grid">
      <button class="btn-action btn-gradient" id="btn-sync">
        ${SVGS.sync} <span class="btn-label" data-i18n="btn_sync">Sincronizar Bóveda</span>
      </button>
      <button class="btn-action btn-outline" id="btn-open-hub">
        ${SVGS.open} <span data-i18n="btn_open_hub">Abrir 00 Antigravity Hub</span>
      </button>
    </div>
    <div class="action-grid" style="margin-top:6px;">
      <button class="btn-action btn-outline" id="btn-scan-project">
        ${SVGS.search} <span data-i18n="btn_scan_project">Escanear Proyecto</span>
      </button>
      <button class="btn-action btn-outline" id="btn-save-session">
        ${SVGS.history} <span data-i18n="btn_save_session">Guardar Sesión</span>
      </button>
    </div>

    <div class="soul-card" id="card-soul">
      <div class="soul-header">
        <div class="soul-badge-wrap">
          ${SVGS.brain}
          <span class="soul-title" data-i18n="soul_title">Hermes Core — Identidad del Agente</span>
        </div>
        <span class="status-badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);" data-i18n="soul_status_active">Activo</span>
      </div>
      <div class="soul-body">
        <div class="soul-row">
          <strong data-i18n="soul_label">Agente de IA:</strong>
          <span style="color:#a855f7;font-weight:600;">${personalityInfo.aiName || 'Pedro'}</span>
          <span style="font-size:10px;color:var(--text-dim);">${T('soul_default_desc')}</span>
        </div>
        <div class="soul-row">
          <strong>${T('soul_callsign_label')}</strong>
          <span style="color:#34d399;font-weight:600;">${personalityInfo.userCallsign || effectiveUser || 'David'}</span>
          <span style="font-size:10px;color:var(--text-dim);">${T('soul_callsign_hint')}</span>
        </div>
      </div>
      <div class="soul-actions">
        <button class="btn-open-link" id="btn-edit-personality">
          ${SVGS.settings} <span>${T('btn_edit_identity')}</span>
        </button>
        <button class="btn-open-link btn-open-note" data-note="${persFileRel}">
          ${SVGS.open} <span>${T('personality')}</span>
        </button>
        <button class="btn-open-link btn-open-note" data-note="00_Agente/USER.md">
          ${SVGS.open} <span data-i18n="soul_view_profile">USER.md</span>
        </button>
      </div>
    </div>

    <!-- Hermes Closed Learning Loop & Bounded Memory Card -->
    <div class="soul-card" style="margin-top:10px;">
      <div class="soul-header">
        <div class="soul-badge-wrap">
          ${SVGS.brain}
          <span class="soul-title">${T('hermes_loop_title')}</span>
        </div>
        <span class="status-badge" style="background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);">${T('v2_active')}</span>
      </div>
      <div class="soul-body">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
          ${T('hermes_loop_desc')}
        </div>
        
        <!-- USER.md Meter -->
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span><strong>00_Agente/USER.md</strong></span>
            <span style="color:${hermesQuotas.userPercent > 90 ? '#ef4444' : (hermesQuotas.userPercent > 70 ? '#f59e0b' : '#10b981')};font-family:monospace;">
              ${hermesQuotas.userChars} / ${hermesQuotas.userLimit} (${hermesQuotas.userPercent}%)
            </span>
          </div>
          <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${hermesQuotas.userPercent}%;background:${hermesQuotas.userPercent > 90 ? '#ef4444' : (hermesQuotas.userPercent > 70 ? '#f59e0b' : '#10b981')};border-radius:3px;"></div>
          </div>
        </div>

        <!-- MEMORY.md Meter -->
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span><strong>00_Agente/MEMORY.md</strong></span>
            <span style="color:${hermesQuotas.memPercent > 90 ? '#ef4444' : (hermesQuotas.memPercent > 70 ? '#f59e0b' : '#10b981')};font-family:monospace;">
              ${hermesQuotas.memChars} / ${hermesQuotas.memLimit} (${hermesQuotas.memPercent}%)
            </span>
          </div>
          <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${hermesQuotas.memPercent}%;background:${hermesQuotas.memPercent > 90 ? '#ef4444' : (hermesQuotas.memPercent > 70 ? '#f59e0b' : '#10b981')};border-radius:3px;"></div>
          </div>
        </div>

        <!-- Skills Count Badge -->
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.06);">
          <span><strong>${T('skills_playbooks')}</strong></span>
          <span class="tag-badge" style="background:rgba(99,102,241,0.15);color:#818cf8;">${T('skills_versioned', { n: hermesQuotas.skillsCount })}</span>
        </div>
      </div>
      <div class="soul-actions" style="margin-top:8px;">
        <button class="btn-open-link btn-open-note" data-note="00_Agente/USER.md">
          ${SVGS.open} <span>USER.md</span>
        </button>
        <button class="btn-open-link btn-open-note" data-note="00_Agente/MEMORY.md">
          ${SVGS.open} <span>MEMORY.md</span>
        </button>
        <button class="btn-open-link btn-open-note" data-note="00_Agente/SOUL.md">
          ${SVGS.open} <span>SOUL.md</span>
        </button>
      </div>
    </div>

    <!-- MCP Server Integration Card -->
    <div class="soul-card" style="margin-top:10px;">
      <div class="soul-header">
        ${SVGS.crystal} <span style="font-weight:600;">${T('mcp_title')}</span>
        <span class="tag-badge" style="${mcpStatus.enabled ? 'background:rgba(34,197,94,0.15);color:#4ade80;' : 'background:rgba(239,68,68,0.15);color:#f87171;'}">
          ${mcpStatus.enabled ? T('mcp_active') : (mcpStatus.installed ? T('mcp_disabled') : T('mcp_not_installed'))}
        </span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin:8px 0;line-height:1.4;">
        ${mcpStatus.enabled ? T('mcp_desc_enabled') : T('mcp_desc_disabled')}
      </div>
      <div style="display:flex;gap:8px;">
        ${mcpStatus.enabled ? `
          <button class="btn-action btn-outline" id="btn-disable-mcp" style="flex:1;">
            <span>${T('btn_disable_mcp')}</span>
          </button>
        ` : `
          <button class="btn-action btn-gradient" id="btn-install-mcp" style="flex:1;">
            <span>${T('btn_install_mcp')}</span>
          </button>
        `}
      </div>
    </div>

    <div class="info-banner">
      <strong data-i18n="info_title">Sincronización Autónoma Activa</strong><br>
      <span data-i18n="info_desc">Antigravity aprende de tus conversaciones y guarda lecciones en tu Vault automáticamente sin pedir confirmación.</span>
    </div>
  </div>

  <!-- TAB 2: MEMORIAS -->
  <div class="tab-pane" id="pane-memoria">
    <div class="search-wrapper">
      <span class="search-icon-pos">${SVGS.search}</span>
      <input type="text" class="search-input" id="search-memories" data-i18n-ph="search_memories" placeholder="Buscar en memorias...">
    </div>

    <div class="filter-chips">
      <div class="chip active" data-category="all" data-i18n="filter_all">Todos</div>
      <div class="chip" data-category="arquitectura" data-i18n="filter_arch">Arquitectura</div>
      <div class="chip" data-category="bugfix" data-i18n="filter_bugfix">Bugfix</div>
      <div class="chip" data-category="knowledge-item" data-i18n="filter_knowledge">Knowledge</div>
      <div class="chip" data-category="general" data-i18n="filter_general">General</div>
    </div>

    <div class="cards-scroll-container" id="memories-list">
      ${memoryList.length === 0 ? `<div style="color:var(--text-muted);text-align:center;padding:20px;" data-i18n="no_memories">Sin memorias registradas aún</div>` : ''}
      ${memoryList.map(m => `
        <div class="note-item" data-title="${m.title}" data-cat="${m.category}">
          <div class="note-top">
            <span class="note-name">${m.title}</span>
            <span class="tag-badge">${m.category}</span>
          </div>
          <div class="note-snippet">${m.summary}</div>
          <div class="note-foot">
            <span class="note-date">${m.date}</span>
            <div style="display:flex;gap:6px;">
              <button class="btn-open-link btn-copy-wikilink" data-title="${m.title}">
                ${SVGS.copy} <span data-i18n="btn_copy">Copiar</span>
              </button>
              <button class="btn-open-link btn-open-note" data-note="${m.relPath}">
                ${SVGS.open} <span data-i18n="btn_open">Abrir</span>
              </button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- TAB 3: SKILLS -->
  <div class="tab-pane" id="pane-skills">
    <div class="search-wrapper">
      <span class="search-icon-pos">${SVGS.search}</span>
      <input type="text" class="search-input" id="search-skills" data-i18n-ph="search_skills" placeholder="Filtrar skills...">
    </div>

    <div class="cards-scroll-container" id="skills-list">
      ${skillList.length === 0 ? `<div style="color:var(--text-muted);text-align:center;padding:20px;" data-i18n="no_skills">Sin skills sincronizadas aún</div>` : ''}
      ${skillList.map(s => `
        <div class="note-item" data-title="${s.title}">
          <div class="note-top">
            <span class="note-name">${s.title}</span>
            <span class="tag-badge ${s.scope === 'global' ? 'skill-global' : ''}">${s.scope}</span>
          </div>
          <div class="note-snippet">${s.desc}</div>
          <div class="note-foot">
            <span class="note-date">${T('active')}</span>
            <button class="btn-open-link btn-open-note" data-note="${s.relPath}">
              ${SVGS.open} <span data-i18n="btn_open">Abrir</span>
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- TAB: SESIONES -->
  <div class="tab-pane" id="pane-sesiones">
    <div class="search-wrapper">
      <span class="search-icon-pos">${SVGS.search}</span>
      <input type="text" class="search-input" id="search-sessions" data-i18n-ph="search_sessions" placeholder="Buscar en sesiones...">
    </div>

    <div style="display:flex;gap:6px;margin-bottom:10px;">
      <button class="btn-action btn-gradient" id="btn-new-session-tab" style="flex:1;">
        ${SVGS.history} <span data-i18n="btn_save_session">Guardar Checkpoint</span>
      </button>
      <button class="btn-action btn-outline btn-open-note" data-note="${sesIndexRel}" style="flex:1;">
        ${SVGS.open} <span data-i18n="btn_open_index">Ver Índice</span>
      </button>
    </div>

    <div class="cards-scroll-container" id="sessions-list">
      ${sessionList.length === 0 ? `<div style="color:var(--text-muted);text-align:center;padding:20px;" data-i18n="no_sessions">Sin sesiones registradas aún</div>` : ''}
      ${sessionList.map(s => `
        <div class="note-item" data-title="${s.title}" data-project="${s.project}">
          <div class="note-top">
            <span class="note-name">${s.title}</span>
            <span class="tag-badge">${s.project}</span>
          </div>
          <div class="note-snippet">${s.summary}</div>
          <div class="note-foot">
            <span class="note-date">${s.date}</span>
            <div style="display:flex;gap:6px;">
              <button class="btn-open-link btn-copy-wikilink" data-title="${s.title}">
                ${SVGS.copy} <span data-i18n="btn_copy">Copiar</span>
              </button>
              <button class="btn-open-link btn-open-note" data-note="${s.relPath}">
                ${SVGS.open} <span data-i18n="btn_open">Abrir</span>
              </button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- TAB: PROYECTOS -->
  <div class="tab-pane" id="pane-proyectos">
    <div class="search-wrapper">
      <span class="search-icon-pos">${SVGS.search}</span>
      <input type="text" class="search-input" id="search-projects" data-i18n-ph="search_projects" placeholder="Buscar proyectos...">
    </div>

    <div style="display:flex;gap:6px;margin-bottom:10px;">
      <button class="btn-action btn-gradient" id="btn-scan-project-tab" style="flex:1;">
        ${SVGS.search} <span data-i18n="btn_scan_project">Escanear Workspace</span>
      </button>
      <button class="btn-action btn-outline btn-open-note" data-note="${projIndexRel}" style="flex:1;">
        ${SVGS.open} <span data-i18n="btn_open_index">Ver Índice</span>
      </button>
    </div>

    <div class="cards-scroll-container" id="projects-list">
      ${projectList.length === 0 ? `<div style="color:var(--text-muted);text-align:center;padding:20px;" data-i18n="no_projects">Sin proyectos registrados aún</div>` : ''}
      ${projectList.map(p => `
        <div class="note-item" data-title="${p.name}" data-stack="${p.stack}">
          <div class="note-top">
            <span class="note-name">${p.name}</span>
            <span class="tag-badge project-badge">${p.stack}</span>
          </div>
          <div class="note-snippet">${p.summary}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0;font-size:10px;">
            ${p.skill ? `<span class="tag-badge skill-global">Skill: ${p.skill}</span>` : ''}
            ${p.totalTasks > 0 ? `<span class="tag-badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;">Backlog: ${p.completedTasks}/${p.totalTasks}</span>` : ''}
            ${p.antipatternsCount > 0 ? `<span class="tag-badge" style="background:rgba(239,68,68,0.15);color:#f87171;">${T('antipatterns', { n: p.antipatternsCount })}</span>` : ''}
          </div>
          <div class="note-foot">
            <span class="note-date">${p.date}</span>
            <div style="display:flex;gap:6px;">
              <button class="btn-open-link btn-copy-wikilink" data-title="${T('project_prefix')} ${p.name}">
                ${SVGS.copy} <span data-i18n="btn_copy">Copiar</span>
              </button>
              <button class="btn-open-link btn-open-note" data-note="${p.relPath}">
                ${SVGS.open} <span data-i18n="btn_open">Ficha</span>
              </button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- TAB: GRAFO INTERACTIVO -->
  <div class="tab-pane" id="pane-grafo">
    <div class="graph-controls-bar">
      <input type="text" class="search-input" id="search-graph-nodes" data-i18n-ph="search_graph" placeholder="Buscar nodo..." style="flex:1;">
      <div class="graph-btn-group">
        <button class="graph-btn" id="btn-fit-graph" title="${T('graph_fit_title')}">${SVGS.dashboard} ${T('graph_fit')}</button>
        <button class="graph-btn" id="btn-zoom-in" title="${T('zoom_in')}">+</button>
        <button class="graph-btn" id="btn-zoom-out" title="${T('zoom_out')}">−</button>
        <button class="graph-btn" id="btn-reset-graph" title="${T('graph_restart')}">${SVGS.sync}</button>
        <button class="graph-btn btn-open-note" data-note="00_Agente/SOUL.md" title="${T('open_in_obsidian')}">${SVGS.open}</button>
      </div>
    </div>

    <div class="graph-legend">
      <span class="legend-dot dot-hub"></span><span>Hub</span>
      <span class="legend-dot dot-soul"></span><span>${T('legend_soul')}</span>
      <span class="legend-dot dot-skill"></span><span>Skills</span>
      <span class="legend-dot dot-memory"></span><span>${T('legend_memory')}</span>
      <span class="legend-dot dot-project"></span><span>${T('legend_projects')}</span>
      <span class="legend-dot dot-session"></span><span>${T('legend_sessions')}</span>
    </div>

    <div class="graph-canvas-container" id="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div id="graph-tooltip" class="graph-tooltip"></div>
    </div>
    <div style="font-size:10px;color:var(--text-dim);text-align:center;margin-top:6px;" data-i18n="graph_instructions">
      Arrastra nodos o el fondo | Doble clic para ajustar | Rueda para zoom | Clic en un nodo para abrir nota
    </div>
  </div>

  <!-- TAB 4: NUEVA MEMORIA -->
  <div class="tab-pane" id="pane-crear">
    <div class="form-panel">
      <form id="memory-form">
        <div class="field">
          <label data-i18n="form_title">Título de la Memoria / Solución</label>
          <input type="text" class="input-ctrl" id="mem-title" data-i18n-ph="form_title_ph" placeholder="Ej: Optimización SQLite WAL" required>
        </div>
        <div class="field">
          <label data-i18n="form_cat">Categoría</label>
          <select class="select-ctrl" id="mem-category">
            <option value="arquitectura" data-i18n="filter_arch">Arquitectura</option>
            <option value="bugfix" data-i18n="filter_bugfix">Bugfix</option>
            <option value="general" data-i18n="filter_general" selected>General</option>
          </select>
        </div>
        <div class="field">
          <label data-i18n="form_details">Detalles / Solución Técnica</label>
          <textarea class="textarea-ctrl" id="mem-content" data-i18n-ph="form_details_ph" placeholder="Escribe aquí los pasos..." required></textarea>
        </div>
        <div class="field">
          <label data-i18n="form_tags">Etiquetas (separadas por coma)</label>
          <input type="text" class="input-ctrl" id="mem-tags" data-i18n-ph="form_tags_ph" placeholder="ej: sqlite, backend">
        </div>
        <button type="submit" class="btn-action btn-gradient" style="margin-top:6px;">
          ${SVGS.save} <span data-i18n="btn_save">Guardar en Obsidian Vault</span>
        </button>
      </form>
    </div>
  </div>

  <!-- TAB 5: AJUSTES -->
  <div class="tab-pane" id="pane-ajustes">
    <div class="field">
      <label data-i18n="settings_user_name_label">Nombre de Usuario (Perfil Hermes):</label>
      <input type="text" class="input-ctrl" id="setting-user-name" value="${configuredUser || effectiveUser}" data-i18n-ph="settings_user_name_ph" placeholder="Davissss2 o tu alias" style="margin-bottom:12px;">
    </div>

    <div class="field">
      <label data-i18n="language_label">Idioma / Language:</label>
      <select class="select-ctrl lang-select" id="setting-language" style="margin-bottom:12px;">
        <option value="auto" ${configuredLang === 'auto' ? 'selected' : ''}>${T('lang_auto')} (${ideLang.toUpperCase()})</option>
        <option value="es" ${configuredLang === 'es' ? 'selected' : ''}>Español (ES)</option>
        <option value="en" ${configuredLang === 'en' ? 'selected' : ''}>English (EN)</option>
        <option value="fr" ${configuredLang === 'fr' ? 'selected' : ''}>Français (FR)</option>
        <option value="de" ${configuredLang === 'de' ? 'selected' : ''}>Deutsch (DE)</option>
        <option value="zh" ${configuredLang === 'zh' ? 'selected' : ''}>中文 (ZH)</option>
        <option value="ja" ${configuredLang === 'ja' ? 'selected' : ''}>日本語 (JA)</option>
      </select>
    </div>

    <div class="info-banner" style="margin-top:0;margin-bottom:12px;">
      <strong data-i18n="settings_mode_title">Modo Nativo Directo Activo</strong><br>
      <span data-i18n="settings_mode_desc">La extensión sincroniza directamente tus archivos Markdown locales. Cero configuración, cero API keys.</span>
    </div>

    <!-- AI Conversations Proactive Memory Settings -->
    <div class="settings-section">
      <div class="settings-section-title">
        ${SVGS.crystal} <span>${T('settings_identity_title')}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">
        ${T('settings_identity_desc')}
      </div>

      <div class="field">
        <label>${T('label_callsign')}</label>
        <input type="text" class="input-ctrl" id="setting-user-callsign" value="${personalityInfo.userCallsign || 'David'}" placeholder="${T('ph_callsign')}">
      </div>

      <div class="field" style="margin-top:8px;">
        <label>${T('label_ai_name')}</label>
        <input type="text" class="input-ctrl" id="setting-ai-name" value="${personalityInfo.aiName || 'Pedro'}" placeholder="${T('ph_ai_name')}">
      </div>

      <div class="field" style="margin-top:8px;">
        <label>${T('label_personality')}</label>
        <textarea class="textarea-ctrl" id="setting-personality" rows="2" placeholder="${T('ph_personality')}">${personalityInfo.personality || T('personality_default')}</textarea>
      </div>

      <button class="btn-action btn-gradient" id="btn-save-personality" style="margin-top:8px;">
        ${SVGS.check} <span>${T('btn_save_identity')}</span>
      </button>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">
        ${SVGS.brain} <span data-i18n="settings_ai_title">Comportamiento en Conversaciones de IA:</span>
      </div>

      <div class="toggle-card">
        <div class="toggle-info">
          <div class="toggle-title" data-i18n="settings_proactive_title">Consultar Vault al Iniciar Tareas</div>
          <div class="toggle-desc" data-i18n="settings_proactive_desc">La IA revisará si hay notas previas que le sirvan antes de investigar o asumir soluciones.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggle-proactive" ${proactiveLookup ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>

      <div class="toggle-card">
        <div class="toggle-info">
          <div class="toggle-title" data-i18n="settings_autosave_title">Aprender y Guardar Automáticamente</div>
          <div class="toggle-desc" data-i18n="settings_autosave_desc">Guarda lecciones de bugs resueltos y decisiones arquitectónicas sin pedir confirmación.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggle-autosave" ${autoSave ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>

      <button class="btn-action btn-gradient" id="btn-save-ai-settings" style="margin-top:8px;">
        ${SVGS.check} <span data-i18n="btn_save_ai_settings">Guardar y Aplicar a Todos los Chats</span>
      </button>
    </div>

    <div class="field">
      <label data-i18n="settings_vaults_detected">Bóvedas detectadas en este equipo:</label>
      <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px; line-height:1.6;">
        ${detection.vaults.map(v => `• <strong>${v.name}</strong><br><span style="font-family:monospace;font-size:10px;color:var(--text-dim);">${v.path}</span>`).join('<br><br>') || T('none')}
      </div>
      <button class="btn-action btn-outline" id="btn-select-another">
        ${SVGS.settings} <span data-i18n="btn_select_another">Seleccionar otra carpeta...</span>
      </button>
    </div>

    <div class="field" style="margin-top:14px; border-top:1px solid var(--card-border); padding-top:12px;">
      <label data-i18n="settings_reinstall_title">Inyección en Chats de IA:</label>
      <button class="btn-action btn-outline" id="btn-reinstall">
        ${SVGS.sync} <span data-i18n="btn_reinstall">Refrescar Skill y Reglas Globales</span>
      </button>
      <div style="font-size:10px; color:var(--text-dim); margin-top:5px;" data-i18n="settings_reinstall_desc">
        Vuelve a comprobar que ~/.gemini/config/skills/ tenga la skill lista para todos los chats.
      </div>
    </div>
    <!-- Encrypted Backup & Git Integration -->
    <div class="settings-section">
      <div class="settings-section-title">
        ${SVGS.lock} <span data-i18n="settings_backup_title">Copia de Seguridad y Migración Cifrada:</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;" data-i18n="settings_backup_desc">
        Exporte toutes les notes Antigravity dans un fichier <code>.agvault</code> chiffré AES-256-GCM avec clé dérivée PBKDF2 sous ton mot de passe. Restaure-le sur n importe quelle machine ou workspace.
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn-action btn-gradient" id="btn-export-vault" style="flex:1;">
          ${SVGS.download} <span data-i18n="btn_export_vault">Exportar Cifrado</span>
        </button>
        <button class="btn-action btn-outline" id="btn-import-vault" style="flex:1;">
          ${SVGS.upload} <span data-i18n="btn_import_vault">Importar Respaldo</span>
        </button>
      </div>

      <div class="git-status-box" style="margin-top:12px;padding:10px;background:rgba(255,255,255,0.02);border:1px solid var(--card-border);border-radius:8px;">
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:${isVaultGit ? '#34d399' : 'var(--text-muted)'};">
          ${SVGS.network}
          <span>${isVaultGit ? T('git_active') : T('git_inactive')}</span>
        </div>
        <div style="font-size:10px;color:var(--text-dim);margin-top:4px;">
          ${isVaultGit ? T('git_active_desc') : T('git_inactive_desc')}
        </div>
      </div>
    </div>

    <div class="danger-zone">
      <div class="danger-title">${SVGS.alert} <span data-i18n="settings_danger_title">Zona de Peligro / Empezar de Cero</span></div>
      <div class="danger-desc" data-i18n="settings_danger_desc">
        Borra todas las memorias acumuladas, limpia duplicados y resetea el contexto de la IA para empezar completamente limpio desde cero con Obsidian.
      </div>
      <button class="btn-action btn-danger" id="btn-reset-data">
        ${SVGS.trash} <span data-i18n="btn_reset_data">Borrar Todo y Empezar de Cero</span>
      </button>
    </div>
  </div>

  <!-- TAB: HERRAMIENTAS -->
  <div class="tab-pane" id="pane-herramientas">
    <div class="card-section" style="margin-bottom:12px;">
      <div class="card-title" style="display:flex;align-items:center;gap:8px;">
        ${SVGS.zap} <span>${T('tools_title')}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.4;">
        ${T('tools_desc')}
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="input-tool-github" class="input-text" placeholder="https://github.com/owner/repo" style="flex:1;" />
        <button class="btn-action btn-gradient" id="btn-install-tool-github">
          ${SVGS.download} <span>${T('btn_install')}</span>
        </button>
      </div>
    </div>

    <div class="card-section">
      <div class="card-title" style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
        ${SVGS.crystal} <span>${T('tools_installed', { n: toolsList.length })}</span>
      </div>
      ${toolsList.length === 0 ? `
        <div class="empty-state" style="padding:20px 10px;text-align:center;color:var(--text-muted);font-size:12px;background:rgba(255,255,255,0.02);border:1px dashed var(--card-border);border-radius:8px;">
          <div style="margin-bottom:6px;font-weight:600;color:var(--text-normal);">${T('tools_none_title')}</div>
          <div>${T('tools_none_desc')}</div>
        </div>
      ` : `
        <div class="tools-grid" style="display:flex;flex-direction:column;gap:8px;">
          ${toolsList.map(t => `
            <div class="tool-card" style="padding:10px;background:rgba(255,255,255,0.03);border:1px solid var(--card-border);border-radius:8px;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                  <div style="font-weight:600;font-size:13px;color:var(--text-bright);">${t.name}</div>
                  <div style="font-size:10px;color:var(--accent-color);text-transform:uppercase;margin-top:2px;">${t.type || 'tool'} ${t.mcpRegistered ? '• MCP' : ''}</div>
                </div>
                <button class="btn-icon btn-uninstall-tool" data-name="${t.name}" title="${T('uninstall_tool')}" style="background:none;border:none;cursor:pointer;color:#f87171;">
                  ${SVGS.trash}
                </button>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.4;">${t.description || T('no_description')}</div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  </div>

  <!-- Toast Bar -->
  <div class="toast-bar" id="toast"></div>

  <script>
    window.INITIAL_GRAPH_DATA = ${JSON.stringify(graphData)};
  </script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const config = vscode.workspace.getConfiguration('antigravityObsidian');
  const configuredPath = config.get('vaultPath');
  
  // 1. Auto-provision vault: finds existing open vault or automatically creates one in Documents
  const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
  const vault = ensureOrCreateDefaultVault(configuredPath);
  const workspaceRoot = getWorkspaceRoot();

  // Instantiate Webview provider
  const provider = new ObsidianPanelProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('antigravityObsidian.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 2. Automatically install skill, global rules, and run full sync
  try {
    const pConfig = vscode.workspace.getConfiguration('antigravityObsidian');
    const pConfigured = pConfig.get('personalityConfigured');
    const pLang = pConfig.get('language') || 'auto';
    const pUser = pConfig.get('userName') || '';
    if (vault && vault.exists) {
      try {
        syncEngine.migrateToHermes(vault.path);
      } catch (e) {}
    }
    installSkillAndRules(vault ? vault.path : null, {
      personalityConfigured: pConfigured !== undefined ? !!pConfigured : undefined,
      language: pLang,
      userName: pUser,
    });
    if (vault && vault.exists) {
      syncEngine.syncAll(vault.path, workspaceRoot, { language: pLang, userName: pUser });
    }
  } catch (err) {
    console.error('Error auto-installing Obsidian skill:', err);
  }

  // 3. Automatic background sync & file watchers
  let syncTimeout = null;
  const triggerDebouncedSync = () => {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      if (vault && vault.exists) {
        try {
          syncEngine.syncAll(vault.path, getWorkspaceRoot());
          if (currentWebviewView) {
            currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
          }
        } catch (e) {}
      }
    }, 2500);
  };

  if (vault && vault.exists) {
    // Watch Antigravity Global Skills directory
    const globalSkillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
    if (fs.existsSync(globalSkillsDir)) {
      try {
        const watcher = fs.watch(globalSkillsDir, { recursive: true }, (event, filename) => {
          if (filename && !filename.includes('antigravity-obsidian')) {
            triggerDebouncedSync();
          }
        });
        context.subscriptions.push({ dispose: () => watcher.close() });
      } catch (e) {}
    }

    // Periodic auto-sync every 3 minutes
    const periodicTimer = setInterval(() => {
      try {
        syncEngine.syncAll(vault.path, getWorkspaceRoot());
      } catch (e) {}
    }, 180000);
    context.subscriptions.push({ dispose: () => clearInterval(periodicTimer) });
  }

  // 3b. Continuous workspace session tracking & proactive auto-checkpointing
  const sessionModifiedFiles = new Set();
  let lastAutoCheckpointTime = Date.now();
  let sessionSaveDebounceTimer = null;

  const performAutoCheckpoint = (reason = 'auto') => {
    if (sessionModifiedFiles.size >= 1) {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const root = getWorkspaceRoot();
      if (activeVault && activeVault.exists && root) {
        const pName = path.basename(root);
        const filesList = Array.from(sessionModifiedFiles);
        try {
          syncEngine.saveSessionCheckpoint(activeVault.path, {
            project: pName,
            summary: t('auto_checkpoint_summary', { n: filesList.length, s: filesList.length > 1 ? 's' : '', name: pName }),
            content: t('auto_checkpoint_content', { files: filesList.join('\n- '), reason }),
          });
          syncEngine.gitCommitVault(activeVault.path, t('auto_commit', { name: pName, n: filesList.length }));
          sessionModifiedFiles.clear();
          lastAutoCheckpointTime = Date.now();
          if (currentWebviewView) {
            currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
          }
        } catch (e) {}
      }
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const root = getWorkspaceRoot();
      if (!root || !doc || !doc.uri) return;
      const fp = doc.uri.fsPath;
      if (fp.startsWith(root) && !fp.includes('node_modules') && !fp.includes('.git') && !fp.includes('.agents')) {
        sessionModifiedFiles.add(path.relative(root, fp));
        if (sessionSaveDebounceTimer) clearTimeout(sessionSaveDebounceTimer);
        // Save automatically after 20 seconds of inactivity following edits
        sessionSaveDebounceTimer = setTimeout(() => {
          performAutoCheckpoint(t('reason_inactivity'));
        }, 20000);
      }
    })
  );

  // Auto-checkpoint on window blur (when user switches window or runs other tasks)
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) {
        if (sessionSaveDebounceTimer) clearTimeout(sessionSaveDebounceTimer);
        performAutoCheckpoint(t('reason_blur'));
      }
    })
  );

  // Periodic session checkpoint every 3 minutes if files were modified
  const sessionPeriodicTimer = setInterval(() => {
    if (sessionModifiedFiles.size >= 1 && (Date.now() - lastAutoCheckpointTime > 120000)) {
      performAutoCheckpoint(t('reason_periodic'));
    }
  }, 180000);
  context.subscriptions.push({ dispose: () => clearInterval(sessionPeriodicTimer) });

  // 4. Status Bar and notification (Zero config, immediate out-of-the-box readiness)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  updateStatusBar(vault);
  context.subscriptions.push(statusBarItem);

  if (vault && vault.exists) {
    const initialized = context.globalState.get('obsidian_auto_initialized');
    if (!initialized) {
      vscode.window.showInformationMessage(t('auto_connected', { name: vault.name }));
      context.globalState.update('obsidian_auto_initialized', true);
    }
  } else {
    vscode.window.showWarningMessage(
      t('no_vault_start'),
      t('btn_select_vault')
    ).then(choice => {
      if (choice) promptSelectVault();
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.openHub', () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (activeVault && activeVault.exists) {
        const { isObsidianAppInstalled } = require('./src/vault-detector');
        if (!isObsidianAppInstalled()) {
          const dlLabel = t('download_obsidian');
          const folderLabel = t('open_notes_folder');
          vscode.window.showInformationMessage(
            t('notes_saved_hint', { path: activeVault.path }),
            dlLabel,
            folderLabel
          ).then(choice => {
            if (choice === dlLabel) {
              vscode.env.openExternal(vscode.Uri.parse('https://obsidian.md/download'));
            } else if (choice === folderLabel) {
              vscode.env.openExternal(vscode.Uri.file(activeVault.path));
            }
          });
        } else {
          openInObsidianApp(activeVault.name, '00_Agente/SOUL');
        }
      } else {
        vscode.window.showWarningMessage(t('no_vault'));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.setPersonality', async () => {
    const config = vscode.workspace.getConfiguration('antigravityObsidian');
    const currentName = config.get('aiName') || 'Pedro';
    const currentCallsign = config.get('userCallsign') || 'David';
    const currentPersona = config.get('personality') || t('personality_default');

    const newCallsign = await vscode.window.showInputBox({
      prompt: t('prompt_callsign'),
      value: currentCallsign,
      placeHolder: t('ph_callsign')
    });
    if (newCallsign === undefined) return;

    const newAiName = await vscode.window.showInputBox({
      prompt: t('prompt_ai_name'),
      value: currentName,
      placeHolder: t('ph_ai_name')
    });
    if (newAiName === undefined) return;

    await config.update('userCallsign', newCallsign.trim() || 'David', vscode.ConfigurationTarget.Global);
    await config.update('userName', newCallsign.trim() || 'David', vscode.ConfigurationTarget.Global);
    await config.update('aiName', newAiName.trim() || 'Pedro', vscode.ConfigurationTarget.Global);
    await config.update('personalityConfigured', true, vscode.ConfigurationTarget.Global);

    const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
    const v = ensureOrCreateDefaultVault(config.get('vaultPath'));
    if (v && v.exists) {
      syncEngine.ensurePersonality(v.path, {
        userCallsign: newCallsign.trim() || 'David',
        aiName: newAiName.trim() || 'Pedro',
        personality: currentPersona,
        personalityConfigured: true,
        forceUpdate: true
      });
      installSkillAndRules(v.path, {
        userCallsign: newCallsign.trim() || 'David',
        aiName: newAiName.trim() || 'Pedro',
        userName: newCallsign.trim() || 'David',
        personality: currentPersona,
        personalityConfigured: true
      });
      syncEngine.syncAll(v.path, getWorkspaceRoot());
      if (currentWebviewView) {
        currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
      }
    }
    vscode.window.showInformationMessage(t('identity_saved', { ai: newAiName, user: newCallsign }));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.syncNow', () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (activeVault && activeVault.exists) {
        syncEngine.syncAll(activeVault.path, getWorkspaceRoot());
        installSkillAndRules(activeVault.path);
        updateStatusBar(activeVault);
        vscode.window.showInformationMessage(t('sync_done', { name: activeVault.name }));
      } else {
        vscode.window.showWarningMessage(t('no_vault'));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.selectVault', async () => {
      await promptSelectVault(() => {
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.newMemory', async () => {
      if (currentWebviewView) {
        currentWebviewView.webview.postMessage({ type: 'switchTab', tab: 'crear' });
      }
      const title = await vscode.window.showInputBox({
        prompt: t('memory_title_prompt'),
        placeHolder: t('memory_title_ph'),
      });
      if (!title) return;

      const content = await vscode.window.showInputBox({
        prompt: t('memory_content_prompt'),
        placeHolder: t('memory_content_ph'),
      });
      if (!content) return;

      const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
      const activeVault = ensureOrCreateDefaultVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (activeVault && activeVault.exists) {
        syncEngine.saveNewMemory(activeVault.path, {
          title,
          content,
          project: getWorkspaceRoot() ? path.basename(getWorkspaceRoot()) : null,
        });
        syncEngine.generateHub(activeVault.path, getWorkspaceRoot());
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
        vscode.window.showInformationMessage(t('memory_saved', { title }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.newSkill', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const name = await vscode.window.showInputBox({
        title: t('skill_new_title'),
        prompt: t('skill_name_prompt'),
        placeHolder: t('skill_name_ph'),
      });
      if (!name) return;

      const desc = await vscode.window.showInputBox({
        title: t('skill_desc_title'),
        prompt: t('skill_desc_prompt'),
        placeHolder: t('skill_desc_ph'),
      });
      if (!desc) return;

      const scopeChoice = await vscode.window.showQuickPick([
        { label: 'Global (~/.gemini/config/skills/)', value: 'global' },
        { label: t('scope_project'), value: 'project' },
      ], { title: t('skill_scope_title') });
      if (!scopeChoice) return;

      try {
        const res = syncEngine.createSkill(activeVault.path, getWorkspaceRoot(), {
          name,
          description: desc,
          content: `# ${name}\n\n${t('skill_body')}`,
          scope: scopeChoice.value,
        });
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
        vscode.window.showInformationMessage(t('skill_created', { name: res.name }));
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.listSkills', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const idx = findIndexFile(activeVault.path, 'skills', uiLang());
      if (idx && fs.existsSync(idx.abs)) {
        const doc = await vscode.workspace.openTextDocument(idx.abs);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage(t('skills_index_missing'));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.showSoul', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const almaDir = path.join(activeVault.path, '00_Agente');
      const soulPath = ['SOUL.md', '00 Soul de Antigravity.md']
        .map(n => path.join(almaDir, n)).find(p => fs.existsSync(p)) || path.join(almaDir, 'SOUL.md');
      const userPath = ['USER.md', '00 Perfil de Usuario.md']
        .map(n => path.join(almaDir, n)).find(p => fs.existsSync(p)) || path.join(almaDir, 'USER.md');
      const persFound = findVaultFile(activeVault.path, '00_Agente', PERSONALITY_NAMES, uiLang());
      const personalityPath = persFound ? persFound.abs : path.join(almaDir, PERSONALITY_NAMES.en);

      const choice = await vscode.window.showQuickPick([
        { label: t('soul_view_ai'), description: path.basename(personalityPath), path: personalityPath },
        { label: t('soul_view_user'), description: path.basename(userPath), path: userPath },
        { label: t('soul_view_soul'), description: path.basename(soulPath), path: soulPath },
        { label: t('soul_view_panel'), description: 'Webview', action: 'webview' },
      ], { placeHolder: t('soul_pick_hint') });

      if (!choice) return;
      if (choice.action === 'webview') {
        if (currentWebviewView) {
          currentWebviewView.show?.(true);
          currentWebviewView.webview.postMessage({ type: 'switchTab', tab: 'hub' });
        }
      } else if (fs.existsSync(choice.path)) {
        const doc = await vscode.workspace.openTextDocument(choice.path);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage(t('file_not_found', { name: choice.description }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.configurePersonality', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const current = syncEngine.getPersonality(activeVault.path);

      const aiName = await vscode.window.showInputBox({
        title: t('calib_ai_title'),
        prompt: t('calib_ai_prompt'),
        value: current.aiName || 'Hermes',
      });
      if (aiName === undefined) return;

      const userCallsign = await vscode.window.showInputBox({
        title: t('calib_user_title'),
        prompt: t('calib_user_prompt'),
        value: current.userCallsign || '',
      });
      if (userCallsign === undefined) return;

      const personality = await vscode.window.showInputBox({
        title: t('calib_pers_title'),
        prompt: t('calib_pers_prompt'),
        value: current.personality || t('calib_pers_default'),
      });
      if (personality === undefined) return;

      const saved = syncEngine.savePersonality(activeVault.path, {
        aiName: aiName.trim() || 'Hermes',
        userCallsign: userCallsign.trim() || 'User',
        personality: personality.trim(),
        configured: true,
      });

      const config = vscode.workspace.getConfiguration('antigravityObsidian');
      await config.update('aiName', saved.aiName, vscode.ConfigurationTarget.Global);
      await config.update('userCallsign', saved.userCallsign, vscode.ConfigurationTarget.Global);
      await config.update('personality', saved.personality, vscode.ConfigurationTarget.Global);
      await config.update('personalityConfigured', true, vscode.ConfigurationTarget.Global);

      installSkillAndRules(activeVault.path, {
        aiName: saved.aiName,
        userCallsign: saved.userCallsign,
        personality: saved.personality,
        personalityConfigured: true,
      });

      syncEngine.syncAll(activeVault.path, getWorkspaceRoot());

      if (currentWebviewView) {
        currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
      }

      vscode.window.showInformationMessage(t('personality_calibrated', { ai: saved.aiName, user: saved.userCallsign }));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.registerProject', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(t('no_workspace'));
        return;
      }

      const res = syncEngine.syncProject(activeVault.path, root);
      syncEngine.syncVaultToKnowledge(activeVault.path);

      if (currentWebviewView) {
        currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
      }

      vscode.window.showInformationMessage(t('project_registered', { name: res.projectName }));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.showProjects', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const idx = findIndexFile(activeVault.path, 'projects', uiLang());
      if (idx && fs.existsSync(idx.abs)) {
        const doc = await vscode.workspace.openTextDocument(idx.abs);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage(t('projects_index_missing'));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.scanProject', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(t('no_workspace'));
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('scanning'),
        cancellable: false
      }, async () => {
        try {
          // Direct in-process scan (fast, zero child_process latency)
          const res = syncEngine.syncProject(activeVault.path, root);
          syncEngine.syncProjectsIndex(activeVault.path);
          syncEngine.syncVaultToKnowledge(activeVault.path);
          if (currentWebviewView) {
            currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
          }
          const pName = (res && res.projectName) || path.basename(root);
          vscode.window.showInformationMessage(t('scan_done', { name: pName }));
        } catch (e) {
          vscode.window.showErrorMessage(t('scan_error', { err: e.message || JSON.stringify(e) }));
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.saveSession', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const root = getWorkspaceRoot();
      const pName = root ? path.basename(root) : 'General';

      const summary = await vscode.window.showInputBox({
        title: t('session_title', { name: pName }),
        prompt: t('session_prompt'),
        placeHolder: t('session_ph'),
      });
      if (!summary) return;

      const content = await vscode.window.showInputBox({
        title: t('session_details_title'),
        prompt: t('session_details_prompt'),
        placeHolder: t('session_details_ph'),
      });

      try {
        // Direct in-process checkpoint saving and Git commit
        const res = syncEngine.saveSessionCheckpoint(activeVault.path, {
          project: pName,
          summary: summary.trim(),
          content: content ? content.trim() : '',
        });
        syncEngine.gitCommitVault(activeVault.path, `Session : ${summary.trim()}`);
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
        vscode.window.showInformationMessage(t('session_saved', { name: pName }));
      } catch (e) {
        vscode.window.showErrorMessage(t('session_error', { err: e.message || JSON.stringify(e) }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.exportVault', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const pwd = await vscode.window.showInputBox({
        title: t('export_title'),
        prompt: t('export_pwd_prompt'),
        password: true,
      });
      if (!pwd) return;

      const confirmPwd = await vscode.window.showInputBox({
        title: t('confirm_pwd_title'),
        prompt: t('confirm_pwd_prompt'),
        password: true,
      });
      if (pwd !== confirmPwd) {
        vscode.window.showErrorMessage(t('pwd_mismatch'));
        return;
      }

      const defaultFileName = `antigravity-vault-${new Date().toISOString().split('T')[0]}.agvault`;
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultFileName),
        filters: { [t('vault_filter')]: ['agvault', 'json'] },
        title: t('save_backup_title'),
      });
      if (!saveUri) return;

      try {
        const jsonStr = syncEngine.exportVaultEncrypted(activeVault.path, pwd);
        fs.writeFileSync(saveUri.fsPath, jsonStr, 'utf8');
        vscode.window.showInformationMessage(t('vault_exported', { name: path.basename(saveUri.fsPath) }));
      } catch (err) {
        vscode.window.showErrorMessage(t('export_error', { err: err.message }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.importVault', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const openUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { [t('vault_filter')]: ['agvault', 'json'] },
        title: t('import_title'),
      });
      if (!openUris || openUris.length === 0) return;

      const pwd = await vscode.window.showInputBox({
        title: t('decrypt_title'),
        prompt: t('decrypt_prompt'),
        password: true,
      });
      if (!pwd) return;

      try {
        const encJson = fs.readFileSync(openUris[0].fsPath, 'utf8');
        const res = syncEngine.importVaultEncrypted(activeVault.path, pwd, encJson);
        syncEngine.syncAll(activeVault.path, getWorkspaceRoot());
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
        vscode.window.showInformationMessage(t('vault_restored', { n: res.restoredFiles }));
      } catch (err) {
        vscode.window.showErrorMessage(t('import_error', { err: err.message }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.showSessions', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('no_vault'));
        return;
      }
      const idx = findIndexFile(activeVault.path, 'sessions', uiLang());
      if (idx && fs.existsSync(idx.abs)) {
        const doc = await vscode.workspace.openTextDocument(idx.abs);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else if (idx) {
        openInObsidianApp(activeVault.name, idx.rel.replace(/\.md$/, ''));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.showStatus', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (!activeVault || !activeVault.exists) {
        vscode.window.showWarningMessage(t('disconnected'));
        return;
      }
      const manifestPath = path.join(activeVault.path, 'context-manifest.json');
      let statsText = '';
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          statsText = ` | ${t('stat_memories', { n: manifest.stats.memories })} | ${t('stat_skills', { n: manifest.stats.skills })}`;
        } catch (e) {}
      }
      const hubLabel = t('open_hub');
      const syncLabel = t('sync_now');
      const action = await vscode.window.showInformationMessage(
        t('status_connected', { name: activeVault.name, stats: statsText }),
        hubLabel,
        syncLabel
      );
      if (action === hubLabel) {
        vscode.commands.executeCommand('antigravityObsidian.openHub');
      } else if (action === syncLabel) {
        vscode.commands.executeCommand('antigravityObsidian.syncNow');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.openGraph', () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (activeVault && activeVault.exists) {
        openInObsidianApp(activeVault.name, '00_Agente/SOUL');
      } else {
        vscode.window.showWarningMessage(t('no_vault'));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.installMcp', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const vaultPath = activeVault ? activeVault.path : '';
      try {
        const res = syncEngine.installMcpServer(vaultPath);
        vscode.window.showInformationMessage(t('mcp_enabled_msg', { n: res.otherServers.length }));
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
      } catch (err) {
        vscode.window.showErrorMessage(t('mcp_install_error', { err: err.message }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.disableMcp', async () => {
      try {
        const res = syncEngine.disableMcpServer();
        if (res.status === 'ok') {
          vscode.window.showInformationMessage(t('mcp_disabled_msg'));
        } else {
          vscode.window.showWarningMessage(res.message || t('mcp_disable_fail'));
        }
        if (currentWebviewView) {
          currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
        }
      } catch (err) {
        vscode.window.showErrorMessage(t('mcp_disable_error', { err: err.message }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.mcpStatus', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const vaultPath = activeVault ? activeVault.path : '';
      try {
        const st = syncEngine.getMcpStatus(vaultPath);
        const stateStr = st.enabled ? t('mcp_state_active') : (st.installed ? t('mcp_state_disabled') : t('mcp_state_none'));
        const otherStr = st.otherServers.length > 0 ? st.otherServers.join(', ') : t('none_m');
        const msg = t('mcp_status_msg', { state: stateStr, others: otherStr, path: st.configPath });
        const disableLabel = t('btn_disable_mcp_short');
        const installLabel = t('btn_install_mcp');
        const openLabel = t('open_file');
        const action = await vscode.window.showInformationMessage(msg, st.enabled ? disableLabel : installLabel, openLabel);
        if (action === disableLabel) {
          vscode.commands.executeCommand('antigravityObsidian.disableMcp');
        } else if (action === installLabel) {
          vscode.commands.executeCommand('antigravityObsidian.installMcp');
        } else if (action === openLabel && fs.existsSync(st.configPath)) {
          const doc = await vscode.workspace.openTextDocument(st.configPath);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err) {
        vscode.window.showErrorMessage(t('mcp_status_error', { err: err.message }));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.installTool', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const repoUrl = await vscode.window.showInputBox({
        title: t('install_tool_title'),
        prompt: t('install_tool_prompt'),
        placeHolder: 'https://github.com/...'
      });
      if (!repoUrl) return;

      const toolsEngine = require('./src/tools-engine');
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('installing_tool'),
        cancellable: false
      }, async () => {
        try {
          const res = await toolsEngine.installFromGithub(repoUrl, {}, activeVault ? activeVault.path : null);
          vscode.window.showInformationMessage(t('tool_installed', { name: res.name }));
          if (currentWebviewView) {
            currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
          }
        } catch (e) {
          vscode.window.showErrorMessage(t('tool_install_error', { err: e.message }));
        }
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.listTools', async () => {
      const activeVault = getActiveOrConfiguredVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      const toolsEngine = require('./src/tools-engine');
      const data = toolsEngine.listTools(activeVault ? activeVault.path : null);
      if (data.total === 0) {
        vscode.window.showInformationMessage(t('no_tools_msg'));
      } else {
        const items = data.tools.map(tool => ({
          label: `$(wrench) ${tool.name}`,
          description: `${tool.type.toUpperCase()}${tool.mcpRegistered ? ' (MCP)' : ''}`,
          detail: tool.description || t('no_description')
        }));
        await vscode.window.showQuickPick(items, { title: t('tools_installed', { n: data.total }) });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityObsidian.resetData', async () => {
      const { ensureOrCreateDefaultVault } = require('./src/vault-detector');
      const activeVault = ensureOrCreateDefaultVault(vscode.workspace.getConfiguration('antigravityObsidian').get('vaultPath'));
      if (activeVault && activeVault.exists) {
        const confirmLabel = t('btn_reset_confirm');
        const answer = await vscode.window.showWarningMessage(
          t('reset_confirm'),
          { modal: true },
          confirmLabel,
          t('cancel')
        );
        if (answer === confirmLabel) {
          syncEngine.resetAllData(activeVault.path, getWorkspaceRoot());
          installSkillAndRules(activeVault.path);
          updateStatusBar(activeVault);
          if (currentWebviewView) {
            currentWebviewView.webview.html = provider._getHtmlForWebview(currentWebviewView.webview);
          }
          vscode.window.showInformationMessage(t('reset_done'));
        }
      } else {
        vscode.window.showWarningMessage(t('no_vault'));
      }
    })
  );
}

function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

module.exports = {
  activate,
  deactivate,
};
