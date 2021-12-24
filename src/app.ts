import { TelnetSequence } from './telnet-sequence';

(async function (): Promise<void> {
  const ts = new TelnetSequence({
    host: 'horizons.jpl.nasa.gov',
    port: 6775,
    timeout: 30000,
    echoToConsole: true,
    stripControls: true
  },
  [
    { prompt: 'Horizons> ', response: '?' },
    { prompt: 'Horizons> ', response: 'x' }
  ]);

  try {
    await ts.process(_line => {}, esc => {
      if (esc === '\x1B[6n')
        return '\x1B[24;80R';
      else if (esc === '\x1B[7m') // This escape sequence (setting reverse video) precedes pausing at a paging prompt
        return ' ';
      else
        return null;
    });
  }
  catch (err) {
    console.error(err);
  }
})();
