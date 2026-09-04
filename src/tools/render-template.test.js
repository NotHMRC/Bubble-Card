import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    getTemplateResult,
    getRenderedTemplate,
    resolveTemplate,
    beginTemplateRender,
    sweepTemplates,
    releaseTemplates,
    TEMPLATE_TEXT,
    TEMPLATE_STYLE,
    TEMPLATE_CONDITION,
    _templateStore,
    _resetTemplateStore,
} from './render-template.js';

async function flushPromiseQueue() {
    await Promise.resolve();
    await Promise.resolve();
}

// A fake websocket connection that records every subscription and lets a test
// push results into it.
function createHass(user = 'Clooos') {
    const subscriptions = [];
    const connection = {
        subscribeMessage: jest.fn((callback, params) => {
            const subscription = { callback, params, unsubscribe: jest.fn(() => Promise.resolve()) };
            subscriptions.push(subscription);
            return Promise.resolve(subscription.unsubscribe);
        }),
    };
    return { hass: { connection, user: { name: user } }, subscriptions, connection };
}

function createOwner(entity = 'light.a', extra = {}) {
    return {
        config: { card_type: 'button', entity },
        onTemplateResults: jest.fn(),
        inEditorPreview: false,
        ...extra,
    };
}

async function deliver(subscription, result) {
    subscription.callback({ result, listeners: { all: false, domains: [], entities: [], time: false } });
    // The flush runs on the next animation frame, faked as a timer.
    jest.advanceTimersByTime(0);
    await flushPromiseQueue();
}

describe('the shared template store', () => {
    let consoleWarnSpy;

    beforeEach(() => {
        jest.useFakeTimers();
        global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        _resetTemplateStore();
    });

    afterEach(() => {
        _resetTemplateStore();
        consoleWarnSpy.mockRestore();
        delete global.requestAnimationFrame;
        jest.useRealTimers();
    });

    test('a template that never reads entity is one subscription for every card', async () => {
        const { hass, subscriptions, connection } = createHass();
        const a = createOwner('light.a');
        const b = createOwner('light.b');
        const template = "{{ states('sensor.outdoor') }}";

        expect(getTemplateResult(hass, template, 'light.a', a)).toBeUndefined();
        expect(getTemplateResult(hass, template, 'light.b', b)).toBeUndefined();
        await flushPromiseQueue();

        expect(connection.subscribeMessage).toHaveBeenCalledTimes(1);
        expect(subscriptions[0].params).toEqual({
            type: 'render_template',
            template,
            strict: false,
            report_errors: false,
        });
        // The server rejects a null dictionary, the key must be absent.
        expect(subscriptions[0].params).not.toHaveProperty('variables');

        await deliver(subscriptions[0], '12.5');

        expect(getTemplateResult(hass, template, 'light.a', a)).toBe('12.5');
        expect(getTemplateResult(hass, template, 'light.b', b)).toBe('12.5');
        expect(a.onTemplateResults).toHaveBeenCalledWith(TEMPLATE_TEXT);
        expect(b.onTemplateResults).toHaveBeenCalledWith(TEMPLATE_TEXT);
    });

    test('a template that reads entity is one subscription per entity, with config.entity too', async () => {
        const { hass, subscriptions } = createHass();
        const a = createOwner('light.a');
        const b = createOwner('light.b');
        const template = "{{ states(entity) }}";

        getTemplateResult(hass, template, 'light.a', a);
        getTemplateResult(hass, template, 'light.b', b);
        await flushPromiseQueue();

        expect(subscriptions).toHaveLength(2);
        expect(subscriptions[0].params.variables).toEqual({ entity: 'light.a', config: { entity: 'light.a' } });
        expect(subscriptions[1].params.variables).toEqual({ entity: 'light.b', config: { entity: 'light.b' } });

        await deliver(subscriptions[0], 'on');

        expect(getTemplateResult(hass, template, 'light.a', a)).toBe('on');
        expect(getTemplateResult(hass, template, 'light.b', b)).toBeUndefined();
        expect(a.onTemplateResults).toHaveBeenCalledTimes(1);
        expect(b.onTemplateResults).not.toHaveBeenCalled();
    });

    test('a template that reads user gets the user name', async () => {
        const { hass, subscriptions } = createHass('Quentin');
        getTemplateResult(hass, 'Hi {{ user }}', 'light.a', createOwner());
        await flushPromiseQueue();
        expect(subscriptions[0].params.variables).toEqual({ user: 'Quentin' });
    });

    test('an unchanged result renders nobody again', async () => {
        const { hass, subscriptions } = createHass();
        const owner = createOwner();
        getTemplateResult(hass, '{{ 1 }}', 'light.a', owner);
        await flushPromiseQueue();

        await deliver(subscriptions[0], 1);
        await deliver(subscriptions[0], 1);

        expect(owner.onTemplateResults).toHaveBeenCalledTimes(1);
    });

    test('the kinds an owner read a template for travel with the notification', async () => {
        const { hass, subscriptions } = createHass();
        const owner = createOwner();
        getTemplateResult(hass, '{{ 1 }}', 'light.a', owner, TEMPLATE_STYLE);
        getTemplateResult(hass, '{{ 2 }}', 'light.a', owner, TEMPLATE_TEXT);
        await flushPromiseQueue();

        await deliver(subscriptions[0], 'a');
        expect(owner.onTemplateResults).toHaveBeenLastCalledWith(TEMPLATE_STYLE);

        subscriptions[0].callback({ result: 'b' });
        subscriptions[1].callback({ result: 'c' });
        jest.advanceTimersByTime(0);
        await flushPromiseQueue();
        expect(owner.onTemplateResults).toHaveBeenLastCalledWith(TEMPLATE_STYLE | TEMPLATE_TEXT);
    });

    test('a released entry lives on for the grace period and answers at once when a card comes back', async () => {
        const { hass, subscriptions, connection } = createHass();
        const owner = createOwner();
        const template = '{{ 1 }}';
        getTemplateResult(hass, template, 'light.a', owner);
        await flushPromiseQueue();
        await deliver(subscriptions[0], 'one');

        releaseTemplates(owner);
        expect(_templateStore().entries.size).toBe(1);
        expect(subscriptions[0].unsubscribe).not.toHaveBeenCalled();

        jest.advanceTimersByTime(19000);
        const again = createOwner();
        expect(getTemplateResult(hass, template, 'light.a', again)).toBe('one');
        expect(connection.subscribeMessage).toHaveBeenCalledTimes(1);

        // The come back cancelled the release.
        jest.advanceTimersByTime(30000);
        expect(_templateStore().entries.size).toBe(1);
        expect(subscriptions[0].unsubscribe).not.toHaveBeenCalled();
    });

    test('past the grace period the subscription ends and the last value is still remembered', async () => {
        const { hass, subscriptions, connection } = createHass();
        const owner = createOwner();
        const template = '{{ 1 }}';
        getTemplateResult(hass, template, 'light.a', owner);
        await flushPromiseQueue();
        await deliver(subscriptions[0], 'one');

        releaseTemplates(owner);
        jest.advanceTimersByTime(20000);
        await flushPromiseQueue();

        expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
        expect(_templateStore().entries.size).toBe(0);

        // A new card is answered with the remembered value while it subscribes again.
        const again = createOwner();
        expect(getTemplateResult(hass, template, 'light.a', again)).toBe('one');
        await flushPromiseQueue();
        expect(connection.subscribeMessage).toHaveBeenCalledTimes(2);
    });

    test('an editor preview waits before subscribing and never subscribes a template it let go of', async () => {
        const { hass, connection, subscriptions } = createHass();
        const typing = createOwner('light.a', { inEditorPreview: true });

        getTemplateResult(hass, '{{ states(', 'light.a', typing);
        jest.advanceTimersByTime(100);
        releaseTemplates(typing);
        jest.advanceTimersByTime(1000);
        await flushPromiseQueue();
        expect(connection.subscribeMessage).not.toHaveBeenCalled();
        expect(_templateStore().entries.size).toBe(0);

        const done = createOwner('light.a', { inEditorPreview: true });
        getTemplateResult(hass, "{{ states('x') }}", 'light.a', done);
        jest.advanceTimersByTime(250);
        await flushPromiseQueue();
        expect(connection.subscribeMessage).toHaveBeenCalledTimes(1);
        expect(subscriptions[0].params.report_errors).toBe(true);
    });

    test('an editor preview has its own entry, with errors reported, next to the dashboard one', async () => {
        const { hass, subscriptions } = createHass();
        const template = "{{ states('x') }}";
        const dashboard = createOwner();
        const preview = createOwner('light.a', { inEditorPreview: true });

        getTemplateResult(hass, template, 'light.a', dashboard);
        getTemplateResult(hass, template, 'light.a', preview);
        jest.advanceTimersByTime(250);
        await flushPromiseQueue();

        expect(subscriptions).toHaveLength(2);
        expect(subscriptions[0].params.report_errors).toBe(false);
        expect(subscriptions[1].params.report_errors).toBe(true);
        expect(_templateStore().entries.size).toBe(2);

        // Each owner follows its own subscription.
        subscriptions[1].callback({ result: 'edited' });
        jest.advanceTimersByTime(0);
        await flushPromiseQueue();
        expect(getTemplateResult(hass, template, 'light.a', preview)).toBe('edited');
        expect(getTemplateResult(hass, template, 'light.a', dashboard)).toBeUndefined();
        expect(preview.onTemplateResults).toHaveBeenCalledTimes(1);
        expect(dashboard.onTemplateResults).not.toHaveBeenCalled();
    });

    test('an error before any result ends the wait, an error after keeps the last value', async () => {
        const { hass, subscriptions } = createHass();
        const owner = createOwner();
        getTemplateResult(hass, '{{ broken', 'light.a', owner);
        await flushPromiseQueue();

        subscriptions[0].callback({ error: 'TemplateSyntaxError', level: 'ERROR' });
        jest.advanceTimersByTime(0);
        await flushPromiseQueue();
        expect(getTemplateResult(hass, '{{ broken', 'light.a', owner)).toBe('');
        expect(owner.onTemplateResults).toHaveBeenCalledTimes(1);
        expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

        await deliver(subscriptions[0], 'good');
        subscriptions[0].callback({ error: 'later failure', level: 'ERROR' });
        jest.advanceTimersByTime(0);
        await flushPromiseQueue();
        expect(getTemplateResult(hass, '{{ broken', 'light.a', owner)).toBe('good');
    });

    test('errors reach the editor console once per change, and clear on the next result', async () => {
        const { hass, subscriptions } = createHass();
        const events = [];
        global.window = { dispatchEvent: jest.fn((event) => events.push(event.detail)) };
        global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
        const owner = createOwner('light.a', { inEditorPreview: true });

        getTemplateResult(hass, '{{ x }}', 'light.a', owner);
        jest.advanceTimersByTime(250);
        await flushPromiseQueue();

        subscriptions[0].callback({ error: "'x' is undefined", level: 'WARNING' });
        subscriptions[0].callback({ error: "'x' is undefined", level: 'WARNING' });
        expect(events).toHaveLength(1);
        expect(events[0].message).toBe("'x' is undefined");
        expect(events[0].context).toMatchObject({ cardType: 'button', entityId: 'light.a', sourceType: 'template', level: 'WARNING' });

        subscriptions[0].callback({ result: '' });
        expect(events).toHaveLength(2);
        expect(events[1].message).toBe('');

        // A preview rebuilt on the next keystroke takes its error away with it,
        // even though a detached element no longer sees the editor around it.
        subscriptions[0].callback({ error: 'TemplateSyntaxError', level: 'ERROR' });
        expect(events).toHaveLength(3);
        owner.inEditorPreview = false;
        releaseTemplates(owner);
        expect(events).toHaveLength(4);
        expect(events[3].message).toBe('');

        delete global.window;
        delete global.CustomEvent;
    });

    test('a refused subscription is retried after a cooldown and reported once', async () => {
        const { hass, connection } = createHass();
        connection.subscribeMessage.mockRejectedValueOnce({ code: 'template_error', message: 'Exceeded maximum execution time' });
        const owner = createOwner();

        getTemplateResult(hass, '{{ slow }}', 'light.a', owner);
        await flushPromiseQueue();
        expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

        getTemplateResult(hass, '{{ slow }}', 'light.a', owner);
        expect(connection.subscribeMessage).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(10000);
        getTemplateResult(hass, '{{ slow }}', 'light.a', owner);
        expect(connection.subscribeMessage).toHaveBeenCalledTimes(2);
    });

    test('a template the card stopped reading is let go of at the end of the render', async () => {
        const { hass } = createHass();
        const owner = createOwner();

        beginTemplateRender(owner);
        getTemplateResult(hass, '{{ a }}', 'light.a', owner);
        getTemplateResult(hass, '{{ b }}', 'light.a', owner);
        sweepTemplates(owner);
        await flushPromiseQueue();
        expect(_templateStore().entries.get('{{ a }}').owners.has(owner)).toBe(true);

        beginTemplateRender(owner);
        getTemplateResult(hass, '{{ b }}', 'light.a', owner);
        sweepTemplates(owner);

        expect(_templateStore().entries.get('{{ a }}').owners.has(owner)).toBe(false);
        expect(_templateStore().entries.get('{{ b }}').owners.has(owner)).toBe(true);
        expect(owner._templateKeys.size).toBe(1);
    });

    test('an owner that goes away is dropped from the render queue', async () => {
        const { hass, subscriptions } = createHass();
        const owner = createOwner();
        getTemplateResult(hass, '{{ 1 }}', 'light.a', owner);
        await flushPromiseQueue();

        subscriptions[0].callback({ result: 'x' });
        releaseTemplates(owner);
        jest.advanceTimersByTime(0);
        await flushPromiseQueue();

        expect(owner.onTemplateResults).not.toHaveBeenCalled();
    });

    test('a read without an owner keeps the entry alive only while it is read', async () => {
        const { hass, subscriptions } = createHass();
        getRenderedTemplate(hass, '{{ 1 }}', {}, null);
        await flushPromiseQueue();
        await deliver(subscriptions[0], 'x');

        jest.advanceTimersByTime(15000);
        expect(getRenderedTemplate(hass, '{{ 1 }}', {}, null)).toBe('x');
        jest.advanceTimersByTime(15000);
        expect(_templateStore().entries.size).toBe(1);

        jest.advanceTimersByTime(20000);
        expect(_templateStore().entries.size).toBe(0);
        expect(subscriptions[0].unsubscribe).toHaveBeenCalledTimes(1);
    });

    test('getRenderedTemplate keys on its variables and reads as a condition', async () => {
        const { hass, subscriptions } = createHass();
        const owner = createOwner();
        getRenderedTemplate(hass, '{{ value | float > 20 }}', { value: '21', entity_id: 'sensor.t' }, owner);
        getRenderedTemplate(hass, '{{ value | float > 20 }}', { value: '19', entity_id: 'sensor.t' }, owner);
        await flushPromiseQueue();

        expect(subscriptions).toHaveLength(2);
        expect(subscriptions[0].params.variables).toEqual({ value: '21', entity_id: 'sensor.t' });
        await deliver(subscriptions[0], true);
        expect(owner.onTemplateResults).toHaveBeenCalledWith(TEMPLATE_CONDITION);
    });

    test('no connection yet means pending, without an entry', () => {
        expect(getTemplateResult({}, '{{ 1 }}', 'light.a', createOwner())).toBeUndefined();
        expect(_templateStore().entries.size).toBe(0);
    });
});

describe('resolveTemplate', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        _resetTemplateStore();
    });

    afterEach(() => {
        _resetTemplateStore();
        jest.useRealTimers();
    });

    test('leaves a plain value alone and never touches the store', () => {
        const context = { _hass: createHass().hass, config: { entity: 'light.a' } };
        expect(resolveTemplate(context, 'Kitchen')).toBe('Kitchen');
        expect(resolveTemplate(context, undefined)).toBeUndefined();
        expect(resolveTemplate(context, 42)).toBe(42);
        expect(context._hass.connection.subscribeMessage).not.toHaveBeenCalled();
        expect(context._templatePending).toBeUndefined();
    });

    test('renders empty while pending and says so', async () => {
        const context = { _hass: createHass().hass, config: { entity: 'light.a' } };
        expect(resolveTemplate(context, '{{ x }}')).toBe('');
        expect(context._templatePending).toBe(true);
    });

    test('turns the parsed result into text, escaped for an innerHTML path', async () => {
        const { hass, subscriptions } = createHass();
        const context = { _hass: hass, config: { entity: 'light.a' } };
        resolveTemplate(context, '{{ x }}');
        await flushPromiseQueue();

        subscriptions[0].callback({ result: 21.5 });
        expect(resolveTemplate(context, '{{ x }}')).toBe('21.5');

        subscriptions[0].callback({ result: '<b>hi</b>' });
        expect(resolveTemplate(context, '{{ x }}')).toBe('<b>hi</b>');
        expect(resolveTemplate(context, '{{ x }}', 'light.a', true)).toBe('&lt;b&gt;hi&lt;/b&gt;');
    });

    test('a sub-button passes its own entity', async () => {
        const { hass, subscriptions } = createHass();
        const context = { _hass: hass, config: { entity: 'light.a' } };
        resolveTemplate(context, '{{ states(entity) }}', 'sensor.sub');
        await flushPromiseQueue();
        expect(subscriptions[0].params.variables.entity).toBe('sensor.sub');
    });
});
