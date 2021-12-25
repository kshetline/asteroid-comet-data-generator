import { TelnetSequence } from './telnet-sequence';
import { DateTime } from '@tubular/time';

async function getBodyData(name: string, designation: string, isAsteroid: boolean,
                           startDate: DateTime, endDate: DateTime, interval: string): Promise<void> {
  const des = designation.startsWith('DES=');
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
    { prompt: 'Horizons> ', response: designation },
    des ?
      { prompt: 'Continue [ <cr>=yes, n=no, ? ] : ', response: '' } :
      { prompt: null, response: null },
    { prompt: '?,<cr>: ', response: 'E' },
    { prompt: '[o,e,v,?] : ', response: 'e' },
    { prompt: '[ ###, ? ] : ', response: '10' },
    { prompt: '[eclip, frame, body ] : ', response: 'eclip' },
    { prompt: /00:\d\d] : $/, response: startDate.toIsoString(10) },
    { prompt: /:\d\d] : $/, response: endDate.toIsoString(10) },
    { prompt: '? ] : ', response: interval },
    { prompt: '?] : ', response: '' },
    { prompt: '[R]edisplay, ? : ', response: 'N' },
    { prompt: 'Horizons> ', response: 'x' }
  ]);

  await ts.process(_line => {}, esc => {
    if (esc === '\x1B[6n')
      return '\x1B[24;80R';
    else if (esc === '\x1B[7m') // This escape sequence (setting reverse video) precedes pausing at a paging prompt
      return ' ';
    else
      return null;
  });
}

(async function (): Promise<void> {
  try {
    await getBodyData('Ceres', '1;', true, new DateTime('2021-12-01Z'), new DateTime('2021-12-31Z'), '1d');
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
