import { TelnetSequence } from './telnet-sequence';

(async function (): Promise<void> {
  const ts = new TelnetSequence({
    host: 'horizons.jpl.nasa.gov',
    port: 6775,
    timeout: 30000,
    echoToConsole: true
  },
  [
    { prompt: 'Horizons> ', response: '?' },
    { prompt: 'Horizons> ', response: 'x' }
  ]);

  try {
    await ts.process(_line => false);
  }
  catch (err) {
    console.error(err);
  }
})();
