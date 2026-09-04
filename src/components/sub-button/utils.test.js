import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../tools/utils.js', () => ({
    getAttribute: jest.fn(),
    isStateOn: jest.fn(),
    isStateRequiringAttention: jest.fn(),
    formatDateTime: jest.fn(),
    createElement: jest.fn(),
    getStateSurfaceColor: jest.fn(),
    getState: jest.fn(),
    isTimerEntity: jest.fn(),
    timerTimeRemaining: jest.fn(),
    computeDisplayTimer: jest.fn(),
    startElementTimerInterval: jest.fn(),
    stopElementTimerInterval: jest.fn(),
    formatNumericValue: jest.fn(),
    getTemperatureUnit: jest.fn(),
}));
jest.unstable_mockModule('../../tools/text-scrolling.js', () => ({ applyScrollingEffect: jest.fn() }));
jest.unstable_mockModule('../../tools/icon.js', () => ({
    getIcon: jest.fn(),
    getLightColorSignature: jest.fn(),
    getImage: jest.fn(),
}));
jest.unstable_mockModule('../../tools/tap-actions.js', () => ({
    addActions: jest.fn(),
    addFeedback: jest.fn(),
}));
jest.unstable_mockModule('../../tools/validate-condition.js', () => ({
    checkConditionsMet: jest.fn(),
    validateConditionalConfig: jest.fn(),
    ensureArray: jest.fn(),
}));

const { revealConditionalSubButtons } = await import('./utils.js');

// Minimal element: classList, parent chain and a class-based querySelectorAll
class StubElement {
    constructor(classNames = '') {
        this.children = [];
        this.parentElement = null;
        this.style = { display: '', removeProperty(name) { if (name === 'display') this.display = ''; } };
        const classes = new Set(classNames.split(' ').filter(Boolean));
        this.classList = {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
        };
    }

    append(...children) {
        children.forEach(child => {
            this.children.push(child);
            child.parentElement = this;
        });
        return this;
    }

    querySelectorAll(selector) {
        const name = selector.replace(/^\./, '');
        const found = [];
        const walk = (node) => node.children.forEach(child => {
            if (child.classList.contains(name)) found.push(child);
            walk(child);
        });
        walk(this);
        return found;
    }
}

function buildCard() {
    const root = new StubElement();
    const lane = new StubElement('bubble-sub-button-alignment-lane hidden');
    const group = new StubElement('bubble-sub-button-group hidden');
    const conditional = new StubElement('bubble-sub-button hidden');
    conditional._hasVisibilityConditions = true;
    conditional._previousVisibilityState = false;

    root.append(lane);
    lane.append(group);
    group.append(conditional);
    return { root, lane, group, conditional };
}

describe('revealConditionalSubButtons', () => {
    test('reveals the button and everything collapsed around it', () => {
        const { root, lane, group, conditional } = buildCard();

        const restore = revealConditionalSubButtons(root);

        expect(conditional.classList.contains('hidden')).toBe(false);
        expect(group.classList.contains('hidden')).toBe(false);
        expect(lane.classList.contains('hidden')).toBe(false);

        restore();

        expect(conditional.classList.contains('hidden')).toBe(true);
        expect(group.classList.contains('hidden')).toBe(true);
        expect(lane.classList.contains('hidden')).toBe(true);
    });

    test('leaves a button hidden for any other reason alone', () => {
        const root = new StubElement();
        const group = new StubElement('bubble-sub-button-group hidden');
        const unavailable = new StubElement('bubble-sub-button hidden');
        root.append(group);
        group.append(unavailable);

        const restore = revealConditionalSubButtons(root);

        expect(unavailable.classList.contains('hidden')).toBe(true);
        expect(group.classList.contains('hidden')).toBe(true);

        restore();

        expect(unavailable.classList.contains('hidden')).toBe(true);
    });

    test('restores a group only once when several of its buttons are revealed', () => {
        const { root, group, conditional } = buildCard();
        const sibling = new StubElement('bubble-sub-button hidden');
        sibling._hasVisibilityConditions = true;
        sibling._previousVisibilityState = false;
        group.append(sibling);

        const restore = revealConditionalSubButtons(root);
        restore();

        expect(group.classList.contains('hidden')).toBe(true);
        expect(conditional.classList.contains('hidden')).toBe(true);
        expect(sibling.classList.contains('hidden')).toBe(true);
    });

    // An always visible slider replaces its host button and carries the height
    // of the row, so the measurement has to see it too
    test('reveals the wrapper of an always visible slider', () => {
        const { root, conditional } = buildCard();
        conditional.sliderWrapper = new StubElement('bubble-sub-slider-wrapper inline');
        conditional.sliderWrapper.style.display = 'none';

        const restore = revealConditionalSubButtons(root);
        expect(conditional.sliderWrapper.style.display).toBe('');

        restore();
        expect(conditional.sliderWrapper.style.display).toBe('none');
    });

    test('a card without conditional sub-buttons is left untouched', () => {
        const root = new StubElement();
        const visible = new StubElement('bubble-sub-button');
        visible._hasVisibilityConditions = true;
        visible._previousVisibilityState = true;
        root.append(visible);

        revealConditionalSubButtons(root)();

        expect(visible.classList.contains('hidden')).toBe(false);
    });
});

describe('getSubButtonOptions with a Home Assistant template', () => {
    test('renders the name with the sub-button entity as `entity`, escaped for the scrolling text', async () => {
        const { getSubButtonOptions } = await import('./utils.js');
        const { _resetTemplateStore } = await import('../../tools/render-template.js');
        const subscriptions = [];
        const hass = {
            connection: {
                subscribeMessage: jest.fn((callback, params) => {
                    subscriptions.push({ callback, params });
                    return Promise.resolve(() => {});
                }),
            },
            states: { 'sensor.h': { entity_id: 'sensor.h', state: '61' } },
            user: { name: 'Q' },
        };
        const context = { _hass: hass, config: { entity: 'light.a' } };
        const subButton = { entity: 'sensor.h', name: "{{ 'Wet' if states(entity) | float > 60 else 'Dry' }}", show_name: true };

        expect(getSubButtonOptions(context, subButton, 1).name).toBe('');
        await Promise.resolve();
        expect(subscriptions[0].params.variables).toEqual({ entity: 'sensor.h', config: { entity: 'sensor.h' } });

        subscriptions[0].callback({ result: '<Wet>' });
        expect(getSubButtonOptions(context, subButton, 1).name).toBe('&lt;Wet&gt;');
        _resetTemplateStore();
    });
});
