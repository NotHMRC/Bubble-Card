import { describe, expect, jest, test } from '@jest/globals';

// The template is not the point here, only which controls the editor decides to
// build, so `html` joins its parts and every control the editor asks for comes
// back as a marker.
jest.unstable_mockModule('lit', () => ({
    html: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
}));
jest.unstable_mockModule('../../tools/utils.js', () => ({ isEntityType: jest.fn(() => false) }));
jest.unstable_mockModule('../../tools/localize.js', () => ({ default: () => (key) => key }));
jest.unstable_mockModule('../../editor/utils.js', () => ({ tTemplate: jest.fn() }));
jest.unstable_mockModule('../../components/slider/editor.js', () => ({ makeButtonSliderPanel: jest.fn(() => '[slider-panel]') }));

const { renderButtonEditor } = await import('./editor.js');

function makeEditor(config) {
    return {
        hass: {},
        _config: config,
        _computeLabelCallback: () => '',
        _optionalLabel: (label) => `optional:${label}`,
        _valueChanged: jest.fn(),
        makeDropdown: (label, configValue) => `[dropdown:${configValue}]`,
        makeShowState: () => '[show-state]',
        makeActionPanel: (token) => `[action:${token}]`,
        makeSubButtonPanel: () => '[sub-buttons]',
        makeLayoutPanel: () => '[layout]',
        makeStyleEditor: () => '[styles]',
        makeModulesEditor: () => '[modules]',
        makeVersion: () => '[version]',
        cardTypeList: [],
    };
}

const popUp = (extra) => ({ card_type: 'pop-up', hash: '#home', ...extra });

describe('the button type of a pop-up header', () => {
    test('a Bubble pop-up offers it', () => {
        const out = renderButtonEditor(makeEditor(popUp()));

        expect(out).toContain('[dropdown:button_type]');
    });

    test('neither header of the more info dialog offers it, and neither offers its actions', () => {
        const classic = renderButtonEditor(makeEditor(popUp({ popup_style: 'classic' })));
        const homeAssistant = renderButtonEditor(makeEditor(popUp({ popup_style: 'home-assistant' })));

        for (const out of [classic, homeAssistant]) {
            expect(out).not.toContain('[dropdown:button_type]');
            expect(out).not.toContain('[action:tap]');
        }
        // The two styles wear the same header, so they ask the same questions.
        expect(homeAssistant).toBe(classic);
    });

    test('a header without a button type of its own keeps the config untouched under those styles', () => {
        const config = popUp({ popup_style: 'home-assistant' });
        renderButtonEditor(makeEditor(config));

        expect(config.button_type).toBeUndefined();
    });

    test('a button card is never read as a classic header', () => {
        const out = renderButtonEditor(makeEditor({ card_type: 'button', entity: 'light.x' }));

        expect(out).toContain('[dropdown:button_type]');
        expect(out).toContain('[action:tap]');
    });
});
