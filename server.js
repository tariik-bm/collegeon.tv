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
      const data = await ncaaFetch('GetContests_web', HASHES.contests, {
        sportCode: 'MBB', division: 1, seasonYear: 2025, contestDate: date, week: null,
      });
      return sendJSON(res, 200, { ok: true, date, contests: data?.data?.contests || [] });
    } catch(e) {
      console.error('[/api/contests]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/teamstats?contestId=6593943
  if (pathname === '/api/teamstats') {
    try {
      const contestId = query.contestId;
      if (!contestId) return sendJSON(res, 400, { ok: false, error: 'contestId required' });
      const data = await ncaaFetch('NCAA_GetGamecenterTeamStatsBasketballById_web', HASHES.teamStats, {
        contestId: String(contestId), staticTestEnv: null,
      });
      return sendJSON(res, 200, { ok: true, data: data?.data?.boxscore || {} });
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

  // /api/boxscore?contestId=6593943
  if (pathname === '/api/boxscore') {
    try {
      const contestId = query.contestId;
      if (!contestId) return sendJSON(res, 400, { ok: false, error: 'contestId required' });
      const data = await ncaaFetch('NCAA_GetGamecenterBoxscoreBasketballById_web', HASHES.boxscore, {
        contestId: String(contestId), staticTestEnv: null,
      });
      return sendJSON(res, 200, { ok: true, data: data?.data?.boxscore || {} });
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

  // /api/mml/bracket — full March Madness bracket with scores
  if (pathname === '/api/mml/bracket') {
    try {
      const data = await ncaaFetch('scores_bracket_web', HASHES.mmlBracket, { seasonYear: 2025 });
      return sendJSON(res, 200, { ok: true, contests: data?.data?.mmlContests || [] });
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
