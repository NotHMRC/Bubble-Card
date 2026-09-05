import { describe, expect, test } from '@jest/globals';
import {
    normalizeStateContent,
    legacyStateContent,
    defaultStateContent,
    resolveStateContent,
    stateContentHasClock,
    migrateStateContent,
    hasLegacyStateKeys,
} from './state-content.js';

describe('normalizeStateContent', () => {
    test('accepts a string, a list, and the spellings Home Assistant accepts', () => {
        expect(normalizeStateContent('state')).toEqual(['state']);
        expect(normalizeStateContent(['state', 'last-changed', 'last-updated', 'last-triggered'])).toEqual(['state', 'last_changed', 'last_updated', 'last_triggered']);
        expect(normalizeStateContent([' brightness ', '', 42, null])).toEqual(['brightness']);
        expect(normalizeStateContent([])).toEqual([]);
        expect(normalizeStateContent(undefined)).toBeNull();
        expect(normalizeStateContent(null)).toBeNull();
    });
});

describe('legacyStateContent', () => {
    test('a state button showed its state and its attribute by default', () => {
        expect(legacyStateContent({ button_type: 'state', attribute: 'battery_level' }, 'card')).toEqual(['state', 'battery_level']);
        expect(legacyStateContent({ button_type: 'state' }, 'card')).toEqual(['state']);
        // The attribute switch defaulted to on there, so the line was empty, not gone.
        expect(legacyStateContent({ button_type: 'state', show_state: false }, 'card')).toEqual([]);
        expect(legacyStateContent({ button_type: 'state', show_state: false, show_attribute: false }, 'card')).toBeNull();
    });

    test('a switch button showed nothing unless asked', () => {
        expect(legacyStateContent({ button_type: 'switch' }, 'card')).toBeNull();
        expect(legacyStateContent({ button_type: 'switch', show_state: true, show_last_changed: true }, 'card')).toEqual(['state', 'last_changed']);
    });

    test('the card order is state, attribute, last changed, last updated', () => {
        expect(legacyStateContent({ show_state: true, show_attribute: true, attribute: 'humidity', show_last_changed: true, show_last_updated: true }, 'card'))
            .toEqual(['state', 'humidity', 'last_changed', 'last_updated']);
    });

    test('the sub-button order puts the attribute last', () => {
        expect(legacyStateContent({ show_state: true, show_attribute: true, attribute: 'humidity', show_last_changed: true }, 'sub_button'))
            .toEqual(['state', 'last_changed', 'humidity']);
        expect(legacyStateContent({ attribute: 'humidity' }, 'sub_button')).toBeNull();
    });

    test('an attribute switch without an attribute is an empty line, the one a template writes into', () => {
        expect(legacyStateContent({ button_type: 'switch', show_attribute: true }, 'card')).toEqual([]);
    });
});

describe('defaultStateContent', () => {
    test('a state button gets the Home Assistant default of its domain', () => {
        expect(defaultStateContent({ button_type: 'state' }, 'card', 'climate.x')).toEqual(['state', 'current_temperature']);
        expect(defaultStateContent({ button_type: 'state' }, 'card', 'light.x')).toEqual(['brightness']);
        expect(defaultStateContent({ button_type: 'state' }, 'card', 'sensor.x')).toEqual(['state']);
    });

    test('everything else stays quiet by default', () => {
        expect(defaultStateContent({ button_type: 'switch' }, 'card', 'light.x')).toBeNull();
        expect(defaultStateContent({}, 'card', 'climate.x')).toBeNull();
        expect(defaultStateContent({ show_name: true }, 'sub_button', 'climate.x')).toBeNull();
    });
});

describe('resolveStateContent', () => {
    test('state_content wins, then the old keys, then the default', () => {
        expect(resolveStateContent({ button_type: 'state', state_content: 'brightness', show_state: true }, 'card', 'light.x')).toEqual(['brightness']);
        expect(resolveStateContent({ button_type: 'state', show_state: true, show_last_updated: true }, 'card', 'light.x')).toEqual(['state', 'last_updated']);
        expect(resolveStateContent({ button_type: 'state' }, 'card', 'light.x')).toEqual(['brightness']);
        expect(resolveStateContent({ button_type: 'switch' }, 'card', 'light.x')).toBeNull();
    });

    test('an explicit empty list is an empty line', () => {
        expect(resolveStateContent({ button_type: 'state', state_content: [] }, 'card', 'light.x')).toEqual([]);
    });

    test('answers from a memo for the same config and entity, and notices a key edited in place', () => {
        const config = { button_type: 'state' };
        const first = resolveStateContent(config, 'card', 'climate.x');
        expect(resolveStateContent(config, 'card', 'climate.x')).toBe(first);
        expect(resolveStateContent(config, 'card', 'light.x')).toEqual(['brightness']);

        config.show_last_changed = true;
        expect(resolveStateContent(config, 'card', 'light.x')).toEqual(['state', 'last_changed']);
        config.state_content = 'brightness';
        expect(resolveStateContent(config, 'card', 'light.x')).toEqual(['brightness']);
    });
});

describe('stateContentHasClock', () => {
    test('relative times and timer countdowns age on their own', () => {
        expect(stateContentHasClock(['state', 'last_changed'], 'light.x')).toBe(true);
        expect(stateContentHasClock(['last_triggered'], 'automation.x')).toBe(true);
        expect(stateContentHasClock(['next_rising'], 'sun.sun')).toBe(true);
        expect(stateContentHasClock(['start_time'], 'calendar.x')).toBe(true);
        expect(stateContentHasClock(['state'], 'timer.x')).toBe(true);
        expect(stateContentHasClock(['remaining_time'], 'timer.x')).toBe(true);
    });

    test('a plain state or attribute does not', () => {
        expect(stateContentHasClock(['state', 'brightness'], 'light.x')).toBe(false);
        expect(stateContentHasClock(['next_rising'], 'sensor.x')).toBe(false);
        expect(stateContentHasClock([], 'timer.x')).toBe(false);
        expect(stateContentHasClock(null, 'timer.x')).toBe(false);
    });
});

describe('migrateStateContent', () => {
    test('rewrites the old card keys as one list and drops them', () => {
        const config = { card_type: 'button', entity: 'sensor.t', show_state: true, show_attribute: true, attribute: 'battery', show_last_changed: true, show_name: true };
        const next = migrateStateContent(config);
        expect(next).toEqual({ card_type: 'button', entity: 'sensor.t', show_name: true, state_content: ['state', 'battery', 'last_changed'] });
        expect(hasLegacyStateKeys(next)).toBe(false);
        expect(config.show_state).toBe(true);
    });

    test('a single item is written as a string, like Home Assistant does', () => {
        expect(migrateStateContent({ card_type: 'button', show_state: true }).state_content).toBe('state');
    });

    test('a state button told to show nothing keeps showing nothing', () => {
        expect(migrateStateContent({ card_type: 'button', button_type: 'state', entity: 'light.x', show_state: false }).state_content).toEqual([]);
        // A switch button showing nothing is the default, so no key is needed.
        expect(migrateStateContent({ card_type: 'button', button_type: 'switch', entity: 'light.x', show_state: false })).toEqual({ card_type: 'button', button_type: 'switch', entity: 'light.x' });
    });

    test('a state button with only an attribute keeps its state and its attribute', () => {
        expect(migrateStateContent({ card_type: 'button', button_type: 'state', entity: 'vacuum.x', attribute: 'battery_level' }).state_content).toEqual(['state', 'battery_level']);
    });

    test('the template trick, an attribute switch without attribute, becomes an empty list', () => {
        expect(migrateStateContent({ card_type: 'button', button_type: 'switch', show_attribute: true }).state_content).toEqual([]);
    });

    test('sub-buttons are rewritten too, in every schema, keeping show_name', () => {
        const legacy = {
            card_type: 'button',
            entity: 'climate.x',
            sub_button: [
                { entity: 'sensor.h', show_name: true, show_state: true, show_attribute: true, attribute: 'humidity' },
                { icon: 'mdi:a' },
            ],
        };
        const next = migrateStateContent(legacy);
        expect(next.sub_button[0]).toEqual({ entity: 'sensor.h', show_name: true, state_content: ['state', 'humidity'] });
        expect(next.sub_button[1]).toBe(legacy.sub_button[1]);

        const sectioned = {
            card_type: 'button',
            entity: 'climate.x',
            sub_button: {
                main: [{ show_last_changed: true }],
                bottom: [{ group: [{ show_state: true }, { name: 'x' }] }],
            },
        };
        const migrated = migrateStateContent(sectioned);
        expect(migrated.sub_button.main[0]).toEqual({ state_content: 'last_changed' });
        expect(migrated.sub_button.bottom[0].group[0]).toEqual({ state_content: 'state' });
        expect(migrated.sub_button.bottom[0].group[1]).toBe(sectioned.sub_button.bottom[0].group[1]);
    });

    test('a config with nothing to migrate comes back as the same object', () => {
        const config = { card_type: 'button', entity: 'light.x', state_content: 'state', sub_button: [{ name: 'a' }] };
        expect(migrateStateContent(config)).toBe(config);
        const already = { card_type: 'button', state_content: ['state'], show_state: true };
        expect(migrateStateContent(already)).toBe(already);
    });
});
