(function () {
  "use strict";
  // Custom Notifications v1.0, Revenge Classic / Vendetta.
  // Avisos LOCALES mientras la aplicacion JS este activa. No modifica push de Android.
  var api = vendetta;
  var React = api.metro.common.React;
  var RN = api.metro.common.ReactNative;
  var storage = api.plugin.storage;
  var findByProps = api.metro.findByProps;
  var E = React.createElement;
  var active = false;
  var dispatcher = null;
  var onMessage = null;
  var commandUndo = [];
  var refresh = null;
  var lastSeen = Object.create(null);
  var lastRuleAt = Object.create(null);
  var config = { enabled: true, vibrate: true, notifications: true, mentionOnly: false, rules: [] };
  var diagnostics = "Esperando mensajes...";
  var audioStatus = "No probado";
  var commandStatus = "Pendiente";
  var ruleSeq = 0;

  function log(message, error) { try { console.log("[CustomNotifications] " + message, error || ""); } catch (_) {} }
  function toast(message) {
    try { if (api.ui && api.ui.toasts) api.ui.toasts.showToast(String(message).slice(0, 150)); } catch (_) {}
  }
  function update() { try { if (refresh) refresh(); } catch (_) {} }
  function str(v, max) { return String(v == null ? "" : v).replace(/[\x00-\x1f]/g, "").slice(0, max || 300); }
  function id(v) { return str(v, 32).trim(); }
  function validId(v) { return /^\d{15,22}$/.test(id(v)); }
  function find() { try { return findByProps.apply(null, arguments); } catch (_) { return null; } }
  function save() { try { storage.customNotificationV1 = JSON.stringify(config); } catch (e) { log("Guardar", e); } }
  function scrubRule(r) {
    if (!r || typeof r !== "object" || ["server", "user"].indexOf(r.type) < 0 || !validId(r.target)) return null;
    return { key: str(r.key || "r" + (++ruleSeq), 50), type: r.type, target: id(r.target),
      label: str(r.label || r.target, 56), url: str(r.url || "", 500),
      tone: ["message1", "message2", "message3", "none"].indexOf(r.tone) !== -1 ? r.tone : "message1",
      enabled: r.enabled !== false, cooldown: Math.min(120, Math.max(1, Number(r.cooldown) || 8)) };
  }
  function load() {
    try {
      var o = JSON.parse(storage.customNotificationV1 || "null");
      if (o && typeof o === "object") {
        config.enabled = o.enabled !== false;
        config.vibrate = o.vibrate !== false;
        config.notifications = o.notifications !== false;
        config.mentionOnly = !!o.mentionOnly;
        config.rules = Array.isArray(o.rules) ? o.rules.slice(0, 100).map(scrubRule).filter(Boolean) : [];
      }
    } catch (e) { log("Configuracion anterior invalida", e); }
  }
  function isDirectAudio(u) {
    return /^https:\/\//i.test(u) && /\.(mp3|m4a|ogg|wav|aac)(?:[?#]|$)/i.test(u);
  }
  function isMediaPage(u) { return /^(https:\/\/)(?:[^/]+\.)?(youtube\.com|youtu\.be|spotify\.com|tiktok\.com)(?:[/:?#]|$)/i.test(u); }
  function playTone(tone) {
    if (tone === "none") { audioStatus = "Sin sonido (regla configurada en silencio)."; return false; }
    // Los sonidos internos requieren el reproductor de esta compilacion de Discord.
    try {
      var player = find("playSound");
      if (player && typeof player.playSound === "function") {
        var result = player.playSound(tone);
        if (result && typeof result.catch === "function") result.catch(function (e) { log("Fallo sonido integrado", e); });
        audioStatus = "Se solicito sonido integrado: " + tone;
        return true;
      }
    } catch (e) { log("Fallo sonido integrado", e); }
    audioStatus = "Discord no expone un reproductor de tonos compatible.";
    return false;
  }
  function playRemoteAudio(url) {
    if (!isDirectAudio(url)) return false;
    // Solo probar APIs de reproduccion explicitas, nunca abrir paginas web por sorpresa.
    // No hay API de audio remoto garantizada en Revenge clasico.
    var candidates = ["playAudio", "playAudioUrl", "playAudioURL", "playUrl"];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var key = candidates[i];
        var module = find(key);
        if (!module || typeof module[key] !== "function") continue;
        var result = module[key](url);
        if (result && typeof result.then === "function") {
          result.then(function () { audioStatus = "Reproduccion remota solicitada"; update(); }, function (e) {
            audioStatus = "El modulo de audio rechazo el enlace"; log("Audio URL", e); update();
          });
        }
        audioStatus = "Reproduccion remota solicitada por " + key;
        return true;
      } catch (e) { log("Metodo de audio incompatible", e); }
    }
    audioStatus = "No se encontro reproductor compatible con MP3/OGG externo.";
    return false;
  }
  function soundRule(rule) {
    var sound = rule.url;
    if (sound && isDirectAudio(sound) && playRemoteAudio(sound)) return true;
    var isPage = !!sound && isMediaPage(sound);
    var notAudio = !!sound && !isDirectAudio(sound);
    var used = playTone(rule.tone);
    if (isPage) audioStatus = "Enlace de plataforma: se uso el tono local, no la musica del enlace.";
    else if (notAudio) audioStatus = "El enlace no es un MP3/OGG directo: se uso tono local.";
    else if (sound && !used) audioStatus = "El audio externo y el tono local no estan disponibles; revisa los ajustes.";
    return used;
  }
  function openSource(url) {
    if (!/^https:\/\//i.test(url)) return toast("Enlace no disponible");
    try {
      var mod = api.metro.common.url;
      if (mod && typeof mod.openURL === "function") { mod.openURL(url); return; }
      if (RN.Linking && typeof RN.Linking.openURL === "function") { RN.Linking.openURL(url); return; }
    } catch (e) { log("No se pudo abrir el enlace", e); }
    toast("No se pudo abrir el enlace en esta version de Discord");
  }
  function alertLocal(rule, author, preview, dryRun) {
    if (config.vibrate && RN.Vibration && typeof RN.Vibration.vibrate === "function") {
      try { RN.Vibration.vibrate(90); } catch (_) {}
    }
    if (config.notifications) {
      toast((dryRun ? "PRUEBA · " : "Aviso · ") + rule.label + " · " + author + (preview ? ": " + str(preview, 38) : ""));
    }
    soundRule(rule);
    diagnostics = (dryRun ? "Prueba" : "Ultima coincidencia") + ": " + rule.label + " (" + new Date().toLocaleTimeString() + ")";
    update();
  }
  function getMyId() {
    try { var mod = find("getCurrentUser"); var user = mod && mod.getCurrentUser(); return id(user && user.id); } catch (_) { return ""; }
  }
  function getChannelGuild(channelId) {
    try { var mod = find("getChannel"); var channel = mod && mod.getChannel(channelId); return id(channel && (channel.guild_id || channel.guildId)); } catch (_) { return ""; }
  }
  function directlyMentioned(msg, myId) {
    if (!myId) return false;
    if (Array.isArray(msg.mentions) && msg.mentions.some(function (m) { return id(m && m.id) === myId; })) return true;
    var content = str(msg.content, 4000);
    return content.indexOf("<@" + myId + ">") >= 0 || content.indexOf("<@!" + myId + ">") >= 0;
  }
  function onMessageCreate(event) {
    if (!active || !config.enabled) return;
    try {
      var msg = event && (event.message || event);
      if (!msg || typeof msg !== "object") return;
      var author = msg.author || event.author || {};
      var authorId = id(author.id || msg.author_id || msg.authorId);
      var msgId = id(msg.id || event.messageId);
      var channelId = id(msg.channel_id || msg.channelId || event.channelId);
      if (!msgId || !channelId || !authorId || authorId === getMyId()) return;
      if (lastSeen[msgId]) return;
      lastSeen[msgId] = Date.now();
      if (Object.keys(lastSeen).length > 350) lastSeen = Object.create(null);
      if (config.mentionOnly && !directlyMentioned(msg, getMyId())) return;
      var guildId = id(msg.guild_id || msg.guildId || event.guildId || getChannelGuild(channelId));
      var match = null;
      // Regla de usuario tiene prioridad sobre regla de servidor.
      config.rules.some(function (r) { if (r.enabled && r.type === "user" && r.target === authorId) { match = r; return true; } return false; });
      if (!match) config.rules.some(function (r) { if (r.enabled && r.type === "server" && guildId && r.target === guildId) { match = r; return true; } return false; });
      if (!match) return;
      var time = Date.now();
      if (lastRuleAt[match.key] && time - lastRuleAt[match.key] < match.cooldown * 1000) return;
      lastRuleAt[match.key] = time;
      alertLocal(match, str(author.global_name || author.username || "Usuario", 32), str(msg.content || "Nuevo mensaje", 100), false);
    } catch (e) { log("No se pudo procesar el mensaje", e); diagnostics = "Error al revisar notificacion"; update(); }
  }
  function addRule(type, target, label, url, tone) {
    target = id(target);
    if (!validId(target)) { toast("ID invalido: pega el ID numerico del usuario o servidor."); return false; }
    if (url && !/^https:\/\//i.test(url)) { toast("Usa una URL https:// valida o deja el enlace vacio."); return false; }
    var existing = config.rules.find(function (r) { return r.type === type && r.target === target; });
    if (existing) {
      existing.label = str(label || target, 56); existing.url = str(url, 500); existing.tone = tone; existing.enabled = true;
    } else {
      config.rules.unshift({ key: "n" + Date.now() + "-" + (++ruleSeq), type: type, target: target, label: str(label || target, 56), url: str(url, 500), tone: tone, enabled: true, cooldown: 8 });
    }
    config.rules = config.rules.slice(0, 100);
    save(); update(); toast("Regla guardada para " + type + " " + target); return true;
  }
  function registerCommand(name, desc, execute) {
    if (!api.commands || typeof api.commands.registerCommand !== "function") return null;
    return api.commands.registerCommand({ name: name, displayName: name, description: desc,
      displayDescription: desc, applicationId: "-1", type: 1, inputType: 0, options: [],
      execute: function () { try { execute(); } catch (e) { log("Comando " + name, e); toast("Error ejecutando " + name); } return; } });
  }
  function registerCommands() {
    var registered = [];
    try {
      var specs = [
        ["notion", "Activar notificaciones privadas", function () { config.enabled = true; save(); update(); toast("Avisos personalizados activados"); }],
        ["notioff", "Desactivar notificaciones privadas", function () { config.enabled = false; save(); update(); toast("Avisos personalizados desactivados"); }],
        ["notitest", "Probar la primera regla personalizada", function () {
          var rule = config.rules.find(function (r) { return r.enabled; });
          if (!rule) return toast("Primero crea una regla en los ajustes del plugin");
          alertLocal(rule, "Prueba", "Sonido de ejemplo", true);
        }],
        ["notistatus", "Mostrar el estado de las alertas privadas", function () {
          toast("Alertas " + (config.enabled ? "ON" : "OFF") + " · " + config.rules.length + " reglas · " + audioStatus);
        }]
      ];
      specs.forEach(function (entry) { var off = registerCommand(entry[0], entry[1], entry[2]); if (typeof off === "function") registered.push(off); });
      commandUndo = registered;
      commandStatus = registered.length === specs.length ? "4 comandos Built-in activos" : "Comandos parciales: " + registered.length + "/4";
    } catch (e) { log("No se pudieron registrar comandos", e); commandStatus = "Error registrando comandos"; }
  }

  function SettingsScreen() {
    var local = React.useState(0), rerender = local[1];
    var typeState = React.useState("server"), type = typeState[0], setType = typeState[1];
    var targetState = React.useState(""), target = targetState[0], setTarget = targetState[1];
    var labelState = React.useState(""), name = labelState[0], setName = labelState[1];
    var urlState = React.useState(""), url = urlState[0], setUrl = urlState[1];
    var toneState = React.useState("message1"), tone = toneState[0], setTone = toneState[1];
    React.useEffect(function () { refresh = function () { rerender(function (v) { return v + 1; }); }; return function () { refresh = null; }; }, []);
    function txt(value, style) { return E(RN.Text, { style: Object.assign({ color: "#e8e9f0", fontSize: 14, lineHeight: 21 }, style || {}) }, value); }
    function input(value, setter, hint, opts) { return E(RN.TextInput, Object.assign({ value: value, onChangeText: setter, placeholder: hint,
      placeholderTextColor: "#9b9da9", autoCorrect: false,
      style: { backgroundColor: "#292b35", borderRadius: 10, color: "white", padding: 12, marginTop: 8, fontSize: 14 } }, opts || {})); }
    function btn(title, callback, color) { return E(RN.TouchableOpacity, { key: title, onPress: callback,
      style: { paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, backgroundColor: color || "#5865f2", marginTop: 8 } },
      txt(title, { fontWeight: "700", textAlign: "center", color: "white" })); }
    function toggle(text, key) { return E(RN.View, { key: key, style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 7 } },
      E(RN.View, { style: { flex: 1, paddingRight: 9 } }, txt(text)), E(RN.Switch, { value: !!config[key], onValueChange: function (v) { config[key] = !!v; save(); update(); } })); }
    function divider() { return E(RN.View, { style: { height: 1, backgroundColor: "#3a3d4a", marginVertical: 15 } }); }
    var rules = config.rules.map(function (rule) {
      return E(RN.View, { key: rule.key, style: { borderRadius: 12, backgroundColor: "#242731", padding: 12, marginTop: 9 } },
        txt((rule.type === "server" ? "SERVIDOR · " : "USUARIO · ") + rule.label, { fontSize: 16, fontWeight: "700" }),
        txt("ID: " + rule.target + " · " + rule.tone + " · " + (rule.enabled ? "ON" : "OFF"), { color: "#aeb5ce", fontSize: 12 }),
        rule.url ? txt(rule.url, { color: "#acb7ff", fontSize: 12 }) : null,
        E(RN.View, { style: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 8 } },
          btn("Probar", function () { alertLocal(rule, "Prueba", "", true); }),
          btn(rule.enabled ? "Desactivar" : "Activar", function () { rule.enabled = !rule.enabled; save(); update(); }, "#444b6b"),
          btn("Editar", function () { setType(rule.type); setTarget(rule.target); setName(rule.label); setUrl(rule.url); setTone(rule.tone); }, "#444b6b"),
          rule.url ? btn("Abrir enlace", function () { openSource(rule.url); }, "#444b6b") : null,
          btn("Borrar", function () { config.rules = config.rules.filter(function (r) { return r.key !== rule.key; }); save(); update(); }, "#893849")
        )
      );
    });
    return E(RN.ScrollView, { style: { flex: 1, backgroundColor: "#17181f" }, contentContainerStyle: { padding: 16, paddingBottom: 60 } },
      txt("CUSTOM NOTIFICATIONS", { fontSize: 23, fontWeight: "800" }),
      txt("Revenge clasico · v1.0 · avisos dentro de Discord", { color: "#afb5c6", marginTop: 4 }),
      divider(),
      toggle("Activar alertas personalizadas", "enabled"),
      toggle("Vibracion corta", "vibrate"),
      toggle("Mostrar aviso dentro de Discord", "notifications"),
      toggle("Avisar solo en menciones directas", "mentionOnly"),
      txt("Los avisos funcionan mientras Discord ejecuta el plugin. No modifican los sonidos push de Android cuando la app esta cerrada.", { color: "#b8b9c6", marginTop: 9, fontSize: 12 }),
      divider(),
      txt("CREAR / EDITAR REGLA", { fontSize: 17, fontWeight: "700" }),
      E(RN.View, { style: { flexDirection: "row", gap: 9 } }, btn("Servidor" + (type === "server" ? " ✓" : ""), function () { setType("server"); }, "#3f4666"),
        btn("Usuario" + (type === "user" ? " ✓" : ""), function () { setType("user"); }, "#3f4666")),
      input(target, setTarget, "ID numerico del " + (type === "server" ? "servidor" : "usuario"), { keyboardType: "number-pad" }),
      input(name, setName, "Nombre para identificar la regla"),
      input(url, setUrl, "Enlace de MP3/OGG directo (o referencia)"),
      txt("YouTube, Spotify y TikTok se guardan como referencia, pero sus URLs normales NO son archivos de sonido. Un MP3/OGG directo puede funcionar si tu Discord expone reproductor de audio remoto.", { fontSize: 12, color: "#b9bfd4", marginTop: 7 }),
      txt("TONO LOCAL: " + tone, { fontWeight: "700", marginTop: 14 }),
      E(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", gap: 6 } },
        ["message1", "message2", "message3", "none"].map(function (t) { return btn(t + (tone === t ? " ✓" : ""), function () { setTone(t); }, "#3b466e"); })),
      btn("GUARDAR REGLA", function () { if (addRule(type, target, name, url.trim(), tone)) { setTarget(""); setName(""); setUrl(""); } }),
      divider(),
      txt("MIS REGLAS (" + config.rules.length + ")", { fontSize: 17, fontWeight: "700" }),
      rules.length ? rules : txt("Todavia no hay reglas. Primero añade un servidor o usuario.", { color: "#9d9fac", marginTop: 12 }),
      divider(),
      txt("COMANDOS LOCALES BUILT-IN", { fontSize: 17, fontWeight: "700" }),
      txt("/notion  ·  /notioff  ·  /notitest  ·  /notistatus", { color: "#aeb7ff" }),
      txt(commandStatus, { color: "#b7c2d7", marginTop: 7 }),
      txt("Diagnostico: " + diagnostics, { color: "#b7c2d7", marginTop: 12, fontSize: 12 }),
      txt("Audio: " + audioStatus, { color: "#b7c2d7", marginTop: 4, fontSize: 12 }),
      btn("PROBAR PRIMERA REGLA", function () { var rule = config.rules[0]; if (rule) alertLocal(rule, "Prueba", "", true); else toast("Primero configura una regla"); }, "#444b6b")
    );
  }
  return {
    onLoad: function () {
      if (active) return;
      active = true; load();
      try {
        dispatcher = api.metro.common.FluxDispatcher || find("subscribe", "unsubscribe", "dispatch");
        if (dispatcher && typeof dispatcher.subscribe === "function") {
          onMessage = function (ev) { onMessageCreate(ev); };
          dispatcher.subscribe("MESSAGE_CREATE", onMessage);
          diagnostics = "Escuchando MESSAGE_CREATE";
        } else diagnostics = "No se encontro FluxDispatcher: las reglas no pueden detectar mensajes";
      } catch (e) { log("Suscribir", e); diagnostics = "Error al escuchar mensajes"; }
      registerCommands(); update();
    },
    onUnload: function () {
      active = false;
      try { if (dispatcher && onMessage) dispatcher.unsubscribe("MESSAGE_CREATE", onMessage); } catch (_) {}
      onMessage = null; dispatcher = null;
      commandUndo.forEach(function (undo) { try { undo(); } catch (_) {} }); commandUndo = [];
      refresh = null; lastSeen = Object.create(null); lastRuleAt = Object.create(null);
      diagnostics = "Plugin detenido";
    },
    settings: SettingsScreen
  };
})()
