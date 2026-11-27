// Resolves the customLogs option into a list of headings and content

/**
 * @param {Array<{heading?: string, content?: string, generateContent?: () => string}>} customLogs
 * @returns {Array<{heading: string, content: string}>}
 */
const resolveCustomLogs = (customLogs) => customLogs.map((customLog, index) => {
    let content = customLog?.content ?? '';

    if (typeof customLog?.generateContent === 'function') {
        let generated;

        try {
            generated = customLog.generateContent();
        } catch (err) {
            generated = `ERROR: Failed to generate customLogs[${index}] content; please check the generateContent function: ${err.message}`;
        }

        content = content ? `${content}\n\n${generated}` : generated;
    }

    return {
        heading: customLog?.heading || `Custom Logs ${index + 1}`,
        content: String(content),
    };
});

module.exports = {
    resolveCustomLogs,
};
