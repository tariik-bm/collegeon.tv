/**
 * fix_brackets.js
 * Fetches ESPN API data for NCAA Tournament 2010-2019,
 * uses tournament seed (rank) data to assign CORRECT bracketIds
 * based on seed matchup within each region.
 *
 * Run: node fix_brackets.js [year]
 * e.g. node fix_brackets.js 2010
 *      node fix_brackets.js 2010 2011 2012
 *      node fix_brackets.js        (all 2010-2019)
 */

const https = require('https');

// ─── Seed-pair → slot within region (First Round) ────────────────
// slot 1 = 1v16, slot 2 = 8v9, slot 3 = 5v12, slot 4 = 4v13
// slot 5 = 6v11, slot 6 = 3v14, slot 7 = 7v10, slot 8 = 2v15
const SEED_PAIR_TO_SLOT = {
  '1-16':1, '16-1':1,
  '8-9':2,  '9-8':2,
  '5-12':3, '12-5':3,
  '4-13':4, '13-4':4,
  '6-11':5, '11-6':5,
  '3-14':6, '14-3':6,
  '7-10':7, '10-7':7,
  '2-15':8, '15-2':8,
};

// Second Round slot from the two seeds playing
// slot 1: 1/16 winner vs 8/9 winner → min seed ∈ {1,8}
// slot 2: 5/12 winner vs 4/13 winner → min seed ∈ {4,5}
// slot 3: 6/11 winner vs 3/14 winner → min seed ∈ {3,6}
// slot 4: 7/10 winner vs 2/15 winner → min seed ∈ {2,7}
function r32SlotFromSeeds(s1, s2) {
  const lo = Math.min(s1, s2);
  if (lo === 1 || lo === 8) return 1;
  if (lo === 4 || lo === 5) return 2;
  if (lo === 3 || lo === 6) return 3;
  if (lo === 2 || lo === 7) return 4;
  return null;
}

// Sweet 16 slot from two seeds playing
// slot 1: top-half winner (1,4,5,8 region bracket)
// slot 2: bottom-half winner (2,3,6,7 region bracket)
function s16SlotFromSeeds(s1, s2) {
  const lo = Math.min(s1, s2);
  if ([1,4,5,8].includes(lo)) return 1;
  if ([2,3,6,7].includes(lo)) return 2;
  return null;
}

// ─── Region bracketId base offsets ───────────────────────────────
const REGION_BASE_R64 = { east: 0,  west: 8,  south: 16, midwest: 24 }; // base 201
const REGION_BASE_R32 = { east: 0,  west: 4,  south: 8,  midwest: 12 }; // base 301
const REGION_BASE_S16 = { east: 0,  west: 2,  south: 4,  midwest: 6  }; // base 401
const REGION_BASE_E8  = { east: 0,  west: 1,  south: 2,  midwest: 3  }; // base 501

// ─── Region detection from ESPN note headline ─────────────────────
function getRegionFromNote(note) {
  const n = note.toUpperCase();
  // Check specific composites first to avoid substring conflicts
  if (n.includes('SOUTHEAST')) return 'south';    // 2011 Southeast → South bracket
  if (n.includes('SOUTHWEST')) return 'midwest';  // 2011 Southwest → Midwest bracket
  if (n.includes('MIDWEST'))   return 'midwest';  // Must check before WEST (MIDWEST ⊃ WEST)
  if (n.includes('MID-WEST'))  return 'midwest';
  if (n.includes('EAST'))      return 'east';
  if (n.includes('WEST'))      return 'west';
  if (n.includes('SOUTH'))     return 'south';
  return null;
}

// ─── Round detection from ESPN note + year ────────────────────────
// ESPN note naming convention by year:
//   2010:      "OPENING ROUND"=First Four, "1ST ROUND"=First Round(64→32), "2ND ROUND"=Second Round(32→16)
//   2011-2015: "1ST ROUND"=First Four,     "2ND ROUND"=First Round(64→32), "3RD ROUND"=Second Round(32→16)
//   2016-2019: "FIRST FOUR"=First Four,    "1ST ROUND"=First Round(64→32), "2ND ROUND"=Second Round(32→16)
function getRoundKey(note, year) {
  const nu = note.toUpperCase();

  // Unambiguous late-round keywords — check FIRST
  if (nu.includes('NATIONAL CHAMPIONSHIP') || (nu.includes('CHAMPIONSHIP') && nu.includes('NATIONAL'))) return 'Championship';
  if (nu.includes('NATIONAL SEMIFINAL') || nu.includes('FINAL FOUR')) return 'Final Four';
  if (nu.includes('ELITE EIGHT') || nu.includes('ELITE 8') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return 'Elite Eight';
  if (nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return 'Sweet 16';

  // "FIRST FOUR" explicit label (2016+) — check before "FIRST ROUND"
  if (nu.includes('FIRST FOUR')) return 'First Four';

  // Opening round / play-in (2010)
  if (nu.includes('OPENING ROUND') || nu.includes('PLAY-IN')) return 'First Four';

  if (year <= 2010) {
    // 2010: 1ST ROUND = First Round (64→32), 2ND ROUND = Second Round (32→16)
    if (nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Round';
    if (nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'Second Round';
  } else if (year <= 2015) {
    // 2011-2015: 1ST ROUND = First Four (play-in), 2ND ROUND = First Round, 3RD ROUND = Second Round
    if (nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Four';
    if (nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'First Round';
    if (nu.includes('3RD ROUND') || nu.includes('THIRD ROUND')) return 'Second Round';
  } else {
    // 2016+: FIRST FOUR already caught above
    // 1ST ROUND = First Round (64→32), 2ND ROUND = Second Round (32→16)
    if (nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Round';
    if (nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'Second Round';
    if (nu.includes('3RD ROUND') || nu.includes('THIRD ROUND')) return 'Second Round';
  }
  return null;
}

// ─── isMMGame filter ──────────────────────────────────────────────
function isMMGame(ev) {
  const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
  const n = note.toUpperCase();
  if (n.includes("MEN'S BASKETBALL CHAMPIONSHIP") || n.includes("NCAA TOURNAMENT") || n.includes("NCAA MEN'S")) return true;
  if (n.includes('SWEET 16') || n.includes('SWEET SIXTEEN') || n.includes('REGIONAL SEMIFINAL')) return true;
  if (n.includes('ELITE 8') || n.includes('ELITE EIGHT') || n.includes('REGIONAL FINAL') || n.includes('REGIONAL CHAMPIONSHIP')) return true;
  if (n.includes('FINAL FOUR') || n.includes('NATIONAL SEMIFINAL')) return true;
  if (n.includes('NATIONAL CHAMPIONSHIP')) return true;
  if ((n.includes('1ST ROUND') || n.includes('2ND ROUND') || n.includes('3RD ROUND')) && n.includes('CHAMPIONSHIP')) return true;
  if ((n.includes('OPENING ROUND') || n.includes('PLAY-IN')) && n.includes('CHAMPIONSHIP')) return true;
  return false;
}

// ─── HTTP helpers ─────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve) => {
    const options = { hostname, path, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
    https.get(options, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function fetchDay(dateStr) {
  const data = await httpGet('site.api.espn.com',
    `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&groups=50&limit=100`
  );
  return data?.events || [];
}

// Fetch game summary to get team seeds (stored as `rank` field in header)
async function fetchGameSeeds(gameId) {
  const data = await httpGet('site.api.espn.com',
    `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gameId}`
  );
  if (!data?.header?.competitions?.[0]) return {};
  const seeds = {};
  const comp = data.header.competitions[0];
  for (const t of (comp.competitors || [])) {
    if (t.team?.id && t.rank != null) {
      seeds[t.team.id] = t.rank;
    }
  }
  return seeds;
}

// ─── Main per-year fetcher ────────────────────────────────────────
async function fetchYear(year) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Fetching ${year} NCAA Tournament from ESPN...`);

  // Build Mar 13 → Apr 10 date range
  const dates = [];
  for (let d = new Date(`${year}-03-13T12:00:00Z`); d <= new Date(`${year}-04-10T12:00:00Z`); d.setDate(d.getDate() + 1)) {
    dates.push(d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'));
  }

  // Fetch scoreboard in batches of 5
  const allEvents = [];
  for (let i = 0; i < dates.length; i += 5) {
    const results = await Promise.all(dates.slice(i, i+5).map(fetchDay));
    results.forEach(evs => allEvents.push(...evs));
    process.stdout.write('.');
  }
  console.log('');

  // Deduplicate + filter MM games
  const seen = new Set();
  const events = allEvents.filter(ev => {
    if (!isMMGame(ev) || seen.has(ev.id)) return false;
    seen.add(ev.id);
    return true;
  });
  events.sort((a,b) => new Date(a.date) - new Date(b.date));
  console.log(`  Found ${events.length} tournament games`);
  if (!events.length) return {};

  // Annotate each event with round + region from note
  for (const ev of events) {
    const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
    ev._round  = getRoundKey(note, year);
    ev._region = getRegionFromNote(note);
    ev._note   = note;
  }

  // Group by round
  const byRound = {};
  for (const ev of events) {
    const r = ev._round || 'Unknown';
    if (!byRound[r]) byRound[r] = [];
    byRound[r].push(ev);
  }

  const roundOrder = ['First Four','First Round','Second Round','Sweet 16','Elite Eight','Final Four','Championship'];
  console.log('  Round counts:');
  for (const r of roundOrder) {
    if (byRound[r]) console.log(`    ${r}: ${byRound[r].length}`);
  }
  if (byRound['Unknown']) {
    console.log(`    UNKNOWN: ${byRound['Unknown'].length}`);
    byRound['Unknown'].forEach(ev => console.log(`      ${ev.id}: "${ev._note}"`));
  }

  // ── Fetch seeds for ALL games via game summary API ──────────────
  console.log('  Fetching seed data for all games...');
  const gameSeedMap = {}; // gameId → { teamId → seed }
  const allGameIds = events.map(ev => ev.id);
  // Batch in groups of 8, 300ms between batches
  for (let i = 0; i < allGameIds.length; i += 8) {
    const batch = allGameIds.slice(i, i+8);
    const results = await Promise.all(batch.map(fetchGameSeeds));
    batch.forEach((gid, j) => { gameSeedMap[gid] = results[j]; });
    if (i + 8 < allGameIds.length) await new Promise(r => setTimeout(r, 300));
    process.stdout.write('.');
  }
  console.log('');

  // Attach seeds + team IDs + winner to each event's competitors
  for (const ev of events) {
    const seeds = gameSeedMap[ev.id] || {};
    const comp = ev.competitions?.[0];
    const teamSeeds = (comp?.competitors || []).map(t => seeds[t.team?.id] || 0).filter(s => s > 0).sort((a,b) => a-b);
    ev._seeds = teamSeeds;
    ev._teams = (comp?.competitors || []).map(t => ({
      name: t.team?.shortDisplayName || t.team?.displayName || '?',
      seed: seeds[t.team?.id] || 0,
      id:   t.team?.id || null,
      winner: t.winner === true,
    }));
    // Store all team IDs in this game
    ev._teamIds = (comp?.competitors || []).map(t => t.team?.id).filter(Boolean);
  }

  // ── Build bracketId mapping ───────────────────────────────────
  const mapping = {};
  const issues  = [];

  // Championship → 701
  (byRound['Championship'] || []).forEach(ev => {
    mapping[ev.id] = 701;
    console.log(`  [CHAMP] 701  ${ev.id}  seeds=${ev._seeds.join('v')}  ${ev._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
  });

  // First Four → 101-104 (sort by time)
  if (byRound['First Four']) {
    const ff = [...byRound['First Four']].sort((a,b) => new Date(a.date)-new Date(b.date));
    ff.forEach((ev, i) => {
      mapping[ev.id] = 101 + i;
      console.log(`  [FF-${i+1}] ${101+i}  ${ev.id}  region=${ev._region||'?'}  ${ev._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
    });
  }

  // ── Region-based round assignments ───────────────────────────────
  // We must assign E8 first (501-504) so we can use them to determine Final Four 601/602
  for (const region of ['east', 'west', 'south', 'midwest']) {

    // Elite Eight → 501 + offset (1 game per region)
    const e8games = (byRound['Elite Eight'] || []).filter(ev => ev._region === region);
    if (e8games.length > 0) {
      const g = e8games[0];
      const bid = 501 + REGION_BASE_E8[region];
      mapping[g.id] = bid;
      console.log(`  [E8-${region.toUpperCase()}] ${bid}  ${g.id}  seeds=${g._seeds.join('v')}  ${g._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
    } else if ((byRound['Elite Eight'] || []).length > 0) {
      issues.push(`  WARN: No Elite Eight game found for region=${region}`);
    }

    // Sweet 16 → 401 + offset (2 games per region)
    const s16games = (byRound['Sweet 16'] || []).filter(ev => ev._region === region);
    if (s16games.length > 0) {
      const base = 401 + REGION_BASE_S16[region];
      const slotMap = {};
      const unslotted = [];
      for (const g of s16games) {
        if (g._seeds.length >= 2) {
          const slot = s16SlotFromSeeds(g._seeds[0], g._seeds[1]);
          if (slot) slotMap[slot] = g;
          else unslotted.push(g);
        } else unslotted.push(g);
      }
      for (let slot = 1; slot <= 2; slot++) {
        const g = slotMap[slot] || unslotted.shift();
        if (g) {
          mapping[g.id] = base + (slot - 1);
          console.log(`  [S16-${region.toUpperCase()}-${slot}] ${base+(slot-1)}  ${g.id}  seeds=${g._seeds.join('v')}  ${g._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
        } else {
          issues.push(`  WARN: No Sweet 16 game for ${region} slot ${slot}`);
        }
      }
    }

    // Second Round → 301 + offset (4 games per region)
    const r32games = (byRound['Second Round'] || []).filter(ev => ev._region === region);
    if (r32games.length > 0) {
      const base = 301 + REGION_BASE_R32[region];
      const slotMap = {};
      const unslotted = [];
      for (const g of r32games) {
        if (g._seeds.length >= 2) {
          const slot = r32SlotFromSeeds(g._seeds[0], g._seeds[1]);
          if (slot) slotMap[slot] = g;
          else unslotted.push(g);
        } else unslotted.push(g);
      }
      for (let slot = 1; slot <= 4; slot++) {
        const g = slotMap[slot] || unslotted.shift();
        if (g) {
          mapping[g.id] = base + (slot - 1);
          console.log(`  [R32-${region.toUpperCase()}-${slot}] ${base+(slot-1)}  ${g.id}  seeds=${g._seeds.join('v')}  ${g._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
        } else {
          issues.push(`  WARN: No Second Round game for ${region} slot ${slot}`);
        }
      }
    }

    // First Round → 201 + offset (8 games per region)
    const r64games = (byRound['First Round'] || []).filter(ev => ev._region === region);
    if (r64games.length > 0) {
      const base = 201 + REGION_BASE_R64[region];
      const slotMap = {};
      const unslotted = [];
      for (const g of r64games) {
        if (g._seeds.length >= 2) {
          const key = `${g._seeds[0]}-${g._seeds[1]}`;
          const slot = SEED_PAIR_TO_SLOT[key];
          if (slot) {
            if (slotMap[slot]) issues.push(`  WARN: Duplicate slot ${slot} in ${region} R64`);
            slotMap[slot] = g;
          } else {
            unslotted.push(g);
            issues.push(`  WARN: Unknown seed pair ${key} in ${region} R64 game ${g.id}`);
          }
        } else {
          unslotted.push(g);
          issues.push(`  WARN: Missing seeds for ${region} R64 game ${g.id} seeds=${g._seeds}`);
        }
      }
      for (let slot = 1; slot <= 8; slot++) {
        const g = slotMap[slot] || unslotted.shift();
        if (g) {
          mapping[g.id] = base + (slot - 1);
          console.log(`  [R64-${region.toUpperCase()}-${slot}] ${base+(slot-1)}  ${g.id}  seeds=${g._seeds.join('v')}  ${g._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
        } else {
          issues.push(`  WARN: No First Round game for ${region} slot ${slot}`);
        }
      }
    }
  }

  // Check for First Round games without a region (for years where notes lack region)
  const noRegionR64 = (byRound['First Round'] || []).filter(ev => !ev._region);
  if (noRegionR64.length > 0) {
    console.log(`\n  ${noRegionR64.length} First Round games with no region in note — inferring from seeds+time`);
    // Find seed-1 games to anchor each region
    const seed1games = noRegionR64.filter(ev => ev._seeds.includes(1)).sort((a,b) => new Date(a.date)-new Date(b.date));
    const regionOrder = ['east','west','south','midwest'];
    if (seed1games.length === 4) {
      const seed1RegionMap = {};
      seed1games.forEach((g, i) => { seed1RegionMap[g.id] = regionOrder[i]; });
      // Assign each game to a region by proximity to its seed-1 anchor
      for (const g of noRegionR64) {
        if (mapping[g.id]) continue; // already assigned
        let bestRegion = 'east', minDiff = Infinity;
        for (const s1g of seed1games) {
          const diff = Math.abs(new Date(g.date).getTime() - new Date(s1g.date).getTime());
          if (diff < minDiff) { minDiff = diff; bestRegion = seed1RegionMap[s1g.id]; }
        }
        g._region = bestRegion;
      }
      // Now assign bracketIds for these no-region games
      for (const region of regionOrder) {
        const regionGames = noRegionR64.filter(ev => ev._region === region);
        const base = 201 + REGION_BASE_R64[region];
        const slotMap = {};
        const unslotted = [];
        for (const g of regionGames) {
          if (g._seeds.length >= 2) {
            const key = `${g._seeds[0]}-${g._seeds[1]}`;
            const slot = SEED_PAIR_TO_SLOT[key];
            if (slot) slotMap[slot] = g;
            else unslotted.push(g);
          } else unslotted.push(g);
        }
        for (let slot = 1; slot <= 8; slot++) {
          if (slotMap[slot] && !mapping[slotMap[slot].id]) {
            const g = slotMap[slot];
            mapping[g.id] = base + (slot - 1);
            console.log(`  [R64-${region.toUpperCase()}-${slot}] ${base+(slot-1)}  ${g.id}  seeds=${g._seeds.join('v')}  (inferred region)`);
          }
        }
        for (const g of unslotted) {
          if (!mapping[g.id]) {
            issues.push(`  WARN: Unassigned no-region R64 game ${g.id} seeds=${g._seeds}`);
          }
        }
      }
    } else {
      issues.push(`  WARN: Expected 4 seed-1 games but found ${seed1games.length} — cannot infer regions`);
    }
  }

  // ── Final Four: 601 = East winner's game, 602 = the other game ──
  // The East regional winner (E8-501 winner) always plays in game 601.
  // This pattern holds for all years 2010-2019 per historical data.
  if (byRound['Final Four']) {
    const ff4 = [...byRound['Final Four']].sort((a,b) => new Date(a.date)-new Date(b.date));

    // Find East E8 game (bracketId 501) winner's team ID
    let eastWinnerTeamId = null;
    const eastE8games = (byRound['Elite Eight'] || []).filter(ev => ev._region === 'east');
    if (eastE8games.length > 0) {
      const eastE8 = eastE8games[0];
      const winner = eastE8._teams.find(t => t.winner);
      if (winner?.id) eastWinnerTeamId = winner.id;
    }

    if (eastWinnerTeamId && ff4.length === 2) {
      // Find which Final Four game has the East winner
      const eastGame = ff4.find(g => g._teamIds.includes(eastWinnerTeamId));
      const otherGame = ff4.find(g => g.id !== eastGame?.id);
      if (eastGame) {
        mapping[eastGame.id] = 601;
        if (otherGame) mapping[otherGame.id] = 602;
        console.log(`  [FF4-601] 601  ${eastGame.id}  seeds=${eastGame._seeds.join('v')}  ${eastGame._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}  [East winner's game]`);
        if (otherGame) console.log(`  [FF4-602] 602  ${otherGame.id}  seeds=${otherGame._seeds.join('v')}  ${otherGame._teams.map(t=>`${t.seed}:${t.name}`).join(' vs ')}`);
      } else {
        // Fallback: time order
        ff4.forEach((g, i) => { mapping[g.id] = 601+i; });
        issues.push('  WARN: Could not find East winner in Final Four games - using time order');
      }
    } else {
      // Fallback: time order
      ff4.forEach((g, i) => { mapping[g.id] = 601+i; });
      if (ff4.length > 0) issues.push(`  WARN: East winner ID not found (eastWinnerTeamId=${eastWinnerTeamId}) - using time order for FF4`);
    }
  }

  if (issues.length > 0) {
    console.log('\n  ISSUES:');
    issues.forEach(i => console.log(i));
  }

  // ── Print JS snippet ──────────────────────────────────────────
  console.log(`\n\n  ══ ${year} JS SNIPPET ══`);
  const allEntries = Object.entries(mapping).sort((a,b) => a[1]-b[1]);
  const sections = [
    { label: 'First Four',   min: 101, max: 104 },
    { label: 'First Round',  min: 201, max: 232 },
    { label: 'Second Round', min: 301, max: 316 },
    { label: 'Sweet 16',     min: 401, max: 408 },
    { label: 'Elite Eight',  min: 501, max: 504 },
    { label: 'Final Four',   min: 601, max: 602 },
    { label: 'Championship', min: 701, max: 701 },
  ];
  const subRegions = [
    { min:201,max:208,label:'East' },{ min:209,max:216,label:'West' },
    { min:217,max:224,label:'South' },{ min:225,max:232,label:'Midwest' },
    { min:301,max:304,label:'East' },{ min:305,max:308,label:'West' },
    { min:309,max:312,label:'South' },{ min:313,max:316,label:'Midwest' },
  ];

  const lines = [];
  for (const sec of sections) {
    const secEntries = allEntries.filter(([,v]) => v >= sec.min && v <= sec.max);
    if (!secEntries.length) continue;
    lines.push(`        // ${year} ${sec.label}`);
    if (sec.min >= 201 && sec.min <= 232) {
      // Split first round by region
      for (const sub of subRegions.filter(r => r.min >= 201 && r.min <= 232)) {
        const subE = secEntries.filter(([,v]) => v >= sub.min && v <= sub.max);
        if (subE.length) lines.push(`        ${subE.map(([k,v])=>`'${k}':${v}`).join(',')},`);
      }
    } else if (sec.min >= 301 && sec.min <= 316) {
      for (const sub of subRegions.filter(r => r.min >= 301 && r.min <= 316)) {
        const subE = secEntries.filter(([,v]) => v >= sub.min && v <= sub.max);
        if (subE.length) lines.push(`        ${subE.map(([k,v])=>`'${k}':${v}`).join(',')},`);
      }
    } else {
      lines.push(`        ${secEntries.map(([k,v])=>`'${k}':${v}`).join(',')},`);
    }
  }
  const snippet = lines.join('\n');
  console.log(snippet);

  return { year, mapping, byRound, events, snippet };
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let years;
  if (args.length === 0) {
    years = [2010,2011,2012,2013,2014,2015,2016,2017,2018,2019];
  } else {
    years = args.map(Number).filter(y => y >= 2010 && y <= 2025);
  }
  console.log(`Processing years: ${years.join(', ')}`);

  const allResults = {};
  for (const year of years) {
    try {
      allResults[year] = await fetchYear(year);
    } catch(e) {
      console.error(`\nError processing ${year}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Final combined output
  console.log('\n\n' + '═'.repeat(70));
  console.log('COMPLETE hardcodedBracketIds REPLACEMENT (paste into server.js):');
  console.log('═'.repeat(70));
  console.log('      const hardcodedBracketIds = {');
  for (const year of years) {
    const r = allResults[year];
    if (!r) { console.log(`        // ${year} - FAILED`); continue; }
    console.log(r.snippet);
  }
  console.log('      };');

  // Verification counts
  console.log('\n── Verification ──');
  for (const year of years) {
    const r = allResults[year];
    if (!r) continue;
    const m = r.mapping;
    const ff  = Object.values(m).filter(v => v>=101&&v<=104).length;
    const r64 = Object.values(m).filter(v => v>=201&&v<=232).length;
    const r32 = Object.values(m).filter(v => v>=301&&v<=316).length;
    const s16 = Object.values(m).filter(v => v>=401&&v<=408).length;
    const e8  = Object.values(m).filter(v => v>=501&&v<=504).length;
    const ff4 = Object.values(m).filter(v => v>=601&&v<=602).length;
    const c   = Object.values(m).filter(v => v===701).length;
    const tot = Object.values(m).length;
    console.log(`  ${year}: FF=${ff} R64=${r64} R32=${r32} S16=${s16} E8=${e8} FF4=${ff4} C=${c} Total=${tot}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
