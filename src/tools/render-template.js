// Home Assistant templates, rendered by the server and shared across cards.
//
// One live `render_template` subscription per distinct template and
// variables, whoever renders it. A card that reads a template becomes one of
// its owners, and only the owners of a template are asked to render again
// when its result changes. The last owner leaving does not end the
// subscription at once, the entry lives on for a grace period so a view that
// comes back, a pop-up that reopens or an editor preview rebuilt on the next
// keystroke finds its value already there. Past the grace period the last
// result is still remembered, so a card that asks again is answered at once
// with what it showed last while the fresh subscription is on its way.
//
// Reconnection is not handled here on purpose. home-assistant-js-websocket
// replays every stored subscribeMessage when the socket comes back, with the
// same callback, so an entry survives a reconnect untouched.

import { isTemplate, templateUsage, templateResultToText, escapeHtml } from './jinja.js';

// What a template was read for. An owner whose changed templates are all
// styles gets a style pass rather than a full render.
export const TEMPLATE_TEXT = 1;
export const TEMPLATE_STYLE = 2;
export const TEMPLATE_CONDITION = 4;

const SEP = '';

const entries = new Map();
// Owners to render on the next frame, with the kinds of templates that moved.
const dirtyOwners = new Map();
let flushScheduled = false;

// The last result of entries that went away, by key. A bounded memory, so a
// card reconfigured or reattached after the grace period does not start over
// from nothing.
const remembered = new Map();
const rememberedMax = 200;

// How long an entry outlives its last owner. card-mod uses the same value.
const graceMs = 20000;
// How long an editor preview waits before the server hears about a template.
// The preview element is rebuilt on every keystroke and releases its entries
// before this runs out, so a half typed template never leaves the browser.
const editorDelayMs = 250;
// Wait before trying again after the server refused a subscription.
const retryCooldownMs = 10000;
// One frame's worth of owner renders, the rest waits for the next one.
const flushBudgetMs = 8;

// Only the copy inside the card editor: `editor` is on for every card of a
// dashboard in edit mode.
function isEditorOwner(owner) {
    return !!(owner && owner.inEditorPreview);
}

function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function warnOnce(entry, message) {
    if (entry.warned === message) return;
    entry.warned = message;
    console.warn(`Bubble Card - Template ${message}: ${entry.template.substring(0, 80)}`);
}

// The editor error console listens for this event. It keys on the card being
// edited, so the event carries what identifies it.
function reportToEditor(owner, message, level) {
    if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
    try {
        window.dispatchEvent(new CustomEvent('bubble-card-error', {
            detail: {
                message,
                context: {
                    cardType: owner.config?.card_type,
                    entityId: owner.config?.entity,
                    hash: owner.config?.hash,
                    sourceType: 'template',
                    level,
                },
            },
        }));
    } catch (_) {}
}

function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const run = () => {
        flushScheduled = false;
        const start = now();
        for (const [owner, kinds] of dirtyOwners) {
            dirtyOwners.delete(owner);
            try {
                if (typeof owner.onTemplateResults === 'function') owner.onTemplateResults(kinds);
                else if (typeof owner.updateBubbleCard === 'function') owner.updateBubbleCard();
            } catch (e) {
                console.error('Bubble Card - Error while rendering a template result:', e);
            }
            if (dirtyOwners.size > 0 && now() - start > flushBudgetMs) {
                scheduleFlush();
                return;
            }
        }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
}

function markOwnersDirty(entry) {
    if (entry.owners.size === 0) return;
    for (const [owner, kinds] of entry.owners) {
        dirtyOwners.set(owner, (dirtyOwners.get(owner) || 0) | kinds);
    }
    scheduleFlush();
}

function onMessage(entry, msg) {
    if (entry.dead) return;
    if (msg && 'error' in msg) {
        const level = msg.level === 'WARNING' ? 'WARNING' : 'ERROR';
        if (level === 'ERROR') warnOnce(entry, `error, ${msg.error}`);
        // The last good value stays on screen, what changes is what the editor
        // says about it. Nothing to keep waiting for when the first render
        // already failed.
        if (level === 'ERROR' && !entry.hasResult) {
            entry.hasResult = true;
            entry.result = '';
            markOwnersDirty(entry);
        }
        if (entry.error !== msg.error || entry.errorLevel !== level) {
            entry.error = msg.error;
            entry.errorLevel = level;
            for (const owner of entry.owners.keys()) {
                if (isEditorOwner(owner)) reportToEditor(owner, msg.error, level);
            }
        }
        return;
    }
    const result = msg ? msg.result : undefined;
    const changed = !entry.hasResult || entry.result !== result;
    entry.hasResult = true;
    entry.result = result;
    entry.listeners = msg?.listeners;
    if (entry.error !== undefined) {
        entry.error = undefined;
        entry.errorLevel = undefined;
        for (const owner of entry.owners.keys()) {
            if (isEditorOwner(owner)) reportToEditor(owner, '', undefined);
        }
    }
    if (changed) markOwnersDirty(entry);
}

function subscribe(entry, hass, reportErrors) {
    const connection = hass?.connection;
    if (!connection || entry.dead || entry.unsubscribe || entry.subscribing) return;
    const message = {
        type: 'render_template',
        template: entry.template,
        // Not strict, like Home Assistant's default and like card-mod, so a
        // template written for either renders the same here. Errors are only
        // reported for the card editor, as Home Assistant does for its own
        // markdown card: reporting costs the server a private template
        // environment per subscription, and outside the editor a failed render
        // is dropped by the server, which leaves the last good value on screen.
        strict: false,
        report_errors: reportErrors,
    };
    // The server wants a dictionary or no key at all, never null.
    if (entry.variables) message.variables = entry.variables;
    entry.subscribing = connection.subscribeMessage((msg) => onMessage(entry, msg), message).then((unsub) => {
        entry.subscribing = null;
        entry.failures = 0;
        if (entry.dead) {
            Promise.resolve(unsub()).catch(() => {});
        } else {
            entry.unsubscribe = unsub;
        }
    }).catch((error) => {
        entry.subscribing = null;
        entry.failures = (entry.failures || 0) + 1;
        entry.failedAt = Date.now();
        const message = error?.message || error?.code || String(error);
        warnOnce(entry, `subscription failed, ${message}`);
        for (const owner of entry.owners.keys()) {
            if (isEditorOwner(owner)) reportToEditor(owner, message, 'ERROR');
        }
    });
}

function ensureSubscribed(entry, hass) {
    if (entry.unsubscribe || entry.subscribing || entry.subscribeTimer) return;
    if (entry.failedAt && Date.now() - entry.failedAt < retryCooldownMs * Math.min(entry.failures, 6)) return;
    if (entry.editor) {
        entry.subscribeTimer = setTimeout(() => {
            entry.subscribeTimer = 0;
            subscribe(entry, hass, true);
        }, editorDelayMs);
        return;
    }
    subscribe(entry, hass, false);
}

function remember(entry) {
    if (!entry.hasResult) return;
    remembered.delete(entry.key);
    remembered.set(entry.key, entry.result);
    if (remembered.size > rememberedMax) {
        remembered.delete(remembered.keys().next().value);
    }
}

function destroy(entry) {
    entry.dead = true;
    entries.delete(entry.key);
    remember(entry);
    if (entry.subscribeTimer) {
        clearTimeout(entry.subscribeTimer);
        entry.subscribeTimer = 0;
    }
    if (entry.releaseTimer) {
        clearTimeout(entry.releaseTimer);
        entry.releaseTimer = 0;
    }
    if (entry.unsubscribe) {
        const unsub = entry.unsubscribe;
        entry.unsubscribe = null;
        try {
            Promise.resolve(unsub()).catch(() => {});
        } catch (_) {}
    }
}

function scheduleRelease(entry) {
    if (entry.releaseTimer) return;
    // Never reached the server, nothing worth keeping.
    if (entry.subscribeTimer && !entry.unsubscribe && !entry.subscribing) {
        destroy(entry);
        return;
    }
    entry.releaseTimer = setTimeout(() => {
        entry.releaseTimer = 0;
        if (entry.owners.size === 0) destroy(entry);
    }, graceMs);
}

function detach(entry, owner) {
    if (!entry.owners.delete(owner)) return;
    if (entry.owners.size === 0) scheduleRelease(entry);
}

// `stamp` marks the key as read by the current render. A card taking its
// templates back after a disconnect does not stamp, the cap below must still
// be able to tell what the latest render read.
function attach(entry, owner, hass, kind, stamp = true) {
    if (owner) {
        const held = entry.owners.get(owner) || 0;
        if ((held & kind) !== kind) entry.owners.set(owner, held | kind);
        let keys = owner._templateKeys;
        if (!keys) keys = owner._templateKeys = new Map();
        const known = keys.get(entry.key);
        keys.set(entry.key, {
            gen: stamp || !known ? (owner._templateGen || 0) : known.gen,
            kinds: (known ? known.kinds : 0) | kind,
            template: entry.template,
            variables: entry.variables,
        });
        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer);
            entry.releaseTimer = 0;
        }
    } else if (entry.owners.size === 0) {
        // Nobody to release it, so it stays alive as long as it keeps being read.
        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer);
            entry.releaseTimer = 0;
        }
        scheduleRelease(entry);
    }
    ensureSubscribed(entry, hass);
}

// An editor preview gets an entry of its own, subscribed with errors
// reported, even when the dashboard already renders the same template
// without them. The template being edited is the one whose errors matter.
function lookup(hass, template, variables, key, owner, kind) {
    const editor = isEditorOwner(owner);
    if (editor) key += SEP + 'editor';
    let entry = entries.get(key);
    if (!entry) {
        entry = {
            key,
            editor,
            template,
            variables,
            result: undefined,
            hasResult: false,
            error: undefined,
            errorLevel: undefined,
            listeners: undefined,
            owners: new Map(),
            unsubscribe: null,
            subscribing: null,
            subscribeTimer: 0,
            releaseTimer: 0,
            failures: 0,
            failedAt: 0,
            warned: null,
            dead: false,
        };
        entries.set(key, entry);
    }
    attach(entry, owner, hass, kind);
    if (entry.hasResult) return entry.result;
    return remembered.get(key);
}

// The result of a template for a card, or undefined while the server has not
// answered yet. `entity` is what the template sees as `entity` (and as
// `config.entity`, the card-mod spelling), the card's own entity unless a
// sub-button passes its own. A template that never reads it is shared by
// every card that renders it.
export function getTemplateResult(hass, template, entity, owner, kind = TEMPLATE_TEXT) {
    if (!hass?.connection || !template) return undefined;
    const usage = templateUsage(template);
    const user = usage.user ? (hass.user?.name ?? null) : null;
    const entityValue = usage.entity ? (entity ?? null) : null;
    const key = template + SEP + (usage.entity ? entityValue : '') + SEP + (usage.user ? user : '');
    let variables = null;
    if (usage.entity || usage.user) {
        variables = {};
        if (usage.entity) {
            variables.entity = entityValue;
            variables.config = { entity: entityValue };
        }
        if (usage.user) variables.user = user;
    }
    return lookup(hass, template, variables, key, owner, kind);
}

// The raw result under arbitrary variables, for the condition helpers.
export function getRenderedTemplate(hass, template, variables, owner = null) {
    if (!hass?.connection || !template) return undefined;
    const hasVariables = variables && typeof variables === 'object' && Object.keys(variables).length > 0;
    const key = template + SEP + (hasVariables ? JSON.stringify(variables) : '');
    return lookup(hass, template, hasVariables ? variables : null, key, owner, TEMPLATE_CONDITION);
}

// A config string as the card should display it. Anything that is not a
// template comes back untouched, which is the whole cost for a card that uses
// none. A template comes back rendered, or empty while pending, and the
// context is told a value is still on its way. `html` escapes the value for a
// path that writes innerHTML, since a rendered value is entity data rather
// than something the dashboard author typed.
export function resolveTemplate(context, value, entity = context?.config?.entity, html = false) {
    if (!isTemplate(value)) return value;
    const result = getTemplateResult(context?._hass, value, entity, context, TEMPLATE_TEXT);
    if (result === undefined) {
        if (context) context._templatePending = true;
        return '';
    }
    const text = templateResultToText(result);
    return html ? escapeHtml(text) : text;
}

// Called before a render: every template the render reads is stamped with
// this generation. A card holds its templates until it is reconfigured,
// whether or not a given render read them again: most render paths sit
// behind a memo that skips the read when nothing moved, and a template let
// go of on such a pass would stop telling the card about its results. The
// generation only serves the cap below.
//
// A card that left the DOM let go of its entries, so nothing renders into a
// detached element, and takes them back here on its first render after it
// came back, the memos never having read them again.
export function beginTemplateRender(owner) {
    if (!owner) return;
    owner._templateGen = (owner._templateGen || 0) + 1;
    const keys = owner._templateKeys;
    if (!keys || keys.size === 0 || !owner._hass?.connection) return;
    for (const [key, held] of keys) {
        const entry = entries.get(key);
        if (entry) {
            if (!entry.owners.has(owner)) attach(entry, owner, owner._hass, held.kinds, false);
        } else {
            lookup(owner._hass, held.template, held.variables, key, owner, held.kinds);
        }
    }
}

// A card that keeps reading new template strings, a module building them
// from a state for instance, would hold one subscription per string it ever
// rendered. Past this many, the ones the latest render did not read are let go.
const templateKeysMax = 32;
export function sweepTemplates(owner) {
    const keys = owner?._templateKeys;
    if (!keys || keys.size <= templateKeysMax) return;
    const gen = owner._templateGen || 0;
    for (const [key, held] of keys) {
        if (held.gen === gen) continue;
        keys.delete(key);
        const entry = entries.get(key);
        if (entry) detach(entry, owner);
    }
}

// Drops the owner from every entry it holds. The entries outlive it for the
// grace period, so a card that comes right back finds its values. The owner
// remembers what it held and takes it back on its next render, unless told to
// forget, which a reconfigured card does since its templates may differ.
export function releaseTemplates(owner, forget = false) {
    if (!owner) return;
    dirtyOwners.delete(owner);
    const keys = owner._templateKeys;
    if (!keys || keys.size === 0) return;
    let hadEditorError = false;
    for (const key of keys.keys()) {
        const entry = entries.get(key);
        if (!entry) continue;
        // Read off the entry, not the owner: a preview being torn down no
        // longer sees the editor around it.
        if (entry.editor && entry.error !== undefined) hadEditorError = true;
        detach(entry, owner);
    }
    if (forget) keys.clear();
    // The editor rebuilds its preview on every keystroke: the error of the
    // template that was just replaced must not outlive it in the console. The
    // new preview reports its own, if it has one.
    if (hadEditorError) reportToEditor(owner, '', undefined);
}

// Kept for the editor helpers that render a template outside a card.
export const subscribeRenderTemplate = (conn, onChange, params) =>
    conn.subscribeMessage((msg) => onChange(msg), { type: 'render_template', ...params });

export const subscribePreviewTemplate = (hass, flow_id, flow_type, user_input, callback) =>
    hass.connection.subscribeMessage(callback, { type: 'template/start_preview', flow_id, flow_type, user_input });

// The style pipeline registers how to refresh the styles of one card, so a
// result that only concerns styles costs a style pass and not a render. Kept
// as a registration rather than an import: the pipeline imports this module,
// and the element must not pull the whole pipeline in from its entry point.
let styleRefresher = null;
export function setStyleRefresher(fn) {
    styleRefresher = typeof fn === 'function' ? fn : null;
}

export function refreshTemplateStyles(owner) {
    if (!styleRefresher) return false;
    styleRefresher(owner);
    return true;
}

// Test and diagnostics hooks, not part of the card API.
export function _templateStore() {
    return { entries, remembered, dirtyOwners };
}

export function _resetTemplateStore() {
    for (const entry of Array.from(entries.values())) destroy(entry);
    entries.clear();
    remembered.clear();
    dirtyOwners.clear();
    flushScheduled = false;
}
