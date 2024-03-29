import { TelnetSequence } from './telnet-sequence';
import ttime, { DateTime } from '@tubular/time';
import { Emitter } from './emitter';
import { toNumber } from '@tubular/util';
import { AdditionalOrbitingObjects, EARTH, K_DEG, ObjectInfo, SolarSystem } from '@tubular/astronomy';
import { abs, floor, max, sign, sqrt, Unit } from '@tubular/math';
import millisFromJulianDay = ttime.millisFromJulianDay;
import { mkdir, readFile, writeFile } from 'fs/promises';
import * as JSONZ from 'json-z';

enum ReadState { SEEK_START, SEEK_DATE, IN_ELEMENTS }

interface BodyInfo {
  name: string;
  designation: string;
  H: number;
  G: number;
}

interface ObjectInfoMod {
  epoch: string;
  q: number;
  e: number;
  i: number;
  w: number;
  L: number;
  Tp: number;
}

interface BodyAndElements {
  body: BodyInfo;
  elements: ObjectInfo[];
}

const YEAR_SPAN = 100;

const solarSystem = new SolarSystem();

const datePattern = /(^\d+\.\d+).*\b(\d{4}-[A-Za-z]{3}-\d{2})/;
const qrPattern = /\bQR\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const ecPattern = /\bEC\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const inPattern = /\bIN\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const w_Pattern = /\bW\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const omPattern = /\bOM\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const tpPattern = /\bTp\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const a_Pattern = /\bA\s*=\s*-?(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const n_Pattern = /\bN\s*=\s*(\d+(\.\d*)?(E[-+]\d{2})?)\b/;
const h_Pattern = /\bH\s*=\s*((\d+(\.\d*)?)|(\.\d+))\b/;
const g_Pattern = /\bG\s*=\s*((\d+(\.\d*)?)|(\.\d+))\b/;

function getFormattedDateFromJulianDay(jd: number): string {
  return new DateTime(millisFromJulianDay(jd), 'UTC').toIsoString(10);
}

function escapeHandler(esc: string): string {
  if (esc === '\x1B[6n')
    return '\x1B[24;80R';
  else if (esc === '\x1B[7m') // This escape sequence (setting reverse video) precedes pausing at a paging prompt
    return ' ';
  else
    return null;
}

async function getBodyData(name: string, designation: string, isAsteroid: boolean,
                           startDate: DateTime, endDate: DateTime, interval: string): Promise<BodyAndElements> {
  let resolve: any;
  let reject: any;
  const result = new Promise<BodyAndElements>((_resolve, _reject) => { resolve = _resolve; reject = _reject; });
  const des = designation.startsWith('DES=');
  const lineSource = new Emitter<string | null>();
  const ts = new TelnetSequence({
    host: 'horizons.jpl.nasa.gov',
    port: 6775,
    timeout: 30000,
    sessionTimeout: 120000,
    echoToConsole: false,
    escapeHandler,
    stripControls: true
  },
  [
    { prompt: 'Horizons> ', response: 'tty 99999 80' },
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

  const body = {} as BodyInfo;
  const elements: ObjectInfo[] = [];

  setTimeout(async () => {
    let line: string;
    let state = ReadState.SEEK_START;
    let oi: ObjectInfo = null;
    let refOI: ObjectInfo = null;
    let lastOI: ObjectInfo = null;
    let physicalParams = false;
    let H: number = null;
    let G: number = null;
    let $: RegExpExecArray;
    let fieldMatches = 0;
    let fieldsNeeded = 0;
    const aoo = new AdditionalOrbitingObjects();
    const tolerance = 1.0; // Minutes of arc, heliocentric longitude or latitude.
    const byMonth = (interval === '1 MO');
    let startOfTrouble: string = null;
    const troubleSpots: string[] = [];
    let partialLine = '';

    while ((line = await lineSource.get()) !== null) {
      line = partialLine + line;
      partialLine = '';
      const pos = line.indexOf('\n');

      if (pos < 0) {
        partialLine = line;
        continue;
      }

      partialLine = line.substring(pos + 1);
      line = line.substring(0, pos);

      if (line === '$$EOE')
        break;

      switch (state) {
        case ReadState.SEEK_START:
          if (line === '$$SOE') {
            state = ReadState.SEEK_DATE;
            body.name = name;
            body.designation = designation;

            if (isAsteroid && H != null && G != null) {
              body.H = H;
              body.G = G;
            }
          }
          else if (physicalParams) {
            if (H == null && ($ = h_Pattern.exec(line)))
              H = toNumber($[1]);

            if (G == null && ($ = g_Pattern.exec(line)))
              G = toNumber($[1]);

            if (H != null && G != null)
              physicalParams = false;
          }
          else if (isAsteroid && line.includes('Asteroid physical parameters'))
            physicalParams = true;
          break;

        case ReadState.SEEK_DATE:
          $ = datePattern.exec(line);

          if ($) {
            oi = { epoch: toNumber($[1]) } as ObjectInfo;
            fieldMatches = 0;
            fieldsNeeded = 6;
            state = ReadState.IN_ELEMENTS;
          }
          break;

        case ReadState.IN_ELEMENTS:
          if (oi.q == null && ($ = qrPattern.exec(line))) {
            oi.q = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.e == null && ($ = ecPattern.exec(line))) {
            oi.e = toNumber($[1]);
            ++fieldMatches;

            if (oi.e >= 1.0)
              fieldsNeeded = 8;
          }

          if (oi.i == null && ($ = inPattern.exec(line))) {
            oi.i = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.ω == null && ($ = w_Pattern.exec(line))) {
            oi.ω = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.L == null && ($ = omPattern.exec(line))) {
            oi.L = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.Tp == null && ($ = tpPattern.exec(line))) {
            oi.Tp = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.a == null && ($ = a_Pattern.exec(line))) {
            oi.a = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.n == null && ($ = n_Pattern.exec(line))) {
            oi.n = toNumber($[1]);
            ++fieldMatches;
          }

          if (fieldMatches === fieldsNeeded) {
            if (oi.e < 1.0) {
              oi.a = oi.q / (1.0 - oi.e);
              oi.n  = K_DEG / oi.a / sqrt(oi.a);
            }

            if (refOI !== null) {
              const earthPos = solarSystem.getHeliocentricPosition(EARTH, oi.epoch);
              const pos1 = aoo.getHeliocentricPosition(refOI, oi.epoch);
              const pos2 = aoo.getHeliocentricPosition(oi, oi.epoch);
              const deltaLong = abs(pos1.longitude.subtract(pos2.longitude).getAngle(Unit.ARC_MINUTES));
              const deltaLat  = abs(pos1.latitude.subtract(pos2.latitude).getAngle(Unit.ARC_MINUTES));
              const geoPos1 = pos1.translate(earthPos);
              const geoPos2 = pos2.translate(earthPos);
              const deltaGeoLong = abs(geoPos1.longitude.subtract(geoPos2.longitude).getAngle(Unit.ARC_MINUTES));
              const deltaGeoLat  = abs(geoPos1.latitude.subtract(geoPos2.latitude).getAngle(Unit.ARC_MINUTES));
              const maxDelta = max(deltaLong, deltaLat, deltaGeoLong, deltaGeoLat);

              if (maxDelta >= tolerance) {
                if (byMonth && startOfTrouble == null && refOI === lastOI && (maxDelta >= tolerance * 1.5)) {
                  startOfTrouble = getFormattedDateFromJulianDay(refOI.epoch);
                  troubleSpots.push(startOfTrouble);
                }

                elements.push(lastOI !== refOI ? lastOI : oi);
                refOI = oi;
              }

              if (startOfTrouble != null && maxDelta < tolerance * 1.5) {
                troubleSpots.push(getFormattedDateFromJulianDay(oi.epoch));
                startOfTrouble = null;
              }
            }
            else {
              refOI = oi;
              elements.push(oi);
            }

            lastOI = oi;
            state = ReadState.SEEK_DATE;
          }
          break;
      }
    }

    if (startOfTrouble != null)
      troubleSpots.push(getFormattedDateFromJulianDay(lastOI.epoch));

    if (troubleSpots.length > 0) {
      const ts = floor((troubleSpots.length + 1) / 2);

      console.log(`    ${name} needs ${ts} batch${ts > 1 ? 'es' : ''} of supplemental data.`);

      for (let i = 0; i < troubleSpots.length - 1; i += 2) {
        console.log(`    Retrieving batch #${i / 2 + 1}`);

        const startDate = troubleSpots[i];
        const endDate = troubleSpots[i + 1];

        const sd = new DateTime(startDate + 'Z');
        const sdJdu = sd.wallTime.jdu;
        const ed = new DateTime(endDate + 'Z');
        const edJdu = ed.wallTime.jdu;

        // Remove original by-month info from trouble interval.
        for (let j = elements.length - 1; j >= 0; --j) {
          oi = elements[j];

          if (sdJdu <= oi.epoch && oi.epoch < edJdu)
            elements.splice(j, 1);
        }

        try {
          const supplementalElements = (await getBodyData(name, designation, isAsteroid, sd, ed, '1 D')).elements;
          elements.push(...supplementalElements);
        }
        catch (e) {
          reject(e);
        }
      }

      elements.sort((a, b) => sign(a.epoch - b.epoch));
    }

    resolve({ body, elements });
  });

  await ts.process(line => lineSource.emit(line));

  return result;
}

(async function (): Promise<void> {
  const currentYear = new DateTime(null, 'UTC').wallTime.year;
  const startDate = new DateTime([currentYear - YEAR_SPAN, 1, 1], 'UTC');
  const endDate = new DateTime([currentYear + YEAR_SPAN, 12, 1], 'UTC');

  try {
    const acListText = await readFile('src/asteroid-and-comet-list.json5', 'utf8');
    const acList = JSONZ.parse(acListText);

    for (const bodyType of ['asteroids', 'comets']) {
      const bodyList = acList[bodyType];
      const results: any[] = [];

      for (let i = 0; i < bodyList.length; i += 2) {
        const name = bodyList[i];
        let gotData = false;

        for (let tries = 1; tries <= 5; ++tries) {
          if (tries === 1)
            console.log(`Getting data for ${name}, ${bodyType.slice(0, -1)} ${(i / 2) + 1} of ${bodyList.length / 2}`);
          else
            console.log(`* Attempt ${tries} to obtain data for ${name}`);

          try {
            const designation = bodyList[i + 1] + (/\d$/.test(bodyList[i + 1]) ? ':' : '');
            const bodyData = await getBodyData(name, designation, bodyType === 'asteroids',
              startDate, endDate, '1 MO') as any;

            bodyData.elements = bodyData?.elements?.map((elem: ObjectInfo) => {
              return {
                epoch: getFormattedDateFromJulianDay(elem.epoch),
                q: elem.q,
                e: elem.e,
                i: elem.i,
                w: elem.ω,
                L: elem.L,
                Tp: elem.Tp
              } as ObjectInfoMod;
            });

            if (bodyData?.body && bodyData?.elements?.length > 0) {
              results.push(bodyData);
              gotData = true;
              break;
            }
            else
              console.error(`No data received for ${name}.`);
          }
          catch (e) {
            console.error(`No data received for ${name}.`);
          }
        }

        if (!gotData) {
          console.error(`Failed to retrieve data for ${name}. Exiting.`);
          process.exit(1);
        }
      }

      await mkdir('output', { recursive: true });
      await writeFile(`output/${bodyType}.json`, JSON.stringify(results));
    }
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
