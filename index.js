(function () {
  "use strict";
  // Favorite Emojis & Stickers v1.0 - Revenge clasico.
  // Comandos BUILT_IN locales + intento de integracion no invasiva en el selector nativo.
  var v = vendetta;
  var React = v.metro.common.React;
  var RN = v.metro.common.ReactNative;
  var storage = v.plugin.storage;
  var findByProps = v.metro.findByProps;
  var cleanups = [];
  var commands = [];
  var running = false;
  var favorites = { emojis: [], stickers: [] };
  var refreshSettings = null;
  var pickerRenders = 0;
  var pickerStatus = "Pendiente";
  var commandsStatus = "Pendiente";
  var originalCreateElement = null;
  var wrappedTypes = [];
  var wraps = 0;

  function log(message, err) { try { console.log("[FavoriteExpressions] " + message, err || ""); } catch (_) {} }
  function toast(text) { try { v.ui.toasts.showToast(String(text).slice(0, 180)); } catch (_) { log(text); } }
  function refresh() { try { if (refreshSettings) refreshSettings(); } catch (_) {} }
  function lookup() { try { return findByProps.apply(null, arguments); } catch (_) { return null; } }
  function safeStr(value, len) { return typeof value === "string" ? value.trim().slice(0, len || 120) : ""; }
  function namesEqual(a,b) { return String(a || "") === String(b || ""); }
  function normalizeEmoji(text) {
    var s = safeStr(text, 160);
    if (!s) return null;
    var m = s.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{15,22})>$/);
    if (m) return { key: m[3], name: m[2], text: s, type: "custom", animated: !!m[1], id: m[3] };
    if (s.indexOf("<") !== -1 || s.indexOf(">") !== -1 || s.length > 36) return null;
    if (!/[^a-zA-Z0-9 _-]/u.test(s)) return null;
    return { key: "u:" + s, name: s, text: s, type: "unicode", animated: false, id: "" };
  }
  function resolveSticker(idOrName) {
    var s = safeStr(idOrName, 120);
    var id = (s.match(/\d{15,22}/) || [])[0];
    if (!id) return null;
    var name = "Sticker " + id.slice(-5);
    try {
      var mod = v.metro.findByStoreName && v.metro.findByStoreName("StickersStore");
      if (!mod) mod = lookup("getStickerById");
      var st = mod && mod.getStickerById && mod.getStickerById(id);
      if (st && st.name) name = safeStr(st.name, 60);
    } catch (_) {}
    return { key: id, id: id, name: name, type: "sticker" };
  }
  function loadSaved(raw) {
    var x = raw && typeof raw === "object" ? raw : {};
    var e = Array.isArray(x.emojis) ? x.emojis : [];
    var s = Array.isArray(x.stickers) ? x.stickers : [];
    return {
      emojis: e.slice(0, 100).filter(function (z) { return z && typeof z.key === "string" && typeof z.text === "string"; }),
      stickers: s.slice(0, 100).filter(function (z) { return z && /^\d{15,22}$/.test(String(z.id)); })
    };
  }
  function save() {
    try { storage.favorites = JSON.parse(JSON.stringify(favorites)); }
    catch (e) { log("No se pudieron guardar favoritos", e); }
    refresh();
  }
  function toggle(kind, item) {
    if (!item) { toast("Formato no valido."); return; }
    var list = favorites[kind];
    var n = list.findIndex(function (z) { return z.key === item.key; });
    if (n !== -1) { list.splice(n, 1); save(); toast("Quitado de favoritos: " + item.name); }
    else {
      if (list.length >= 100) list.pop();
      list.unshift(item); save(); toast("Guardado: " + item.name);
    }
    if (typeof setTimeout === "function") setTimeout(function () { if (running) installCommands(); }, 60);
    else installCommands(); // Actualizar opciones de los comandos Built-in.
  }
  function currentChannel() {
    try {
      var store = v.metro.findByStoreName && v.metro.findByStoreName("SelectedChannelStore");
      if (!store) store = lookup("getChannelId");
      var id = store && store.getChannelId && store.getChannelId();
      return id ? String(id) : "";
    } catch (_) { return ""; }
  }
  function insertEmoji(item) {
    if (!item) { toast("Selecciona un emoji favorito."); return false; }
    var value = item.text;
    try {
      var cd = lookup("ComponentDispatch") || lookup("dispatchToLastSubscribed", "subscribe") || lookup("dispatchToLastSubscribed") || (v.metro.common && v.metro.common.ComponentDispatch);
      var bus = cd && (cd.ComponentDispatch || cd.default && cd.default.ComponentDispatch || cd);
      if (bus && typeof bus.dispatchToLastSubscribed === "function" && (!bus.hasSubscribers || bus.hasSubscribers("INSERT_TEXT"))) {
        bus.dispatchToLastSubscribed("INSERT_TEXT", { rawText: value, plainText: value });
        return true;
      }
      if (bus && typeof bus.dispatch === "function" && (!bus.hasSubscribers || bus.hasSubscribers("INSERT_TEXT"))) {
        bus.dispatch("INSERT_TEXT", { rawText: value, plainText: value });
        return true;
      }
    } catch (e) { log("No se pudo insertar emoji", e); }
    try {
      var clip = RN.Clipboard || lookup("setString");
      if (clip && typeof clip.setString === "function") {
        clip.setString(value); toast("Emoji copiado. Pegalo en el chat."); return true;
      }
    } catch (_) {}
    toast("No se encontro el campo de escritura. Usa /emojis.");
    return false;
  }
  function sendSticker(item) {
    if (!item) { toast("Selecciona un sticker favorito."); return false; }
    var channelId = currentChannel();
    if (!channelId) { toast("Abre primero un chat."); return false; }
    try {
      var send = lookup("sendStickers", "sendMessage") || lookup("sendStickers");
      if (send && typeof send.sendStickers === "function") {
        var result = send.sendStickers(channelId, [item.id], false);
        if (result && typeof result.catch === "function") result.catch(function () { toast("Discord no permite enviar este sticker aqui."); });
        return true;
      }
    } catch (e) { log("Fallo envio de sticker", e); }
    toast("Tu Discord no expone el envio nativo de stickers.");
    return false;
  }
  function argValue(args, i) {
    var z = args && args[i];
    if (z === undefined || z === null) return "";
    if (typeof z === "string" || typeof z === "number") return String(z);
    if (typeof z.value === "string" || typeof z.value === "number") return String(z.value);
    if (typeof z.option === "string") return z.option;
    return "";
  }
  function opt(name, desc, required, choices) {
    var o = { name: name, displayName: name, description: desc, displayDescription: desc,
      type: 3, required: !!required };
    if (choices && choices.length) o.choices = choices.map(function (z) {
      return { name: safeStr(z.name, 90), displayName: safeStr(z.name, 90), value: z.key };
    });
    return o;
  }
  function command(name, desc, opts, callback) {
    var remove = v.commands.registerCommand({
      name: name, displayName: name, description: desc, displayDescription: desc,
      applicationId: "-1", type: 1, inputType: 0, options: opts,
      execute: function (args) {
        try { callback(args || []); }
        catch (e) { log("Error comando /" + name, e); toast("No se pudo ejecutar /" + name); }
        return; // Solo local: nunca devuelve un mensaje para enviarlo al canal.
      }
    });
    if (typeof remove === "function") commands.push(remove);
  }
  function installCommands() {
    while (commands.length) { try { commands.pop()(); } catch (_) {} }
    try {
      if (!v.commands || typeof v.commands.registerCommand !== "function") throw Error("API de comandos ausente");
      command("favemoji", "Guardar o quitar un emoji favorito (local)", [opt("emoji", "Pega un emoji o <:nombre:id>", true)], function(args){ toggle("emojis", normalizeEmoji(argValue(args, 0))); });
      command("favsticker", "Guardar o quitar sticker por ID (local)", [opt("id", "ID numerico del sticker", true)], function(args){ toggle("stickers", resolveSticker(argValue(args, 0))); });
      command("emojis", "Insertar un emoji favorito en el chat (local)",
        [opt("favorito", "Nombre o emoji guardado", false, favorites.emojis.slice(0, 25))], function(args){
          var s = argValue(args, 0);
          var it = favorites.emojis.find(function (z) { return z.key === s || z.text === s || z.name.toLowerCase() === s.toLowerCase(); });
          if (!it && !s && favorites.emojis.length === 1) it = favorites.emojis[0];
          if (!it) { toast(favorites.emojis.length ? "Elige un emoji en las opciones de /emojis." : "No tienes emojis. Usa /favemoji."); return; }
          insertEmoji(it);
        });
      command("stickers", "Enviar un sticker favorito (local, el sticker si se envia)",
        [opt("favorito", "Selecciona tu sticker favorito", false, favorites.stickers.slice(0, 25))], function(args){
          var s = argValue(args, 0);
          var it = favorites.stickers.find(function (z) { return z.key === s || z.id === s || z.name.toLowerCase() === s.toLowerCase(); });
          if (!it && !s && favorites.stickers.length === 1) it = favorites.stickers[0];
          if (!it) { toast(favorites.stickers.length ? "Elige un sticker en las opciones de /stickers." : "No tienes stickers. Usa /favsticker."); return; }
          sendSticker(it);
        });
      commandsStatus = "4 comandos BUILT-IN registrados";
    } catch (e) { commandsStatus = "Error al registrar comandos"; log(commandsStatus, e); }
    refresh();
  }
  function Txt(value, style) {
    return React.createElement(RN.Text, { style: Object.assign({ color: "#eef0f6", fontSize: 13 }, style || {}) }, value);
  }
  function button(text, action, style) {
    return React.createElement(RN.TouchableOpacity, { key: text, onPress: action,
      style: Object.assign({ backgroundColor: "#333b58", borderRadius: 9, padding: 10, margin: 4 }, style || {}) },
      Txt(text, { color: "#ffffff", fontWeight: "700" }));
  }
  function FavoriteTray(props) {
    var kind = props.kind;
    var items = kind === "sticker" ? favorites.stickers : favorites.emojis;
    var [, force] = React.useState(0);
    React.useEffect(function () { return function () {}; }, []);
    if (!items.length) return React.createElement(RN.View, { style: { padding: 6, backgroundColor: "#242731" } },
      Txt("⭐ Sin favoritos. Usa /favemoji o /favsticker", { color: "#aab1c6", fontSize: 12 }));
    return React.createElement(RN.View, { style: { paddingVertical: 7, backgroundColor: "#242731", borderBottomWidth: 1, borderBottomColor: "#44485c" } },
      Txt("⭐ FAVORITOS · Mantener pulsado para quitar", { color: "#f3df89", fontWeight: "700", paddingLeft: 10, marginBottom: 5 }),
      React.createElement(RN.ScrollView, { horizontal: true, showsHorizontalScrollIndicator: false },
        items.slice(0, 25).map(function (item) {
          var src = kind === "sticker" ? "https://cdn.discordapp.com/stickers/" + item.id + ".png" :
            item.id ? "https://cdn.discordapp.com/emojis/" + item.id + (item.animated ? ".gif" : ".png") : "";
          return React.createElement(RN.TouchableOpacity, {
            key: item.key, onPress: function () { kind === "sticker" ? sendSticker(item) : insertEmoji(item); },
            onLongPress: function () { toggle(kind === "sticker" ? "stickers" : "emojis", item); force(function(x) { return x + 1; }); },
            style: { minWidth: 46, minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 10, marginHorizontal: 3, backgroundColor: "#373b50" }
          }, src && RN.Image ? React.createElement(RN.Image, { source: { uri: src }, style: { width: 35, height: 35 } }) :
            Txt(item.text || "⭐", { fontSize: 28 }));
        })));
  }
  function favoriteShell(props) {
    pickerRenders++;
    // RN.View solo envuelve el selector reconocido; no cambia la barra de mensajes.
    return React.createElement(RN.View, { style: { flex: 1 } },
      React.createElement(FavoriteTray, { kind: props.kind }), props.child);
  }
  function targetKind(type) {
    if (!type) return "";
    var name = type.displayName || type.name || (type.type && (type.type.displayName || type.type.name)) ||
      (type.render && (type.render.displayName || type.render.name)) || "";
    if (/^(?:EmojiPicker|EmojiPickerSheet|EmojiPickerContainer|EmojiPickerBody|EmojiPickerContent)$/.test(name)) return "emoji";
    if (/^(?:StickerPicker|StickerPickerSheet|StickerPickerContainer|StickerPickerBody|StickerPickerContent)$/.test(name)) return "sticker";
    if (/^(?:ExpressionPicker|ExpressionPickerSheet|ExpressionPickerContainer)$/.test(name)) return "emoji";
    return "";
  }
  function wrapTarget(wrapper, type, kind) {
    if (!wrapper || typeof wrapper[type] !== "function") return false;
    var original = wrapper[type];
    if (wrappedTypes.indexOf(original) !== -1) return false;
    var wrapped = function (props) {
      var child = React.createElement(original, props);
      return React.createElement(favoriteShell, { kind: kind, child: child });
    };
    wrapped.displayName = "FavoritesWrappedPicker";
    wrapper[type] = wrapped;
    wrappedTypes.push(original);
    cleanups.push(function () { if (wrapper[type] === wrapped) wrapper[type] = original; });
    wraps++;
    return true;
  }
  function scanPickerModules() {
    var modules = v.metro.modules;
    if (!modules) return 0;
    var count = 0;
    Object.keys(modules).forEach(function (id) {
      try {
        var m = modules[id];
        var exp = m && ((m.publicModule && m.publicModule.exports) || m.exports);
        if (!exp) return;
        var exports = [exp];
        if (exp.default) exports.push(exp.default);
        exports.forEach(function (item) {
          var kind = targetKind(item);
          if (!kind) return;
          if (item && typeof item.type === "function" && wrapTarget(item, "type", kind)) count++;
          // No sustituir .render de forwardRef: puede recibir ref como segundo argumento.
        });
      } catch (_) {}
    });
    return count;
  }
  function patchPicker() {
    // Interceptamos createElement como apoyo a los exportes React.memo ya importados.
    // El filtro por nombre es estricto, para no modificar el resto de la interfaz.
    var original = React.createElement;
    if (typeof original !== "function") { pickerStatus = "No se encontro React.createElement"; return; }
    originalCreateElement = original;
    React.createElement = function () {
      var type = arguments[0];
      var kind = targetKind(type);
      var normal = original.apply(this, arguments);
      if (!running || !kind || wrappedTypes.indexOf(type) !== -1) return normal;
      pickerRenders++;
      return original.call(React, favoriteShell, { kind: kind, child: normal });
    };
    cleanups.push(function () { if (React.createElement !== original) React.createElement = original; });
    var patched = scanPickerModules();
    pickerStatus = "Parches: " + patched + " | Render del selector: 0 (pendiente de abrirlo)";
    refresh();
  }
  function SettingsScreen() {
    var [, force] = React.useState(0);
    React.useEffect(function () {
      refreshSettings = function () { force(function(x) {return x + 1;}); };
      return function () { refreshSettings = null; };
    }, []);
    function list(kind, title) {
      var arr = favorites[kind];
      return React.createElement(RN.View, { style: { marginTop: 14 } },
        Txt(title + " (" + arr.length + ")", { fontSize: 17, fontWeight: "700", marginBottom: 6 }),
        arr.length ? arr.map(function(it) {
          return React.createElement(RN.View, { key: it.key, style: { flexDirection: "row", alignItems: "center", marginBottom: 3, backgroundColor: "#292d3c", borderRadius: 10 } },
            React.createElement(RN.View, { style: { flex: 1, padding: 10 } }, Txt(it.name)),
            button("QUITAR", function() { toggle(kind, it); }, { backgroundColor: "#783748" }));
        }) : Txt("No hay favoritos guardados", { color: "#abb0c4" }));
    }
    return React.createElement(RN.ScrollView, { style: { flex: 1, backgroundColor: "#171920" }, contentContainerStyle: { padding: 16, paddingBottom: 40 } },
      Txt("FAVORITE EMOJIS & STICKERS", { fontSize: 20, fontWeight: "800" }),
      Txt("v1.0 · Revenge clásico", { color: "#aab1c6", marginBottom: 12 }),
      Txt(commandsStatus, { color: "#98f5ae" }),
      Txt(pickerStatus.replace("Render del selector: 0", "Render del selector: " + pickerRenders), { color: "#f3df89", marginTop: 5 }),
      Txt("Comandos: /favemoji, /favsticker, /emojis y /stickers. Los cuatro son BUILT-IN. Para agregar stickers necesitas su ID.", { marginTop: 10, lineHeight: 20 }),
      Txt("Si el contador de render sigue en 0 despues de abrir el selector, tu version de Discord no expone un componente compatible. Los comandos siguen disponibles.", { marginTop: 7, color: "#b4b9c9", lineHeight: 19 }),
      button("VOLVER A BUSCAR SELECTOR", function() { scanPickerModules(); refresh(); }),
      list("emojis", "EMOJIS FAVORITOS"),
      list("stickers", "STICKERS FAVORITOS"));
  }
  return {
    onLoad: function () {
      running = true;
      favorites = loadSaved(storage.favorites);
      installCommands();
      try { patchPicker(); }
      catch (e) { pickerStatus = "Error de integracion en selector"; log(pickerStatus, e); }
      log("Plugin iniciado, " + commandsStatus);
    },
    onUnload: function () {
      running = false;
      while (commands.length) { try { commands.pop()(); } catch (_) {} }
      while (cleanups.length) { try { cleanups.pop()(); } catch (_) {} }
      wrappedTypes = [];
      originalCreateElement = null;
      refreshSettings = null;
    },
    settings: SettingsScreen
  };
})()
