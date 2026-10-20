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
  // Keep = no change; none = explicitly unequip; select = use an owned item.
  const KINDS = [
    { key: "deco", title: "Avatar Deco", type: 0 },
    { key: "effect", title: "Efecto de perfil", type: 1 },
    { key: "nameplate", title: "Placa de nombre", type: 2 },
    { key: "frame", title: "Marco de perfil", type: 3 }
  ];
  const FONTS = [
    [11,"gg sans"],[12,"Tempo"],[3,"Sakura"],[4,"Jellybean"],
    [6,"Modern"],[7,"Medieval"],[8,"8Bit"],[10,"Vampyre"],
    [13,"Monkey Bars"],[14,"Mainframe"],[15,"Headbang"],[16,"Journal"]
  ];
  const NAME_EFFECTS = [[1,"Sólido"],[2,"Degradado"],[3,"Neón"],[4,"Toon"],[5,"Pop"],[6,"Glow"],[7,"Prisma"],[8,"Gummy"]];
  const EMPTY = () => ({
    label: "", avatarUrl: "", bannerUrl: "", primary: "", secondary: "", avatarData: "", bannerData: "",
    decoMode: "keep", decoSku: "", effectMode: "keep", effectSku: "",
    nameplateMode: "keep", nameplateSku: "", frameMode: "keep", frameSku: "",
    styleMode: "keep", fontId: "11", nameEffectId: "1", nameColors: "#FFFFFF"
  });

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
  const isSnowflake = s => /^\d{16,22}$/.test(String(s || ""));
  const modeOf = (p, key) => ["keep", "none", "select"].includes(p[key + "Mode"]) ? p[key + "Mode"] : "keep";
  function validateOptional(p) {
    KINDS.forEach(k => {
      if (modeOf(p, k.key) === "select" && !isSnowflake(p[k.key + "Sku"]))
        throw new Error(k.title + ": elige un artículo de tu colección.");
    });
    if (modeOf(p, "style") === "select") {
      if (!FONTS.some(x => String(x[0]) === String(p.fontId))) throw new Error("Elige una fuente válida.");
      if (!NAME_EFFECTS.some(x => String(x[0]) === String(p.nameEffectId))) throw new Error("Elige un efecto del nombre válido.");
      const colors = String(p.nameColors || "").split(",").map(x => x.trim()).filter(Boolean);
      if (!colors.length || colors.length > 2 || colors.some(x => !HEX.test(x)))
        throw new Error("Estilo de nombre: escribe 1 o 2 colores HEX separados por coma.");
    }
  }
  function ownedData() {
    const id = uid();
    const m = store.cosmeticCollections || {};
    return id && m[id] && typeof m[id] === "object" ? m[id] : null;
  }
  function saveOwned(items) {
    const id = uid();
    if (!id) throw new Error("No hay una cuenta activa.");
    const map = Object.assign({}, store.cosmeticCollections || {});
    map[id] = { items, updated: Date.now() };
    store.cosmeticCollections = map;
  }
  function friendlyName(v, fallback) {
    const text = String(v || "").trim();
    if (!text || /^COLLECTIBLES_[A-Z0-9_]+$/.test(text)) return fallback;
    return text.slice(0, 100);
  }
  function formatOwned(body) {
    // Discord returns purchased products. Support the mobile result envelope, variants and bundles.
    const roots = Array.isArray(body) ? body :
      Array.isArray(body && body.products) ? body.products :
      Array.isArray(body && body.purchases) ? body.purchases :
      Array.isArray(body && body.collectibles) ? body.collectibles :
      Array.isArray(body && body.items) ? body.items : null;
    if (!roots) throw new Error("Discord devolvió una colección con un formato no reconocido.");
    const list = [], seen = new Set();
    const now = Date.now();
    function walk(product, depth) {
      if (!product || depth > 6) return;
      if (product.expires_at && Date.parse(product.expires_at) < now) return;
      const kids = [].concat(Array.isArray(product.bundled_products) ? product.bundled_products : [], Array.isArray(product.variants) ? product.variants : []);
      kids.forEach(x => walk(x, depth + 1));
      const elements = Array.isArray(product.items) ? product.items : [];
      elements.forEach(item => {
        if (!item || ![0,1,2,3].includes(Number(item.type))) return;
        const type = Number(item.type), sku = String(item.sku_id || product.sku_id || "");
        if (!isSnowflake(sku) || seen.has(type + ":" + sku)) return;
        seen.add(type + ":" + sku);
        const assets = item.assets || {};
        const candidates = [assets.static_image_url, item.staticFrameSrc, item.thumbnailPreviewSrc, assets.animated_image_url, product.preview_assets && product.preview_assets.fg_static];
        const preview = candidates.find(x => typeof x === "string" && /^https:\/\//.test(x)) || "";
        list.push({
          type, sku,
          name: friendlyName(product.name, friendlyName(item.title, friendlyName(item.label, "Artículo " + sku.slice(-6)))),
          preview,
          expires: product.expires_at || null
        });
      });
    }
    roots.forEach(x => walk(x, 0));
    return list.sort((a,b) => a.type - b.type || a.name.localeCompare(b.name));
  }
  async function fetchOwned() {
    const owner = uid();
    if (!owner) throw new Error("No hay cuenta activa.");
    const result = formatOwned(await callHttp("get", "/users/@me/collectibles-purchases"));
    if (uid() !== owner) throw new Error("Cambió la cuenta durante la consulta.");
    saveOwned(result);
    return result;
  }
  function getSelectedStyle(p) {
    const colors = String(p.nameColors || "#FFFFFF").split(",").map(v => colorNum(v.trim(), "Nombre"));
    return { display_name_font_id: Number(p.fontId), display_name_effect_id: Number(p.nameEffectId), display_name_colors: colors };
  }
  async function readAccount() {
    const id = uid();
    if (!id) throw new Error("No hay cuenta activa.");
    const userStore = metro.findByStoreName("UserStore") || metro.findByProps("getCurrentUser");
    const current = userStore && userStore.getCurrentUser && userStore.getCurrentUser();
    const [me, profile] = await Promise.all([
      callHttp("get", "/users/@me").catch(() => current || {}),
      callHttp("get", "/users/" + id + "/profile").catch(() => ({}))
    ]);
    return { user: Object.assign({}, current || {}, me && me.user || me || {}, profile && profile.user || {}), profile: profile && (profile.user_profile || profile.userProfile) || {} };
  }
  function validate(p) {
    if (!p.label.trim()) throw new Error("Escribe un nombre para este perfil.");
    if (p.label.trim().length > 45) throw new Error("El nombre del perfil no puede superar 45 caracteres.");
    ["primary", "secondary"].forEach(k => colorNum(p[k], k));
    if (Boolean(p.primary) !== Boolean(p.secondary)) throw new Error("Para el tema, escribe ambos colores o deja ambos vacíos.");
    validateOptional(p);
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
    try { validate(p); } catch (e) { return Promise.reject(e); }
    if (!uid()) return Promise.reject(new Error("No hay una cuenta de Discord activa."));
    const attempts = [], failures = [];
    const primary = colorNum(p.primary, "Primario"), secondary = colorNum(p.secondary, "Secundario");
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
    const acc = {};
    for (const def of [{ k: "deco", field: "avatar_decoration_sku_id" }, { k: "nameplate", field: "nameplate_sku_id" }]) {
      const mode = modeOf(p, def.k);
      if (mode !== "keep") acc[def.field] = mode === "none" ? null : String(p[def.k + "Sku"]);
    }
    const style = modeOf(p, "style");
    if (style === "none") Object.assign(acc, { display_name_font_id: null, display_name_effect_id: null, display_name_colors: null });
    else if (style === "select") Object.assign(acc, getSelectedStyle(p));
    if (Object.keys(acc).length) attempts.push({ name: "Decoración / placa / estilo de nombre", run: () => callHttp("patch", "/users/@me", acc) });
    const eff = modeOf(p, "effect");
    if (eff !== "keep") attempts.push({ name: "Efecto de perfil", run: () => callHttp("patch", "/users/@me/profile", { profile_effect_id: eff === "none" ? null : String(p.effectSku) }) });
    // Discord does not publish a documented field for profile frames. Try an explicit
    // profile change only when requested, then verify using the current user profile.
    const frame = modeOf(p, "frame");
    if (frame !== "keep") attempts.push({
      name: "Marco de perfil (experimental)", run: async () => {
        const requested = frame === "none" ? null : String(p.frameSku);
        await callHttp("patch", "/users/@me/profile", { profile_frame_sku_id: requested });
        const account = await readAccount();
        const u = account.user, meta = account.profile;
        const frameData = meta.profile_frame || u.profile_frame || meta.profile_frame_data || u.profile_frame_data;
        const currentSku = frameData && (frameData.sku_id || frameData.id) || meta.profile_frame_sku_id || u.profile_frame_sku_id;
        if (requested === null ? Boolean(currentSku) : String(currentSku || "") !== requested)
          throw new Error("Discord no confirmó el cambio del marco. Puedes equiparlo desde Editar perfil.");
      }
    });
    if (!attempts.length) return Promise.reject(new Error("Este perfil no tiene cambios configurados."));
    let ok = 0, chain = Promise.resolve();
    attempts.forEach(job => {
      chain = chain.then(() => {
        if (!running) throw new Error("Plugin desactivado durante el cambio de perfil.");
        notify("Aplicando: " + job.name + "…");
        return job.run().then(() => { ok++; }, e => { failures.push(job.name + ": " + errText(e)); });
      });
    });
    return chain.then(() => ({ ok, total: attempts.length, failures }));
  }
  async function captureCurrent() {
    const id = uid();
    const result = await readAccount();
    if (id !== uid()) throw new Error("La cuenta cambió durante la lectura.");
    const u = result.user, data = result.profile;
    const bannerHash = data.banner || u.banner;
    const avatarHash = u.avatar;
    const avatarExt = String(avatarHash || "").startsWith("a_") ? "gif" : "png";
    const bannerExt = String(bannerHash || "").startsWith("a_") ? "gif" : "png";
    const theme = data.theme_colors || u.theme_colors || [];
    const p = Object.assign(EMPTY(), {
      label: "Perfil " + new Date().toLocaleDateString(),
      avatarUrl: avatarHash ? "https://cdn.discordapp.com/avatars/" + id + "/" + avatarHash + "." + avatarExt + "?size=512" : "",
      bannerUrl: bannerHash ? "https://cdn.discordapp.com/banners/" + id + "/" + bannerHash + "." + bannerExt + "?size=1024" : "",
      primary: toHex(theme[0]), secondary: toHex(theme[1])
    });
    const decoSku = u.avatar_decoration_data && u.avatar_decoration_data.sku_id;
    p.decoMode = decoSku ? "select" : "none"; p.decoSku = String(decoSku || "");
    const plateSku = u.collectibles && u.collectibles.nameplate && u.collectibles.nameplate.sku_id;
    p.nameplateMode = plateSku ? "select" : "none"; p.nameplateSku = String(plateSku || "");
    const effectId = data.profile_effect && data.profile_effect.id;
    p.effectMode = effectId ? "select" : "none"; p.effectSku = String(effectId || "");
    const framed = data.profile_frame || u.profile_frame || data.profile_frame_data || u.profile_frame_data;
    const framedSku = framed && (framed.sku_id || framed.id) || data.profile_frame_sku_id || u.profile_frame_sku_id;
    if (framedSku) { p.frameMode = "select"; p.frameSku = String(framedSku); }
    // If the frame is absent from the response, leave it untouched rather than removing it.
    const nameStyle = u.display_name_styles;
    if (nameStyle && typeof nameStyle.font_id === "number") {
      p.styleMode = "select";
      p.fontId = String(nameStyle.font_id);
      p.nameEffectId = String(nameStyle.effect_id || 1);
      p.nameColors = Array.isArray(nameStyle.colors) && nameStyle.colors.length ? nameStyle.colors.slice(0,2).map(toHex).join(", ") : "#FFFFFF";
    } else p.styleMode = "none";
    return p;
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
    const [collection, setCollection] = React.useState(() => (ownedData() || {}).items || []);
    const [collectionTime, setCollectionTime] = React.useState(() => (ownedData() || {}).updated || 0);
    const [expanded, setExpanded] = React.useState("");
    const activeId = uid();
    const visible = items;
    React.useEffect(() => {
      if (activeId !== formOwner) {
        setForm(EMPTY()); setEditing(null); setFormOwner(activeId);
        setItems(profiles().slice()); setNotice("Cuenta cambiada: mostrando sus perfiles.");
        const saved = ownedData() || {};
        setCollection(saved.items || []); setCollectionTime(saved.updated || 0);
        setExpanded("");
      }
    }, [activeId, formOwner]);
    const bg = "#101116", card = "#1A1C25", ink = "#F4F6FA", muted = "#B3B7C7", purple = "#9A7CFF", line = "#343644";
    const refresh = () => setItems(profiles().slice());
    const update = (key, val) => setForm(old => Object.assign({}, old, { [key]: val, ...(key === "avatarUrl" ? { avatarData: "" } : key === "bannerUrl" ? { bannerData: "" } : {}) }));
    const section = label => e(Text, { style: { color: purple, fontSize: 15, fontWeight: "700", marginTop: 16, marginBottom: 8 } }, label);
    const hint = value => e(Text, { style: { color: muted, fontSize: 12, lineHeight: 18, marginTop: 5 } }, value);
    function field(label, key, placeholder) {
      return e(View, { key, style: { marginBottom: 12 } },
        e(Text, { style: { color: ink, marginBottom: 6, fontWeight: "600" } }, label),
        e(TextInput, {
          style: { backgroundColor: "#252733", borderColor: line, borderWidth: 1, color: ink, borderRadius: 9, minHeight: 43, paddingVertical: 10, paddingHorizontal: 12 },
          placeholderTextColor: "#828699", placeholder: placeholder || label,
          value: String(form[key] || ""), onChangeText: val => update(key, val),
          autoCapitalize: "none", autoCorrect: false
        })
      );
    }
    function button(label, click, variant, selected, disabled) {
      const destructive = variant === "danger", soft = variant === "soft";
      const backgroundColor = destructive ? "#7C2835" : soft ? (selected ? "#4A396A" : "#2B2D39") : purple;
      return e(TouchableOpacity, {
        key: label, onPress: click, disabled: busy || !!disabled, accessibilityRole: "button",
        style: { backgroundColor, borderColor: selected ? purple : "transparent", borderWidth: 1,
          borderRadius: 9, minHeight: 39, paddingHorizontal: 11, marginRight: 6, marginTop: 7,
          justifyContent: "center", alignItems: "center", opacity: busy || disabled ? .45 : 1 }
      }, e(Text, { style: { color: soft ? ink : "#101018", fontWeight: "700", fontSize: 12 } }, label));
    }
    function chooseChips(options, value, cb) {
      return e(View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 1, marginBottom: 9 } },
        ...options.map(opt => button(opt[1], () => cb(String(opt[0])), "soft", String(value) === String(opt[0]))));
    }
    function preview(url, w, h, round) {
      return url && /^https:\/\//.test(url) ? e(Image, {
        source: { uri: url }, resizeMode: "contain",
        style: { width: w, height: h, borderRadius: round || 6, backgroundColor: "#303243" }
      }) : null;
    }
    function handleError(error) { setNotice("Error: " + errText(error)); setBusy(false); }
    function doRefreshCollection() {
      if (busy) return;
      setBusy(true); setNotice("Consultando los artículos que posee tu cuenta…");
      fetchOwned().then(found => {
        setCollection(found); setCollectionTime(Date.now()); setBusy(false);
        setNotice("Colección actualizada: " + found.length + " artículos. Selecciona los que desees guardar.");
      }).catch(handleError);
    }
    function doSave() {
      if (busy) return;
      let next;
      try {
        next = Object.assign(EMPTY(), form, { label: String(form.label || "").trim() });
        // Ensure old preset formats are migrated without losing images.
        validate(next);
        if (formOwner !== uid()) throw new Error("Cambiaste de cuenta: abre el editor de nuevo.");
        if (editing === null && profiles().length >= LIMIT) throw new Error("Límite de " + LIMIT + " perfiles guardados.");
      } catch (err) { handleError(err); return; }
      setBusy(true); setNotice("Guardando perfil e intentando conservar las imágenes…");
      memoizeImages(next).then(warnings => {
        const list = profiles().slice();
        next.recordId = editing || (String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8));
        const oldAt = list.findIndex(it => it.recordId === next.recordId);
        if (oldAt >= 0) list[oldAt] = next;
        else list.unshift(next);
        saveList(list); refresh();
        setForm(EMPTY()); setEditing(null); setExpanded("");
        setNotice("Perfil guardado. " + (warnings.length ? "Imágenes pendientes por URL: " + warnings.join(" · ") : "Los ajustes opcionales también se guardaron."));
        setBusy(false);
      }).catch(handleError);
    }
    function doCapture() {
      if (busy) return;
      setBusy(true); setNotice("Leyendo tu perfil actual…");
      captureCurrent().then(next => {
        setForm(next); setEditing(null); setBusy(false); setExpanded("");
        setNotice("Perfil actual cargado en el editor. Ponle un nombre y pulsa Guardar. Los marcos no detectables se dejan en No modificar.");
      }).catch(handleError);
    }
    function doApply(p) {
      if (busy) return;
      if (!profiles().some(x => x.recordId === p.recordId)) { setNotice("Este perfil pertenece a otra cuenta; no se aplicó."); return; }
      if (Alert && Alert.alert) Alert.alert("Aplicar perfil", "¿Aplicar «" + p.label + "» a tu perfil real de Discord? Solo se cambiarán los campos configurados.", [
        { text: "Cancelar", style: "cancel" },
        { text: "Aplicar", onPress: () => {
          setBusy(true); setNotice("Preparando…");
          applyPreset(p, setNotice).then(result => {
            setBusy(false);
            setNotice("Aplicados " + result.ok + "/" + result.total + " cambios. " + (result.failures.length ? "Errores: " + result.failures.join(" · ") : "Discord aceptó los cambios."));
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
    function cosmeticPicker(def) {
      const modeKey = def.key + "Mode", skuKey = def.key + "Sku";
      const mode = modeOf(form, def.key);
      const values = collection.filter(x => x.type === def.type);
      const selected = values.find(x => x.sku === String(form[skuKey] || ""));
      const title = def.title + " (opcional)";
      return e(View, { key: def.key, style: { marginTop: 10, borderTopColor: line, borderTopWidth: 1, paddingTop: 12 } },
        e(Text, { style: { color: ink, fontWeight: "700", fontSize: 14 } }, title),
        chooseChips([["keep", "No modificar"],["none", "Quitar"],["select", "Elegir"]], mode, next => {
          update(modeKey, next); if (next === "select") setExpanded(def.key);
        }),
        mode === "select" ? e(View, null,
          selected ? e(View, { style: { flexDirection: "row", alignItems: "center", paddingVertical: 4 } },
            preview(selected.preview, 42, 42, 6),
            e(Text, { style: { color: ink, flex: 1, marginLeft: 8, fontSize: 12 } }, "Seleccionado: " + selected.name)
          ) : hint(form[skuKey] ? "Artículo guardado: " + form[skuKey] + ". No aparece en el catálogo actual; podría estar caducado." : "Aún no has elegido un artículo."),
          button(expanded === def.key ? "Ocultar colección" : "Ver mis " + def.title.toLowerCase(), () => setExpanded(expanded === def.key ? "" : def.key), "soft"),
          expanded === def.key ? e(View, { style: { marginTop: 8 } },
            ...(!values.length ? [hint(collectionTime ? "No se encontraron artículos de este tipo. Pulsa Actualizar mi colección." : "Pulsa Actualizar mi colección para obtener tus artículos.")] :
              values.map(x => e(TouchableOpacity, { key: x.sku, disabled: busy,
                onPress: () => { setForm(old => Object.assign({}, old, { [modeKey]: "select", [skuKey]: x.sku })); setExpanded(""); },
                style: { marginBottom: 7, padding: 8, flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 9, borderColor: x.sku === form[skuKey] ? purple : line, backgroundColor: "#252733" } },
                preview(x.preview, 54, 54, 7),
                e(View, { style: { flex: 1, paddingLeft: 8 } },
                  e(Text, { style: { color: ink, fontWeight: "600", fontSize: 13 } }, x.name),
                  e(Text, { style: { color: muted, fontSize: 10 } }, "ID · " + x.sku.slice(-8) + (x.sku === form[skuKey] ? " · Seleccionado" : ""))
                )
              )))
          ) : null
        ) : null,
        def.key === "frame" ? hint("Marcos: guardado y selección disponibles. Aplicación experimental; solo se considera aplicado si Discord confirma el cambio.") : null
      );
    }
    function nameStylePicker() {
      const mode = modeOf(form, "style");
      return e(View, { style: { marginTop: 10, borderTopColor: line, borderTopWidth: 1, paddingTop: 12 } },
        e(Text, { style: { color: ink, fontWeight: "700", fontSize: 14 } }, "Estilo de nombre (Nitro, opcional)"),
        hint("Cambia la apariencia del nombre, no tu nombre visible ni tu usuario."),
        chooseChips([["keep", "No modificar"],["none", "Quitar estilo"],["select", "Personalizar"]], mode, v => update("styleMode", v)),
        mode === "select" ? e(View, null,
          e(Text, { style: { color: ink, fontWeight: "600", marginBottom: 5 } }, "Fuente"),
          chooseChips(FONTS, form.fontId, v => update("fontId", v)),
          e(Text, { style: { color: ink, fontWeight: "600", marginBottom: 5 } }, "Efecto"),
          chooseChips(NAME_EFFECTS, form.nameEffectId, v => update("nameEffectId", v)),
          field("Colores del nombre", "nameColors", "#FFFFFF o #A855F7, #00E5FF"),
          hint("Usa uno o dos colores HEX separados por coma. Discord requiere Nitro; algunos efectos pueden cambiar cómo se ven.")
        ) : null
      );
    }
    const cachedCount = KINDS.map(k => k.title + ": " + collection.filter(x => x.type === k.type).length).join(" · ");
    return e(ScrollView, { keyboardShouldPersistTaps: "handled", style: { flex: 1, backgroundColor: bg }, contentContainerStyle: { paddingHorizontal: 16, paddingVertical: 19, paddingBottom: 70 } },
      e(Text, { style: { color: ink, fontWeight: "800", fontSize: 23 } }, "Profile Presets"),
      hint("Avatares, banners, colores Nitro, cosméticos de la colección y estilos de nombre. Solo se aplica lo que elijas."),
      button("Capturar perfil actual", doCapture),
      button("Actualizar mi colección", doRefreshCollection, "soft"),
      collectionTime ? hint(cachedCount) : hint("Aún no has consultado la colección de esta cuenta."),
      section("PERFILES GUARDADOS (" + visible.length + "/" + LIMIT + ")"),
      ...(!visible.length ? [hint("Todavía no hay perfiles guardados.")] : visible.map(p =>
        e(View, { key: p.recordId, style: { backgroundColor: card, borderColor: line, borderWidth: 1, padding: 12, borderRadius: 12, marginBottom: 10 } },
          e(View, { style: { flexDirection: "row", alignItems: "center" } },
            p.avatarUrl || p.avatarData ? e(Image, { source: { uri: p.avatarUrl || p.avatarData }, style: { width: 50, height: 50, borderRadius: 25, backgroundColor: line } }) : null,
            e(View, { style: { flex: 1, paddingLeft: p.avatarUrl ? 10 : 0 } },
              e(Text, { style: { color: ink, fontSize: 16, fontWeight: "700" } }, p.label),
              e(View, { style: { flexDirection: "row", marginTop: 5 } },
                ...[p.primary, p.secondary].filter(Boolean).map((hex, i) => e(View, { key: i, style: { backgroundColor: HEX.test(hex) ? (hex.startsWith("#") ? hex : "#" + hex) : line, width: 17, height: 17, borderRadius: 5, marginRight: 5 } }))
              )
            )
          ),
          p.bannerUrl ? e(Image, { source: { uri: p.bannerUrl }, resizeMode: "cover", style: { marginTop: 7, height: 72, borderRadius: 7, backgroundColor: line } }) : null,
          hint(KINDS.filter(k => modeOf(p,k.key) !== "keep").map(k => k.title).concat(modeOf(p,"style") !== "keep" ? ["Estilo de nombre"] : []).join(" · ") || "Sin cosméticos opcionales configurados"),
          e(View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 5 } },
            button("Aplicar", () => doApply(p)),
            button("Editar", () => { setEditing(p.recordId); setForm(Object.assign({}, EMPTY(), p)); setNotice("Editando «" + p.label + "»."); }, "soft"),
            button("Duplicar", () => { setEditing(null); setForm(Object.assign({}, EMPTY(), p, { label: p.label + " copia", recordId: undefined })); setNotice("Edita el nombre y guarda la copia."); }, "soft"),
            button("Eliminar", () => doDelete(p), "danger")
          )
        )
      )),
      section(editing ? "EDITAR PERFIL" : "CREAR PERFIL"),
      e(View, { style: { backgroundColor: card, borderRadius: 12, borderWidth: 1, borderColor: line, padding: 13 } },
        field("Nombre del perfil guardado", "label"),
        field("URL HTTPS del avatar", "avatarUrl", "https://.../imagen.png"),
        field("URL HTTPS del banner (Nitro)", "bannerUrl", "https://.../imagen.gif"),
        hint("Admite PNG, JPG, GIF y WebP directos. Las imágenes se conservan cuando es posible."),
        field("Color principal del perfil (Nitro)", "primary", "#AABBCC"),
        field("Color secundario del perfil (Nitro)", "secondary", "#AABBCC"),
        hint("Si dejas ambos colores vacíos, no se modifican al aplicar el perfil."),
        section("COSMÉTICOS OPCIONALES"),
        hint("Usa Actualizar mi colección. No modificar conserva el artículo que ya tienes. Quitar lo desequipa. Elegir usa uno que poseas."),
        ...KINDS.map(cosmeticPicker),
        nameStylePicker(),
        e(View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 13 } },
          button(editing ? "Guardar cambios" : "Guardar perfil", doSave),
          button("Limpiar editor", () => { setForm(EMPTY()); setEditing(null); setExpanded(""); setNotice(""); }, "soft")
        )
      ),
      busy ? e(ActivityIndicator, { color: purple, size: "small", style: { marginTop: 14 } }) : null,
      notice ? e(Text, { selectable: true, style: { color: ink, marginTop: 14, fontSize: 13, lineHeight: 19 } }, notice) : null,
      hint("Los datos se guardan localmente y por cuenta. Los cosméticos requieren que Discord permita equiparlos. El marco depende de la compatibilidad de tu cliente.")
    );
  }

  return {
    onLoad() { running = true; if (!store.profilePresets || typeof store.profilePresets !== "object") store.profilePresets = {}; if (!store.cosmeticCollections || typeof store.cosmeticCollections !== "object") store.cosmeticCollections = {}; },
    onUnload() { running = false; },
    settings: Settings
  };
})()
