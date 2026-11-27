// Finding the spec files that belong to each phase

const fs = require('fs-extra');
const path = require('path');
const { getFilesRecursive } = require('../util/fs');

/**
 * Does a spec file's content satisfy the phase's onlyRunSpecFiles* text filters?
 *
 * @param {string} content the spec file's contents
 * @param {object} textFilters normalised (lowercase) filters from the phase settings
 */
const passesTextFilters = (content, textFilters) => {
    const { includingAny, includingAll, notIncludingAny, notIncludingAll } = textFilters;

    if (!includingAny && !includingAll && !notIncludingAny && !notIncludingAll) {
        return true;
    }

    const text = content.toLowerCase();

    return (!includingAny || includingAny.some((str) => text.includes(str)))
        && (!includingAll || includingAll.every((str) => text.includes(str)))
        && (!notIncludingAny || notIncludingAny.every((str) => !text.includes(str)))
        && (!notIncludingAll || notIncludingAll.some((str) => !text.includes(str)));
};

const hasAllowedExtension = (file, specFileExts) => specFileExts.some((ext) => `.${ext}` === path.extname(file));

/**
 * Does `spec` (a discovered spec file) match `specFile` (a user-provided filter entry)?
 * An entry matches if it's the same file, or if it's a trailing portion of the path with the same basename
 */
const specMatchesFilter = (spec, specFile) => (
    spec.endsWith(specFile) && path.basename(specFile) === path.basename(spec)
) || path.resolve(specFile) === path.resolve(spec);

/**
 * All spec files in a phase, after the extension and text filters have been applied
 *
 * @param {object} phase normalised phase settings
 * @returns {string[]}
 */
const findPhaseSpecFiles = (phase) => getFilesRecursive(phase.specsDir)
    .filter((file) => hasAllowedExtension(file, phase.specFileExts))
    .filter((file) => passesTextFilters(fs.readFileSync(file, 'utf8'), phase.textFilters));

module.exports = {
    passesTextFilters,
    hasAllowedExtension,
    specMatchesFilter,
    findPhaseSpecFiles,
};
