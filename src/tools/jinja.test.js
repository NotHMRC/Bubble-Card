import { describe, expect, test } from '@jest/globals';
import {
    isTemplate,
    templateUsage,
    escapeHtml,
    templateResultToText,
    cookTemplateLiteral,
    splitStyleTemplate,
} from './jinja.js';

describe('isTemplate', () => {
    test('matches what the Home Assistant frontend matches', () => {
        expect(isTemplate("{{ states('x') }}")).toBe(true);
        expect(isTemplate('{% if x %}a{% endif %}')).toBe(true);
        expect(isTemplate('Kitchen')).toBe(false);
        expect(isTemplate('{ single: brace }')).toBe(false);
        expect(isTemplate('')).toBe(false);
        expect(isTemplate(undefined)).toBe(false);
        expect(isTemplate({ a: 1 })).toBe(false);
    });
});

describe('templateUsage', () => {
    test('reports whether a template reads entity, config or user', () => {
        expect(templateUsage("{{ states(entity) }}")).toEqual({ entity: true, user: false });
        expect(templateUsage("{{ is_state(config.entity, 'on') }}")).toEqual({ entity: true, user: false });
        expect(templateUsage("Hello {{ user }}")).toEqual({ entity: false, user: true });
        expect(templateUsage("{{ states('sensor.outdoor') }}")).toEqual({ entity: false, user: false });
        // A word boundary is enough to keep entity_id apart from entity.
        expect(templateUsage("{{ states.sensor.a.entity_id }}")).toEqual({ entity: false, user: false });
    });

    test('answers from a memo for the same string', () => {
        const a = templateUsage('{{ entity }}');
        expect(templateUsage('{{ entity }}')).toBe(a);
    });
});

describe('escapeHtml', () => {
    test('neutralises markup and leaves plain text alone', () => {
        const plain = 'Living room 21.5 °C';
        expect(escapeHtml(plain)).toBe(plain);
        expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });
});

describe('templateResultToText', () => {
    test('turns the parsed server result back into text', () => {
        expect(templateResultToText('on')).toBe('on');
        expect(templateResultToText(21.5)).toBe('21.5');
        expect(templateResultToText(0)).toBe('0');
        expect(templateResultToText(false)).toBe('false');
        expect(templateResultToText(null)).toBe('');
        expect(templateResultToText(undefined)).toBe('');
        expect(templateResultToText([1, 'a'])).toBe('[1,"a"]');
        expect(templateResultToText({ a: 1 })).toBe('{"a":1}');
    });
});

// The reference is the JavaScript engine itself: cooking a piece of source
// must give the same string as putting that source in a template literal.
function cookedByTheEngine(source) {
    return Function('return `' + source + '`;')();
}

describe('cookTemplateLiteral', () => {
    test.each([
        ['plain text with no backslash', 'plain'],
        ['a newline escape', 'line1\\nline2'],
        ['a tab and a carriage return escape', 'a\\tb\\rc'],
        ['a double backslash', 'C:\\\\path'],
        ['a hex escape', '\\x41'],
        ['a unicode escape', '\\u2014'],
        ['a code point escape', '\\u{1F600}'],
        ['an unknown escape loses its backslash', '\\A \\q'],
        ['a CSS content escape written the way users write it', 'content: "\\\\2014"'],
        ['an escaped dollar brace', '\\${not js}'],
        ['an escaped backtick', 'a\\`b'],
        ['a line continuation', 'a\\\nb'],
    ])('%s', (_label, source) => {
        expect(cookTemplateLiteral(source)).toBe(cookedByTheEngine(source));
    });

    test('normalises Windows line endings like the literal does', () => {
        expect(cookTemplateLiteral('a\r\nb\rc')).toBe('a\nb\nc');
    });

    test('drops a lone trailing backslash instead of throwing', () => {
        expect(cookTemplateLiteral('abc\\')).toBe('abc');
    });
});

describe('splitStyleTemplate', () => {
    test('returns null for a block without any Home Assistant template', () => {
        expect(splitStyleTemplate('.a { color: ${state === "on" ? "red" : "blue"}; }')).toBeNull();
        expect(splitStyleTemplate('.a { color: red; }')).toBeNull();
        expect(splitStyleTemplate('')).toBeNull();
    });

    test('sends only the run of tags, the CSS around it stays in the source', () => {
        const styles = ".a { color: {{ states('x') }}; }";
        expect(splitStyleTemplate(styles)).toEqual({
            source: '.a { color: ${__jinja[0]}; }',
            segments: ["{{ states('x') }}"],
            unbalanced: [],
        });
    });

    test('two tags in one literal span become one segment with the CSS between them', () => {
        const result = splitStyleTemplate(".a { color: ${'blue'}; b: {{ x }}; c: {{ y }}; }");
        expect(result.source).toBe(".a { color: ${'blue'}; b: ${__jinja[0]}; }");
        expect(result.segments).toEqual(['{{ x }}; c: {{ y }}']);
    });

    test('the spaces next to a JavaScript span stay on the client', () => {
        // The server strips both the template and its result, so a segment
        // that started or ended with a space would glue two values together.
        const result = splitStyleTemplate(".a { border: ${w} solid {{ c }}; margin: {{ m }}px ${x}; }");
        expect(result.source).toBe('.a { border: ${w} solid ${__jinja[0]}px ${x}; }');
        expect(result.segments).toEqual(['{{ c }}; margin: {{ m }}']);
    });

    test('an if block is sent whole with the CSS inside it', () => {
        const styles = ".a { {% if is_state('x', 'on') %} color: red; {% endif %} }";
        const result = splitStyleTemplate(styles);
        expect(result.source).toBe('.a { ${__jinja[0]} }');
        expect(result.segments).toEqual(["{% if is_state('x', 'on') %} color: red; {% endif %}"]);
        expect(result.unbalanced).toEqual([]);
    });

    test('a block that straddles a JavaScript span is reported as unbalanced', () => {
        const result = splitStyleTemplate(".a { {% if x %} color: ${c}; {% endif %} }");
        expect(result.segments).toEqual(['{% if x %}', '{% endif %}']);
        expect(result.unbalanced).toEqual([0, 1]);
    });

    test('a set with a value is not a block, a set block is', () => {
        expect(splitStyleTemplate('.a { --x: {% set v = 1 %}{{ v }}; }').unbalanced).toEqual([]);
        expect(splitStyleTemplate('.a { --x: {% set v %}1{% endset %}{{ v }}; }').unbalanced).toEqual([]);
        expect(splitStyleTemplate('.a { --x: {% for i in [1] %}{{ i }}; }').unbalanced).toEqual([0]);
    });

    test('a closing brace inside a regular expression does not end the span', () => {
        const styles = ".a { content: '${ 'ab}cd'.replace(/\\}/g, '-') }'; color: {{ x }}; }";
        const result = splitStyleTemplate(styles);
        expect(result.source).toBe(".a { content: '${ 'ab}cd'.replace(/\\}/g, '-') }'; color: ${__jinja[0]}; }");
        expect(result.segments).toEqual(['{{ x }}']);
    });

    test('a division is not mistaken for a regular expression', () => {
        const result = splitStyleTemplate(".a { width: ${ 100 / 2 }px; color: {{ x }}; }");
        expect(result.source).toBe('.a { width: ${ 100 / 2 }px; color: ${__jinja[0]}; }');
    });

    test('a closing brace inside a line comment does not end the span', () => {
        const styles = ".a { color: ${\n  // closing } here\n  'red'\n}; background: {{ y }}; }";
        const result = splitStyleTemplate(styles);
        expect(result.source).toBe(".a { color: ${\n  // closing } here\n  'red'\n}; background: ${__jinja[0]}; }");
    });

    test('a closing brace inside a block comment does not end the span', () => {
        const styles = ".a { color: ${ /* } */ 'red' }; background: {{ y }}; }";
        expect(splitStyleTemplate(styles).source).toBe(".a { color: ${ /* } */ 'red' }; background: ${__jinja[0]}; }");
    });

    test('a nested template literal with its own interpolation is skipped whole', () => {
        const styles = ".a { color: ${ `rgb(${r}, ${g}, 0)` }; b: {{ x }}; }";
        expect(splitStyleTemplate(styles).source).toBe(".a { color: ${ `rgb(${r}, ${g}, 0)` }; b: ${__jinja[0]}; }");
    });

    test('an object literal inside the span is balanced', () => {
        const styles = ".a { color: ${ ({ on: 'red', off: 'blue' })[state] }; b: {{ x }}; }";
        expect(splitStyleTemplate(styles).source).toBe(".a { color: ${ ({ on: 'red', off: 'blue' })[state] }; b: ${__jinja[0]}; }");
    });

    test('a string containing a dollar brace inside the span is skipped', () => {
        const styles = ".a { content: ${ '${' }; b: {{ x }}; }";
        expect(splitStyleTemplate(styles).source).toBe(".a { content: ${ '${' }; b: ${__jinja[0]}; }");
    });

    test('a Jinja tag inside a JavaScript span belongs to the JavaScript', () => {
        // The documented way to reach a condition from a JS template today.
        const styles = ".a { display: ${checkConditionsMet([{condition: 'template', value_template: '{{ is_state(\"x\", \"on\") }}'}], hass) ? 'block' : 'none'}; color: {{ c }}; }";
        const result = splitStyleTemplate(styles);
        expect(result.segments).toEqual(['{{ c }}']);
        expect(result.source.startsWith(".a { display: ${checkConditionsMet(")).toBe(true);
    });

    test('a dollar brace inside a Jinja tag does not open a JavaScript span', () => {
        const result = splitStyleTemplate(".a { content: \"{{ '${x}' }}\"; }");
        expect(result.source).toBe('.a { content: "${__jinja[0]}"; }');
        expect(result.segments).toEqual(["{{ '${x}' }}"]);
    });

    test('a closing pair inside a Jinja string does not close the tag', () => {
        const result = splitStyleTemplate(".a { content: \"{{ '}}' }}\"; }");
        expect(result.segments).toEqual(["{{ '}}' }}"]);
    });

    test('a brace right before a statement is a brace', () => {
        const result = splitStyleTemplate('.a{{% if x %}color: red;{% endif %}}');
        expect(result.source).toBe('.a{${__jinja[0]}}');
        expect(result.segments).toEqual(['{% if x %}color: red;{% endif %}']);
    });

    test('a Jinja comment travels with the segment', () => {
        const result = splitStyleTemplate('.a { {# note #} color: {{ c }}; }');
        expect(result.segments).toEqual(['{# note #} color: {{ c }}']);
    });

    test('an apostrophe in the CSS outside any span is just text', () => {
        const result = splitStyleTemplate(".a::after { content: \"it's\"; color: {{ c }}; } .b { color: ${x}; }");
        expect(result.source).toBe('.a::after { content: "it\'s"; color: ${__jinja[0]}; } .b { color: ${x}; }');
    });

    test('an escaped dollar brace in the literal is not a span', () => {
        const styles = ".a { content: '\\${literal}'; b: {{ x }}; }";
        const result = splitStyleTemplate(styles);
        expect(result.source).toBe(".a { content: '\\${literal}'; b: ${__jinja[0]}; }");
    });

    test('a span that is never closed swallows the rest, which then holds no segment', () => {
        // The block would not compile as a template literal either, so there
        // is nothing to send to the server and the caller sees no template.
        expect(splitStyleTemplate(".a { color: ${ 'red'; b: {{ x }}; }")).toBeNull();
    });

    test('the text between tags is cooked, the text inside a tag is not', () => {
        const styles = '.a::after { content: "{{ a }}\\A{{ b }}"; --r: {{ x | regex_replace("(\\\\d+)", "\\\\1") }}; }';
        const result = splitStyleTemplate(styles);
        expect(result.segments).toEqual(['{{ a }}A{{ b }}"; --r: {{ x | regex_replace("(\\\\d+)", "\\\\1") }}']);
    });

    test('the placeholder source compiles and interpolates the rendered segments', () => {
        const styles = ".a { color: ${'blue'}; background: {{ x }}; }";
        const { source, segments } = splitStyleTemplate(styles);
        const fn = Function('__jinja', 'return `' + source + '`;');
        const rendered = segments.map((s) => s.replace('{{ x }}', 'red'));
        expect(fn(rendered)).toBe('.a { color: blue; background: red; }');
    });

    test('a rendered value cannot break out of the literal', () => {
        const { source, segments } = splitStyleTemplate('{{ dangerous }}');
        const fn = Function('__jinja', 'return `' + source + '`;');
        expect(segments).toEqual(['{{ dangerous }}']);
        expect(fn(['a`b${c}'])).toBe('a`b${c}');
    });
});
