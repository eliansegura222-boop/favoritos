(() => {
  "use strict";
  // Nitro Gift Watcher 1.2.0 — Vendetta/Revenge classic runtime.
  // Single-file executable plugin: no imports, bundler, token collection or external hosts.
  const api = vendetta;
  const metro = api.metro;
  const ui = api.ui;
  const storage = api.plugin.storage;
  const log = api.logger || console;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const Forms = ui.components.Forms;
  const MAX_HISTORY = 30;
  const MAX_SEEN = 500;
  const GIFT_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gift\/|discord(?:app)?\.com\/gifts\/)([a-z0-9]{8,64})(?![a-z0-9_-])/gi;
  const DEFAULTS = {
    enabled: true,
    autoRedeem: false,
    notifyDetected: true,
    notifyResult: true,
    lastStatus: "Esperando enlaces de regalo...",
    lastTime: "",
    history: []
  };

  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (storage[key] === undefined || storage[key] === null) storage[key] = value;
  }

  let running = false;
  let dispatcher = null;
  let http = null;
  const seen = new Set();
  const seenOrder = [];
  const pending = new Set();
  let counter = 0;

  function lookup(...props) {
    try { return metro.findByProps(...props); } catch { return null; }
  }

  function findHttp() {
    const wrapped = lookup("HTTP");
    const choices = [wrapped && wrapped.HTTP, wrapped && wrapped.default && wrapped.default.HTTP,
      lookup("get", "post", "put", "patch"), lookup("get", "post", "put"),
      wrapped && wrapped.default];
    return choices.find(obj => obj && typeof obj.get === "function" && typeof obj.post === "function") || null;
  }

  function getDispatcher() {
    const candidates = [lookup("dispatch", "subscribe", "unsubscribe"),
      lookup("dispatch", "subscribe"), lookup("subscribe", "unsubscribe")];
    return candidates.find(obj => obj && typeof obj.subscribe === "function" && typeof obj.unsubscribe === "function") || null;
  }

  function truncate(value, alternative, limit = 70) {
    const text = typeof value === "string" ? value.trim() : "";
    return (text || alternative).slice(0, limit);
  }

  function messageLocation(message, event) {
    const channelId = String(message.channel_id || message.channelId || event.channelId || event.channel_id || "");
    let channel = null;
    let guild = null;
    try { channel = metro.findByStoreName("ChannelStore")?.getChannel(channelId); } catch {}
    const guildId = String(message.guild_id || message.guildId || event.guildId || channel?.guild_id || "");
    try { if (guildId) guild = metro.findByStoreName("GuildStore")?.getGuild(guildId); } catch {}
    return {
      server: guildId ? truncate(guild?.name, "Servidor desconocido") : "Mensajes privados",
      channel: truncate(channel?.name, guildId ? "Canal desconocido" : "Mensaje privado")
    };
  }

  function getCodes(message) {
    if (!message || typeof message !== "object") return [];
    const parts = [message.content];
    if (Array.isArray(message.embeds)) {
      for (const embed of message.embeds) {
        parts.push(embed?.url, embed?.title, embed?.description);
      }
    }
    const found = new Set();
    for (const part of parts) {
      if (typeof part !== "string") continue;
      GIFT_RE.lastIndex = 0;
      let match;
      while ((match = GIFT_RE.exec(part)) !== null) found.add(match[1]);
    }
    return [...found];
  }

  function notify(text, kind) {
    if (kind === "detected" && storage.notifyDetected === false) return;
    if (kind !== "detected" && storage.notifyResult === false) return;
    try {
      const icon = ui.assets?.getAssetIDByName?.("ic_gift_24px");
      ui.toasts?.showToast?.(text.slice(0, 250), icon);
    } catch (error) {
      log.warn?.("Nitro Gift Watcher: error al mostrar aviso", error);
    }
  }

  function updateRecord(record, state, detail, show = true, kind = "result") {
    if (!running) return;
    const previous = Array.isArray(storage.history) ? storage.history : [];
    const next = { ...record, state, detail, time: new Date().toLocaleString() };
    storage.history = [next, ...previous.filter(item => item.id !== next.id)].slice(0, MAX_HISTORY);
    storage.lastStatus = `${state}: ${detail}`;
    storage.lastTime = next.time;
    log.log?.(`[Nitro Gift Watcher] ${state} | ${next.server} / #${next.channel} | ${detail}`);
    if (show) notify(`Nitro: ${state} | ${next.server} / #${next.channel} | ${detail}`, kind);
  }

  function remember(code) {
    if (seen.has(code)) return false;
    seen.add(code);
    seenOrder.push(code);
    if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift());
    return true;
  }

  function parseError(error) {
    const body = error?.body ?? error?.response?.body ?? error?.response?.data ?? error?.data ?? {};
    const status = Number(error?.status ?? error?.response?.status ?? body?.status) || 0;
    const code = Number(body?.code ?? error?.code) || 0;
    const reason = String(body?.message ?? error?.message ?? "").toLowerCase();
    if (status === 429) return ["Limitado", "Discord aplicó un límite de solicitudes (429)."];
    if (/already.{0,20}(claimed|redeemed|used)|already redeemed|gift.{0,12}claimed/.test(reason))
      return ["Ya canjeado", "Este regalo ya fue utilizado."];
    if (code === 10038 || /unknown gift|invalid gift|expired|caducado|inválido/.test(reason))
      return ["Inválido/caducado", "Código inválido, caducado o desconocido."];
    if (/payment method|payment source|payment required|credit card|billing/.test(reason))
      return ["Requiere tarjeta", "Discord solicita un método de pago; no se canjeó."];
    if (code === 50054 || /not eligible|ineligible|already have nitro/.test(reason))
      return ["No elegible", "Tu cuenta no cumple los requisitos de este regalo."];
    if (status === 401 || status === 403)
      return ["No autorizado", `Discord rechazó la operación (HTTP ${status}).`];
    return ["Error", status ? `Discord respondió con HTTP ${status}.` : "No se pudo comprobar el enlace."];
  }

  async function processCode(code, record) {
    if (!running || pending.has(code)) return;
    pending.add(code);
    try {
      if (!http) {
        updateRecord(record, "Sin verificar", "No se encontró el módulo HTTP del cliente.");
        return;
      }
      let response;
      try {
        response = await http.get({
          url: `/entitlements/gift-codes/${encodeURIComponent(code)}?with_application=false&with_subscription_plan=true`
        });
      } catch (error) {
        if (running) {
          const [status, description] = parseError(error);
          updateRecord(record, status, description);
        }
        return;
      }
      if (!running) return;
      if (response?.status >= 400) {
        const [status, description] = parseError(response);
        updateRecord(record, status, description);
        return;
      }
      const data = response?.body ?? response;
      if (!data || typeof data !== "object") {
        updateRecord(record, "Sin verificar", "Discord no devolvió información del regalo.");
        return;
      }
      if (data.redeemed === true || (Number.isFinite(data.max_uses) && data.max_uses > 0 && data.uses >= data.max_uses)) {
        updateRecord(record, "Ya canjeado", "Discord indica que este regalo ya se utilizó.");
        return;
      }
      if (typeof data.code !== "string") {
        updateRecord(record, "Sin verificar", "La respuesta no confirma un regalo válido.");
        return;
      }
      const planName = data.subscription_plan?.name ?? data.sku?.name ?? "";
      if (planName && !/nitro/i.test(planName)) {
        updateRecord(record, "Otro regalo", "No parece ser una suscripción Nitro. No se canjeó.");
        return;
      }
      if (storage.autoRedeem !== true) {
        updateRecord(record, "Reconocido", "Regalo detectado; autocanje desactivado.");
        return;
      }
      let result;
      try {
        result = await http.post({
          url: `/entitlements/gift-codes/${encodeURIComponent(code)}/redeem`,
          body: {}
        });
      } catch (error) {
        if (running) {
          const [status, description] = parseError(error);
          updateRecord(record, status, description);
        }
        return;
      }
      if (!running) return;
      if (result?.status >= 400) {
        const [status, description] = parseError(result);
        updateRecord(record, status, description);
      } else if ((Number(result?.status) >= 200 && Number(result?.status) < 300) ||
        result?.body?.entitlement || result?.body?.entitlement_id) {
        updateRecord(record, "Canje aceptado", "Discord aceptó la solicitud. Confirma Nitro en tu cuenta.");
      } else {
        updateRecord(record, "Sin confirmar", "El servidor respondió, pero no se confirmó el canje.");
      }
    } catch (error) {
      if (running) {
        log.error?.("Nitro Gift Watcher: error procesando mensaje", error);
        updateRecord(record, "Error", "Fallo inesperado al procesar el enlace.");
      }
    } finally {
      pending.delete(code);
    }
  }

  function onMessage(event) {
    if (!running || storage.enabled === false) return;
    const message = event?.message ?? event;
    const codes = getCodes(message);
    if (!codes.length) return;
    const source = messageLocation(message, event || {});
    for (const code of codes) {
      if (!remember(code)) continue;
      const record = {
        id: `${Date.now()}-${++counter}`,
        codeHint: `••••${code.slice(-4)}`,
        server: source.server,
        channel: source.channel
      };
      updateRecord(record, "Detectado", "Enlace encontrado; verificando...", true, "detected");
      void processCode(code, record);
    }
  }

  function Settings() {
    const [, refresh] = React.useState(0);
    const set = (key, value) => { storage[key] = value; refresh(x => x + 1); };
    const h = React.createElement;
    const { FormSection, FormRow, FormSwitchRow, FormDivider } = Forms;
    const history = Array.isArray(storage.history) ? storage.history.slice(0, MAX_HISTORY) : [];
    const switchRow = (label, subLabel, key) => h(FormSwitchRow, {
      key, label, subLabel, value: storage[key] === true,
      onValueChange: value => set(key, value)
    });
    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 30 } },
      h(FormSection, { title: "Nitro Gift Watcher" },
        switchRow("Detectar enlaces de Nitro", "Mensajes nuevos y editados visibles para el cliente.", "enabled"),
        h(FormDivider),
        switchRow("Notificar detección", "Muestra el servidor y el canal.", "notifyDetected"),
        h(FormDivider),
        switchRow("Notificar resultados", "Avisa si está usado, caducado o canjeado.", "notifyResult"),
        h(FormDivider),
        switchRow("Autocanjear", "Desactivado por defecto. Usa funciones no oficiales de Discord.", "autoRedeem"),
        h(FormDivider),
        h(FormRow, { label: "Último estado", subLabel: `${storage.lastStatus || "Sin actividad"}\n${storage.lastTime || ""}` })
      ),
      h(FormSection, { title: `Historial de regalos (${history.length}/${MAX_HISTORY})` },
        ...(history.length ? history.flatMap((item, index) => [
          ...(index ? [h(FormDivider, { key: `d${index}` })] : []),
          h(FormRow, {
            key: item.id,
            label: `${item.state || "Detectado"} • ${item.codeHint || "código"}`,
            subLabel: `${item.server || "Servidor"} / #${item.channel || "canal"}\n${item.detail || ""}\n${item.time || ""}`
          })
        ]) : [h(FormRow, { key: "empty", label: "Todavía no hay enlaces detectados." })])
      )
    );
  }

  return {
    onLoad() {
      if (running) return;
      running = true;
      dispatcher = getDispatcher();
      http = findHttp();
      if (!dispatcher) {
        storage.lastStatus = "No se encontró el despachador de eventos de Discord.";
        notify("Nitro: no se pueden escuchar mensajes en esta versión.", "result");
        log.error?.("Nitro Gift Watcher: dispatcher no disponible");
        running = false;
        return;
      }
      try {
        dispatcher.subscribe("MESSAGE_CREATE", onMessage);
        dispatcher.subscribe("MESSAGE_UPDATE", onMessage);
        log.log?.("Nitro Gift Watcher 1.2.0 activo (formato Revenge/Vendetta clásico)");
      } catch (error) {
        log.error?.("Nitro Gift Watcher: fallo al iniciar", error);
        try { dispatcher.unsubscribe("MESSAGE_CREATE", onMessage); } catch {}
        try { dispatcher.unsubscribe("MESSAGE_UPDATE", onMessage); } catch {}
        running = false;
      }
    },
    onUnload() {
      running = false;
      try { dispatcher?.unsubscribe("MESSAGE_CREATE", onMessage); } catch {}
      try { dispatcher?.unsubscribe("MESSAGE_UPDATE", onMessage); } catch {}
      dispatcher = null;
      http = null;
      pending.clear();
      seen.clear();
      seenOrder.length = 0;
    },
    settings: React.createElement(Settings)
  };
})()
