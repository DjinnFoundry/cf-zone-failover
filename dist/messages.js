/** The details block shared by every alert; only the labels are translated. */
const detailsWith = (labels) => ({ reason, zoneIps, reserveIps, mode, runbook }) => `${reason}.\n\n${labels.zoneIps}: ${zoneIps.join(', ')}\n${labels.reserveIps}: ${reserveIps.join(', ')}\n${labels.mode}: ${mode}` +
    (runbook ? `\nRunbook: ${runbook}` : '');
const en = (c) => ({
    reason: {
        staleLists: `${c.blocklistName} lists are stale or unreadable`,
        bothBlocked: (zoneBy, reserveBy) => `zone blocked (${zoneBy}) and reserve too (${reserveBy})`,
        alreadyActive: (by) => `zone blocked (${by}), reserve already active`,
        reserveDown: (by) => `zone blocked (${by}) but the reserve does not answer`,
        blocked: (by) => `zone blocked by ${by}`,
        noBlock: 'no block',
        reserveBlocked: (by) => `zone free and reserve blocked (${by})`,
        freeFor: (m) => `zone free for ${m} min`,
        waiting: (m, needed) => `zone free for ${m} min, waiting for ${needed}`,
    },
    alert: {
        'stale-lists': `The ${c.blocklistName} lists are stale or unreadable: the guard decides nothing until they are back.`,
        'both-blocked': `The primary zone and the reserve (${c.fallbackHost}) are blocked at the same time: the reserve is no use. Find another way out by hand.`,
        'reserve-unhealthy': `${c.publicHost} is blocked, but ${c.healthUrl} does not answer 200: a broken reserve is not activated. Check the reserve Worker and the custom hostnames.`,
    },
    subject: {
        observe: '[observe] ',
        problem: 'problem',
        activated: 'reserve ACTIVATED',
        deactivated: 'reserve deactivated',
        maintenance: 'reserve maintenance',
        failing: 'failing',
    },
    body: {
        activated: `${c.publicHost} is now served from ${c.fallbackHost}.\n\nDo not deploy the main Worker until the guard reports the way back: the deploy would fail recreating its Custom Domains.`,
        deactivated: `${c.publicHost} is back on its Worker.\n\nIf someone deployed ${c.worker} while the reserve was active, that deploy failed: run it again.`,
        failing: (error) => `Three runs in a row failed. The last one:\n\n${error}`,
        details: detailsWith({ zoneIps: 'Watched zone IPs', reserveIps: 'Watched reserve IPs', mode: 'Mode' }),
    },
    change: {
        recreated: (h) => `custom hostname ${h} recreated`,
        reactivated: (h) => `custom hostname ${h} reactivated from moved`,
        txtAdded: (n) => `TXT ${n} added`,
        txtRemoved: (n) => `stale TXT ${n} removed`,
    },
});
const es = (c) => ({
    reason: {
        staleLists: `listas de ${c.blocklistName} viejas o ilegibles`,
        bothBlocked: (zoneBy, reserveBy) => `zona bloqueada (${zoneBy}) y reserva también (${reserveBy})`,
        alreadyActive: (by) => `zona bloqueada (${by}), reserva ya activa`,
        reserveDown: (by) => `zona bloqueada (${by}) pero la reserva no responde`,
        blocked: (by) => `zona bloqueada por ${by}`,
        noBlock: 'sin bloqueo',
        reserveBlocked: (by) => `zona libre y reserva bloqueada (${by})`,
        freeFor: (m) => `zona libre desde hace ${m} min`,
        waiting: (m, needed) => `zona libre desde hace ${m} min, se espera a ${needed}`,
    },
    alert: {
        'stale-lists': `Las listas de ${c.blocklistName} están viejas o no se pueden leer: el vigía no decide nada hasta que vuelvan.`,
        'both-blocked': `Están bloqueadas a la vez las IPs de la zona principal y las de la reserva (${c.fallbackHost}): la reserva no sirve. Hay que buscar otra salida a mano.`,
        'reserve-unhealthy': `${c.publicHost} está bloqueado, pero ${c.healthUrl} no responde 200: no se activa una reserva rota. Revisa el Worker de reserva y los custom hostnames.`,
    },
    subject: {
        observe: '[observación] ',
        problem: 'problema',
        activated: 'reserva ACTIVADA',
        deactivated: 'reserva desactivada',
        maintenance: 'mantenimiento de la reserva',
        failing: 'falla',
    },
    body: {
        activated: `${c.publicHost} sirve ahora desde ${c.fallbackHost}.\n\nNo despliegues el Worker principal hasta que el vigía avise de la vuelta: el deploy fallaría al recrear los Custom Domains.`,
        deactivated: `${c.publicHost} vuelve a su Worker.\n\nSi alguien desplegó ${c.worker} con la reserva activa, ese deploy falló: relánzalo.`,
        failing: (error) => `Tres pasadas seguidas con error. La última:\n\n${error}`,
        details: detailsWith({ zoneIps: 'IPs de la zona vigiladas', reserveIps: 'IPs de la reserva vigiladas', mode: 'Modo' }),
    },
    change: {
        recreated: (h) => `custom hostname ${h} recreado`,
        reactivated: (h) => `custom hostname ${h} reactivado desde moved`,
        txtAdded: (n) => `TXT ${n} añadido`,
        txtRemoved: (n) => `TXT ${n} viejo borrado`,
    },
});
export const LOCALES = { en, es };
