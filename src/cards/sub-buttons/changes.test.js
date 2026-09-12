import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../tools/utils.js', () => ({
    setLayout: jest.fn(),
}));

jest.unstable_mockModule('../../tools/style-processor.js', () => ({
    handleCustomStyles: jest.fn(),
}));

const { changeEditor, changeStyle } = await import('./changes.js');

// A sections view puts the card in a grid cell whose parent is an ordinary
// element. Every other view type can nest it one shadow root deeper, and a
// shadow root has no style: writing to it is what threw on every render.
function createCardContainer({ parentIsShadowRoot = false } = {}) {
    return {
        classList: { contains: (name) => name === 'card' },
        style: { position: '' },
        parentNode: parentIsShadowRoot ? { host: {} } : { style: {} },
    };
}

function createContext({ insidePopup, cardContainer, editorClass = false }) {
    const classes = new Set(editorClass ? ['editor'] : []);
    const card = {
        classList: {
            contains: (name) => classes.has(name),
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
        },
        style: { setProperty: jest.fn() },
        offsetHeight: 56,
        getBoundingClientRect: () => ({ height: 56 }),
        closest: (selector) => (insidePopup && selector === '.bubble-pop-up' ? card : null),
    };
    card.getRootNode = () => card;
    card.parentNode = { host: { parentNode: { parentNode: cardContainer } } };

    return {
        card,
        config: { footer_mode: true },
        editor: false,
        detectedEditor: false,
    };
}

let mountedRoot = null;

// home-assistant → home-assistant-main → ha-panel-lovelace → hui-root, each
// behind its own shadow root, then #view > hui-view holding the view element.
function mountDashboard(viewElement) {
    // The resolver caches hui-root and revalidates it through isConnected, the
    // way HA swaps the panel when you leave a dashboard.
    if (mountedRoot) mountedRoot.isConnected = false;

    const huiRoot = {
        isConnected: true,
        shadowRoot: {
            querySelector: (selector) => {
                if (selector === '#view > hui-view') return { firstElementChild: viewElement };
                // The lookup this card used before #2607, kept so a test that
                // covers another view type fails for its own reason.
                if (selector === '#view > hui-view > hui-sections-view') {
                    return viewElement?.tagName === 'HUI-SECTIONS-VIEW' ? viewElement : null;
                }
                return null;
            },
        },
    };
    mountedRoot = huiRoot;

    const panel = { shadowRoot: { querySelector: (s) => (s === 'hui-root' ? huiRoot : null) } };
    const main = { shadowRoot: { querySelector: (s) => (s.includes('ha-panel-lovelace') ? panel : null) } };
    const ha = { shadowRoot: { querySelector: (s) => (s === 'home-assistant-main' ? main : null) } };
    global.document = { querySelector: (s) => (s === 'body > home-assistant' ? ha : null) };

    return viewElement;
}

describe('sub-buttons footer mode style updates', () => {
    beforeEach(() => {
        global.requestAnimationFrame = (callback) => { callback(); return 1; };
    });

    afterEach(() => {
        delete global.document;
        delete global.requestAnimationFrame;
    });

    test('reserves room at the end of the dashboard for a dashboard footer', () => {
        const view = mountDashboard({ tagName: 'HUI-SECTIONS-VIEW', style: {} });
        const context = createContext({ insidePopup: false, cardContainer: createCardContainer() });

        changeStyle(context);

        expect(view.style.paddingBottom).toBe('88px');
    });

    // #2607: on anything but a sections view the lookup fell back to the node
    // above the card, which is a shadow root, and threw about once a second
    // while reserving no room at all.
    test('reserves room on a view that is not a sections view', () => {
        const view = mountDashboard({ tagName: 'HUI-MASONRY-VIEW', style: {} });
        const context = createContext({
            insidePopup: false,
            cardContainer: createCardContainer({ parentIsShadowRoot: true }),
        });

        expect(() => changeStyle(context)).not.toThrow();
        expect(view.style.paddingBottom).toBe('88px');
    });

    // A view element HA does not ship, such as Layout Card's grid-layout: no
    // list of HA tag names would name it, and it must be padded all the same.
    test('reserves room on a third-party view element', () => {
        const view = mountDashboard({ tagName: 'GRID-LAYOUT', style: {} });
        const context = createContext({
            insidePopup: false,
            cardContainer: createCardContainer({ parentIsShadowRoot: true }),
        });

        changeStyle(context);

        expect(view.style.paddingBottom).toBe('88px');
    });

    test('skips the reservation rather than throwing when no view resolves', () => {
        mountDashboard(null);
        const context = createContext({
            insidePopup: false,
            cardContainer: createCardContainer({ parentIsShadowRoot: true }),
        });

        expect(() => changeStyle(context)).not.toThrow();
        // The offset variable is a card-local concern and still applies.
        expect(context.card.style.setProperty).toHaveBeenCalledWith('--bubble-footer-bottom', '16px');
    });

    test('never pads the dashboard for a footer living in a pop-up', () => {
        const view = mountDashboard({ tagName: 'HUI-SECTIONS-VIEW', style: {} });
        const context = createContext({ insidePopup: true, cardContainer: createCardContainer() });

        changeStyle(context);

        expect(view.style.paddingBottom).toBeUndefined();
        expect(context.card.style.setProperty).toHaveBeenCalledWith('--bubble-footer-bottom', '16px');
    });

    test('restores the dashboard cell positioning when leaving the editor', () => {
        const cardContainer = createCardContainer();
        const context = createContext({ insidePopup: false, cardContainer, editorClass: true });

        changeEditor(context);

        expect(cardContainer.style.position).toBe('absolute');
    });

    test('leaves a pop-up card wrapper alone when leaving the editor', () => {
        const cardContainer = createCardContainer();
        const context = createContext({ insidePopup: true, cardContainer, editorClass: true });

        changeEditor(context);

        expect(cardContainer.style.position).toBe('');
    });
});
