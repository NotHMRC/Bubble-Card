import { describe, expect, jest, test } from '@jest/globals';

// A DOM stand-in with just enough of it for the two functions under test. The
// suite runs on the node environment, like the rest of the project.
const fakeElement = (name) => ({
    name,
    style: {},
    children: [],
    firstChild: null,
    parentNode: null,
    classList: {
        entries: new Set(),
        add(className) { this.entries.add(className); },
        remove(className) { this.entries.delete(className); },
        contains(className) { return this.entries.has(className); },
    },
    contains(child) { return this.children.includes(child); },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    insertBefore(child) { this.children.unshift(child); child.parentNode = this; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    remove() { this.parentNode?.removeChild(this); },
});

jest.unstable_mockModule('../../tools/utils.js', () => ({
    getAttribute: () => 'blind',
    setLayout: jest.fn(),
    createElement: (tag, className) => fakeElement(`${tag}.${className}`),
    isDocumentRTL: () => false,
}));
jest.unstable_mockModule('../../tools/icon.js', () => ({ getIcon: () => 'mdi:window-shutter' }));
jest.unstable_mockModule('../../tools/style-processor.js', () => ({ handleCustomStyles: jest.fn() }));
jest.unstable_mockModule('../../tools/render-template.js', () => ({
    resolveTemplate: (_context, value) => value,
}));

const {
    changeCoverIcons,
    positionTiltButtons,
    tiltButtonSupport,
    tiltsByPositionOnly,
    DEFAULT_OPEN_TILT_SERVICE,
    DEFAULT_CLOSE_TILT_SERVICE,
} = await import('./changes.js');

const OPEN = 1;
const CLOSE = 2;
const SET_POSITION = 4;
const STOP = 8;
const OPEN_TILT = 16;
const CLOSE_TILT = 32;
const STOP_TILT = 64;
const SET_TILT_POSITION = 128;

// The cover from #2618, a KNX blind with move_long, stop, position and angle
// addresses but no move_short_address. xknx leaves its `step` unwritable, so
// KNX grants the angle alone and never OPEN_TILT or CLOSE_TILT.
const TILTS_BY_POSITION = OPEN | CLOSE | SET_POSITION | STOP | STOP_TILT | SET_TILT_POSITION;

// A cover that really does tilt by impulse
const TILTS_BY_IMPULSE = OPEN | CLOSE | OPEN_TILT | CLOSE_TILT | STOP_TILT;

const ENTITY = 'cover.kuchentuere';

const makeContext = (supportedFeatures, config = {}) => {
    const elements = {};
    for (const key of [
        'icon', 'buttonOpen', 'buttonStop', 'buttonClose',
        'buttonTiltOpen', 'buttonTiltClose', 'tiltButtonsContainer',
        'subButtonContainer', 'bottomSubButtonContainer', 'buttonsContainer', 'cardWrapper',
    ]) {
        elements[key] = fakeElement(key);
    }
    elements.buttonOpen.icon = { setAttribute: jest.fn() };
    elements.buttonClose.icon = { setAttribute: jest.fn() };
    // create.js hides the row until something is known to fill it
    elements.tiltButtonsContainer.style.display = 'none';

    return {
        config: { entity: ENTITY, ...config },
        elements,
        _hass: {
            states: {
                [ENTITY]: {
                    state: 'open',
                    attributes: {
                        supported_features: supportedFeatures,
                        current_position: 50,
                        current_tilt_position: 50,
                    },
                },
            },
        },
    };
};

const render = (context) => {
    changeCoverIcons(context);
    positionTiltButtons(context);
};

describe('which tilt buttons a cover gets', () => {
    // The reporter's cover carries SET_TILT_POSITION and neither tilt impulse
    // feature. Counting the angle as button support used to show the row and
    // hide both of its buttons, so the card offered an empty slot that nudged
    // the open and close arrows around. #2618
    test('a cover that only tilts to an angle gets no row at all', () => {
        const context = makeContext(TILTS_BY_POSITION);
        render(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('none');
        expect(context.elements.buttonTiltClose.style.display).toBe('none');
        expect(context.elements.tiltButtonsContainer.style.display).toBe('none');
        expect(context.elements.subButtonContainer.children).toHaveLength(0);
    });

    test('a cover that tilts by impulse keeps both buttons and its row', () => {
        const context = makeContext(TILTS_BY_IMPULSE);
        render(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('');
        expect(context.elements.buttonTiltClose.style.display).toBe('');
        expect(context.elements.tiltButtonsContainer.style.display).toBe('');
        expect(context.elements.subButtonContainer.children)
            .toContain(context.elements.tiltButtonsContainer);
    });

    // Home Assistant masks its own tilt buttons one by one in
    // ha-cover-tilt-controls, so half the support means half the row
    test('a cover that only opens its tilt keeps only that button', () => {
        const context = makeContext(OPEN | CLOSE | OPEN_TILT);
        render(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('');
        expect(context.elements.buttonTiltClose.style.display).toBe('none');
        expect(context.elements.tiltButtonsContainer.style.display).toBe('');
    });

    test('the row is hidden on request even when both buttons are supported', () => {
        const context = makeContext(TILTS_BY_IMPULSE, { tilt_buttons: 'hidden' });
        render(context);

        expect(context.elements.tiltButtonsContainer.style.display).toBe('none');
        expect(context.elements.subButtonContainer.children).toHaveLength(0);
    });
});

describe('a tilt action the user picked themselves', () => {
    // The button calls whatever it is pointed at with the cover's entity_id, so
    // a script can tilt a cover Home Assistant refuses to tilt by impulse
    test('brings back the button it drives, and only that one', () => {
        const context = makeContext(TILTS_BY_POSITION, { open_tilt_service: 'script.tilt_open' });
        render(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('');
        expect(context.elements.buttonTiltClose.style.display).toBe('none');
        expect(context.elements.subButtonContainer.children)
            .toContain(context.elements.tiltButtonsContainer);
    });

    // The editor shows the default action as a real value rather than a
    // placeholder, so retyping it writes it to the config. It is also the exact
    // action core refuses without OPEN_TILT, so it can never count as support.
    test('the default action is not one of those', () => {
        const context = makeContext(TILTS_BY_POSITION, {
            open_tilt_service: DEFAULT_OPEN_TILT_SERVICE,
            close_tilt_service: DEFAULT_CLOSE_TILT_SERVICE,
        });
        render(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('none');
        expect(context.elements.buttonTiltClose.style.display).toBe('none');
        expect(context.elements.tiltButtonsContainer.style.display).toBe('none');
    });

    test('an emptied action field is not one either', () => {
        expect(tiltButtonSupport({ attributes: { supported_features: TILTS_BY_POSITION } }, {
            open_tilt_service: '',
        }).open).toBe(false);
    });

    // The row memoizes its own placement, and a config change has to get past
    // that memo or the button would appear with nowhere to sit
    test('gets past the row placement memo', () => {
        const context = makeContext(TILTS_BY_POSITION);
        render(context);
        expect(context.elements.subButtonContainer.children).toHaveLength(0);

        context.config.close_tilt_service = 'script.tilt_close';
        render(context);

        expect(context.elements.buttonTiltClose.style.display).toBe('');
        expect(context.elements.subButtonContainer.children)
            .toContain(context.elements.tiltButtonsContainer);
    });
});

// Hiding a button used to be one way for the life of the card, with no branch
// restoring the display, so nothing could ever bring it back. #2618
describe('a button that was hidden', () => {
    test('comes back when the features arrive', () => {
        const context = makeContext(TILTS_BY_POSITION);
        changeCoverIcons(context);
        expect(context.elements.buttonTiltOpen.style.display).toBe('none');

        context._hass.states[ENTITY].attributes.supported_features = TILTS_BY_IMPULSE;
        changeCoverIcons(context);

        expect(context.elements.buttonTiltOpen.style.display).toBe('');
        expect(context.elements.buttonTiltClose.style.display).toBe('');
    });
});

describe('what the editor explains', () => {
    const cover = (supportedFeatures) => ({ attributes: { supported_features: supportedFeatures } });

    test('speaks up only for a cover that tilts to an angle and nothing else', () => {
        expect(tiltsByPositionOnly(cover(TILTS_BY_POSITION))).toBe(true);
        expect(tiltsByPositionOnly(cover(TILTS_BY_IMPULSE))).toBe(false);
        expect(tiltsByPositionOnly(cover(OPEN | CLOSE))).toBe(false);
        // A cover with both says nothing, its buttons already work
        expect(tiltsByPositionOnly(cover(OPEN_TILT | CLOSE_TILT | SET_TILT_POSITION))).toBe(false);
    });

    test('stays quiet on a cover with no state to read', () => {
        expect(tiltsByPositionOnly(null)).toBe(false);
        expect(tiltsByPositionOnly(undefined)).toBe(false);
    });
});
