// A port of @cypress/grep's matching rules, so the runner can work out up front which tests
// grep/grepTags/grepUntagged will select. Kept in sync with @cypress/grep's own utils (see unit tests)

const parseTitleGrep = (s) => {
    const str = s?.trim();

    if (!str) {
        return null;
    }

    return str.startsWith('-')
        ? { title: str.substring(1), invert: true }
        : { title: str, invert: false };
};

const parseFullTitleGrep = (s) => (s ? String(s).split(';').map(parseTitleGrep).filter((g) => g !== null) : []);

const parseTagsGrep = (s) => {
    if (!s) {
        return [];
    }

    const explicitNotTags = [];

    const ors = String(s)
        .split(/[ ,]/)
        .filter(Boolean)
        .map((part) => {
            if (part.startsWith('--')) {
                explicitNotTags.push({ tag: part.slice(2), invert: true });
                return undefined;
            }

            return part.split('+').map((tag) => (
                tag.startsWith('-') ? { tag: tag.slice(1), invert: true } : { tag, invert: false }
            ));
        })
        .filter((or) => or !== undefined);

    if (explicitNotTags.length) {
        if (!ors.length) {
            return [explicitNotTags];
        }

        return ors.map((or) => or.concat(explicitNotTags));
    }

    return ors;
};

const shouldTestRunTags = (parsedTags, tags = []) => {
    if (!parsedTags.length) {
        return true;
    }

    return parsedTags.some((orPart) => orPart.every((p) => (p.invert ? !tags.includes(p.tag) : tags.includes(p.tag))));
};

const shouldTestRunTitle = (parsedTitles, testName) => {
    if (!testName || !parsedTitles.length) {
        return true;
    }

    const inverted = parsedTitles.filter((g) => g.invert);
    const straight = parsedTitles.filter((g) => !g.invert);

    return inverted.every((g) => !testName.includes(g.title))
        && (!straight.length || straight.some((g) => testName.includes(g.title)));
};

/**
 * Parse a string the way Cypress would receive it via `--env`/`--expose` (the runner wraps values in quotes)
 */
const unquote = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value);

/**
 * Build a matcher for a phase's grep options
 *
 * @param {{grep?: string, grepTags?: string, grepUntagged?: boolean|string}} options
 * @returns {(fullTitle: string, tags: string[]) => boolean}
 */
const createGrepMatcher = ({ grep, grepTags, grepUntagged } = {}) => {
    const titles = parseFullTitleGrep(unquote(grep));
    const tags = parseTagsGrep(unquote(grepTags));
    const untagged = String(unquote(grepUntagged)) === 'true';

    return (fullTitle, testTags = []) => {
        if (untagged) {
            return !testTags.length;
        }

        return shouldTestRunTitle(titles, fullTitle) && shouldTestRunTags(tags, testTags);
    };
};

module.exports = {
    createGrepMatcher,
    parseFullTitleGrep,
    parseTagsGrep,
    shouldTestRunTitle,
    shouldTestRunTags,
};
