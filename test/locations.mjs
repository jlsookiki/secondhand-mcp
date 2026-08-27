import { lookupUsCity } from '../dist/marketplaces/us-cities.js';
import allCities from 'all-the-cities';

let pass = 0, fail = 0;
const failures = [];
function check(input, expectName, expectState) {
  const r = lookupUsCity(input);
  const got = r ? `${r.name}` : 'NULL';
  const want = expectState === null ? 'NULL' : expectState === '__self__' ? expectName : `${expectName}, ${expectState}`;
  if (got === want) pass++; else { fail++; failures.push(`${input}  got=${got}  want=${want}`); }
}

// 1. ambiguous bare names must pick the most prominent
check('austin','Austin','TX'); check('portland','Portland','OR');
check('brooklyn','Brooklyn','NY'); check('springfield','Springfield','MO');
check('columbus','Columbus','OH'); check('kansas city','Kansas City','MO');
check('phoenix','Phoenix','AZ'); check('sacramento','Sacramento','CA');
check('boston','Boston','MA'); check('atlanta','Atlanta','GA');
check('oakland','Oakland','CA'); check('charlotte','Charlotte','NC');
check('san antonio','San Antonio','TX'); check('san diego','San Diego','CA');

// 2. "City, ST" and full-state forms
check('Austin, TX','Austin','TX'); check('austin texas','Austin','TX');
check('Kansas City, MO','Kansas City','MO'); check('kansas city, kansas','Kansas City','KS');
check('Portland, ME','Portland','ME'); check('Springfield, IL','Springfield','IL');
check('Columbus, GA','Columbus','GA'); check('Charlotte, NC','Charlotte','NC');
check('Boise, ID','Boise','ID'); check('new york, ny','New York City','NY');

// 3. multi-word states
check('Charlotte, North Carolina','Charlotte','NC');
check('Newark, New Jersey','Newark','NJ');
check('Albuquerque, New Mexico','Albuquerque','NM');

// 4. aliases
check('nyc','New York City','NY'); check('sf','San Francisco','CA');
check('la','Los Angeles','CA'); check('philly','Philadelphia','PA');
check('vegas','Las Vegas','NV'); check('dc','Washington, D.C.','__self__');

// 5. case / whitespace / punctuation
check('  AUSTIN,   tx ','Austin','TX'); check('St. Louis','St. Louis','MO');

// 6. wrong-state and nonsense must not silently answer
check('Austin, ME', null, null);
check('zzzznotacity', null, null);

console.log(`PASS ${pass}  FAIL ${fail}`);
failures.forEach(f => console.log('  FAIL:', f));

// 7. round-trip the 200 largest US cities through "City, ST"
const us = allCities.filter(c => c.country === 'US').sort((a,b)=>b.population-a.population).slice(0,200);
let rt = 0, rtBad = [];
for (const c of us) {
  const r = lookupUsCity(`${c.name}, ${c.adminCode}`);
  if (r && Math.abs(r.latitude - c.loc.coordinates[1]) < 0.5 && Math.abs(r.longitude - c.loc.coordinates[0]) < 0.5) rt++;
  else rtBad.push(`${c.name}, ${c.adminCode}`);
}
console.log(`ROUND-TRIP top 200: ${rt}/200`);
rtBad.slice(0,8).forEach(b => console.log('   miss:', b));

// 8. famous non-US names must not be answered by a small US namesake
for (const n of ['toronto','london','paris','berlin','manchester','vancouver']) {
  const r = lookupUsCity(n);
  if (r) { console.log('  FAIL: bare', n, 'resolved locally to', r.name); fail++; } else pass++;
}
// 9. ...but an explicit state still answers
for (const [q, want] of [['toronto, oh','Toronto, OH'],['paris, tx','Paris, TX'],['london, ky','London, KY']]) {
  const r = lookupUsCity(q);
  if (!r || r.name !== want) { console.log('  FAIL:', q, '->', r ? r.name : 'NULL'); fail++; } else pass++;
}
console.log(`TOTAL PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
