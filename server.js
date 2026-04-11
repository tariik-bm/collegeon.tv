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
      console.log(`[ESPN Bracket] Fetching ${year} from ESPN...`);
      const MM_ROUNDS = ['First Four','First Round','Second Round','Sweet 16','Sweet Sixteen','Elite Eight','Final Four','Championship'];
      // Older ESPN format (pre-2019): "MEN'S BASKETBALL CHAMPIONSHIP - EAST REGION - 1st ROUND"
      // Pre-2016 notes may be short all-caps format: "EAST - SWEET 16 AT SYRACUSE NY"
      function isMMGame(ev) {
        const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
        const nu = note.toUpperCase();
        if(nu.includes("MEN'S BASKETBALL CHAMPIONSHIP") || nu.includes("NCAA TOURNAMENT")) return true;
        // Handle pre-2016 short all-caps notes without NCAA prefix
        if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return true;
        if(nu.includes('ELITE 8') || nu.includes('ELITE EIGHT') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return true;
        if(nu.includes('FINAL FOUR') || nu.includes('NATIONAL SEMIFINAL')) return true;
        if(nu.includes('NATIONAL CHAMPIONSHIP')) return true;
        if((nu.includes('1ST ROUND') || nu.includes('2ND ROUND') || nu.includes('3RD ROUND')) && (nu.includes('CHAMPIONSHIP') || nu.includes('NCAA'))) return true;
        if((nu.includes('OPENING ROUND') || nu.includes('PLAY-IN')) && (nu.includes('CHAMPIONSHIP') || nu.includes('NCAA'))) return true;
        return MM_ROUNDS.some(r => note.includes(r));
      }
      function getRoundFromNote(note) {
        const nu = note.toUpperCase();
        if(nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Round';
        if(nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'Second Round';
        if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return 'Sweet 16';
        if(nu.includes('ELITE EIGHT') || nu.includes('ELITE 8') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return 'Elite Eight';
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

      // Deduplicate events
      const seen = new Set();
      const events = allEvents.filter(ev => {
        if(seen.has(ev.id)) return false;
        seen.add(ev.id);
        return true;
      });

      if(events.length === 0) {
        return sendJSON(res, 404, { ok: false, error: `No NCAA Tournament games found for ${year}. ESPN may not have historical data for this year.` });
      }

      // Hardcoded contestId → bracketId for ESPN historical bracket
      // Built from actual ESPN API data - each region has 8 slots
      // First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
      // Second Round: East=301-304, West=305-308, South=309-312, Midwest=313-316
      // Sweet 16: East=401-402, West=403-404, South=405-406, Midwest=407-408
      // Elite Eight: East=501, West=502, South=503, Midwest=504
      // Final Four: 601-602, Championship: 701
      const hardcodedBracketIds = {
        // 2019 First Four
        '401123378':101,'401123380':102,'401123379':103,'401123377':104,
        // 2019 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        '401123420':201,'401123419':202,'401123418':203,'401123417':204,'401123437':205,'401123438':206,'401123436':207,'401123435':208,
        '401123396':209,'401123395':210,'401123394':211,'401123393':212,'401123408':213,'401123407':214,'401123406':215,'401123405':216,
        '401123412':217,'401123411':218,'401123410':219,'401123409':220,'401123400':221,'401123399':222,'401123398':223,'401123397':224,
        '401123416':225,'401123415':226,'401123402':227,'401123401':228,'401123414':229,'401123413':230,'401123404':231,'401123403':232,
        // 2019 Second Round
        '401123427':301,'401123428':302,'401123440':303,'401123439':304,
        '401123429':305,'401123430':306,'401123422':307,'401123421':308,
        '401123424':309,'401123431':310,'401123432':311,'401123423':312,
        '401123426':313,'401123434':314,'401123425':315,'401123433':316,
        // 2019 Sweet 16
        '401123388':401,'401123389':402,'401123386':403,'401123385':404,'401123381':405,'401123382':406,'401123392':407,'401123391':408,
        // 2019 Elite Eight
        '401123387':501,'401123384':502,'401123383':503,'401123390':504,
        // 2019 Final Four: 601=East(MSU/501)+West(TTech/502), 602=South(UVA/503)+Midwest(AUB/504)
        '401123376':601,'401123375':602,
        // 2019 Championship
        '401123374':701,

        // 2018 First Four
        '401025856':101,'401025841':102,'401025855':103,'401025854':104,
        // 2018 First Round (seed-ordered: 1v16=slot1, 8v9=2, 5v12=3, 4v13=4, 6v11=5, 3v14=6, 7v10=7, 2v15=8)
        '401025816':201,'401025832':202,'401025821':203,'401025822':204,'401025819':205,'401025833':206,'401025827':207,'401025828':208,
        '401025826':209,'401025837':210,'401025853':211,'401025840':212,'401025829':213,'401025838':214,'401025850':215,'401025839':216,
        '401025813':217,'401025830':218,'401025814':219,'401025818':220,'401025815':221,'401025831':222,'401025817':223,'401025820':224,
        '401025823':225,'401025834':226,'401025851':227,'401025852':228,'401025824':229,'401025835':230,'401025825':231,'401025836':232,
        // 2018 Second Round
        '401025862':301,'401025865':302,'401025863':303,'401025864':304,
        '401025867':305,'401025869':306,'401025868':307,'401025866':308,
        '401025860':309,'401025858':310,'401025857':311,'401025861':312,
        '401025871':313,'401025872':314,'401025873':315,'401025870':316,
        // 2018 Sweet 16
        '401025879':401,'401025878':402,'401025874':403,'401025875':404,'401025877':405,'401025876':406,'401025880':407,'401025881':408,
        // 2018 Elite Eight (East=501, West=502, South=503, Midwest=504)
        '401025883':501,'401025885':502,'401025884':503,'401025882':504,
        // 2018 Final Four: 601=East(Villanova/501)+Midwest(Kansas/504), 602=West(Michigan/502)+South(Loyola/503)
        '401025886':601,'401025887':602,
        // 2018 Championship
        '401025888':701,

        // 2017 First Four
        '400946445':101,'400946443':102,
        // 2017 First Round
        '400946417':201,'400946427':202,'400946428':203,'400946418':204,'400946420':205,'400946430':206,'400946429':207,'400946419':208,
        '400946449':209,'400946439':210,'400946440':211,'400946450':212,'400946452':213,'400946442':214,'400946441':215,'400946451':216,
        '400946425':217,'400946435':218,'400946436':219,'400946446':220,'400946448':221,'400946438':222,'400946437':223,'400946447':224,
        '400946421':225,'400946431':226,'400946432':227,'400946422':228,'400946424':229,'400946434':230,'400946433':231,'400946423':232,
        // 2017 Second Round
        '400947025':301,'400947000':302,'400947183':303,'400947225':304,
        '400947027':305,'400947006':306,'400947046':307,'400947049':308,
        '400947185':309,'400947026':310,'400947226':311,'400947227':312,
        '400947223':313,'400947047':314,'400947206':315,'400947182':316,
        // 2017 Sweet 16
        '400947266':401,'400947327':402,'400947270':403,'400947273':404,'400947324':405,'400947330':406,'400947321':407,'400947325':408,
        // 2017 Elite Eight
        '400948729':501,'400948652':502,'400948726':503,'400948650':504,
        // 2017 Final Four: 601=East(South Carolina/501)+West(Gonzaga/502), 602=South(UNC/503)+Midwest(Oregon/504)
        '400948847':601,'400948853':602,
        // 2017 Championship
        '400949246':701,

        // 2016 First Four
        '400871279':101,'400871274':102,'400871254':103,'400871283':104,
        // 2016 First Round
        '400871258':201,'400871280':202,'400871259':203,'400871260':204,'400871262':205,'400871261':206,'400871282':207,'400871281':208,
        '400871253':209,'400871275':210,'400871276':211,'400871255':212,'400871257':213,'400871278':214,'400871277':215,'400871256':216,
        '400871129':217,'400871250':218,'400871270':219,'400871271':220,'400871273':221,'400871272':222,'400871252':223,'400871251':224,
        '400871284':225,'400871263':226,'400871264':227,'400871285':228,'400871287':229,'400871266':230,'400871265':231,'400871286':232,
        // 2016 Second Round
        '400872165':301,'400872166':302,'400872251':303,'400872259':304,
        '400872255':305,'400872082':306,'400872229':307,'400872224':308,
        '400872131':309,'400872218':310,'400872163':311,'400872214':312,
        '400872129':313,'400872132':314,'400872167':315,'400872223':316,
        // 2016 Sweet 16
        '400872339':401,'400872394':402,'400872397':403,'400872390':404,'400872333':405,'400872358':406,'400872330':407,'400872391':408,
        // 2016 Elite Eight
        '400873157':501,'400873026':502,'400873025':503,'400873156':504,
        // 2016 Final Four: 601=East(UNC/501)+Midwest(Syracuse/504), 602=West(Oklahoma/502)+South(Villanova/503)
        '400873196':601,'400873214':602,
        // 2016 Championship
        '400873651':701,

        // 2015 First Four
        '400785453':101,'400785451':102,'400785452':103,'400785474':104,
        // 2015 First Round (seed-ordered: slot1=1v16, slot2=8v9, slot3=5v12, slot4=4v13, slot5=6v11, slot6=3v14, slot7=7v10, slot8=2v15)
        '400785347':201,'400785439':202,'400785440':203,'400785348':204,'400785350':205,'400785442':206,'400785441':207,'400785349':208,
        '400785455':209,'400785447':210,'400785448':211,'400785456':212,'400785458':213,'400785450':214,'400785449':215,'400785457':216,
        '400785351':217,'400785443':218,'400785444':219,'400785352':220,'400785454':221,'400785446':222,'400785445':223,'400785353':224,
        '400785343':225,'400785435':226,'400785436':227,'400785344':228,'400785346':229,'400785438':230,'400785437':231,'400785345':232,
        // 2015 Second Round
        '400786221':301,'400786306':302,'400786333':303,'400786305':304,
        '400786326':305,'400786202':306,'400786184':307,'400786186':308,
        '400786330':309,'400786206':310,'400786183':311,'400786332':312,
        '400786203':313,'400786307':314,'400786182':315,'400786304':316,
        // 2015 Sweet 16
        '400786516':401,'400786506':402,'400786512':403,'400786370':404,'400786476':405,'400786510':406,'400786514':407,'400786505':408,
        // 2015 Elite Eight
        '400787680':501,'400787578':502,'400787701':503,'400787576':504,
        // 2015 Final Four: 601=East(MSU/501)+South(Duke/503), 602=Midwest(Kentucky/504)+West(Wisconsin/502)
        '400787887':601,'400787769':602,
        // 2015 Championship
        '400788981':701,

        // 2014 First Four
        '400546938':101,'400546939':102,'400546940':103,'400546941':104,
        // 2014 First Round (seed-ordered)
        '400546932':201,'400546933':202,'400546934':203,'400546908':204,'400546909':205,'400546937':206,'400546936':207,'400546935':208,
        '400546921':209,'400546922':210,'400546923':211,'400546901':212,'400546902':213,'400546926':214,'400546925':215,'400546924':216,
        '400546943':217,'400546916':218,'400546917':219,'400546899':220,'400546900':221,'400546920':222,'400546919':223,'400546918':224,
        '400546948':225,'400546928':226,'400546949':227,'400546903':228,'400546950':229,'400546931':230,'400546930':231,'400546929':232,
        // 2014 Second Round
        '400548704':301,'400548471':302,'400548705':303,'400548494':304,
        '400548688':305,'400548509':306,'400548679':307,'400548468':308,
        '400548469':309,'400548713':310,'400548467':311,'400548683':312,
        '400548706':313,'400548508':314,'400548678':315,'400548473':316,
        // 2014 Sweet 16
        '400548899':401,'400548879':402,'400548900':403,'400548897':404,'400548873':405,'400548862':406,'400548877':407,'400548885':408,
        // 2014 Elite Eight
        '400549858':501,'400549675':502,'400549674':503,'400549857':504,
        // 2014 Final Four: 601=East(UConn/501)+South(Florida/503), 602=West(Wisconsin/502)+Midwest(Kentucky/504)
        '400549976':601,'400549978':602,
        // 2014 Championship
        '400551234':701,

        // 2013 First Four
        '330782335':101,'330782393':102,'330790068':103,'330790256':104,
        // 2013 First Round (seed-ordered)
        '330810084':201,'330810152':202,'330802439':203,'330800183':204,'330802086':205,'330800269':206,'330810356':207,'330812390':208,
        '330802250':209,'330800221':210,'330810275':211,'330812306':212,'330800012':213,'330800167':214,'330810087':215,'330810194':216,
        '330812305':217,'330810153':218,'330802670':219,'330800130':220,'330810026':221,'330810057':222,'330810021':223,'330810046':224,
        '330800097':225,'330800036':226,'330800197':227,'330800139':228,'330800235':229,'330800127':230,'330810156':231,'330810150':232,
        // 2013 Second Round
        '330830084':301,'330820183':302,'330820269':303,'330832390':304,
        '330822250':305,'330830145':306,'330820012':307,'330830194':308,
        '330832305':309,'330820130':310,'330830057':311,'330830021':312,
        '330820097':313,'330820139':314,'330820127':315,'330830150':316,
        // 2013 Sweet 16
        '330870084':401,'330872390':402,'330872724':403,'330870194':404,'330882305':405,'330880057':406,'330880097':407,'330880150':408,
        // 2013 Elite Eight
        '330890269':501,'330890194':502,'330900057':503,'330900097':504,
        // 2013 Final Four: 601=East(Syracuse/501)+South(Michigan/503), 602=West(Wichita St/502)+Midwest(Louisville/504)
        '330960130':601,'330960097':602,
        // 2013 Championship
        '330980097':701,

        // 2012 First Four
        '320732400':101,'320730252':102,'320742320':103,'320740025':104,
        // 2012 First Round (seed-ordered)
        '320750183':201,'320752306':202,'320750238':203,'320750275':204,'320762132':205,'320760052':206,'320752250':207,'320750194':208,
        '320760127':209,'320760235':210,'320750167':211,'320750097':212,'320750093':213,'320750269':214,'320760057':215,'320760142':216,
        '320750096':217,'320750066':218,'320752724':219,'320750084':220,'320752439':221,'320750239':222,'320760087':223,'320760150':224,
        '320760153':225,'320760156':226,'320760218':227,'320760130':228,'320760021':229,'320760046':230,'320762608':231,'320762305':232,
        // 2012 Second Round
        '320770183':301,'320770275':302,'320780052':303,'320770194':304,
        '320780127':305,'320770097':306,'320770269':307,'320780057':308,
        '320770096':309,'320770084':310,'320770239':311,'320782752':312,
        '320780153':313,'320780058':314,'320780046':315,'320782305':316,
        // 2012 Sweet 16
        '320820183':401,'320820194':402,'320820127':403,'320820269':404,'320830096':405,'320830239':406,'320830153':407,'320832305':408,
        // 2012 Elite Eight
        '320840183':501,'320840097':502,'320850096':503,'320850153':504,
        // 2012 Final Four: 601=East(Ohio St/501)+Midwest(Kansas/504), 602=West(Louisville/502)+South(Kentucky/503)
        '320912305':601,'320910096':602,
        // 2012 Championship
        '320930096':701,

        // 2011 First Four
        '310742031':101,'310740005':102,'310752011':103,'310750030':104,
        // 2011 First Round (seed-ordered; Southeast->South slots 217-224, Southwest->Midwest slots 225-232)
        '310770194':201,'310772244':202,'310760277':203,'310760096':204,'310772752':205,'310770183':206,'310770264':207,'310770153':208,
        '310770150':209,'310770130':210,'310770012':211,'310770251':212,'310762132':213,'310760041':214,'310760218':215,'310760021':216,
        '310760221':217,'310762086':218,'310762306':219,'310760275':220,'310762599':221,'310760252':222,'310760026':223,'310760057':224,
        '310772305':225,'310772439':226,'310760238':227,'310760097':228,'310770046':229,'310772509':230,'310770245':231,'310770087':232,
        // 2011 Second Round
        '310790194':301,'310780096':302,'310790183':303,'310790153':304,
        '310790150':305,'310790251':306,'310780041':307,'310780021':308,
        '310780221':309,'310780275':310,'310780252':311,'310780057':312,
        '310792305':313,'310780257':314,'310792509':315,'310790087':316,
        // 2011 Sweet 16
        '310840194':401,'310840153':402,'310830150':403,'310830021':404,'310830275':405,'310830057':406,'310842305':407,'310840052':408,
        // 2011 Elite Eight
        '310860153':501,'310850041':502,'310850057':503,'310862305':504,
        // 2011 Final Four: 601=East(Kentucky/501)+West(UConn/502), 602=South/SE(Butler/503)+Midwest/SW(VCU/504)
        '310920041':601,'310922086':602,
        // 2011 Championship
        '310940041':701,

        // 2010 First Four (Opening Round: only 1 play-in game)
        '300752737':101,
        // 2010 First Round (seed-ordered)
        '300770096':201,'300770251':202,'300780218':203,'300780275':204,'300770269':205,'300770167':206,'300780228':207,'300780277':208,
        '300780150':209,'300780025':210,'300780245':211,'300782509':212,'300770087':213,'300770239':214,'300770257':215,'300770222':216,
        '300780183':217,'300782250':218,'300772086':219,'300770238':220,'300782752':221,'300780221':222,'300770252':223,'300772306':224,
        '300772305':225,'300772439':226,'300780127':227,'300780120':228,'300772633':229,'300770046':230,'300780197':231,'300780194':232,
        // 2010 Second Round
        '300790096':301,'300800275':302,'300790167':303,'300800277':304,
        '300800150':305,'300802509':306,'300790239':307,'300790222':308,
        '300800183':309,'300792086':310,'300800221':311,'300792306':312,
        '300792305':313,'300800120':314,'300792633':315,'300800194':316,
        // 2010 Sweet 16
        '300840096':401,'300840277':402,'300850150':403,'300850239':404,'300840183':405,'300842306':406,'300850127':407,'300850194':408,
        // 2010 Elite Eight
        '300860096':501,'300870150':502,'300862306':503,'300870127':504,
        // 2010 Final Four: 601=East(501)+South(502), 602=West(503)+Midwest(504)
        '300930150':601,'300930127':602,
        // 2010 Championship
        '300950150':701,
      };

      // ESPN pre-2016 used different round naming:
      // 2011-2015: "1ST ROUND"=First Four, "2ND ROUND"=First Round, "3RD ROUND"=Second Round,
      //            "SWEET 16"=Sweet 16, "ELITE 8"=Elite Eight
      // 2010: one play-in "OPENING ROUND"→First Four (bracketId=101), "1ST ROUND"=First Round, "2ND ROUND"=Second Round
      if(year < 2016) {
        events.forEach(ev => {
          const comp = ev.competitions?.[0];
          if(!comp) return;
          const note = comp.notes?.[0]?.headline || '';
          const nu = note.toUpperCase();
          ev.__remappedRound = null;
          ev.__bracketIdOffset = 0;
          if(nu.includes('OPENING ROUND') || nu.includes('PLAY-IN')) {
            ev.__remappedRound = 'First Four';
          } else if(nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) {
            ev.__remappedRound = year <= 2010 ? 'First Round' : 'First Four';
          } else if(nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) {
            ev.__remappedRound = year <= 2010 ? 'Second Round' : 'First Round';
          } else if(nu.includes('3RD ROUND') || nu.includes('THIRD ROUND')) {
            ev.__remappedRound = 'Second Round';
          } else if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) {
            ev.__remappedRound = 'Sweet 16';
          } else if(nu.includes('ELITE') || (nu.includes('REGIONAL') && (nu.includes('FINAL') || nu.includes('CHAMPIONSHIP')))) {
            ev.__remappedRound = 'Elite Eight';
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
        if(n.includes('EAST') && !n.includes('NORTHEAST') && !n.includes('SOUTHEAST'))    return 'east';
        if(n.includes('WEST') && !n.includes('NORTHWEST') && !n.includes('SOUTHWEST')) return 'west';
        if(n.includes('SOUTHEAST') || (n.includes('SOUTH') && !n.includes('SOUTHWEST'))) return 'south';
        if(n.includes('MIDWEST') || n.includes('SOUTHWEST') || (n.includes('MID') && n.includes('REGION'))) return 'midwest';
        // Use seed-based region map for First Round
        return gameRegionMap[ev.id] || null;
      }

      function assignBracketId(roundKey, ev) {
        const region = getRegionFromEvent(ev);

        if(roundKey === 'First Four')   return nextSlot('ff', 180); // 180+ = hidden (real FF games come from hardcodedBracketIds)
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
          // Use hardcoded mapping first; unmapped games go to hidden range
          if(hardcodedBracketIds[ev.id]) return hardcodedBracketIds[ev.id];
          return nextSlot('r64:x', 900); // outside display range
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
