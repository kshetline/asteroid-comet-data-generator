import { TelnetSequence } from './telnet-sequence';
import ttime, { DateTime } from '@tubular/time';
import { Emitter } from './emitter';
import { toNumber } from '@tubular/util';
import { AdditionalOrbitingObjects, EARTH, K_DEG, ObjectInfo, SolarSystem } from '@tubular/astronomy';
import { abs, max, sqrt, Unit } from '@tubular/math';
import millisFromJulianDay = ttime.millisFromJulianDay;

enum ReadState { SEEK_START, SEEK_DATE, IN_ELEMENTS }

interface BodyInfo {
  name: string;
  designation: string;
  H: number;
  G: number;
}

interface ObjectInfoMod {
  epoch: string;
  a: number;
  q: number;
  e: number;
  i: number;
  w: number;
  L: number;
  Tp: number;
  n: number;
}

interface BodyAndElements {
  body: BodyInfo;
  elements: ObjectInfoMod[];
}

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

async function getBodyData(name: string, designation: string, isAsteroid: boolean,
                           startDate: DateTime, endDate: DateTime, interval: string): Promise<BodyAndElements> {
  const des = designation.startsWith('DES=');
  const lineSource = new Emitter<string | null>();
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

  const body = {} as BodyInfo;
  const elements: ObjectInfo[] = [];

  setTimeout(async () => {
    let line: string;
    let state = ReadState.SEEK_START;
    let oi: ObjectInfo = null;
    let refOI: ObjectInfo = null;
    let lastOI: ObjectInfo = null;
    let physicalParams = false;
    let H = Number.NEGATIVE_INFINITY;
    let G = Number.NEGATIVE_INFINITY;
    let $: RegExpExecArray;
    let fieldMatches = 0;
    let fieldsNeeded = 0;
    const aoo = new AdditionalOrbitingObjects();
    const tolerance = 1.0; // Minutes of arc, heliocentric longitude or latitude.
    const byMonth = (interval === '1 MO');
    let startOfTrouble: string = null;
    const troubleSpots: string[] = [];

    while ((line = (await lineSource.get())?.trim()) !== null) {
      if (line === '$$EOE')
        break;

      switch (state) {
        case ReadState.SEEK_START:
          if (line === '$$SOE') {
            state = ReadState.SEEK_DATE;
            body.name = name;
            body.designation = designation;

            if (isAsteroid && H !== Number.NEGATIVE_INFINITY && G !== Number.NEGATIVE_INFINITY) {
              body.H = H;
              body.G = G;
            }
          }
          else if (physicalParams) {
            if (H === Number.NEGATIVE_INFINITY && ($ = h_Pattern.exec(line)))
              H = toNumber($[1]);

            if (G === Number.NEGATIVE_INFINITY && ($ = g_Pattern.exec(line)))
              G = toNumber($[1]);

            if (H !== Number.NEGATIVE_INFINITY && G !== Number.NEGATIVE_INFINITY)
              physicalParams = false;
          }
          else if (isAsteroid && line.includes('Asteroid physical parameters'))
            physicalParams = true;
          break;

        case ReadState.SEEK_DATE:
          $ = datePattern.exec(line);

          if ($) {
            oi = { epoch: toNumber($[1]) } as ObjectInfo;
            oi.q = oi.e = oi.i = oi.ω = oi.L = oi.Tp = oi.a = oi.n = Number.NEGATIVE_INFINITY;
            fieldMatches = 0;
            fieldsNeeded = 6;
            state = ReadState.IN_ELEMENTS;
          }
          break;

        case ReadState.IN_ELEMENTS:
          if (oi.q === Number.NEGATIVE_INFINITY && ($ = qrPattern.exec(line))) {
            oi.q = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.e === Number.NEGATIVE_INFINITY && ($ = ecPattern.exec(line))) {
            oi.e = toNumber($[1]);
            ++fieldMatches;

            if (oi.e >= 1.0)
              fieldsNeeded = 8;
          }

          if (oi.i === Number.NEGATIVE_INFINITY && ($ = inPattern.exec(line))) {
            oi.i = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.ω === Number.NEGATIVE_INFINITY && ($ = w_Pattern.exec(line))) {
            oi.ω = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.L === Number.NEGATIVE_INFINITY && ($ = omPattern.exec(line))) {
            oi.L = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.Tp === Number.NEGATIVE_INFINITY && ($ = tpPattern.exec(line))) {
            oi.Tp = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.a === Number.NEGATIVE_INFINITY && ($ = a_Pattern.exec(line))) {
            oi.a = toNumber($[1]);
            ++fieldMatches;
          }

          if (oi.n === Number.NEGATIVE_INFINITY && ($ = n_Pattern.exec(line))) {
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
  });

  await ts.process(line => lineSource.emit(line), esc => {
    if (esc === '\x1B[6n')
      return '\x1B[24;80R';
    else if (esc === '\x1B[7m') // This escape sequence (setting reverse video) precedes pausing at a paging prompt
      return ' ';
    else
      return null;
  });

  return {
    body,
    elements: elements.map(elem => {
      const elemMod = Object.assign({}, elem) as any;

      elemMod.epoch = getFormattedDateFromJulianDay(elem.epoch);
      elemMod.w = elem.ω;
      delete elemMod.ω;

      return elemMod as ObjectInfoMod;
    })
  };
}

(async function (): Promise<void> {
  try {
    const results = await getBodyData('Ceres', '1;', true, new DateTime('2000-01-01Z'), new DateTime('2022-01-01Z'), '1 MO');

    console.log(JSON.stringify(results));
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
