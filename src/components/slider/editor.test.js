import { describe, expect, jest, test } from '@jest/globals';

// The template is not the point here, only whether the panel decides to show
// itself, so `html` joins its parts and the panel is read by its own heading.
jest.unstable_mockModule('lit', () => ({
    html: (strings, ...values) => strings.reduce((out, part, i) => out + part + (values[i] ?? ''), ''),
}));
jest.unstable_mockModule('./helpers.js', () => ({ isReadOnlyEntityId: jest.fn(() => false) }));
jest.unstable_mockModule('../../tools/localize.js', () => ({ default: () => (key) => key }));
jest.unstable_mockModule('../../editor/utils.js', () => ({ tTemplate: (text) => text }));

const { makeButtonSliderPanel } = await import('./editor.js');

const makeEditor = (config) => ({
    hass: { states: {} },
    _config: config,
    _valueChanged: jest.fn(),
});

// The panel hides by going display:none rather than by leaving the template.
const panelIsHidden = (config) => {
    const out = makeButtonSliderPanel(makeEditor(config));
    const at = out.indexOf('editor.button.slider_settings');
    expect(at).toBeGreaterThan(-1);
    return /display:\s*none/.test(out.slice(0, at));
};

describe('the slider settings panel', () => {
    test('a slider button shows it', () => {
        expect(panelIsHidden({ card_type: 'button', button_type: 'slider', entity: 'light.a' })).toBe(false);
    });

    test('any other button type hides it', () => {
        for (const type of ['switch', 'state', 'name']) {
            expect(panelIsHidden({ card_type: 'button', button_type: type, entity: 'light.a' })).toBe(true);
        }
    });

    // The header of those pop-ups is built as a switch whatever `button_type`
    // says, so it carries no slider. A config that held one before the style
    // was picked kept the panel on screen with nothing to settle.
    test('a pop-up wearing the more info header hides it, slider in the config or not', () => {
        for (const style of ['classic', 'home-assistant']) {
            expect(panelIsHidden({
                card_type: 'pop-up', hash: '#kitchen', popup_style: style,
                button_type: 'slider', entity: 'light.a',
            })).toBe(true);
        }
    });

    test('a Bubble pop-up keeps it, its header can really be a slider', () => {
        expect(panelIsHidden({
            card_type: 'pop-up', hash: '#kitchen', popup_style: 'bubble',
            button_type: 'slider', entity: 'light.a',
        })).toBe(false);
    });
});
