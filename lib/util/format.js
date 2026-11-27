// Pure string/time formatting helpers shared across the runner

const noColour = String(process.env.NO_COLOR) === '1';

const colour = (code) => (s) => (noColour ? String(s) : `\x1b[${code}m${s}\x1b[0m`);

const green = colour(32);
const orange = colour(33);
const red = colour(31);
const cyan = colour(36);

/**
 * "1 thread", "2 threads"
 */
const pluralise = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

/**
 * ['a', 'b', 'c'] => 'A, b and c' (or 'a, b and c' with capitalise: false)
 */
const arrToNaturalStr = (arr, { capitalise = true } = {}) => {
    const items = arr.filter((a) => a);

    if (!items.length) {
        return '';
    }

    const str = items.length === 1
        ? items[0]
        : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

    return capitalise ? str.charAt(0).toUpperCase() + str.slice(1) : str;
};

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/**
 * 1 => 'first', 2 => 'second' ... 11 => '11th', 22 => '22nd'
 */
const ordinal = (n) => {
    if (ORDINAL_WORDS[n - 1]) {
        return ORDINAL_WORDS[n - 1];
    }

    const suffix = [11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');

    return `${n}${suffix}`;
};

const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;',
};

const escapeHtml = (str) => String(str).replace(/[&<>"'`=/]/g, (s) => HTML_ENTITIES[s]);

/**
 * Whole seconds elapsed between two `performance.now()` readings
 */
const calcTimeDifference = (end, start) => parseInt((end - start) / 1000, 10);

const secondsToNaturalString = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - (minutes * 60);

    const minutesStr = minutes ? `${pluralise(minutes, 'minute')}, ` : '';

    return `${minutesStr}${pluralise(remainingSeconds, 'second')}`.replace(', 0 seconds', '');
};

const generatePercentageBar = (percentageOfTotal, seconds) => {
    const filled = Math.round(percentageOfTotal / 2);
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 50 - filled));

    return `${bar} ${percentageOfTotal.toFixed(2)}% (${secondsToNaturalString(seconds)})`;
};

/**
 * HH:MM:SS
 */
const getTimeStr = (date = new Date()) => [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

/**
 * Shorten a path to at most `maxLength` characters, preferring to cut at a directory boundary
 */
const shortenPath = (filepath, maxLength = 60) => {
    if (filepath.length <= maxLength) {
        return filepath;
    }

    const tail = filepath.substring(filepath.length - (maxLength - 3));

    return `...${tail.match(/\/(.*)$/)?.[0] || tail}`;
};

module.exports = {
    green,
    orange,
    red,
    cyan,
    pluralise,
    arrToNaturalStr,
    ordinal,
    escapeHtml,
    calcTimeDifference,
    secondsToNaturalString,
    generatePercentageBar,
    getTimeStr,
    shortenPath,
};
