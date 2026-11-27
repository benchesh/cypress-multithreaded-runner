// Tests leave their output behind in test-artifacts/ (git ignored) so it can be inspected afterwards:
// test-artifacts/<kind>/<suite>/<name>/, plus an index.html linking to every report

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'test-artifacts');
const MARKER_FILE = 'artifact.json';

const MAX_SLUG_LENGTH = 70;

// long names are shortened, with a hash of the full name so that names differing only at the end stay distinct
const slug = (str) => {
    const full = String(str);
    const readable = full.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';

    if (readable.length <= MAX_SLUG_LENGTH) {
        return readable;
    }

    return `${readable.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '')}-${crypto.createHash('md5').update(full).digest('hex').slice(0, 8)}`;
};

const artifactDir = ({ kind, suite, name }) => path.join(ARTIFACTS_DIR, slug(kind), slug(suite), slug(name));

/**
 * Directories that have been saved, found by their marker file
 */
const listArtifacts = () => {
    const found = [];

    const walk = (dir, depth) => {
        if (!fs.existsSync(dir)) {
            return;
        }

        if (fs.existsSync(path.join(dir, MARKER_FILE))) {
            found.push({ dir, ...fs.readJsonSync(path.join(dir, MARKER_FILE), { throws: false }) });
            return;
        }

        if (depth < 4) {
            fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((entry) => walk(path.join(dir, entry.name), depth + 1));
        }
    };

    walk(ARTIFACTS_DIR, 0);

    return found.sort((a, b) => a.dir.localeCompare(b.dir));
};

/**
 * The best file to open for an artifact: the single-file Allure report if there is one
 */
const mainFile = (dir) => ['report/allure-report/complete.html', 'report/allure-report/index.html', 'report/index.html', 'index.html']
    .find((relative) => fs.existsSync(path.join(dir, relative)));

const escape = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const writeIndex = () => {
    const rows = listArtifacts().map((artifact) => {
        const relative = path.relative(ARTIFACTS_DIR, artifact.dir).split(path.sep).join('/');
        const main = mainFile(artifact.dir);

        return `<tr>
    <td>${escape(artifact.kind)}</td><td>${escape(artifact.suite)}</td><td>${escape(artifact.name)}</td>
    <td>${main ? `<a href="${relative}/${main}">${escape(main)}</a>` : '-'}</td>
    <td><a href="${relative}/">folder</a></td>
    <td>${escape(artifact.savedAt)}</td>
</tr>`;
    });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Test artefacts</title>
<style>body { font-family: sans-serif; margin: 20px; } td, th { padding: 4px 12px; text-align: left; } tr:nth-child(even) { background: #f2f2f2; }</style>
</head>
<body>
<h1>Test artefacts</h1>
<p>Each row is the output of a test. Open the single-file Allure report (<code>complete.html</code>) directly in a browser. To view a multi-file Allure report (<code>allure-report/index.html</code>), serve its folder with <code>npx allure open &lt;folder&gt;</code>.</p>
<table>
<tr><th>Kind</th><th>Suite</th><th>Test</th><th>Open</th><th>Files</th><th>Saved</th></tr>
${rows.join('\n')}
</table>
</body>
</html>
`;

    const file = path.join(ARTIFACTS_DIR, 'index.html');
    const temporary = `${file}.${process.pid}.tmp`;

    fs.writeFileSync(temporary, html);
    fs.renameSync(temporary, file); // atomic, as test files run in parallel processes
};

const mark = (location, dest) => {
    fs.writeJsonSync(path.join(dest, MARKER_FILE), { ...location, savedAt: new Date().toISOString() });
    writeIndex();
    return dest;
};

/**
 * Copy a directory into test-artifacts, replacing anything saved by the same test before
 *
 * @param {{kind: string, suite: string, name: string}} location e.g. {kind: 'integration', suite: 'runner', name: 'my test'}
 * @param {string} source
 * @returns {string} where it was saved
 */
const keepDirectory = (location, source) => {
    const dest = artifactDir(location);

    fs.rmSync(dest, { recursive: true, force: true });
    fs.copySync(source, dest);

    return mark(location, dest);
};

/**
 * Save individual files ({filename: content}) into test-artifacts. Objects are saved as JSON
 */
const keepFiles = (location, files) => {
    const dest = artifactDir(location);

    fs.rmSync(dest, { recursive: true, force: true });

    Object.entries(files).forEach(([filename, content]) => {
        fs.outputFileSync(path.join(dest, filename), typeof content === 'string' ? content : `${JSON.stringify(content, null, 4)}\n`);
    });

    return mark(location, dest);
};

module.exports = {
    ARTIFACTS_DIR,
    keepDirectory,
    keepFiles,
    listArtifacts,
};
