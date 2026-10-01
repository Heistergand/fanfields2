'use strict';
// One-off build script: turns the GeoLite2 country CSV (ip_start,ip_end,country_code) into a
// compact sorted binary table of (ip_start uint32 BE, regionId uint8), bucketing ~190 country
// codes down to the 8 regions FanFields 3 stats cares about. Run once here, ship only the
// resulting .bin in the stats server's Docker image (no CSV, no runtime country table).
const fs = require('fs');

// REGIONS[0] is always "other" (unallocated ranges, Antarctica, disputed/uninhabited territories).
const REGIONS = ['other', 'north_america', 'south_america', 'west_europe', 'middle_east_africa', 'east_europe', 'china', 'asia'];
const R = {};
REGIONS.forEach(function (name, i) { R[name] = i; });

// Country (ISO 3166-1 alpha-2) -> region bucket. Caribbean/Central America grouped with North
// America; Caucasus grouped with East Europe; Oceania/Pacific grouped with Asia as a catch-all
// (none of the 7 requested buckets covers it on its own); mainland China kept separate from the
// rest of Asia (own network/market), Hong Kong/Macau/Taiwan counted under Asia.
const COUNTRY_REGION = {
  AD: 'west_europe', AE: 'middle_east_africa', AF: 'asia', AG: 'north_america', AI: 'north_america',
  AL: 'east_europe', AM: 'east_europe', AO: 'middle_east_africa', AQ: 'other', AR: 'south_america',
  AS: 'asia', AT: 'west_europe', AU: 'asia', AW: 'north_america', AX: 'west_europe', AZ: 'east_europe',
  BA: 'east_europe', BB: 'north_america', BD: 'asia', BE: 'west_europe', BF: 'middle_east_africa',
  BG: 'east_europe', BH: 'middle_east_africa', BI: 'middle_east_africa', BJ: 'middle_east_africa',
  BL: 'north_america', BM: 'north_america', BN: 'asia', BO: 'south_america', BQ: 'north_america',
  BR: 'south_america', BS: 'north_america', BT: 'asia', BV: 'other', BW: 'middle_east_africa',
  BY: 'east_europe', BZ: 'north_america', CA: 'north_america', CC: 'asia', CD: 'middle_east_africa',
  CF: 'middle_east_africa', CG: 'middle_east_africa', CH: 'west_europe', CI: 'middle_east_africa',
  CK: 'asia', CL: 'south_america', CM: 'middle_east_africa', CN: 'china', CO: 'south_america',
  CR: 'north_america', CU: 'north_america', CV: 'middle_east_africa', CW: 'north_america',
  CX: 'asia', CY: 'west_europe', CZ: 'east_europe', DE: 'west_europe', DJ: 'middle_east_africa',
  DK: 'west_europe', DM: 'north_america', DO: 'north_america', DZ: 'middle_east_africa',
  EC: 'south_america', EE: 'east_europe', EG: 'middle_east_africa', EH: 'middle_east_africa',
  ER: 'middle_east_africa', ES: 'west_europe', ET: 'middle_east_africa', FI: 'west_europe',
  FJ: 'asia', FK: 'south_america', FM: 'asia', FO: 'west_europe', FR: 'west_europe',
  GA: 'middle_east_africa', GB: 'west_europe', GD: 'north_america', GE: 'east_europe',
  GF: 'south_america', GG: 'west_europe', GH: 'middle_east_africa', GI: 'west_europe',
  GL: 'north_america', GM: 'middle_east_africa', GN: 'middle_east_africa', GP: 'north_america',
  GQ: 'middle_east_africa', GR: 'west_europe', GS: 'other', GT: 'north_america', GU: 'asia',
  GW: 'middle_east_africa', GY: 'south_america', HK: 'asia', HM: 'other', HN: 'north_america',
  HR: 'east_europe', HT: 'north_america', HU: 'east_europe', ID: 'asia', IE: 'west_europe',
  IL: 'middle_east_africa', IM: 'west_europe', IN: 'asia', IO: 'other', IQ: 'middle_east_africa',
  IR: 'middle_east_africa', IS: 'west_europe', IT: 'west_europe', JE: 'west_europe',
  JM: 'north_america', JO: 'middle_east_africa', JP: 'asia', KE: 'middle_east_africa',
  KG: 'asia', KH: 'asia', KI: 'asia', KM: 'middle_east_africa', KN: 'north_america',
  KP: 'asia', KR: 'asia', KW: 'middle_east_africa', KY: 'north_america', KZ: 'asia',
  LA: 'asia', LB: 'middle_east_africa', LC: 'north_america', LI: 'west_europe', LK: 'asia',
  LR: 'middle_east_africa', LS: 'middle_east_africa', LT: 'east_europe', LU: 'west_europe',
  LV: 'east_europe', LY: 'middle_east_africa', MA: 'middle_east_africa', MC: 'west_europe',
  MD: 'east_europe', ME: 'east_europe', MF: 'north_america', MG: 'middle_east_africa',
  MH: 'asia', MK: 'east_europe', ML: 'middle_east_africa', MM: 'asia', MN: 'asia', MO: 'asia',
  MP: 'asia', MQ: 'north_america', MR: 'middle_east_africa', MS: 'north_america',
  MT: 'west_europe', MU: 'middle_east_africa', MV: 'asia', MW: 'middle_east_africa',
  MX: 'north_america', MY: 'asia', MZ: 'middle_east_africa', NA: 'middle_east_africa',
  NC: 'asia', NE: 'middle_east_africa', NF: 'asia', NG: 'middle_east_africa',
  NI: 'north_america', NL: 'west_europe', NO: 'west_europe', NP: 'asia', NR: 'asia',
  NU: 'asia', NZ: 'asia', OM: 'middle_east_africa', PA: 'north_america', PE: 'south_america',
  PF: 'asia', PG: 'asia', PH: 'asia', PK: 'asia', PL: 'east_europe', PM: 'north_america',
  PN: 'asia', PR: 'north_america', PS: 'middle_east_africa', PT: 'west_europe', PW: 'asia',
  PY: 'south_america', QA: 'middle_east_africa', RE: 'middle_east_africa', RO: 'east_europe',
  RS: 'east_europe', RU: 'east_europe', RW: 'middle_east_africa', SA: 'middle_east_africa',
  SB: 'asia', SC: 'middle_east_africa', SD: 'middle_east_africa', SE: 'west_europe',
  SG: 'asia', SH: 'middle_east_africa', SI: 'east_europe', SJ: 'west_europe', SK: 'east_europe',
  SL: 'middle_east_africa', SM: 'west_europe', SN: 'middle_east_africa', SO: 'middle_east_africa',
  SR: 'south_america', SS: 'middle_east_africa', ST: 'middle_east_africa', SV: 'north_america',
  SX: 'north_america', SY: 'middle_east_africa', SZ: 'middle_east_africa', TC: 'north_america',
  TD: 'middle_east_africa', TF: 'other', TG: 'middle_east_africa', TH: 'asia', TJ: 'asia',
  TK: 'asia', TL: 'asia', TM: 'asia', TN: 'middle_east_africa', TO: 'asia', TR: 'middle_east_africa',
  TT: 'north_america', TV: 'asia', TW: 'asia', TZ: 'middle_east_africa', UA: 'east_europe',
  UG: 'middle_east_africa', UM: 'north_america', US: 'north_america', UY: 'south_america',
  UZ: 'asia', VA: 'west_europe', VC: 'north_america', VE: 'south_america', VG: 'north_america',
  VI: 'north_america', VN: 'asia', VU: 'asia', WF: 'asia', WS: 'asia', XK: 'east_europe',
  YE: 'middle_east_africa', YT: 'middle_east_africa', ZA: 'middle_east_africa',
  ZM: 'middle_east_africa', ZW: 'middle_east_africa'
};

function build(csvPath, binPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    const start = Number(parts[0]);
    const cc = parts[2];
    const region = COUNTRY_REGION[cc];
    if (region === undefined) throw new Error('Unmapped country code: ' + cc);
    rows.push({ start: start, regionId: R[region] });
  }
  rows.sort(function (a, b) { return a.start - b.start; });

  // Merge consecutive rows that map to the same region: the binary only needs to record where
  // the region *changes*, not every original country range.
  const merged = [];
  rows.forEach(function (r) {
    const last = merged[merged.length - 1];
    if (!last || last.regionId !== r.regionId) merged.push(r);
  });
  if (merged.length === 0 || merged[0].start !== 0) merged.unshift({ start: 0, regionId: R.other });

  const buf = Buffer.alloc(merged.length * 5);
  merged.forEach(function (r, i) {
    buf.writeUInt32BE(r.start >>> 0, i * 5);
    buf.writeUInt8(r.regionId, i * 5 + 4);
  });
  fs.writeFileSync(binPath, buf);
  console.log(csvPath, '->', binPath, ':', rows.length, 'source ranges merged into', merged.length, '(', buf.length, 'bytes )');
}

build('geolite2-country-ipv4-num.csv', 'ipv4-regions.bin');
console.log('REGIONS =', JSON.stringify(REGIONS));
