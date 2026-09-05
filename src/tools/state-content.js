// What the state line of a card or a sub-button is made of, written the way
// Home Assistant writes it on its tile card and its badges: a `state_content`
// list of items, `state`, `last_changed`, an attribute name, a template, in
// the order they show. The list replaces `show_state`, `show_attribute`,
// `attribute`, `show_last_changed` and `show_last_updated`, which keep working
// as they are read here into the same list.
//
// A leaf module on purpose, no imports. The render gate and the pop-up header
// ask it whether a line moves with the clock, and neither can afford to pull
// the formatters in.

// Same table as src/state-display/state-display.ts in the Home Assistant
// frontend, what a line shows when nothing was asked for.
export const DEFAULT_STATE_CONTENT_DOMAINS = {
    climate: ['state', 'current_temperature'],
    cover: ['state', 'current_position'],
    fan: ['percentage'],
    humidifier: ['state', 'current_humidity'],
    light: ['brightness'],
    timer: ['remaining_time'],
    update: ['install_status'],
    valve: ['state', 'current_position'],
};

// Attributes Home Assistant leaves out of the line when they read zero, so an
// off light shows "Off" rather than "0 %".
export const HIDDEN_ZERO_ATTRIBUTES_DOMAINS = {
    valve: ['current_position'],
    cover: ['current_position'],
    fan: ['percentage'],
    light: ['brightness'],
};

// Items that show a moment in time, as a relative time that ages.
export const TIMESTAMP_CONTENTS = ['last_changed', 'last_updated', 'last_triggered'];
export const TIMESTAMP_DOMAIN_CONTENTS = {
    calendar: ['start_time', 'end_time'],
    input_datetime: ['timestamp'],
    sun: ['next_dawn', 'next_dusk', 'next_midnight', 'next_noon', 'next_rising', 'next_setting'],
};

// The spellings Home Assistant accepts in a config next to the internal ones.
const ALIASES = {
    'last-changed': 'last_changed',
    'last-updated': 'last_updated',
    'last-triggered': 'last_triggered',
};

export const LEGACY_STATE_KEYS = ['show_state', 'show_attribute', 'attribute', 'show_last_changed', 'show_last_updated'];

export function domainOf(entityId) {
    if (typeof entityId !== 'string') return '';
    const dot = entityId.indexOf('.');
    return dot > 0 ? entityId.slice(0, dot) : '';
}

// `state_content` as a list, null when the key is absent. A single string is
// one item, like Home Assistant writes it.
export function normalizeStateContent(value) {
    if (value === undefined || value === null) return null;
    const list = Array.isArray(value) ? value : [value];
    const out = [];
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        out.push(ALIASES[trimmed] || trimmed);
    }
    return out;
}

export function hasLegacyStateKeys(config) {
    if (!config) return false;
    for (const key of LEGACY_STATE_KEYS) {
        if (config[key] !== undefined) return true;
    }
    return false;
}

// The list the old keys describe, with the defaults each kind of config had:
// a `button_type: state` button showed its state and its attribute unless told
// otherwise, everything else showed nothing. Null when the old keys show
// nothing at all, an empty list when they show an empty line (the way a
// template gets a `.bubble-state` to write into).
export function legacyStateContent(config, kind = 'card') {
    if (!config) return null;
    const stateButton = kind === 'card' && config.button_type === 'state';
    const showState = config.show_state ?? stateButton;
    const showAttribute = config.show_attribute ?? stateButton;
    const showLastChanged = config.show_last_changed ?? false;
    const showLastUpdated = config.show_last_updated ?? false;
    if (!showState && !showAttribute && !showLastChanged && !showLastUpdated) return null;

    const out = [];
    if (showState) out.push('state');
    const attribute = typeof config.attribute === 'string' ? config.attribute.trim() : '';
    if (kind === 'card') {
        if (showAttribute && attribute) out.push(attribute);
        if (showLastChanged) out.push('last_changed');
        if (showLastUpdated) out.push('last_updated');
    } else {
        if (showLastChanged) out.push('last_changed');
        if (showLastUpdated) out.push('last_updated');
        if (showAttribute && attribute) out.push(attribute);
    }
    return out;
}

// What a line shows when the config says nothing: a `button_type: state`
// button gets what Home Assistant shows for the entity's domain, every other
// card and every sub-button stays quiet, as before.
export function defaultStateContent(config, kind, entityId) {
    if (kind !== 'card' || config?.button_type !== 'state') return null;
    return DEFAULT_STATE_CONTENT_DOMAINS[domainOf(entityId)] || ['state'];
}

// The list a card or a sub-button shows, or null for no line at all. Answered
// once per config object and entity, and again only when one of the keys it
// was read from moved: the editor and the pop-up header edit a config in
// place, so the object alone is not enough to trust.
const resolved = new WeakMap();
function sameInputs(cached, config, kind, entityId) {
    return cached.entityId === entityId
        && cached.kind === kind
        && cached.stateContent === config.state_content
        && cached.buttonType === config.button_type
        && cached.showState === config.show_state
        && cached.showAttribute === config.show_attribute
        && cached.attribute === config.attribute
        && cached.showLastChanged === config.show_last_changed
        && cached.showLastUpdated === config.show_last_updated;
}

export function resolveStateContent(config, kind = 'card', entityId = config?.entity) {
    if (!config || typeof config !== 'object') return null;
    const cached = resolved.get(config);
    if (cached && sameInputs(cached, config, kind, entityId)) return cached.content;

    let content;
    if (config.state_content !== undefined && config.state_content !== null) {
        content = normalizeStateContent(config.state_content);
    } else if (hasLegacyStateKeys(config)) {
        content = legacyStateContent(config, kind);
    } else {
        content = defaultStateContent(config, kind, entityId);
    }
    resolved.set(config, {
        entityId,
        kind,
        content,
        stateContent: config.state_content,
        buttonType: config.button_type,
        showState: config.show_state,
        showAttribute: config.show_attribute,
        attribute: config.attribute,
        showLastChanged: config.show_last_changed,
        showLastUpdated: config.show_last_updated,
    });
    return content;
}

// Whether the line ages on its own, without any state change: a relative time,
// or the countdown of a running timer.
export function stateContentHasClock(content, entityId) {
    if (!content || content.length === 0) return false;
    const domain = domainOf(entityId);
    const domainTimestamps = TIMESTAMP_DOMAIN_CONTENTS[domain];
    for (const item of content) {
        if (TIMESTAMP_CONTENTS.includes(item)) return true;
        if (domainTimestamps && domainTimestamps.includes(item)) return true;
        if (domain === 'timer' && (item === 'state' || item === 'remaining_time')) return true;
    }
    return false;
}

function contentToConfigValue(content) {
    return content.length === 1 ? content[0] : content;
}

function migrateOne(config, kind, entityId) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    if (config.state_content !== undefined || !hasLegacyStateKeys(config)) return config;
    const content = legacyStateContent(config, kind);
    const next = {};
    for (const key in config) {
        if (LEGACY_STATE_KEYS.includes(key)) continue;
        next[key] = config[key];
    }
    // The old keys showed nothing: written down only where the defaults would
    // now show something, so the line stays as quiet as it was.
    if (content) {
        next.state_content = contentToConfigValue(content);
    } else if (defaultStateContent(config, kind, entityId)) {
        next.state_content = [];
    }
    return next;
}

function migrateList(list, cardEntity) {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const out = list.map((item) => {
        if (!item || typeof item !== 'object') return item;
        let next = migrateOne(item, 'sub_button', item.entity ?? cardEntity);
        if (Array.isArray(item.group)) {
            const group = migrateList(item.group, cardEntity);
            if (group !== item.group) next = next === item ? { ...item, group } : { ...next, group };
        }
        if (next !== item) changed = true;
        return next;
    });
    return changed ? out : list;
}

// A config with its old state keys, and the ones of its sub-buttons, rewritten
// as `state_content`. The same object comes back when there is nothing to do,
// so the caller can tell.
export function migrateStateContent(config) {
    if (!config || typeof config !== 'object') return config;
    let next = migrateOne(config, 'card', config.entity);
    const subButtons = config.sub_button;
    let migratedSubButtons = subButtons;
    if (Array.isArray(subButtons)) {
        migratedSubButtons = migrateList(subButtons, config.entity);
    } else if (subButtons && typeof subButtons === 'object') {
        const main = migrateList(subButtons.main, config.entity);
        const bottom = migrateList(subButtons.bottom, config.entity);
        if (main !== subButtons.main || bottom !== subButtons.bottom) {
            migratedSubButtons = { ...subButtons };
            if (main !== subButtons.main) migratedSubButtons.main = main;
            if (bottom !== subButtons.bottom) migratedSubButtons.bottom = bottom;
        }
    }
    if (migratedSubButtons !== subButtons) {
        next = next === config ? { ...config } : next;
        next.sub_button = migratedSubButtons;
    }
    return next;
}
