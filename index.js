(() => {
  "use strict";
  // Profile Presets for classic Revenge/Vendetta (folder URL + manifest.json loader).
  // The plugin intentionally has no automatic background account changes.
  const store = vendetta.plugin.storage;
  const metro = vendetta.metro;
  let running = false;
  const LIMIT = 35;
  const HEX = /^#?[0-9a-fA-F]{6}$/;
  const IMAGE_URL = /^https:\/\//i;
  const EMPTY = () => ({ label: "", avatarUrl: "", bannerUrl: "", primary: "", secondary: "", avatarData: "", bannerData: "" });

  function uid() {
    try {
      const users = metro.findByStoreName("UserStore") || metro.findByProps("getCurrentUser");
      const u = users && users.getCurrentUser && users.getCurrentUser();
      return u && u.id ? String(u.id) : "";
    } catch (_) { return ""; }
  }
  function profiles() {
    const id = uid();
    if (!id) return [];
    const map = store.profilePresets || {};
    const entry = map[id];
    return Array.isArray(entry) ? entry : [];
  }
  function saveList(list) {
    const id = uid();
    if (!id) throw new Error("Inicia sesión en Discord antes de guardar perfiles.");
    // Reassign the top-level property so storage's change tracker persists it.
    const next = Object.assign({}, store.profilePresets || {});
    next[id] = list;
    store.profilePresets = next;
  }
  function colorNum(value, field) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (!HEX.test(raw)) throw new Error(field + ": escribe un color hexadecimal como #AABBCC.");
    return parseInt(raw.replace("#", ""), 16);
  }
  const toHex = (value) => (typeof value === "number" && Number.isFinite(value)) ? "#" + (value & 0xFFFFFF).toString(16).padStart(6, "0").toUpperCase() : "";
  const errText = (err) => String((err && (err.message || err.body?.message)) || err || "Error desconocido").slice(0, 240);
  function validate(p) {
    if (!p.label.trim()) throw new Error("Escribe un nombre para este perfil.");
    if (p.label.trim().length > 45) throw new Error("El nombre del perfil no puede superar 45 caracteres.");
    ["primary", "secondary"].forEach(k => colorNum(p[k], k));
    if (Boolean(p.primary) !== Boolean(p.secondary)) throw new Error("Para el tema, escribe ambos colores o deja ambos vacíos.");
    ["avatarUrl", "bannerUrl"].forEach(k => {
      if (p[k] && !IMAGE_URL.test(p[k]) && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(p[k])) {
        throw new Error(k + ": utiliza un enlace HTTPS directo a la imagen.");
      }
    });
  }
  function getHttp() {
    const a = metro.findByProps("HTTP");
    if (a && a.HTTP && typeof a.HTTP.patch === "function") return a.HTTP;
    const b = metro.findByProps("get", "patch", "post");
    if (b && typeof b.patch === "function") return b;
    throw new Error("No encontré el HTTP interno de Discord en esta versión de Revenge.");
  }
  function callHttp(method, url, data) {
    const api = getHttp();
    if (typeof api[method] !== "function") return Promise.reject(new Error("Método HTTP no disponible: " + method));
    let req;
    try { req = api[method]({ url: url, ...(data ? { body: data } : {}) }); }
    catch (e) { return Promise.reject(e); }
    return Promise.resolve(req).then(res => {
      if (!res) throw new Error("Discord no devolvió respuesta.");
      const status = Number(res.status || res.statusCode || 200);
      const content = res.body || res.data || res;
      if (status >= 400 || res.ok === false) {
        const message = content && (content.message || content.error);
        throw new Error((message || "Error de Discord") + " (HTTP " + status + ")");
      }
      return content;
    });
  }
  function detectedMime(bytes) {
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) return "image/gif";
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
    return "";
  }
  function toBase64(bytes) {
    // No FileReader required. React Native supports Response.arrayBuffer on many versions.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const parts = [];
    let part = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      part += alphabet[a >> 2] + alphabet[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)] +
        (b === undefined ? "=" : alphabet[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)]) +
        (c === undefined ? "=" : alphabet[c & 63]);
      if (part.length >= 8192) { parts.push(part); part = ""; }
    }
    if (part) parts.push(part);
    return parts.join("");
  }
  async function fetchImageData(uri, bytesLimit) {
    if (!uri) return null;
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(uri)) {
      if (uri.length > Math.ceil(bytesLimit * 4 / 3) + 100) throw new Error("La imagen supera el tamaño permitido.");
      return uri;
    }
    if (!IMAGE_URL.test(uri)) throw new Error("La imagen debe tener un enlace HTTPS directo.");
    if (typeof fetch !== "function") throw new Error("Este Revenge no permite descargar imágenes desde enlaces.");
    let response;
    try { response = await fetch(uri); }
    catch (e) { throw new Error("No se pudo abrir el enlace de imagen: " + errText(e)); }
    if (!response || !response.ok) throw new Error("Descarga fallida (HTTP " + (response ? response.status : "sin respuesta") + ").");
    const sizeHeader = response.headers && typeof response.headers.get === "function" ? Number(response.headers.get("content-length")) : 0;
    if (sizeHeader > bytesLimit) throw new Error("Imagen demasiado grande; máximo " + (bytesLimit / 1048576).toFixed(1) + " MB.");
    // Do not rely solely on FileReader; some Discord Android builds lack it.
    let buffer = null;
    let readError = null;
    if (typeof response.arrayBuffer === "function") {
      try { buffer = await response.arrayBuffer(); } catch (e) { readError = e; }
    }
    if (buffer) {
      const bytes = new Uint8Array(buffer);
      if (!bytes.length || bytes.length > bytesLimit) throw new Error("La imagen está vacía o es demasiado grande.");
      const mime = detectedMime(bytes);
      if (!mime) throw new Error("El enlace no devuelve un PNG, JPG, GIF o WebP válido.");
      return "data:" + mime + ";base64," + toBase64(bytes);
    }
    if (typeof response.blob === "function" && typeof FileReader === "function") {
      let blob;
      try { blob = await response.blob(); } catch (e) { throw new Error("No se pudo leer la imagen: " + errText(e)); }
      if (!blob || !blob.size || blob.size > bytesLimit) throw new Error("Imagen vacía o demasiado grande.");
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Error al convertir la imagen a base64."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
      if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(data)) throw new Error("El enlace no devolvió una imagen compatible.");
      return data;
    }
    throw new Error("Esta versión de Revenge no puede convertir imágenes a base64: " + errText(readError || "sin conversor disponible"));
  }
  async function memoizeImages(record) {
    // Save local copies for reasonably small files; the original link is always preserved.
    const results = [];
    const jobs = [
      ["avatarUrl", "avatarData", 2 * 1024 * 1024, "Avatar"],
      ["bannerUrl", "bannerData", 4 * 1024 * 1024, "Banner"]
    ];
    for (const [urlKey, dataKey, max, name] of jobs) {
      if (record[urlKey] && !record[dataKey]) {
        try { record[dataKey] = await fetchImageData(record[urlKey], max); }
        catch (e) { record[dataKey] = ""; results.push(name + ": " + errText(e)); }
      }
    }
    return results;
  }
  function chooseImage(p, field) {
    const k = field === "avatar" ? "avatarUrl" : "bannerUrl";
    const dk = field === "avatar" ? "avatarData" : "bannerData";
    return p[dk] || p[k] || "";
  }
  function applyPreset(p, notify) {
    // Only change fields explicitly requested by the user. Never modify name, bio or pronouns.
    try { validate(p); } catch (e) { return Promise.reject(e); }
    if (!uid()) return Promise.reject(new Error("No hay una cuenta de Discord activa."));
    const attempts = [];
    const failures = [];
    const primary = colorNum(p.primary, "Primario");
    const secondary = colorNum(p.secondary, "Secundario");
    if (p.avatarUrl || p.avatarData) attempts.push({
      name: "Avatar", run: () => fetchImageData(chooseImage(p, "avatar"), 8 * 1024 * 1024)
        .then(image => callHttp("patch", "/users/@me", { avatar: image }))
    });
    if (p.bannerUrl || p.bannerData) attempts.push({
      name: "Banner Nitro", run: () => fetchImageData(chooseImage(p, "banner"), 10 * 1024 * 1024)
        .then(image => callHttp("patch", "/users/@me/profile", { banner: image }))
    });
    if (primary !== null && secondary !== null) attempts.push({
      name: "Colores Nitro", run: () => callHttp("patch", "/users/@me/profile", { theme_colors: [primary, secondary] })
    });
    if (!attempts.length) return Promise.reject(new Error("Este perfil no tiene avatar, banner ni colores configurados."));
    let ok = 0;
    let chain = Promise.resolve();
    attempts.forEach(job => {
      chain = chain.then(() => {
        if (!running) throw new Error("Plugin desactivado durante el cambio de perfil.");
        notify("Aplicando: " + job.name + "…");
        return job.run().then(() => { ok++; }, e => { failures.push(job.name + ": " + errText(e)); });
      });
    });
    return chain.then(() => ({ ok, total: attempts.length, failures }));
  }
  function captureCurrent() {
    const id = uid();
    if (!id) return Promise.reject(new Error("No encontré tu cuenta actual."));
    const userStore = metro.findByStoreName("UserStore") || metro.findByProps("getCurrentUser");
    const user = userStore && userStore.getCurrentUser && userStore.getCurrentUser();
    if (!user) return Promise.reject(new Error("No encontré el usuario actual."));
    return callHttp("get", "/users/" + id + "/profile").catch(() => ({})).then(body => {
      const data = body && (body.user_profile || body.userProfile) || {};
      const u = body && body.user || user;
      const bannerHash = data.banner || u.banner || user.banner;
      const avatarHash = u.avatar || user.avatar;
      const avatarExt = String(avatarHash || "").startsWith("a_") ? "gif" : "png";
      const bannerExt = String(bannerHash || "").startsWith("a_") ? "gif" : "png";
      const theme = data.theme_colors || u.theme_colors || [];
      return {
        label: "Perfil " + (new Date()).toLocaleDateString(),
        avatarUrl: avatarHash ? "https://cdn.discordapp.com/avatars/" + id + "/" + avatarHash + "." + avatarExt + "?size=512" : "",
        bannerUrl: bannerHash ? "https://cdn.discordapp.com/banners/" + id + "/" + bannerHash + "." + bannerExt + "?size=1024" : "",
        primary: toHex(theme[0]), secondary: toHex(theme[1]),
        avatarData: "", bannerData: ""
      };
    });
  }

  function Settings() {
    const React = metro.common.React;
    const RN = metro.common.ReactNative;
    if (!React || !RN) return null;
    const e = React.createElement;
    const { View, Text, ScrollView, TextInput, TouchableOpacity, Image, ActivityIndicator, Alert } = RN;
    const [items, setItems] = React.useState(() => profiles());
    const [form, setForm] = React.useState(() => EMPTY());
    const [editing, setEditing] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState("");
    const [formOwner, setFormOwner] = React.useState(() => uid());
    const activeId = uid();
    const visible = profiles();
    React.useEffect(() => {
      if (activeId !== formOwner) {
        setForm(EMPTY()); setEditing(null); setFormOwner(activeId);
        setItems(profiles().slice()); setNotice("Cuenta cambiada: mostrando los perfiles de la cuenta actual.");
      }
    }, [activeId, formOwner]);
    const bg = "#101116", card = "#1A1C25", ink = "#F4F6FA", muted = "#B3B7C7", purple = "#9A7CFF", line = "#343644";
    const refresh = () => setItems(profiles().slice());
    const update = (key, val) => setForm(old => Object.assign({}, old, { [key]: val, ...(key === "avatarUrl" ? { avatarData: "" } : key === "bannerUrl" ? { bannerData: "" } : {}) }));
    const section = label => e(Text, { style: { color: purple, fontSize: 15, fontWeight: "700", marginTop: 16, marginBottom: 8 } }, label);
    const hint = value => e(Text, { style: { color: muted, fontSize: 12, lineHeight: 18, marginTop: 5 } }, value);
    function field(label, key, more) {
      return e(View, { key, style: { marginBottom: 12 } },
        e(Text, { style: { color: ink, marginBottom: 6, fontWeight: "600" } }, label),
        e(TextInput, {
          style: { backgroundColor: "#252733", borderColor: line, borderWidth: 1, color: ink, borderRadius: 9, minHeight: more ? 70 : 43, paddingVertical: 10, paddingHorizontal: 12, textAlignVertical: more ? "top" : "center" },
          placeholderTextColor: "#828699", placeholder: (key === "avatarUrl" || key === "bannerUrl") ? "https://.../imagen.png" : (key === "primary" || key === "secondary") ? "#AABBCC" : label,
          value: String(form[key] || ""), onChangeText: val => update(key, val), multiline: !!more,
          autoCapitalize: "none", autoCorrect: false,
        })
      );
    }
    function button(label, click, variant) {
      const destructive = variant === "danger";
      const soft = variant === "soft";
      const backgroundColor = destructive ? "#7C2835" : soft ? "#2B2D39" : purple;
      return e(TouchableOpacity, {
        onPress: click, disabled: busy, accessibilityRole: "button",
        style: { backgroundColor, borderRadius: 9, minHeight: 41, paddingHorizontal: 12, marginRight: 6, marginTop: 7, justifyContent: "center", alignItems: "center", opacity: busy ? .5 : 1 }
      }, e(Text, { style: { color: soft ? ink : "#101018", fontWeight: "700", fontSize: 13 } }, label));
    }
    function handleError(error) { setNotice("Error: " + errText(error)); setBusy(false); }
    function doSave() {
      if (busy) return;
      let next;
      try {
        next = Object.assign({}, EMPTY(), {
          label: String(form.label || "").trim(), avatarUrl: form.avatarUrl || "", bannerUrl: form.bannerUrl || "",
          primary: form.primary || "", secondary: form.secondary || "",
          avatarData: form.avatarData || "", bannerData: form.bannerData || ""
        });
        validate(next);
        if (formOwner !== uid()) throw new Error("Cambiaste de cuenta: abre el editor de nuevo.");
        if (editing === null && profiles().length >= LIMIT) throw new Error("Límite de " + LIMIT + " perfiles guardados.");
      } catch (err) { handleError(err); return; }
      setBusy(true);
      setNotice("Guardando perfil e intentando conservar las imágenes…");
      memoizeImages(next).then(warnings => {
        const list = profiles().slice();
        next.recordId = editing || (String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8));
        const oldAt = list.findIndex(it => it.recordId === next.recordId);
        if (oldAt >= 0) list[oldAt] = next;
        else list.unshift(next);
        saveList(list);
        refresh();
        setForm(EMPTY()); setEditing(null);
        setNotice("Perfil guardado. " + (warnings.length ? "Algunas imágenes solo se conservaron por URL: " + warnings.join(" · ") : "Imágenes guardadas localmente cuando están disponibles."));
        setBusy(false);
      }).catch(handleError);
    }
    function doCapture() {
      if (busy) return;
      setBusy(true);
      setNotice("Leyendo tu perfil actual…");
      captureCurrent().then(next => {
        setForm(next); setEditing(null); setBusy(false);
        setNotice("Perfil actual cargado en el editor. Escribe un nombre y pulsa Guardar.");
      }).catch(handleError);
    }
    function doApply(p) {
      if (busy) return;
      if (!profiles().some(x => x.recordId === p.recordId)) { setNotice("Este perfil pertenece a otra cuenta; no se aplicó."); return; }
      if (Alert && Alert.alert) Alert.alert("Aplicar perfil", "¿Cambiar tu perfil real de Discord a «" + p.label + "»? Los campos y funciones Nitro dependerán de tu cuenta.", [
        { text: "Cancelar", style: "cancel" },
        { text: "Aplicar", onPress: () => {
          setBusy(true); setNotice("Preparando…");
          applyPreset(p, setNotice).then(result => {
            setBusy(false);
            setNotice("Aplicado: " + result.ok + "/" + result.total + " partes. " + (result.failures.length ? "Errores: " + result.failures.join(" · ") : "Discord aceptó los cambios."));
          }).catch(handleError);
        } }
      ]);
      else setNotice("No se encontró el diálogo de confirmación; no se aplicó el perfil.");
    }
    function doDelete(p) {
      if (busy) return;
      if (Alert && Alert.alert) Alert.alert("Eliminar perfil", "¿Eliminar «" + p.label + "» de este teléfono?", [
        { text: "Cancelar", style: "cancel" },
        { text: "Eliminar", style: "destructive", onPress: () => {
          try { saveList(profiles().filter(x => x.recordId !== p.recordId)); refresh(); setNotice("Perfil eliminado."); }
          catch (err) { handleError(err); }
        } }
      ]);
    }
    function thumb(url, size, rounded) {
      return url ? e(Image, { source: { uri: url }, style: { width: size, height: rounded ? size : 78, borderRadius: rounded ? size / 2 : 7, backgroundColor: "#333443" } }) : null;
    }
    return e(ScrollView, { keyboardShouldPersistTaps: "handled", style: { flex: 1, backgroundColor: bg }, contentContainerStyle: { paddingHorizontal: 16, paddingVertical: 19, paddingBottom: 70 } },
      e(Text, { style: { color: ink, fontWeight: "800", fontSize: 23 } }, "Profile Presets"),
      hint("Guarda y aplica avatar, banner y los dos colores del tema Nitro. No modifica nombre, pronombres, biografía ni acento del banner."),
      button("Capturar perfil actual", doCapture),
      section("PERFILES GUARDADOS (" + visible.length + "/" + LIMIT + ")"),
      ...(!visible.length ? [hint("Todavía no hay perfiles guardados.")] : visible.map(p =>
        e(View, { key: p.recordId, style: { backgroundColor: card, borderColor: line, borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 10 } },
          e(View, { style: { flexDirection: "row", alignItems: "center" } },
            thumb(p.avatarUrl || p.avatarData, 50, true),
            e(View, { style: { flex: 1, paddingLeft: p.avatarUrl ? 10 : 0 } },
              e(Text, { style: { color: ink, fontSize: 16, fontWeight: "700" } }, p.label),
              e(View, { style: { flexDirection: "row", marginTop: 5 } },
                ...[p.primary, p.secondary].filter(Boolean).map((hex, i) => e(View, { key: i, style: { backgroundColor: HEX.test(hex) ? (hex.startsWith("#") ? hex : "#" + hex) : line, width: 17, height: 17, borderRadius: 5, marginRight: 5 } }))
              )
            )
          ),
          p.bannerUrl ? e(View, { style: { marginTop: 7, overflow: "hidden" } }, thumb(p.bannerUrl || p.bannerData, "100%", false)) : null,
          e(View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 5 } },
            button("Aplicar", () => doApply(p)),
            button("Editar", () => { setEditing(p.recordId); setForm(Object.assign({}, EMPTY(), p)); setNotice("Editando «" + p.label + "»."); }, "soft"),
            button("Duplicar", () => { setEditing(null); setForm(Object.assign({}, EMPTY(), p, { label: p.label + " copia" })); setNotice("Edita el nombre y guarda la copia."); }, "soft"),
            button("Eliminar", () => doDelete(p), "danger")
          )
        )
      )),
      section(editing ? "EDITAR PERFIL" : "CREAR PERFIL"),
      e(View, { style: { backgroundColor: card, borderRadius: 12, borderWidth: 1, borderColor: line, padding: 13 } },
        field("Nombre del perfil guardado", "label"),
        field("URL HTTPS del avatar", "avatarUrl"),
        field("URL HTTPS del banner (Nitro)", "bannerUrl"),
        hint("Usa URLs directas PNG, JPG, GIF o WebP (por ejemplo i.pinimg.com). Se intenta guardar una copia de las imágenes; los banners y GIF animados pueden requerir Nitro."),
        field("Color principal del perfil (Nitro)", "primary"),
        field("Color secundario del perfil (Nitro)", "secondary"),
        hint("Colores hexadecimales (#9A7CFF). El tema de dos colores requiere Nitro. Si un cambio de imagen falla, aparecerá el error exacto."),
        e(View, { style: { flexDirection: "row", flexWrap: "wrap" } },
          button(editing ? "Guardar cambios" : "Guardar perfil", doSave),
          button("Limpiar editor", () => { setForm(EMPTY()); setEditing(null); setNotice(""); }, "soft")
        )
      ),
      busy ? e(ActivityIndicator, { color: purple, size: "small", style: { marginTop: 14 } }) : null,
      notice ? e(Text, { selectable: true, style: { color: ink, marginTop: 14, fontSize: 13, lineHeight: 19 } }, notice) : null,
      hint("Los perfiles se guardan por cuenta en Revenge. Discord recibe las imágenes al pulsar Aplicar; puede pedir una verificación. No necesitas cambiar nombre, pronombres ni biografía.")
    );
  }
  return {
    onLoad() { running = true; if (!store.profilePresets || typeof store.profilePresets !== "object") store.profilePresets = {}; },
    onUnload() { running = false; },
    settings: Settings
  };
})()
