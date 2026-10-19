/**
 * Nitro Gift Watcher — Revenge (Android), v1.1.0
 * Detecta regalos nuevos recibidos por el cliente, avisa y guarda resultados.
 * No necesita tokens ni envia datos a servidores de terceros.
 * El autocanje usa una API interna/no documentada de Discord: puede dejar de funcionar
 * o provocar sanciones. Esta DESACTIVADO por defecto.
 */
const GIFT_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gift\/|discord(?:app)?\.com\/gifts\/)([A-Za-z0-9]{8,64})(?![A-Za-z0-9_-])/gi;
const MAX_SEEN = 500;
const MAX_HISTORY = 30;

function extractGiftCodes(message) {
  if (!message || typeof message !== "object") return [];
  const parts = [message.content];
  if (Array.isArray(message.embeds)) {
    for (const embed of message.embeds) {
      if (embed && typeof embed === "object") {
        parts.push(embed.url, embed.description, embed.title);
      }
    }
  }
  const codes = new Set();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    GIFT_PATTERN.lastIndex = 0;
    let match;
    while ((match = GIFT_PATTERN.exec(part)) !== null) codes.add(match[1]);
  }
  return [...codes];
}

function findAuthenticatedHttp(unscoped) {
  try {
    const { lookupModule } = unscoped.modules.finders;
    const { withProps } = unscoped.modules.finders.filters;
    const [wrapper] = lookupModule(withProps("HTTP"));
    const [direct] = lookupModule(withProps("get", "post", "put", "patch"));
    return [wrapper?.HTTP, wrapper?.default?.HTTP, direct, direct?.default]
      .find(x => typeof x?.get === "function" && typeof x?.post === "function") || null;
  } catch { return null; }
}

function safeText(value, fallback, limit = 60) {
  const result = typeof value === "string" ? value.trim() : "";
  return (result || fallback).slice(0, limit);
}

function giftError(error) {
  const data = error?.body ?? error?.response?.body ?? error?.response?.data ?? error?.data ?? {};
  const code = Number(data?.code ?? error?.code);
  const status = Number(error?.status ?? error?.response?.status ?? data?.status);
  const message = String(data?.message ?? error?.message ?? "").toLowerCase();

  if (code === 50070) return ["requires-payment", "Requiere metodo de pago; no se pudo canjear."];
  if (code === 50054) return ["ineligible", "No puedes canjear un regalo enviado por ti."];
  if (code === 10038 || /unknown gift|invalid gift|expired|no existe|invalido|inválido/.test(message)) {
    return ["invalid", "Codigo invalido, caducado o no reconocido."];
  }
  if (/already (?:been )?(?:claimed|redeemed|used)|already redeemed|already claimed|gift has been claimed/.test(message)) {
    return ["used", "El regalo ya fue canjeado."];
  }
  if (/eligible|eligib|already have nitro|already had nitro/.test(message)) {
    return ["ineligible", "Tu cuenta no cumple los requisitos de este regalo."];
  }
  if (status === 429) return ["rate-limited", "Limite de solicitudes de Discord (429)."];
  if (status === 401 || status === 403) return ["error", `Discord no autorizo la consulta (HTTP ${status}).`];
  return ["error", status ? `Discord devolvio HTTP ${status}; no se confirmo el canje.` : "No se pudo verificar o canjear el enlace."];
}

function readSource(unscoped, event) {
  const message = event?.message || {};
  const channelId = String(message.channel_id ?? message.channelId ?? event?.channelId ?? event?.channel_id ?? "");
  let channel = null;
  let guild = null;
  try { channel = unscoped.discord.flux.Stores?.ChannelStore?.getChannel?.(channelId); } catch {}
  const guildId = String(message.guild_id ?? message.guildId ?? event?.guildId ?? channel?.guild_id ?? channel?.guildId ?? "");
  try { if (guildId) guild = unscoped.discord.flux.Stores?.GuildStore?.getGuild?.(guildId); } catch {}
  return {
    server: guildId ? safeText(guild?.name, "Servidor desconocido") : "Mensajes privados",
    channel: safeText(channel?.name, guildId ? "canal desconocido" : "mensaje privado")
  };
}

export default plugin({
  jsonStorage: {
    load: true,
    default: {
      enabled: true,
      autoRedeem: false,
      notifyDetected: true,
      notifyResult: true,
      lastStatus: "Esperando regalos de Nitro...",
      lastTime: "",
      history: []
    }
  },

  start({ unscoped, jsonStorage, cleanup, logger }) {
    let active = true;
    let serial = 0;
    const seen = new Set();
    const seenOrder = [];
    const pending = new Set();
    const onFluxEventDispatched = unscoped?.discord?.flux?.onFluxEventDispatched;
    const toast = unscoped?.discord?.actions?.ToastActionCreators;
    const http = findAuthenticatedHttp(unscoped);
    let GiftIcon = () => null;
    try {
      GiftIcon = unscoped.utils?.discord?.lookupGeneratedIconComponent?.(
        "GiftIcon", "GiftIcon-primary", "GiftIcon-secondary"
      ) || GiftIcon;
    } catch {}

    function getSettings() { return jsonStorage.cache || {}; }

    function showToast(message, isResult) {
      const settings = getSettings();
      if (isResult ? settings.notifyResult === false : settings.notifyDetected === false) return;
      try {
        toast?.open?.({
          key: `nitro-watch-${Date.now()}-${++serial}`,
          content: message.slice(0, 220),
          IconComponent: GiftIcon
        });
      } catch (error) {
        logger.warn("No se pudo mostrar una notificacion interna de Discord.");
      }
    }

    function persistRecord(record, notify = false, isResult = true) {
      if (!active) return;
      const settings = getSettings();
      const history = Array.isArray(settings.history) ? settings.history : [];
      const previous = history.find(item => item.id === record.id);
      const entry = { ...previous, ...record, time: new Date().toLocaleString() };
      const next = [entry, ...history.filter(item => item.id !== record.id)].slice(0, MAX_HISTORY);
      const lastStatus = `${entry.state}: ${entry.detail}`;
      jsonStorage.set({ ...settings, history: next, lastStatus, lastTime: entry.time });
      logger.log(`${lastStatus} (${entry.server} / #${entry.channel}, ${entry.codeHint})`);
      if (notify) showToast(`Nitro • ${entry.state}\n${entry.server} / #${entry.channel}\n${entry.detail}`, isResult);
    }

    function mark(record, state, detail, notify = true) {
      persistRecord({ ...record, state, detail }, notify, true);
    }

    function remember(code) {
      if (seen.has(code)) return false;
      seen.add(code);
      seenOrder.push(code);
      if (seenOrder.length > MAX_SEEN) seen.delete(seenOrder.shift());
      return true;
    }

    async function inspectGift(code, record) {
      if (!active || pending.has(code)) return;
      pending.add(code);
      try {
        if (!http) {
          mark(record, "Sin verificar", "No se encontro el modulo HTTP de Discord.");
          return;
        }
        let response;
        try {
          response = await http.get({
            url: `/entitlements/gift-codes/${encodeURIComponent(code)}?with_application=false&with_subscription_plan=true`
          });
        } catch (error) {
          if (active) {
            const [state, detail] = giftError(error);
            mark(record, state === "used" ? "Ya canjeado" : state === "invalid" ? "Invalido/caducado" : "Error al verificar", detail);
          }
          return;
        }
        if (!active) return;
        if (typeof response?.status === "number" && response.status >= 400) {
          const [state, detail] = giftError({ status: response.status, body: response.body });
          mark(record, state === "used" ? "Ya canjeado" : state === "invalid" ? "Invalido/caducado" : "Error al verificar", detail);
          return;
        }
        const info = response?.body ?? response;
        if (!info || typeof info !== "object" || typeof info.code !== "string") {
          mark(record, "Sin verificar", "Discord no devolvio datos de un regalo valido.");
          return;
        }
        if (typeof info.uses === "number" && typeof info.max_uses === "number" && info.uses >= info.max_uses) {
          mark(record, "Ya canjeado", "El regalo alcanzo su limite de usos.");
          return;
        }
        const name = info.subscription_plan?.name ?? info.sku?.name ?? "";
        if (name && !/nitro/i.test(name)) {
          mark(record, "Otro producto", "Este regalo no parece ser de Nitro; no se canjeo.");
          return;
        }
        if (!getSettings().autoRedeem) {
          mark(record, "Disponible", "Regalo reconocido. Autocanje desactivado.");
          return;
        }

        // Endpoint privado del cliente de Discord, sujeto a cambios y restricciones.
        let result;
        try {
          result = await http.post({
            url: `/entitlements/gift-codes/${encodeURIComponent(code)}/redeem`,
            body: {}
          });
        } catch (error) {
          if (active) {
            const [state, detail] = giftError(error);
            const stateName = {
              "used": "Ya canjeado", "invalid": "Invalido/caducado",
              "requires-payment": "Requiere tarjeta", "ineligible": "No elegible",
              "rate-limited": "Limite de Discord"
            }[state] || "Canje fallido";
            mark(record, stateName, detail);
          }
          return;
        }
        if (!active) return;
        if (typeof result?.status === "number" && result.status >= 400) {
          const [state, detail] = giftError({ status: result.status, body: result.body });
          const stateName = {
            "used": "Ya canjeado", "invalid": "Invalido/caducado",
            "requires-payment": "Requiere tarjeta", "ineligible": "No elegible",
            "rate-limited": "Limite de Discord"
          }[state] || "Canje fallido";
          mark(record, stateName, detail);
          return;
        }
        if ((typeof result?.status === "number" && result.status >= 200 && result.status < 300) ||
            result?.body?.entitlement || result?.body?.entitlement_id || result?.body?.id) {
          mark(record, "Canje aceptado", "Discord acepto la solicitud. Comprueba Nitro en tu cuenta.");
        } else {
          mark(record, "Canje sin confirmar", "Discord respondio, pero no se pudo confirmar el resultado.");
        }
      } catch (error) {
        if (active) {
          logger.error("Fallo procesando regalo:", error);
          mark(record, "Error", "Fallo inesperado; consulta los registros de Revenge.");
        }
      } finally { pending.delete(code); }
    }

    function onMessage(event) {
      if (!active || getSettings().enabled === false) return event;
      const codes = extractGiftCodes(event?.message);
      if (!codes.length) return event;
      const source = readSource(unscoped, event);
      for (const code of codes) {
        if (!remember(code)) continue;
        const record = {
          id: `${Date.now()}-${++serial}`,
          codeHint: `••••${code.slice(-4)}`,
          server: source.server,
          channel: source.channel,
          state: "Detectado",
          detail: "Se encontro un enlace; comprobando su estado..."
        };
        persistRecord(record, true, false);
        void inspectGift(code, record);
      }
      return event;
    }

    if (typeof onFluxEventDispatched !== "function") {
      logger.error("Esta version de Revenge no expone los eventos de mensajes.");
      return;
    }
    cleanup(
      onFluxEventDispatched("MESSAGE_CREATE", onMessage),
      onFluxEventDispatched("MESSAGE_UPDATE", onMessage),
      () => { active = false; pending.clear(); seen.clear(); }
    );
    logger.log("Nitro Gift Watcher v1.1.0 iniciado. Los avisos estan activados; autocanje apagado.");
  },

  SettingsComponent({ api }) {
    const React = api.unscoped.react.React;
    const { Design } = api.unscoped.discord.design;
    const h = React.createElement;
    const settings = api.jsonStorage.use() || {};
    const history = Array.isArray(settings.history) ? settings.history : [];
    const change = (key, value) => api.jsonStorage.set({ ...api.jsonStorage.cache, [key]: value });

    return h(React.Fragment, null,
      h(Design.TableRowGroup, { title: "Nitro Gift Watcher" },
        h(Design.TableSwitchRow, {
          label: "Detectar enlaces de Nitro",
          subLabel: "Mensajes nuevos o editados que recibe Discord en canales accesibles.",
          value: settings.enabled !== false,
          onValueChange: value => change("enabled", value)
        }),
        h(Design.TableSwitchRow, {
          label: "Notificar al detectar",
          subLabel: "Muestra un aviso con el servidor y canal donde aparecio el enlace.",
          value: settings.notifyDetected !== false,
          onValueChange: value => change("notifyDetected", value)
        }),
        h(Design.TableSwitchRow, {
          label: "Notificar resultados",
          subLabel: "Avisa si fue canjeado, usado, invalido o hubo un error.",
          value: settings.notifyResult !== false,
          onValueChange: value => change("notifyResult", value)
        }),
        h(Design.TableSwitchRow, {
          label: "Autocanjear (riesgo de sancion)",
          subLabel: "Desactivado por defecto. Usa funciones internas no oficiales de Discord.",
          value: settings.autoRedeem === true,
          onValueChange: value => change("autoRedeem", value)
        }),
        h(Design.TableRow, {
          label: "Ultimo resultado",
          subLabel: `${settings.lastStatus || "Sin actividad"}${settings.lastTime ? ` • ${settings.lastTime}` : ""}`
        })
      ),
      h(Design.TableRowGroup, { title: `Historial de regalos (${history.length}/${MAX_HISTORY})` },
        ...(history.length ? history.slice(0, 20).map(entry => h(Design.TableRow, {
          key: entry.id,
          label: `${entry.state || "Detectado"} • ${entry.codeHint || "codigo"}`,
          subLabel: `${entry.server || "Servidor"} / #${entry.channel || "canal"}\n${entry.detail || ""}\n${entry.time || ""}`
        })) : [h(Design.TableRow, { key: "empty", label: "Todavia no se detectaron regalos." })])
      )
    );
  }
});
