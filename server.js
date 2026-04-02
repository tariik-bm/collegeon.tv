/**
 * CollegeOnTV — Backend Server
 * Pure Node.js — zero dependencies needed
 * Run: node server.js
 * Open: http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT      = 3000;
const NCAA_HOST = 'sdataprod.ncaa.com';

const HASHES = {
  contests:      '6b26e5cda954c1302873c52835bfd223e169e2068b12511e92b3ef29fac779c2',
  schedule:      '5f2dd33c4660d1d169b65a67b86bc578258b93cadc45c0ff871e372ea57a9825',
  bracket:       '941f661183641391c58c4874929ffbf2edd5877baf783d585743c87c63959ace',
  teamStats:     '5fcf84602d59c003f37ddd1185da542578080e04fe854e935cbcaee590a0e8a2',
  pbp:           '6b1232714a3598954c5bacabc0f81570e16d6ee017c9a6b93b601a3d40dafb98',
  boxscore:      '4a7fa26398db33de3ff51402a90eb5f25acef001cca28d239fe5361315d1419a',
  gameStats:     'ce86ac82d692ce803573c7e9f96fb625f99cf3c8b4a5c6ce266d7c4dff02d5a1', // bracketId-based
  mmlBracket:    'e5746c1f7317fbbb07928dee293eb92e7fa30cc349e5ed0c20e45fa94aacc22e',
  mmlCurrent:    'e87c0a32428997f6b576a015810811b20038933a3b2f70cbf3b8aad2817183d8',
  mmlOfficial:   '58cd1e8be6f2902dd6d7fed23392b885c7349ea6ff04b740f95cfe8f8c226595',
};

// ─── Scrape NCAA Rankings ─────────────────────────────────
// NCAA name → seoname mapping
const SEONAME_MAP = {
  'duke': 'duke', 'arizona': 'arizona', 'michigan': 'michigan',
  'florida': 'florida', 'houston': 'houston', 'uconn': 'uconn',
  'iowa state': 'iowa-st', 'iowa st.': 'iowa-st', 'iowa st': 'iowa-st',
  'michigan state': 'michigan-st', 'michigan st.': 'michigan-st',
  'illinois': 'illinois', 'virginia': 'virginia', 'nebraska': 'nebraska',
  'gonzaga': 'gonzaga', "st. john's": 'st-johns', "st. john's (ny)": 'st-johns',
  'kansas': 'kansas', 'alabama': 'alabama', 'texas tech': 'texas-tech',
  'arkansas': 'arkansas', 'purdue': 'purdue', 'north carolina': 'north-carolina',
  'unc': 'north-carolina', 'miami (oh)': 'miami-oh', 'miami (ohio)': 'miami-oh',
  "saint mary's": 'saint-marys', "st. mary's": 'saint-marys',
  'vanderbilt': 'vanderbilt', 'wisconsin': 'wisconsin', 'louisville': 'louisville',
  'tennessee': 'tennessee', 'kentucky': 'kentucky', 'duke': 'duke',
  'auburn': 'auburn', 'baylor': 'baylor', 'ohio st.': 'ohio-st', 'ohio state': 'ohio-st',
  'texas': 'texas', 'ucla': 'ucla', 'tcu': 'tcu', 'byu': 'byu',
  'new mexico': 'new-mexico', 'missouri': 'missouri', 'vcu': 'vcu',
  'florida state': 'florida-st', 'florida st.': 'florida-st',
  'wake forest': 'wake-forest', 'pittsburgh': 'pittsburgh',
  'indiana': 'indiana', 'utah': 'utah', 'utah state': 'utah-st', 'utah st.': 'utah-st',
  'akron': 'akron', 'marquette': 'marquette', 'villanova': 'villanova',
  'saint louis': 'saint-louis', 'high point': 'high-point',
  'georgia': 'georgia', 'miami': 'miami-fl', 'stephen f austin': 'sf-austin',
  'north carolina state': 'north-carolina-st', 'nc state': 'north-carolina-st',
  'creighton': 'creighton', 'xavier': 'xavier', 'seton hall': 'seton-hall',
};

function nameToSeo(name) {
  const key = name.toLowerCase().replace(/\s*\(\d+\)/g, '').trim();
  if (SEONAME_MAP[key]) return SEONAME_MAP[key];
  // auto-generate: lowercase, spaces→hyphens, remove special chars
  return key.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}

function scrapeNCAARankings() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.ncaa.com',
      path:     '/rankings/basketball-men/d1/associated-press',
      method:   'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(scrapeNCAARankings());
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          // NCAA page has rankings as a Markdown-style table in the HTML:
          // | 1 | Duke (56) | 29-2 | 1519 | 1 |
          const tableMatch = body.match(/\|\s*RANK\s*\|[\s\S]*?(?=\n\n|\*\*OTHERS)/i);
          if (!tableMatch) throw new Error('Rankings table not found in page');

          const rows = tableMatch[0].split('\n').filter(r => r.includes('|'));
          const rankings = [];

          for (const row of rows) {
            // skip header and separator rows
            if (/RANK|---/.test(row)) continue;
            const cells = row.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length < 4) continue;

            const rank     = parseInt(cells[0]);
            if (isNaN(rank) || rank < 1 || rank > 25) continue;

            // name may include "(56)" for first-place votes
            const rawName  = cells[1];
            const nameShort= rawName.replace(/\s*\(\d+\)/g, '').trim();
            const fpVotes  = (rawName.match(/\((\d+)\)/) || [])[1] || 0;

            // record: "29-2"
            const recParts = (cells[2] || '').split('-');
            const wins     = parseInt(recParts[0]) || 0;
            const losses   = parseInt(recParts[1]) || 0;

            const points   = parseInt(cells[3]) || 0;
            const prevRank = cells[4] ? (parseInt(cells[4]) || null) : null;

            rankings.push({
              rank,
              prevRank: prevRank === rank ? prevRank : prevRank,
              seoname:  nameToSeo(nameShort),
              nameShort,
              wins,
              losses,
              points,
              firstPlaceVotes: Number(fpVotes),
            });
          }

          if (!rankings.length) throw new Error('No rankings parsed from table');

          // Extract "Through Games" date
          const dateMatch = body.match(/Through Games?\s+([A-Z]{3}\.?\s+\d+,?\s+\d{4})/i);
          const updated = dateMatch
            ? new Date(dateMatch[1].replace('.', '')).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];

          resolve({ poll: 'AP Top 25', updated, season: '2025-26', rankings });
        } catch(e) {
          reject(new Error('Scrape error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Scrape timeout')); });
    req.end();
  });
}

// ─── ESPN API Rankings ───────────────────────────────────
// ESPN API: https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings
// type param: (none)=AP, coaches=Coaches, net=NET
// committee and WAB not available on ESPN → use static fallback

const POLL_CONFIG = {
  ap:        { espn: '',         label: 'AP Top 25',             hasPoints: true,  hasChange: true,  extraCol: null  },
  coaches:   { espn: 'coaches',  label: 'USA TODAY Coaches Poll', hasPoints: true,  hasChange: true,  extraCol: null  },
  net:       { espn: 'net',      label: 'NCAA NET Rankings',     hasPoints: false, hasChange: false, extraCol: null  },
  committee: { espn: null,       label: 'Top 16 Committee',      hasPoints: false, hasChange: false, extraCol: null  },
  wab:       { espn: null,       label: 'WAB Ranking',           hasPoints: false, hasChange: false, extraCol: 'WAB' },
};

function fetchESPNRankings(pollKey) {
  const cfg = POLL_CONFIG[pollKey];
  return new Promise((resolve, reject) => {
    const qs   = cfg.espn ? `?type=${cfg.espn}` : '';
    const path = `/apis/site/v2/sports/basketball/mens-college-basketball/rankings${qs}`;
    const options = {
      hostname: 'site.api.espn.com',
      path,
      method:  'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json    = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const rankObj = json.rankings && json.rankings[0];
          if (!rankObj || !rankObj.ranks) throw new Error('No ranks in ESPN response');

          // ESPN may return a different poll than requested — pick the right one
          // For AP: type=ap or no type → look for "AP" in name
          // For coaches: look for "Coaches"
          // For net: look for "NET" 
          let target = rankObj;
          if (json.rankings.length > 1) {
            const keyword = pollKey === 'ap' ? 'AP' : pollKey === 'coaches' ? 'Coach' : 'NET';
            target = json.rankings.find(r => r.name.includes(keyword)) || rankObj;
          }

          const updated = target.date
            ? new Date(target.date).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];

          const rankings = target.ranks.map(r => {
            const rec   = (r.recordSummary || '0-0').split('-');
            const name  = r.team.location + (r.team.name !== r.team.location ? '' : '');
            // Use team nickname if location alone is ambiguous
            const nameShort = r.team.nickname || r.team.location;
            return {
              rank:             r.current,
              prevRank:         cfg.hasChange ? (r.previous || null) : undefined,
              seoname:          nameToSeo(nameShort),
              nameShort,
              espnId:           r.team.id,
              espnLogo:         r.team.logos && r.team.logos[0] ? r.team.logos[0].href : null,
              wins:             parseInt(rec[0]) || 0,
              losses:           parseInt(rec[1]) || 0,
              points:           cfg.hasPoints ? (r.points || 0) : undefined,
              firstPlaceVotes:  cfg.hasPoints ? (r.firstPlaceVotes || 0) : undefined,
            };
          });

          resolve({
            poll: target.name || cfg.label, updated, season: '2025-26',
            hasPoints: cfg.hasPoints, hasChange: cfg.hasChange, extraCol: cfg.extraCol,
            rankings,
          });
        } catch(e) {
          reject(new Error(`ESPN parse error [${pollKey}]: ` + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`ESPN timeout [${pollKey}]`)); });
    req.end();
  });
}

function scrapeNCAAPoll(pollKey) {
  const cfg = POLL_CONFIG[pollKey];
  if (!cfg) return Promise.reject(new Error('Unknown poll: ' + pollKey));
  // committee and WAB not on ESPN → return error (will use cache)
  if (cfg.espn === null) return Promise.reject(new Error(`${pollKey} not available via ESPN API`));
  return fetchESPNRankings(pollKey);
}

function scrapeNCAARankings() { return scrapeNCAAPoll('ap'); }
function scrapeNETRankings()  { return scrapeNCAAPoll('net'); }

function ncaaFetch(meta, hash, variables) {
  return new Promise((resolve, reject) => {
    const ext  = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } });
    const vars = JSON.stringify(variables);
    const qs   = `?meta=${encodeURIComponent(meta)}&extensions=${encodeURIComponent(ext)}&variables=${encodeURIComponent(vars)}`;

    const options = {
      hostname: NCAA_HOST,
      path:     '/' + qs,
      method:   'GET',
      headers: {
        'Accept':          'application/json',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin':          'https://www.ncaa.com',
        'Referer':         'https://www.ncaa.com/',
        'Accept-Encoding': 'identity',
      },
      timeout: 12000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return reject(new Error(`NCAA API status ${res.statusCode}`));
          resolve(JSON.parse(body));
        } catch(e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function getTodayDate() {
  const d   = new Date();
  const m   = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${m}/${day}/${d.getFullYear()}`;
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control':                'no-cache',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.ico':'image/x-icon', '.png':'image/png' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${pathname}`);

  // /api/health
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // /api/rankings?poll=ap|net|committee|wab|coaches
  if (pathname === '/api/rankings') {
    const poll = query.poll || 'ap';
    if (!POLL_CONFIG[poll]) return sendJSON(res, 400, { ok: false, error: 'Unknown poll' });
    const cfg  = POLL_CONFIG[poll];
    const file = path.join(__dirname, 'data', `rankings-${poll}.json`);

    // Check cache age
    let cacheAge = Infinity;
    if (fs.existsSync(file)) {
      cacheAge = (Date.now() - fs.statSync(file).mtimeMs) / 3600000;
    }

    // If ESPN available and cache > 2h, fetch live
    if (POLL_CONFIG[poll].espn !== null && cacheAge > 2) {
      try {
        const fresh = await scrapeNCAAPoll(poll);
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
        return sendJSON(res, 200, { ok: true, fromCache: false, ...fresh });
      } catch(e) {
        console.log(`[rankings/${poll}] Live fetch failed: ${e.message}, trying cache`);
      }
    }

    // Serve from cache
    const fallback = path.join(__dirname, 'data', 'rankings.json');
    const src = fs.existsSync(file) ? file : (poll === 'ap' && fs.existsSync(fallback) ? fallback : null);
    if (src) {
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      data.hasPoints = POLL_CONFIG[poll].hasPoints;
      data.hasChange = POLL_CONFIG[poll].hasChange;
      data.extraCol  = POLL_CONFIG[poll].extraCol;
      return sendJSON(res, 200, { ok: true, fromCache: true, ...data });
    }

    // No cache and ESPN null (committee/wab) — return empty
    return sendJSON(res, 200, { ok: true, fromCache: false,
      poll: POLL_CONFIG[poll].label, updated: '', season: '2025-26',
      hasPoints: POLL_CONFIG[poll].hasPoints, hasChange: POLL_CONFIG[poll].hasChange,
      extraCol: POLL_CONFIG[poll].extraCol, rankings: [],
      scrapeError: 'No data available',
    });
  }

  // /api/rankings/refresh — force live fetch from ESPN
  if (pathname === '/api/rankings/refresh') {
    const poll = query.poll || 'ap';
    if (!POLL_CONFIG[poll]) return sendJSON(res, 400, { ok: false, error: 'Unknown poll' });
    if (POLL_CONFIG[poll].espn === null) {
      return sendJSON(res, 200, { ok: false, error: `${poll} not available via live API — no data` });
    }
    try {
      const fresh = await scrapeNCAAPoll(poll);
      const file  = path.join(__dirname, 'data', `rankings-${poll}.json`);
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
      return sendJSON(res, 200, { ok: true, fromCache: false, ...fresh });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/logo/:seoname  — proxy NCAA team logos to avoid CORS
  if (pathname.startsWith('/api/logo/')) {
    const seoname = pathname.replace('/api/logo/', '').replace(/[^a-z0-9-]/g, '');
    if (!seoname) { res.writeHead(404); return res.end(); }

    // Try URLs in order: 500.png (big colored) → med SVG → bgd SVG
    const urls = [
      `https://www.ncaa.com/sites/default/files/images/logos/schools/bgl/${seoname}.svg`,
      `https://www.ncaa.com/sites/default/files/images/logos/schools/bgd/${seoname}.svg`,
      `https://i.turner.ncaa.com/sites/default/files/images/logos/schools/bgl/${seoname}.svg`,
    ];

    async function tryNext(index) {
      if (index >= urls.length) { res.writeHead(404); return res.end(); }
      const imgReq = https.request(urls[index], {
        headers: { 'Referer': 'https://www.ncaa.com/', 'User-Agent': 'Mozilla/5.0' }
      }, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          imgRes.resume(); // drain
          return tryNext(index + 1);
        }
        res.writeHead(200, {
          'Content-Type': imgRes.headers['content-type'] || 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        imgRes.pipe(res);
      });
      imgReq.on('error', () => tryNext(index + 1));
      imgReq.end();
    }
    return tryNext(0);
  }

  // /api/contests?date=03/15/2026
  if (pathname === '/api/contests') {
    try {
      const date = query.date || getTodayDate();
      // Calculate correct seasonYear from date (NCAA academic year = calendar year - 1 if before July)
      const parts = date.split('/');
      const month = parseInt(parts[0]), year = parseInt(parts[2]);
      const seasonYear = month >= 7 ? year : year - 1;
      const data = await ncaaFetch('GetContests_web', HASHES.contests, {
        sportCode: 'MBB', division: 1, seasonYear, contestDate: date, week: null,
      });
      return sendJSON(res, 200, { ok: true, date, contests: data?.data?.contests || [], seasonYear });
    } catch(e) {
      console.error('[/api/contests]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/scoreboard?date=20240315  — ESPN historical scores
  if (pathname === '/api/espn/scoreboard') {
    try {
      const date = query.date; // format YYYYMMDD
      if (!date) return sendJSON(res, 400, { ok: false, error: 'date required (YYYYMMDD)' });
      const espnPath = `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${date}&groups=50&limit=200`;
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: espnPath,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        };
        https.get(options, res2 => {
          let body = '';
          res2.on('data', chunk => body += chunk);
          res2.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(new Error('ESPN parse error')); }
          });
        }).on('error', reject);
      });
      // Also fetch NCAA contests for same date to get ncaaContestId for stats
      let ncaaContests = [];
      try {
        const ncaaDate = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00Z');
        const mmdd = (ncaaDate.getMonth()+1).toString().padStart(2,'0') + '/' + ncaaDate.getDate().toString().padStart(2,'0') + '/' + ncaaDate.getFullYear();
        const y = ncaaDate.getFullYear(), m = ncaaDate.getMonth()+1;
        const seasonYear = m >= 7 ? y : y - 1;
        const ncaaData = await ncaaFetch('GetContests_web', HASHES.contests, {
          sportCode: 'MBB', division: 1, seasonYear, contestDate: mmdd, week: null,
        });
        ncaaContests = ncaaData?.data?.contests || [];
      } catch(e) { /* NCAA lookup failed, continue without */ }

      // Build lookup with multiple keys for robust matching
      const ncaaLookup = {};
      const ncaaLookupByName = {};
      ncaaContests.forEach(c => {
        // Key 1: by name6Char abbreviations (e.g. "DAY|ILST")
        const abbrs = (c.teams||[]).map(t=>(t.name6Char||'').toUpperCase()).sort().join('|');
        if(abbrs && abbrs !== '|') ncaaLookup[abbrs] = c;
        // Key 2: by nameShort (e.g. "Dayton|Illinois St.")
        const names = (c.teams||[]).map(t=>(t.nameShort||'').toLowerCase()).sort().join('|');
        if(names) ncaaLookupByName[names] = c;
        // Key 3: by seoname (e.g. "dayton|illinois-st")
        const seos = (c.teams||[]).map(t=>(t.seoname||'').toLowerCase()).sort().join('|');
        if(seos) ncaaLookupByName['seo:'+seos] = c;
      });

      // Transform ESPN events → CollegeOnTV contest format
      // ESPN gives us: tournament labels, logos, schedule
      // NCAA gives us: live scores, timing, game state
      const contests = (data.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(t => t.homeAway === 'home');
        const away = comp?.competitors?.find(t => t.homeAway === 'away');
        const status = comp?.status;
        const broadcast = comp?.broadcasts?.[0]?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '';

        // Find matching NCAA contest using multiple strategies
        const espnAbbrs = [home, away].filter(Boolean)
          .map(t => (t.team?.abbreviation||'').toUpperCase()).sort().join('|');
        const espnNames = [home, away].filter(Boolean)
          .map(t => (t.team?.shortDisplayName||t.team?.location||'').toLowerCase()).sort().join('|');
        const espnSeos = [home, away].filter(Boolean)
          .map(t => (t.team?.location||'').toLowerCase().replace(/[^a-z0-9]+/g,'-')).sort().join('|');

        const ncaa = ncaaLookup[espnAbbrs]
          || ncaaLookupByName[espnNames]
          || ncaaLookupByName['seo:'+espnSeos]
          || null;
        const ncaaHome = ncaa?.teams?.find(t => t.isHome);
        const ncaaAway = ncaa?.teams?.find(t => !t.isHome);

        // Game state: prefer NCAA (live/accurate), fallback ESPN
        let gameState = 'P';
        if(ncaa) {
          if(ncaa.gameState === 'F') gameState = 'F';
          else if(ncaa.gameState === 'I') gameState = 'I';
          else gameState = 'P';
        } else {
          if (status?.type?.state === 'in') gameState = 'I';
          else if (status?.type?.state === 'post') gameState = 'F';
        }

        return {
          contestId: ev.id,
          ncaaContestId: ncaa?.contestId || null,
          gameState,
          // Live timing from NCAA (preferred) or ESPN
          currentPeriod: ncaa?.currentPeriod || (() => {
            if(status?.type?.state !== 'in') return '';
            const p = status?.period || 1;
            const half = p === 1 ? '1st' : p === 2 ? '2nd' : `OT${p-2}`;
            return half;
          })(),
          contestClock: ncaa?.contestClock || (status?.type?.state === 'in' ? status?.displayClock || '' : ''),
          finalMessage: gameState === 'F' ? 'FINAL' : '',
          // Schedule from ESPN
          startDate: ncaa?.startDate || (ev.date ? new Date(ev.date).toLocaleDateString('en-US', {month:'2-digit',day:'2-digit',year:'numeric',timeZone:'America/New_York'}) : ''),
          startTime: ncaa?.startTime || (ev.date ? new Date(ev.date).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'America/New_York'}) : ''),
          startTimeEpoch: ncaa?.startTimeEpoch || (ev.date ? Math.floor(new Date(ev.date).getTime()/1000) : 0),
          broadcasterName: ncaa?.broadcasterName || broadcast,
          // Tournament label from ESPN
          roundDescription: comp?.notes?.[0]?.headline || comp?.groups?.shortName || 'Men\'s Basketball D-I',
          roundNumber: ncaa?.roundNumber || 0,
          source: 'ESPN+NCAA',
          teams: [
            home ? {
              isHome: true,
              seoname: ncaaHome?.seoname || home.team?.location?.toLowerCase().replace(/[^a-z0-9]+/g,'-') || '',
              nameShort: ncaaHome?.nameShort || home.team?.shortDisplayName || '?',
              name6Char: ncaaHome?.name6Char || home.team?.abbreviation || '',
              // Scores from NCAA, fallback ESPN
              score: ncaa ? (ncaaHome?.score ?? null) : (home.score ? parseInt(home.score) : null),
              isWinner: ncaaHome?.isWinner || home.winner || false,
              teamRank: ncaaHome?.teamRank || (home.curatedRank?.current < 26 ? home.curatedRank?.current : null),
              seed: ncaaHome?.seed || null,
              color: ncaaHome?.color || (home.team?.color ? '#'+home.team.color : '#1a3fa8'),
              conferenceSeo: ncaaHome?.conferenceSeo || home.team?.conferenceId || '',
              teamId: ncaaHome?.teamId || home.team?.id,
              espnLogoUrl: home.team?.logo,
            } : null,
            away ? {
              isHome: false,
              seoname: ncaaAway?.seoname || away.team?.location?.toLowerCase().replace(/[^a-z0-9]+/g,'-') || '',
              nameShort: ncaaAway?.nameShort || away.team?.shortDisplayName || '?',
              name6Char: ncaaAway?.name6Char || away.team?.abbreviation || '',
              score: ncaa ? (ncaaAway?.score ?? null) : (away.score ? parseInt(away.score) : null),
              isWinner: ncaaAway?.isWinner || away.winner || false,
              teamRank: ncaaAway?.teamRank || (away.curatedRank?.current < 26 ? away.curatedRank?.current : null),
              seed: ncaaAway?.seed || null,
              color: ncaaAway?.color || (away.team?.color ? '#'+away.team.color : '#ef4444'),
              conferenceSeo: ncaaAway?.conferenceSeo || away.team?.conferenceId || '',
              teamId: ncaaAway?.teamId || away.team?.id,
              espnLogoUrl: away.team?.logo,
            } : null,
          ].filter(Boolean),
        };
      });
      return sendJSON(res, 200, { ok: true, date, contests, source: 'ESPN', total: contests.length });
    } catch(e) {
      console.error('[/api/espn/scoreboard]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/calendar?from=20260301&to=20260331 — get days with games
  if (pathname === '/api/espn/calendar') {
    try {
      const from = query.from, to = query.to;
      if(!from || !to) return sendJSON(res, 400, { ok: false, error: 'from and to required' });
      // ESPN calendar endpoint returns available game dates
      const espnPath = `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${from}-${to}&groups=50&limit=1`;
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: espnPath,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        };
        https.get(options, res2 => {
          let body = '';
          res2.on('data', chunk => body += chunk);
          res2.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(new Error('ESPN parse error')); }
          });
        }).on('error', reject);
      });
      // ESPN returns calendar array of ISO date strings with games
      const calendar = data.leagues?.[0]?.calendar || [];
      // Filter to just the month requested
      const fromDate = from.slice(0,4)+'-'+from.slice(4,6)+'-'+from.slice(6,8);
      const toDate = to.slice(0,4)+'-'+to.slice(4,6)+'-'+to.slice(6,8);
      const gameDays = calendar
        .map(d => d.slice(0,10)) // "2026-03-15T07:00Z" → "2026-03-15"
        .filter(d => d >= fromDate && d <= toDate);
      return sendJSON(res, 200, { ok: true, gameDays: [...new Set(gameDays)] });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/summary?gameId=401858359 — ESPN game stats (fallback for historical games)
  if (pathname === '/api/espn/summary') {
    try {
      const gameId = query.gameId;
      if (!gameId) return sendJSON(res, 400, { ok: false, error: 'gameId required' });
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gameId}`,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        };
        https.get(options, res2 => {
          let body = '';
          res2.on('data', chunk => body += chunk);
          res2.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(new Error('ESPN parse error')); }
          });
        }).on('error', reject);
      });
      return sendJSON(res, 200, {
        ok: true,
        boxscore: data.boxscore || null,
        plays: data.plays || [],
        leaders: data.leaders || [],
        header: data.header || null,
      });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/ncaa/find?date=YYYYMMDD&teams=DAY|ILST  — find NCAA contestId for an ESPN game
  if (pathname === '/api/ncaa/find') {
    try {
      const date = query.date; // YYYYMMDD
      const teams = query.teams || ''; // "DAY|ILST" sorted
      if (!date || !teams) return sendJSON(res, 400, { ok: false, error: 'date and teams required' });
      const ncaaDate = new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00Z');
      const mmdd = (ncaaDate.getMonth()+1).toString().padStart(2,'0') + '/' + ncaaDate.getDate().toString().padStart(2,'0') + '/' + ncaaDate.getFullYear();
      const y = ncaaDate.getFullYear(), m = ncaaDate.getMonth()+1;
      const seasonYear = m >= 7 ? y : y - 1;
      const ncaaData = await ncaaFetch('GetContests_web', HASHES.contests, {
        sportCode: 'MBB', division: 1, seasonYear, contestDate: mmdd, week: null,
      });
      const contests = ncaaData?.data?.contests || [];
      const teamsArr = teams.toUpperCase().split('|').sort();

      // Fuzzy match: check if query team name is contained in or contains NCAA team name
      function teamMatches(ncaaName, queryName) {
        const n = ncaaName.toUpperCase().replace(/[^A-Z0-9]/g,'');
        const q = queryName.toUpperCase().replace(/[^A-Z0-9]/g,'');
        return n === q || n.includes(q) || q.includes(n) || 
               // Handle common abbreviation differences
               n.startsWith(q.slice(0,4)) || q.startsWith(n.slice(0,4));
      }

      const found = contests.find(c => {
        const ncaaTeams = c.teams||[];
        // Try exact name6Char match first
        const abbrs = ncaaTeams.map(t=>(t.name6Char||'').toUpperCase()).sort();
        if(abbrs.join('|') === teamsArr.join('|')) return true;
        // Try nameShort match
        const shorts = ncaaTeams.map(t=>(t.nameShort||'').toUpperCase()).sort();
        if(shorts.join('|') === teamsArr.join('|')) return true;
        // Try fuzzy: each query team matches some NCAA team
        return teamsArr.every(qTeam =>
          ncaaTeams.some(t =>
            teamMatches(t.nameShort||'', qTeam) ||
            teamMatches(t.name6Char||'', qTeam) ||
            teamMatches(t.seoname||'', qTeam)
          )
        );
      });
      if(found) return sendJSON(res, 200, { ok: true, ncaaContestId: found.contestId });
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/teamstats?contestId=6593943 OR ?bracketId=401&seasonYear=2025
  if (pathname === '/api/teamstats') {
    try {
      const contestId = query.contestId;
      const bracketId = query.bracketId;
      const seasonYear = parseInt(query.seasonYear || '2025');
      if (!contestId && !bracketId) return sendJSON(res, 400, { ok: false, error: 'contestId or bracketId required' });

      let data;
      if (bracketId) {
        // New endpoint using bracketId (more reliable for MM games)
        data = await ncaaFetch('gamecenter_game_stats_web', HASHES.gameStats, {
          seasonYear, bracketId: parseInt(bracketId),
        });
        // This endpoint returns data in mmlContests[0].boxscore format
        const contest = data?.data?.mmlContests?.[0];
        return sendJSON(res, 200, { ok: true, data: contest?.boxscore || {} });
      } else {
        data = await ncaaFetch('NCAA_GetGamecenterTeamStatsBasketballById_web', HASHES.teamStats, {
          contestId: String(contestId), staticTestEnv: null,
        });
        return sendJSON(res, 200, { ok: true, data: data?.data?.boxscore || {} });
      }
    } catch(e) {
      console.error('[/api/teamstats]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/pbp?contestId=6593943
  if (pathname === '/api/pbp') {
    try {
      const contestId = query.contestId;
      if (!contestId) return sendJSON(res, 400, { ok: false, error: 'contestId required' });
      const data = await ncaaFetch('NCAA_GetGamecenterPbpBasketballById_web', HASHES.pbp, {
        contestId: String(contestId), staticTestEnv: null,
      });
      return sendJSON(res, 200, { ok: true, data: data?.data?.playbyplay || {} });
    } catch(e) {
      console.error('[/api/pbp]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/boxscore?contestId=6593943 OR ?bracketId=401&seasonYear=2025
  if (pathname === '/api/boxscore') {
    try {
      const contestId = query.contestId;
      const bracketId = query.bracketId;
      const seasonYear = parseInt(query.seasonYear || '2025');
      if (!contestId && !bracketId) return sendJSON(res, 400, { ok: false, error: 'contestId or bracketId required' });

      let data;
      if (bracketId) {
        data = await ncaaFetch('gamecenter_game_stats_web', HASHES.gameStats, {
          seasonYear, bracketId: parseInt(bracketId),
        });
        const contest = data?.data?.mmlContests?.[0];
        return sendJSON(res, 200, { ok: true, data: contest?.boxscore || {} });
      } else {
        data = await ncaaFetch('NCAA_GetGamecenterBoxscoreBasketballById_web', HASHES.boxscore, {
          contestId: String(contestId), staticTestEnv: null,
        });
        return sendJSON(res, 200, { ok: true, data: data?.data?.boxscore || {} });
      }
    } catch(e) {
      console.error('[/api/boxscore]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/schedule?date=03/15/2026
  if (pathname === '/api/schedule') {
    try {
      const date = query.date || getTodayDate();
      const data = await ncaaFetch('GetLiveSchedulePlusMmlEventVideo_web', HASHES.schedule, {
        today: true, monthly: false, contestDate: date, seasonYear: 2025, current: true,
      });
      return sendJSON(res, 200, { ok: true, date, data: data?.data || {} });
    } catch(e) {
      console.error('[/api/schedule]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/bracket
  if (pathname === '/api/bracket') {
    try {
      const data = await ncaaFetch('NCAA_get_bracket_tracker_web', HASHES.bracket, {
        seasonYear: 2025, sportCode: 'MBB', division: 1,
      });
      return sendJSON(res, 200, { ok: true, data: data?.data || {} });
    } catch(e) {
      console.error('[/api/bracket]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/bracket?year=2019 — ESPN MM games used to reconstruct bracket
  if (pathname === '/api/espn/bracket') {
    try {
      const year = parseInt(query.year || '2019');
      
      // Check cache first
      const cacheDir = path.join(__dirname, 'cache');
      const cacheFile = path.join(cacheDir, `espn_bracket_${year}.json`);
      
      // Create cache dir if needed
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      
      // Return cached data if exists
      if (fs.existsSync(cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        console.log(`[ESPN Bracket] Serving ${year} from cache (${cached.contests?.length} contests)`);
        return sendJSON(res, 200, cached);
      }
      
      console.log(`[ESPN Bracket] Fetching ${year} from ESPN...`);
      const MM_ROUNDS = ['First Four','First Round','Second Round','Sweet 16','Sweet Sixteen','Elite Eight','Final Four','Championship'];
      // Older ESPN format (pre-2019): "MEN'S BASKETBALL CHAMPIONSHIP - EAST REGION - 1st ROUND"
      function isMMGame(ev) {
        const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
        const nu = note.toUpperCase();
        if(nu.includes("MEN'S BASKETBALL CHAMPIONSHIP") || nu.includes("NCAA TOURNAMENT")) return true;
        return MM_ROUNDS.some(r => note.includes(r));
      }
      function getRoundFromNote(note) {
        const nu = note.toUpperCase();
        if(nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Round';
        if(nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'Second Round';
        if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return 'Sweet 16';
        if(nu.includes('ELITE EIGHT') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return 'Elite Eight';
        if(nu.includes('FINAL FOUR') || nu.includes('NATIONAL SEMIFINAL')) return 'Final Four';
        if(nu.includes('CHAMPIONSHIP') && nu.includes('NATIONAL')) return 'Championship';
        if(nu.includes('FIRST FOUR') || nu.includes('OPENING ROUND')) return 'First Four';
        // Fallback: check original MM_ROUNDS
        return MM_ROUNDS.find(r => note.includes(r)) || 'First Round';
      }

      // Fetch day by day (Mar 13 → Apr 10) — ESPN historical scoreboard works per-day
      async function fetchDay(dateStr) {
        return new Promise((resolve) => {
          const path = `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&groups=50&limit=100`;
          const options = { hostname:'site.api.espn.com', path, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} };
          https.get(options, r => {
            let body = '';
            r.on('data', c => body += c);
            r.on('end', () => {
              try {
                const data = JSON.parse(body);
                const evs = (data.events||[]).filter(ev => isMMGame(ev));
                resolve(evs);
              } catch(e) { resolve([]); }
            });
          }).on('error', () => resolve([]));
        });
      }

      // Build list of dates to check
      const dates = [];
      for(let d = new Date(`${year}-03-13T12:00:00Z`); d <= new Date(`${year}-04-10T12:00:00Z`); d.setDate(d.getDate()+1)) {
        dates.push(d.getFullYear().toString() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'));
      }

      // Fetch all days (in parallel batches of 5)
      const allEvents = [];
      for(let i=0; i<dates.length; i+=5) {
        const batch = dates.slice(i, i+5);
        const results = await Promise.all(batch.map(fetchDay));
        results.forEach(evs => allEvents.push(...evs));
      }

      // Deduplicate
      const seen = new Set();
      const events = allEvents.filter(ev => { if(seen.has(ev.id)) return false; seen.add(ev.id); return true; });

      if(events.length === 0) {
        return sendJSON(res, 404, { ok: false, error: `No NCAA Tournament games found for ${year}. ESPN may not have historical data for this year.` });
      }

      // Hardcoded contestId → bracketId for ESPN historical First Round
      // Built from actual ESPN API data - each region has 8 slots
      const hardcodedBracketIds = {
        // 2018 First Round
        '401025816':201,'401025833':202,'401025832':203,'401025819':204,
        '401025828':205,'401025822':206,'401025827':207,'401025821':208,
        '401025825':209,'401025840':210,'401025836':211,'401025834':212,
        '401025853':213,'401025829':214,'401025838':215,'401025821':216,
        '401025831':217,'401025850':218,'401025814':219,'401025818':220,
        '401025826':221,'401025817':222,'401025830':223,'401025813':224,
        '401025823':225,'401025815':226,'401025852':227,'401025820':228,
        '401025839':229,'401025835':230,'401025837':231,'401025824':232,
        // 2015 Second Round (ESPN calls them Sweet 16, bracketIds 401-408 → we map to 301-316)
        '400786505':301,'400786512':302,'400786516':303,'400786506':304,
        '400786514':309,'400786370':310,'400786510':311,'400786476':312,
        // 2015 Sweet 16 (ESPN calls them Elite Eight, bracketIds 501-504 → we map to 401-408)
        '400786516':401,'400786506':402,'400786505':403,'400786512':404,
        '400786514':405,'400786370':406,'400786510':407,'400786476':408,
      };

      // ESPN pre-2016 used different round naming AND bracketIds shifted by one round:
      // ESPN "First Round" = our First Four
      // ESPN "Second Round" (bracketIds 201-232) = our First Round
      // ESPN "Sweet 16" (bracketIds 401-408) = our Second Round (301-316)
      // ESPN "Elite Eight" (bracketIds 501-504) = our Sweet 16 (401-408)
      if(year < 2016) {
        events.forEach(ev => {
          const comp = ev.competitions?.[0];
          if(!comp) return;
          const note = comp.notes?.[0]?.headline || '';
          const nu = note.toUpperCase();
          ev.__remappedRound = null;
          ev.__bracketIdOffset = 0;
          if(nu.includes('FIRST ROUND') || nu.includes('1ST ROUND')) {
            ev.__remappedRound = 'First Four';
          } else if(nu.includes('SECOND ROUND') || nu.includes('2ND ROUND')) {
            ev.__remappedRound = 'First Round';
          } else if(nu.includes('SWEET 16') || nu.includes('REGIONAL SEMIFINAL')) {
            ev.__remappedRound = 'Second Round';
            ev.__bracketIdOffset = -100; // 401→301, 402→302, etc.
            ev.__espnBracketId = ev.competitions?.[0]?.bracketId;
          } else if(nu.includes('REGIONAL') && (nu.includes('FINAL') || nu.includes('CHAMPIONSHIP') || nu.includes('ELITE'))) {
            ev.__remappedRound = 'Sweet 16';
            ev.__bracketIdOffset = -100; // 501→401, 502→402, etc.
            ev.__espnBracketId = ev.competitions?.[0]?.bracketId;
          } else if(nu.includes('NATIONAL SEMIFINAL') || nu.includes('FINAL FOUR')) {
            ev.__remappedRound = 'Final Four';
          } else if(nu.includes('NATIONAL CHAMPIONSHIP') || nu.includes('CHAMPIONSHIP GAME')) {
            ev.__remappedRound = 'Championship';
          }
        });
      }
      const roundOrder = {'First Four':0,'First Round':1,'Second Round':2,'Sweet 16':3,'Sweet Sixteen':3,'Elite Eight':4,'Final Four':5,'Championship':6};
      const roundBase  = [201, 201, 301, 401, 501, 601, 701]; // bracketId bases per round

      // Sort by date then group by round
      events.sort((a,b) => new Date(a.date) - new Date(b.date));

      const byRound = {};
      events.forEach(ev => {
        const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
        const roundKey = MM_ROUNDS.find(r => note.includes(r)) || 'Unknown';
        if(!byRound[roundKey]) byRound[roundKey] = [];
        byRound[roundKey].push(ev);
      });

      // Region-aware bracketId assignment
      // ESPN notes headline: "NCAA Tournament - East Regional - Second Round"
      // or "NCAA Tournament - First Round" (no region for first round)
      // BracketId layout:
      // First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
      // Second Round: East=301-304, West=305-308, South=309-312, Midwest=313-316
      // Sweet 16:     East=401-402, West=403-404, South=405-406, Midwest=407-408
      // Elite Eight:  East=501, West=502, South=503, Midwest=504
      // Final Four:   601, 602
      // Championship: 701

      const regionBase = { east:0, west:8, south:16, midwest:24 }; // offset for first round
      const regionR32  = { east:0, west:4, south:8, midwest:12 };
      const regionS16  = { east:0, west:2, south:4, midwest:6 };
      const regionE8   = { east:0, west:1, south:2, midwest:3 };
      const regionCounters = {}; // "round:region" → counter

      function getRegionFromNote(note) {
        const n = note.toUpperCase();
        if(n.includes('EAST'))    return 'east';
        if(n.includes('WEST'))    return 'west';
        if(n.includes('SOUTH') && !n.includes('SOUTHEAST')) return 'south';
        if(n.includes('MIDWEST') || n.includes('MID'))      return 'midwest';
        return null;
      }

      // Group First Round games and assign regions using 1-seed teams
      const firstRoundEvents = events.filter(ev => getRoundFromNote(ev.competitions?.[0]?.notes?.[0]?.headline||'') === 'First Round');
      firstRoundEvents.sort((a,b) => new Date(a.date) - new Date(b.date));
      
      // Seed-based region assignment for First Round
      // Each region has exactly one 1-seed game (1 vs 16)
      // We find all 1-seed First Round games and assign them regions in order
      // Then group remaining games by which 1-seed game they share a time/day with
      
      firstRoundEvents.sort((a,b) => new Date(a.date)-new Date(b.date));
      
      // Find games with 1-seeds → these anchor each region
      const seed1Games = firstRoundEvents.filter(ev =>
        (ev.competitions?.[0]?.competitors||[]).some(t => Number(t.seed)===1)
      ).sort((a,b) => new Date(a.date)-new Date(b.date));
      
      // Map each 1-seed game's contestId → region
      const regionOrder2 = ['east','west','south','midwest'];
      const seed1RegionMap = {}; // contestId → region
      seed1Games.forEach((ev, i) => {
        seed1RegionMap[ev.id] = regionOrder2[i % 4];
      });
      
      // For non-1-seed games: find the closest 1-seed game by time (same day+location proxy)
      // Games on same day within 2 hours of a 1-seed game belong to same region
      // But simpler: just assign by index within each day's game order
      // Split 32 games into 4 groups of 8 by time order
      const sortedFirstRound = [...firstRoundEvents];
      
      // Assign region counter per group of 8
      const gameRegionMap = {}; // ev.id → region
      seed1Games.forEach(seed1Ev => {
        const seed1Time = new Date(seed1Ev.date).getTime();
        const region = seed1RegionMap[seed1Ev.id];
        // Games within 6 hours of this 1-seed game = same region
        firstRoundEvents.forEach(ev => {
          if(gameRegionMap[ev.id]) return; // already assigned
          const t = new Date(ev.date).getTime();
          if(Math.abs(t - seed1Time) < 6 * 3600 * 1000) {
            gameRegionMap[ev.id] = region;
          }
        });
      });
      
      // Remaining unassigned games: assign to remaining regions by time order
      const assignedRegions = new Set(Object.values(gameRegionMap));
      const unassigned = firstRoundEvents.filter(ev => !gameRegionMap[ev.id]);
      const remainingRegions2 = regionOrder2.filter(r => !assignedRegions.has(r));
      const chunkSize = Math.ceil(unassigned.length / Math.max(remainingRegions2.length, 1));
      unassigned.forEach((ev, i) => {
        gameRegionMap[ev.id] = remainingRegions2[Math.floor(i / chunkSize)] || remainingRegions2[0] || 'east';
      });

      // Per-round-per-region counters
      const slotCounters = {};
      function nextSlot(key, base) {
        if(slotCounters[key] === undefined) slotCounters[key] = base;
        return slotCounters[key]++;
      }

      function getRegionFromEvent(ev) {
        const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
        const n = note.toUpperCase();
        if(n.includes('EAST') && !n.includes('NORTHEAST'))    return 'east';
        if(n.includes('WEST') && !n.includes('NORTHWEST') && !n.includes('SOUTHWEST')) return 'west';
        if(n.includes('SOUTH') && !n.includes('SOUTHEAST')) return 'south';
        if(n.includes('MIDWEST') || (n.includes('MID') && n.includes('REGION'))) return 'midwest';
        // Use seed-based region map for First Round
        return gameRegionMap[ev.id] || null;
      }

      function assignBracketId(roundKey, ev) {
        const region = getRegionFromEvent(ev);

        if(roundKey === 'First Four')   return nextSlot('ff', 101);
        if(roundKey === 'Championship') return 701;
        if(roundKey === 'Final Four')   return nextSlot('ff4', 601);

        if(roundKey === 'Elite Eight') {
          if(region) return 501 + (regionE8[region]||0);
          return nextSlot('e8', 501);
        }
        if(roundKey === 'Sweet 16' || roundKey === 'Sweet Sixteen') {
          if(region) return nextSlot(`s16:${region}`, 401 + (regionS16[region]||0));
          return nextSlot('s16:x', 401);
        }
        if(roundKey === 'Second Round') {
          if(region) return nextSlot(`r32:${region}`, 301 + (regionR32[region]||0));
          return nextSlot('r32:x', 301);
        }
        if(roundKey === 'First Round') {
          // Use hardcoded mapping first
          if(hardcodedBracketIds[ev.id]) return hardcodedBracketIds[ev.id];
          if(region) return nextSlot(`r64:${region}`, 201 + (regionBase[region]||0));
          return nextSlot('r64:x', 201);
        }
        return nextSlot('other', 900);
      }

      const contests = [];
      events.sort((a,b) => new Date(a.date) - new Date(b.date));

      events.forEach(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(t => t.homeAway === 'home');
        const away = comp?.competitors?.find(t => t.homeAway === 'away');
        const status = comp?.status;
        const gameState = status?.type?.state === 'post' ? 'F' : status?.type?.state === 'in' ? 'I' : 'P';
        const note = comp?.notes?.[0]?.headline || '';
        const roundKey = ev.__remappedRound || getRoundFromNote(note);
        const ri = roundOrder[roundKey] ?? 1;
        // Use hardcoded bracketId if available
        let bracketId = hardcodedBracketIds[ev.id] || assignBracketId(roundKey, ev);

        contests.push({
          bracketId,
          contestId: ev.id,
          gameState,
          currentPeriod: gameState==='I' ? (() => {
            const p = status?.period||1;
            return p===1?'1st':p===2?'2nd':`OT${p-2}`;
          })() : '',
          contestClock: gameState==='I' ? status?.displayClock||'' : '',
          finalMessage: gameState==='F' ? 'FINAL' : '',
          startTimeEpoch: ev.date ? Math.floor(new Date(ev.date).getTime()/1000) : 0,
          round: {
            roundNumber: ri + 2,
            title: roundKey,
            subtitle: ev.date ? new Date(ev.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : ''
          },
          broadcaster: { name: comp?.broadcasts?.[0]?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '' },
          teams: [home, away].filter(Boolean).map((t, i) => ({
            isHome: i===0,
            seoname: (t.team?.location||'').toLowerCase().replace(/[^a-z0-9]+/g,'-'),
            nameShort: t.team?.shortDisplayName || t.team?.location || '?',
            name6Char: t.team?.abbreviation || '',
            seed: t.seed != null ? t.seed : (t.curatedRank?.current < 17 ? t.curatedRank?.current : null),
            score: t.score ? parseInt(t.score) : null,
            isWinner: t.winner || false,
            color: t.team?.color ? '#'+t.team.color : null,
            espnLogoUrl: t.team?.logo || null,
          })),
        });
      });

      // Fix duplicate bracketIds - simple forward search with max iterations
      const usedBracketIds = new Set();
      contests.forEach(c => {
        if(usedBracketIds.has(c.bracketId)) {
          const rk = c.round?.title;
          let min, max;
          if(rk === 'First Round')   { min = 201; max = 232; }
          else if(rk === 'Second Round') { min = 301; max = 332; }
          else if(rk === 'Sweet 16' || rk === 'Sweet Sixteen') { min = 401; max = 416; }
          else if(rk === 'Elite Eight') { min = 501; max = 508; }
          else { usedBracketIds.add(c.bracketId); return; }
          // Find next available slot
          let newId = c.bracketId + 1;
          let attempts = 0;
          while(usedBracketIds.has(newId) && attempts < 50) {
            newId++;
            if(newId > max) newId = min;
            attempts++;
          }
          if(!usedBracketIds.has(newId)) c.bracketId = newId;
        }
        usedBracketIds.add(c.bracketId);
      });

      const result = { ok: true, contests, year, total: contests.length, source: 'ESPN' };
      
      // Save to cache
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(result));
        console.log(`[ESPN Bracket] Cached ${year} (${contests.length} contests)`);
      } catch(cacheErr) {
        console.warn('[ESPN Bracket] Cache write failed:', cacheErr.message);
      }
      
      return sendJSON(res, 200, result);
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/mml/bracket — full March Madness bracket with scores
  // supports ?season=2024 for historical brackets
  if (pathname === '/api/mml/bracket') {
    try {
      const season = parseInt(query.season || '2025') || 2025;
      const data = await ncaaFetch('scores_bracket_web', HASHES.mmlBracket, { seasonYear: season });
      return sendJSON(res, 200, { ok: true, contests: data?.data?.mmlContests || [], season });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/mml/live — current live March Madness games
  if (pathname === '/api/mml/live') {
    try {
      const data = await ncaaFetch('scores_current_web', HASHES.mmlCurrent, { seasonYear: 2025, current: true });
      return sendJSON(res, 200, { ok: true, contests: data?.data?.mmlContests || [], events: data?.data?.mmlEvents || [] });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // static files from /public
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'));
  }

  const staticPath = path.join(__dirname, 'public', pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    return sendFile(res, staticPath);
  }

  // fallback SPA
  sendFile(res, path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     CollegeOnTV — Backend Server     ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  App : http://localhost:${PORT}          ║`);
  console.log(`║  API : http://localhost:${PORT}/api      ║`);
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Endpoints:                          ║');
  console.log('║  GET /api/health                     ║');
  console.log('║  GET /api/contests?date=MM/DD/YYYY   ║');
  console.log('║  GET /api/schedule?date=MM/DD/YYYY   ║');
  console.log('║  GET /api/bracket                    ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('\n  Press Ctrl+C to stop\n');
});
