import { describe, expect, test } from '@jest/globals';
import { effectiveButtonType, hasClassicHeader, isHomeAssistantStyle } from './style.js';

const popUp = (extra) => ({ card_type: 'pop-up', hash: '#kitchen', ...extra });

describe('which look a pop-up wears', () => {
    test('only the Home Assistant style answers to itself', () => {
        expect(isHomeAssistantStyle(popUp({ popup_style: 'home-assistant' }))).toBe(true);
        expect(isHomeAssistantStyle(popUp({ popup_style: 'classic' }))).toBe(false);
        expect(isHomeAssistantStyle(popUp())).toBe(false);
    });

    test('both styles that copy the more info dialog answer to its header', () => {
        expect(hasClassicHeader(popUp({ popup_style: 'classic' }))).toBe(true);
        expect(hasClassicHeader(popUp({ popup_style: 'home-assistant' }))).toBe(true);
        expect(hasClassicHeader(popUp({ popup_style: 'bubble' }))).toBe(false);
        expect(hasClassicHeader(popUp())).toBe(false);
    });
});

// The single answer the card and the editor both read. create.js forces the
// config to this value before it builds the header, and every editor field that
// depends on the button type asks here rather than reading the key.
describe('the button a card really draws', () => {
    test('a header copying the more info dialog is a switch, whatever the key says', () => {
        for (const style of ['classic', 'home-assistant']) {
            for (const stored of ['name', 'slider', 'state', 'switch', undefined]) {
                expect(effectiveButtonType(popUp({ popup_style: style, button_type: stored }))).toBe('switch');
            }
        }
    });

    test('every other card is its own key, untouched', () => {
        expect(effectiveButtonType(popUp({ popup_style: 'bubble', button_type: 'slider' }))).toBe('slider');
        expect(effectiveButtonType(popUp({ button_type: 'name' }))).toBe('name');
        expect(effectiveButtonType({ card_type: 'button', button_type: 'slider' })).toBe('slider');
        expect(effectiveButtonType({ card_type: 'climate', button_type: 'name' })).toBe('name');
    });

    // A pop-up style on a card that is not a pop-up says nothing about it.
    test('a button card is never read as a pop-up header', () => {
        expect(effectiveButtonType({ card_type: 'button', popup_style: 'home-assistant', button_type: 'slider' })).toBe('slider');
    });

    test('an unset key stays unset, the caller decides its default', () => {
        expect(effectiveButtonType({ card_type: 'button' })).toBeUndefined();
        expect(effectiveButtonType(undefined)).toBeUndefined();
    });
});
