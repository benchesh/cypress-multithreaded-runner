// Runs in its own process (see setupNodeEvents.js): loads the Cypress config file, runs its e2e setupNodeEvents
// function with the config it's sent, and replies with the resulting config. Event handlers that
// setupNodeEvents registers (on('task'), on('after:run') etc.) are ignored, as Cypress isn't actually running

const { evaluateConfigFile, registerTypeScript } = require('./projectConfig');
const { toJsonSafe } = require('./setupNodeEvents');

// setupNodeEvents may require TypeScript files of its own, after the config file has loaded
registerTypeScript();

const reply = (message) => {
    process.send(message, () => process.exit(0));
};

process.once('message', async ({ configFile, config }) => {
    try {
        const fileConfig = await evaluateConfigFile(configFile);
        const setupNodeEvents = fileConfig.e2e?.setupNodeEvents;

        if (typeof setupNodeEvents !== 'function') {
            reply({ ok: true, config });
            return;
        }

        const returned = await setupNodeEvents(() => { }, config);

        // as with Cypress, the config can be changed in place or returned
        reply({ ok: true, config: toJsonSafe(returned && typeof returned === 'object' ? { ...config, ...returned } : config) });
    } catch (err) {
        reply({ ok: false, error: `setupNodeEvents threw an error: ${err?.stack || err}` });
    }
});
