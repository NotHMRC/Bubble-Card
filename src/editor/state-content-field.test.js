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
