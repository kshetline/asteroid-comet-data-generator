import { TelnetSequence } from './telnet-sequence';

(async function (): Promise<void> {
  const ts = new TelnetSequence({
    host: 'horizons.jpl.nasa.gov',
    port: 6775,
    timeout: 30000,
    sessionTimeout: 120000,
    echoToConsole: true,
    stripControls: true
  },
  [
    { prompt: 'Horizons> ', response: 'tty 99999 79' },
    { prompt: 'Horizons> ', response: '90000033:' },
    // { prompt: 'Continue [ <cr>=yes, n=no, ? ] : ', response: '' },
    { prompt: '?,<cr>: ', response: 'E' },
    { prompt: '[o,e,v,?] : ', response: 'e' },
    { prompt: '[ ###, ? ] : ', response: '10' },
    { prompt: '[eclip, frame, body ] : ', response: 'eclip' },
    { prompt: /00:\d\d] : $/, response: '2021-12-01' },
    { prompt: /:\d\d] : $/, response: '2021-12-31' },
    { prompt: '? ] : ', response: '1d' },
    { prompt: '?] : ', response: '' },
    { prompt: '[R]edisplay, ? : ', response: 'N' },
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
    process.exit(1);
  }
})();
