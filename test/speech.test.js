const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Speech, localeFor } = require('../electron/speech');

const helper = path.join(__dirname, 'fixtures/fake-speech.cjs');

test('speech: the locale follows the Mac when it is in the chosen language', () => {
  assert.equal(localeFor('en', 'en-GB'), 'en-GB');
  assert.equal(localeFor('en', 'en_AU'), 'en-AU');
  assert.equal(localeFor('en', 'de-DE'), 'en-US');
  assert.equal(localeFor('pt', 'en-US'), 'pt-BR');
  assert.equal(localeFor('xx', 'en-US'), 'xx');
});

test('speech: partial text streams while recording; stop gives the final text', async () => {
  const events = [];
  const speech = new Speech({ helper, onEvent: e => events.push(e) });
  await speech.start('en-GB');
  await assert.rejects(speech.start('en-GB'), /already on/);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(events, [{ type: 'level', value: 0.4 }, { type: 'partial', text: 'hello from en-GB' }]);
  assert.equal(await speech.stop(), 'Hello from en-GB.');
  assert.equal(await speech.stop(), ''); // nothing is recording now
  // A new recording can start after the last one ended.
  await speech.start('en-US');
  speech.cancel();
  await speech.start('en-US');
  assert.equal(await speech.stop(), 'Hello from en-US.');
});

test('speech: a denied permission, a missing helper, and a macOS stop give clear errors', async () => {
  const run = async mode => { process.env.FAKE_SPEECH = mode; try { await new Speech({ helper }).start('en-US'); } finally { delete process.env.FAKE_SPEECH; } };
  await assert.rejects(run('deny'), /cannot use speech recognition/);
  await assert.rejects(run('abort'), /no speech permission text/);
  await assert.rejects(new Speech({ helper: '/nope/orin-speech' }).start('en-US'), /helper is missing/);
});
