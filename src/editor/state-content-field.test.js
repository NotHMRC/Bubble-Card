import { beforeEach, describe, expect, jest, test } from '@jest/globals';

// The same mocks as bubble-card-editor.test.js, with one difference: `html`
// joins its parts here rather than returning an empty string, so the test can
// read which fields the state panel decided to build.
jest.unstable_mockModule('lit', () => ({
    LitElement: class {
        connectedCallback() {}
        disconnectedCallback() {}
        updated() {}
        // Not a Lit method, but the editor reaches for it in setConfig and the
        // mock is not an HTMLElement.
        getRootNode() { return null; }
    },
    html: (strings, ...values) => (Array.isArray(strings)
        ? strings.reduce((out, part, i) => out + part + (values[i] ?? ''), '')
        : ''),
    css: () => '',
    unsafeCSS: (value) => value,
}));
jest.unstable_mockModule('../var/version.js', () => ({ version: 'test' }));
jest.unstable_mockModule('../tools/utils.js', () => ({ fireEvent: jest.fn() }));
jest.unstable_mockModule('../components/editor/ha-selector-bc_object.js', () => ({}));
jest.unstable_mockModule('../cards/button/editor.js', () => ({ renderButtonEditor: jest.fn() }));
jest.unstable_mockModule('../cards/sub-buttons/editor.js', () => ({ renderSubButtonsEditor: jest.fn() }));
jest.unstable_mockModule('../cards/pop-up/editor.js', () => ({ renderPopUpEditor: jest.fn() }));
jest.unstable_mockModule('../cards/separator/editor.js', () => ({ renderSeparatorEditor: jest.fn() }));
jest.unstable_mockModule('../cards/horizontal-buttons-stack/editor.js', () => ({ renderHorButtonStackEditor: jest.fn() }));
jest.unstable_mockModule('../cards/cover/editor.js', () => ({ renderCoverEditor: jest.fn() }));
jest.unstable_mockModule('../cards/climate/editor.js', () => ({ renderClimateEditor: jest.fn() }));
jest.unstable_mockModule('../cards/select/editor.js', () => ({ renderSelectEditor: jest.fn() }));
jest.unstable_mockModule('../cards/calendar/editor.js', () => ({ renderCalendarEditor: jest.fn() }));
jest.unstable_mockModule('../cards/media-player/editor.js', () => ({ renderMediaPlayerEditor: jest.fn() }));
jest.unstable_mockModule('../cards/empty-column/editor.js', () => ({ renderEmptyColumnEditor: jest.fn() }));
jest.unstable_mockModule('../components/sub-button/editor/index.js', () => ({ makeSubButtonPanel: jest.fn() }));
jest.unstable_mockModule('../components/sub-button/utils.js', () => ({ revealConditionalSubButtons: jest.fn(() => () => {}) }));
jest.unstable_mockModule('../modules/editor.js', () => ({ makeModulesEditor: jest.fn() }));
jest.unstable_mockModule('../modules/store.js', () => ({ makeModuleStore: jest.fn(), _fetchModuleStore: jest.fn() }));
const dropSuggestionsPreviewIfStale = jest.fn();
const releaseSuggestionsPreview = jest.fn();
jest.unstable_mockModule('../modules/module-editor.js', () => ({
    dropSuggestionsPreviewIfStale,
    releaseSuggestionsPreview,
}));
jest.unstable_mockModule('../modules/registry.js', () => ({ yamlKeysMap: new Map() }));
jest.unstable_mockModule('../tools/localize.js', () => ({
    default: jest.fn(() => (key) => key),
    ensureEditorTranslations: jest.fn(() => Promise.resolve(false)),
    isEditorEnglishForced: jest.fn(() => false),
    setEditorEnglishForced: jest.fn(),
    getCurrentLocale: jest.fn(() => 'en'),
    // Reached through ../modules/utils.js, which the editor imports for
    // schemaDefaults.
    tGlobal: jest.fn((key) => key),
}));
jest.unstable_mockModule('./styles.css', () => ({ default: '' }));
jest.unstable_mockModule('../modules/styles.css', () => ({ default: '' }));
jest.unstable_mockModule('../cards/pop-up/cards/styles.css', () => ({ default: '' }));
// Mirror every named export of the real module: a partial mock breaks the
// suite as soon as the editor starts importing another helper from it.
jest.unstable_mockModule('./utils.js', () => ({
    tTemplate: jest.fn((text) => text),
    getLazyLoadedPanelContent: jest.fn(),
    supportsHaDropdown: jest.fn(() => false),
    renderDropdown: jest.fn(),
}));
jest.unstable_mockModule('./standalone-dialog-bridge.js', () => ({
    bridgeDialogCloseToParent: jest.fn(),
    createReopenedStandaloneParentDialogParams: jest.fn(),
    createStandaloneParentDialogParamsFromDialog: jest.fn(),
    forceDialogDirtyState: jest.fn(),
    getDialogCardElementEditor: jest.fn(),
    restoreDialogCardEditorVisualState: jest.fn(),
}));

const definedElements = {};
global.customElements = { define: jest.fn((name, cls) => { definedElements[name] = cls; }) };
global.window = {
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
};
global.document = {
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    querySelector: jest.fn(() => null),
};

// The module has no export: the class is only reachable through the
// customElements.define call it performs at load time.
await import('./bubble-card-editor.js');
const BubbleCardEditor = definedElements['bubble-card-editor'];
const { fireEvent } = await import('../tools/utils.js');

function makeEditor(config) {
    const editor = new BubbleCardEditor();
    editor._config = config;
    editor.__renderHass = { states: {} };
    editor._expandedPanelStates = {};
    return editor;
}

// A schema object lands in the template as [object Object], so the field is
// recognised by its label, which no other field of the panel carries.
const STATE_CONTENT_FIELD = 'editor.show.state_content';
const showsStateContent = (config) => makeEditor(config).makeShowState().includes(STATE_CONTENT_FIELD);

describe('the state content field', () => {
    test('a card with an entity is asked what its line shows', () => {
        expect(showsStateContent({ card_type: 'button', button_type: 'switch', entity: 'light.kitchen' })).toBe(true);
    });

    test('a card without an entity is not, a pop-up header for instance', () => {
        expect(showsStateContent({ card_type: 'pop-up', hash: '#home', button_type: 'switch', name: 'Rooms' })).toBe(false);
        expect(showsStateContent({ card_type: 'button', button_type: 'switch' })).toBe(false);
    });

    test('a name button is not either, entity or not', () => {
        expect(showsStateContent({ card_type: 'button', button_type: 'name', entity: 'light.kitchen' })).toBe(false);
        expect(showsStateContent({ card_type: 'pop-up', hash: '#home', button_type: 'name', entity: 'light.kitchen' })).toBe(false);
    });

    // The card builds these headers as a switch whatever `button_type` says, so
    // they draw a state line and the editor cannot pretend otherwise.
    test('a pop-up wearing the more info header is asked, name button or not', () => {
        for (const style of ['classic', 'home-assistant']) {
            expect(showsStateContent({
                card_type: 'pop-up', hash: '#kitchen2', popup_style: style,
                button_type: 'name', name: 'Kitchen 2', entity: 'light.bas_tv',
            })).toBe(true);
        }
    });

    test('but only when it has an entity to describe', () => {
        for (const style of ['classic', 'home-assistant']) {
            expect(showsStateContent({
                card_type: 'pop-up', hash: '#rooms', popup_style: style,
                button_type: 'name', name: 'Rooms',
            })).toBe(false);
        }
    });

    test('a sub-button keeps its field, its line can hold a template of its own', () => {
        const editor = makeEditor({ card_type: 'button', button_type: 'switch' });
        const subButton = { icon: 'mdi:home' };

        expect(editor.makeShowState(subButton, '', 'sub_button', 0)).toContain(STATE_CONTENT_FIELD);
    });
});

// Ce style ne dessine ni icone ni fond derriere le titre, donc la couleur
// d'accent n'a rien a teindre et l'icone n'a rien a montrer.
describe('the switches the Home Assistant pop-up style settles', () => {
    const ACCENT = 'editor.show.accent_color';
    const panelFor = (config) => makeEditor(config).makeShowState();

    // The attributes of a switch land between its aria-label and its closing
    // tag, so this reads that one switch and not its neighbours.
    const switchIsDisabled = (panel, label) => {
        const from = panel.indexOf(`aria-label="${label}"`);
        if (from === -1) return null;
        // Some bindings are quoted in the template and some are not, so the
        // rendered text is `disabled=true` or `disabled="true"`.
        return /disabled="?true/.test(panel.slice(from, panel.indexOf('</ha-switch>', from)));
    };

    const light = { entity: 'light.bas_tv', name: 'Kitchen 2', hash: '#kitchen2' };

    test('the accent color switch is greyed out under it', () => {
        expect(switchIsDisabled(panelFor({ card_type: 'pop-up', popup_style: 'home-assistant', ...light }), ACCENT)).toBe(true);
    });

    test('the Bubble and classic styles leave it alone, both paint a fill', () => {
        for (const style of ['bubble', 'classic']) {
            expect(switchIsDisabled(panelFor({ card_type: 'pop-up', popup_style: style, ...light }), ACCENT)).toBe(false);
        }
    });

    test('a button card is never settled by a pop-up style', () => {
        expect(switchIsDisabled(panelFor({ card_type: 'button', popup_style: 'home-assistant', ...light }), ACCENT)).toBe(false);
    });

    // Same reason as the accent color: there is no icon left to prefer over an
    // entity picture. A `name` button greys it out on its own, so this reads a
    // `switch` one, where only the style can.
    test('the icon priority switch is greyed out under it too', () => {
        const FORCE = 'editor.show.force_icon';
        const withSwitch = { ...light, button_type: 'switch' };

        expect(switchIsDisabled(panelFor({ card_type: 'pop-up', popup_style: 'home-assistant', ...withSwitch }), FORCE)).toBe(true);
        expect(switchIsDisabled(panelFor({ card_type: 'pop-up', popup_style: 'classic', ...withSwitch }), FORCE)).toBe(false);
        expect(switchIsDisabled(panelFor({ card_type: 'button', ...withSwitch }), FORCE)).toBe(false);
    });
});
