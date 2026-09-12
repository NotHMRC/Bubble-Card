import {
  setLayout
} from '../../tools/utils.js';
import { isInsidePopupShell } from '../../tools/popup-dom.js';
import { resolveLovelaceViewElement } from '../../tools/ha-boundary.js';
import { handleCustomStyles } from '../../tools/style-processor.js';

const DEFAULT_BOTTOM_OFFSET = 16;
const DEFAULT_PADDING_EXTRA = 16;

function getCardContainer(context) {
    return context.cardContainer || context.card.parentNode?.host?.parentNode?.parentNode;
}

function updateFooterPadding(view, context) {
    const measureCard = () => {
        const cardHeight = Number(context.card.offsetHeight || context.card.getBoundingClientRect().height) || 0;
        const bottomOffset = Number(context?.config?.footer_bottom_offset) || DEFAULT_BOTTOM_OFFSET;
        const padding = cardHeight + bottomOffset + DEFAULT_PADDING_EXTRA;

        view.style.paddingBottom = `${padding}px`;
    };

    requestAnimationFrame(() => {
        requestAnimationFrame(measureCard);
    });
}

function updateFooterBottomOffset(context) {
    const bottomOffset = context.config.footer_bottom_offset || DEFAULT_BOTTOM_OFFSET;
    context.card.style.setProperty('--bubble-footer-bottom', `${bottomOffset}px`);
}

function applyFooterPadding(context) {
    // The padding reserves room at the end of the dashboard for the fixed
    // footer. A footer living in a pop-up is not part of that flow, and the
    // lookup below would resolve to the dashboard behind the pop-up.
    if (isInsidePopupShell(context.card)) {
        return;
    }

    // Only the view element itself. Walking up from the card instead used to
    // land on whatever sat above it, which on any view that is not a sections
    // view is a shadow root with no style at all: that threw on every render,
    // about once a second, and reserved nothing (#2607).
    const view = resolveLovelaceViewElement();

    if (view?.style) {
        updateFooterPadding(view, context);
    }
}

function setCardContainerPosition(context, position) {
    const cardContainer = getCardContainer(context);
    if (cardContainer?.classList.contains('card')) {
        cardContainer.style.position = position;
        context.cardContainer = cardContainer;
    }
}

function applyFooterModePositioning(context) {
    // Same reason as in create.js: the dashboard cell is the only legitimate
    // target, a pop-up card wrapper must keep its own box (#2528).
    if (isInsidePopupShell(context.card)) {
        return;
    }

    const cardContainer = getCardContainer(context);

    if (!cardContainer || cardContainer.style.position === '') {
        setCardContainerPosition(context, 'absolute');
    }
}

function resetCardContainerPosition(context) {
    if (context.cardContainer) {
        context.cardContainer.style.position = '';
    }
}

export function changeStyle(context) {
    setLayout(context);
    handleCustomStyles(context);
    
    if (context.config.footer_mode) {
        updateFooterBottomOffset(context);
        
        if (!context.editor) {
            applyFooterPadding(context);
        }
    }
}

export function changeEditor(context) {
    const detectedEditor = context.editor || context.detectedEditor;
    const hasEditorClass = context.card.classList.contains('editor');

    if (detectedEditor) {
        if (!hasEditorClass) {
            resetCardContainerPosition(context);
            context.card.classList.add('editor');
        }
        return;
    }

    if (hasEditorClass) {
        context.card.classList.remove('editor');
        
        if (context.config.footer_mode) {
            applyFooterModePositioning(context);
        } else {
            resetCardContainerPosition(context);
        }
    }
}