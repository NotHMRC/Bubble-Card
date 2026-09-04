// What makes a string a Home Assistant template, what a template reads, and
// how a styles block that mixes Home Assistant templates with JavaScript
// `${ }` templates is taken apart before compilation.
//
// A leaf module on purpose, no imports. Both the template store and the style
// pipeline need it, and neither should drag the other in.

// The exact test the Home Assistant frontend uses (src/common/string/has-template.ts),
// written as two indexOf so a card without templates pays nothing measurable
// for the check that runs on every render of every text field.
export function isTemplate(value) {
    return typeof value === 'string' && (value.indexOf('{{') !== -1 || value.indexOf('{%') !== -1);
}

// Everything below keyed by a template string shares one shape: computed once
// per distinct string, the most recent ~1000 kept, 100 evicted at a time.
function memoByTemplate(cache, template, compute) {
    const cached = cache.get(template);
    if (cached !== undefined) return cached;
    const value = compute(template);
    cache.set(template, value);
    if (cache.size > 1000) {
        const iterator = cache.keys();
        for (let i = 0; i < 100; i++) {
            const key = iterator.next().value;
            if (key !== undefined) cache.delete(key);
        }
    }
    return value;
}

// Which of the variables a card can hand to the server the template actually
// reads. A template that never mentions `entity` renders the same for every
// card, so it is shared by all of them instead of subscribed once per card.
// `config` counts as `entity`, it is card-mod's way of reaching the same value.
const ENTITY_RE = /\b(?:entity|config)\b/;
const USER_RE = /\buser\b/;
const usageCache = new Map();
export function templateUsage(template) {
    return memoByTemplate(usageCache, template, (t) => ({
        entity: ENTITY_RE.test(t),
        user: USER_RE.test(t),
    }));
}

// Escapes the three characters that would let a rendered value be read as
// markup, for the text paths that write innerHTML.
export function escapeHtml(text) {
    if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1) return text;
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The server parses what it renders: "21.50" comes back as the number 21.5,
// "True" as a boolean, "[1, 2]" as a list, "None" as null. Text fields want
// text, like the developer tools show it.
export function templateResultToText(result) {
    if (result === undefined || result === null) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'object') {
        try { return JSON.stringify(result); } catch (_) { return String(result); }
    }
    return String(result);
}

const SIMPLE_ESCAPES = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
};

function isHexDigit(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

// Gives a piece of template literal SOURCE the value the literal would have
// given it. A styles block is compiled as one template literal today, so its
// escape sequences are resolved before any CSS sees them. The parts that go to
// the server for rendering leave that literal, and cooking them first is what
// keeps a backslash meaning the same thing whether or not the block has a Jinja
// expression somewhere else in it. An escape the literal would have rejected
// as a syntax error simply loses its backslash here.
export function cookTemplateLiteral(text) {
    if (text.indexOf('\\') === -1 && text.indexOf('\r') === -1) return text;

    let out = '';
    const n = text.length;
    for (let i = 0; i < n; i++) {
        const c = text[i];
        if (c === '\r') {
            // A template literal normalises every line ending to a line feed.
            if (text[i + 1] === '\n') i++;
            out += '\n';
            continue;
        }
        if (c !== '\\') {
            out += c;
            continue;
        }

        const next = text[i + 1];
        if (next === undefined) break;

        if (next === '\n') { i++; continue; }
        if (next === '\r') { i += text[i + 2] === '\n' ? 2 : 1; continue; }

        if (next === 'x' && isHexDigit(text.charCodeAt(i + 2)) && isHexDigit(text.charCodeAt(i + 3))) {
            out += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
            i += 3;
            continue;
        }

        if (next === 'u') {
            if (text[i + 2] === '{') {
                const close = text.indexOf('}', i + 3);
                if (close !== -1) {
                    const point = parseInt(text.slice(i + 3, close), 16);
                    if (!Number.isNaN(point)) {
                        out += String.fromCodePoint(point);
                        i = close;
                        continue;
                    }
                }
            } else if (isHexDigit(text.charCodeAt(i + 2)) && isHexDigit(text.charCodeAt(i + 3))
                && isHexDigit(text.charCodeAt(i + 4)) && isHexDigit(text.charCodeAt(i + 5))) {
                out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
                i += 5;
                continue;
            }
        }

        out += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next) ? SIMPLE_ESCAPES[next] : next;
        i++;
    }
    return out;
}

// Characters after which a `/` starts a regular expression rather than a
// division. The usual heuristic, and enough for the code found in a styles
// block.
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else']);

function slashStartsRegex(s, slashAt, exprStart) {
    let j = slashAt - 1;
    while (j >= exprStart && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j--;
    if (j < exprStart) return true;
    const prev = s[j];
    if (REGEX_PRECEDERS.indexOf(prev) !== -1) return true;
    if (/[A-Za-z_$]/.test(prev)) {
        let k = j;
        while (k > exprStart && /[A-Za-z0-9_$]/.test(s[k - 1])) k--;
        return REGEX_KEYWORDS.has(s.slice(k, j + 1));
    }
    return false;
}

function skipQuoted(s, i, quote) {
    const n = s.length;
    i++;
    while (i < n) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) return i + 1;
        if (c === '\n' && quote !== '`') return i;
        i++;
    }
    return n;
}

function skipRegex(s, i) {
    const n = s.length;
    i++;
    let inClass = false;
    while (i < n) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') return i;
        if (inClass) {
            if (c === ']') inClass = false;
        } else if (c === '[') {
            inClass = true;
        } else if (c === '/') {
            return i + 1;
        }
        i++;
    }
    return n;
}

// `i` is the index right after a `${`. Returns the index right after the `}`
// that closes it, or the end of the string when it is never closed.
function skipExpression(s, i) {
    const n = s.length;
    const exprStart = i;
    let depth = 1;
    while (i < n) {
        const c = s[i];
        if (c === '"' || c === "'") { i = skipQuoted(s, i, c); continue; }
        if (c === '`') { i = skipTemplateLiteral(s, i); continue; }
        if (c === '/') {
            const next = s[i + 1];
            if (next === '/') {
                const eol = s.indexOf('\n', i);
                i = eol === -1 ? n : eol;
                continue;
            }
            if (next === '*') {
                const end = s.indexOf('*/', i + 2);
                i = end === -1 ? n : end + 2;
                continue;
            }
            if (slashStartsRegex(s, i, exprStart)) { i = skipRegex(s, i); continue; }
            i++;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
        i++;
    }
    return n;
}

// `i` is the index of an opening backtick. Returns the index right after the
// closing one, going through any `${ }` nested inside on the way.
function skipTemplateLiteral(s, i) {
    const n = s.length;
    i++;
    while (i < n) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`') return i + 1;
        if (c === '$' && s[i + 1] === '{') { i = skipExpression(s, i + 2); continue; }
        i++;
    }
    return n;
}

// `i` is the index of the `{` opening a Jinja tag whose second character is
// `open`. Returns the index right after its closer, or the end of the string.
// Quoted strings inside an expression or a statement are skipped, so a `}}`
// inside one does not close the tag.
function skipJinjaTag(s, i, open) {
    const n = s.length;
    const close = open === '{' ? '}}' : open === '%' ? '%}' : '#}';
    i += 2;
    while (i < n) {
        const c = s[i];
        if (open !== '#' && (c === '"' || c === "'")) { i = skipQuoted(s, i, c); continue; }
        if (c === close[0] && s[i + 1] === close[1]) return i + 2;
        i++;
    }
    return n;
}

// Statements that open a block and must be closed inside the same segment. A
// block that straddles a JavaScript `${ }` span would reach the server in two
// halves, each of them a syntax error.
const BLOCK_OPEN_RE = /\{%-?\s*(if|for|macro|call|filter|with|raw|autoescape|trans)\b|\{%-?\s*set\s+\w+\s*-?%\}/g;
const BLOCK_CLOSE_RE = /\{%-?\s*end(if|for|macro|call|filter|with|raw|autoescape|trans|set)\b/g;

function hasBalancedBlocks(template) {
    const opens = template.match(BLOCK_OPEN_RE);
    const closes = template.match(BLOCK_CLOSE_RE);
    return (opens ? opens.length : 0) === (closes ? closes.length : 0);
}

// Takes a styles block apart into the JavaScript `${ }` spans, kept verbatim,
// and the literal text between them. In every literal span, the run from its
// first Jinja tag to its last one becomes one segment, sent to the server
// whole so a `{% if %} ... {% endif %}` block is rendered together with the
// CSS inside it, and replaced in the source by `${__jinja[i]}`. The CSS before
// and after the run stays in the source, which keeps the payload down to the
// template itself and keeps the spaces around it on the client, where the
// server would strip them. The source is compiled once, like any other styles
// block, and the rendered segments are handed to it as values at each
// evaluation.
//
// The text between the tags of a segment is cooked with the escape semantics
// of the template literal it leaves, the text inside a tag goes to the server
// verbatim, so a backslash in a Jinja string literal means what it means in
// Home Assistant.
//
// Returns null when the block has no template at all, so the caller can tell
// the common case apart without allocating anything for it.
export function splitStyleTemplate(styles) {
    if (!isTemplate(styles)) return null;

    const n = styles.length;
    const segments = [];
    const unbalanced = [];
    let source = '';
    let literalStart = 0;
    let tags = [];

    const flushLiteral = (end) => {
        if (end <= literalStart) return;
        if (tags.length === 0) {
            source += styles.slice(literalStart, end);
            return;
        }
        const first = tags[0][0];
        const last = tags[tags.length - 1][1];
        let template = '';
        let at = first;
        for (const [start, stop] of tags) {
            template += cookTemplateLiteral(styles.slice(at, start)) + styles.slice(start, stop);
            at = stop;
        }
        if (!hasBalancedBlocks(template)) unbalanced.push(segments.length);
        source += styles.slice(literalStart, first) + '${__jinja[' + segments.length + ']}' + styles.slice(last, end);
        segments.push(template);
        tags = [];
    };

    let i = 0;
    while (i < n) {
        const c = styles[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '{') {
            const next = styles[i + 1];
            if (next === '{' && styles[i + 2] === '%') {
                // `{{%` is a brace followed by a statement, not an expression.
                i++;
                continue;
            }
            if (next === '{' || next === '%' || next === '#') {
                const end = skipJinjaTag(styles, i, next);
                tags.push([i, end]);
                i = end;
                continue;
            }
            i++;
            continue;
        }
        if (c === '$' && styles[i + 1] === '{') {
            flushLiteral(i);
            const end = skipExpression(styles, i + 2);
            source += styles.slice(i, end);
            i = end;
            literalStart = i;
            continue;
        }
        i++;
    }
    flushLiteral(n);

    if (segments.length === 0) return null;
    return { source, segments, unbalanced };
}
