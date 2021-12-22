import { Telnet } from './telnet';

(async function (): Promise<void> {
  const conn = new Telnet();

  conn.on('connect', () => console.log('connect'));
  conn.on('ready', () => console.log('ready'));
  conn.on('data', data => console.log('data:', data.toString()));

  try {
    await conn.connect({
      host: 'horizons.jpl.nasa.gov',
      port: 6775,
      timeout: 2000000
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    await conn.send('?', { waitfor: 'Horizons> ' });
    await conn.send('x');
  }
  catch (err) {
    console.error(err);
  }
  finally {
    await conn.end();
  }
})();
