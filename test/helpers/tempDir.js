const fs = require('fs-extra');
const os = require('os');
const path = require('path');

/**
 * Create a temporary directory containing the given files ({relative path: content})
 *
 * @returns {{dir: string, file: (relative: string) => string, cleanup: () => void}}
 */
const createTempDir = (files = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-test-'));

    Object.entries(files).forEach(([relative, content]) => {
        const filepath = path.join(dir, relative);
        fs.mkdirSync(path.dirname(filepath), { recursive: true });
        fs.writeFileSync(filepath, typeof content === 'string' ? content : JSON.stringify(content));
    });

    return {
        dir,
        file: (relative) => path.join(dir, relative),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
};

module.exports = {
    createTempDir,
};
