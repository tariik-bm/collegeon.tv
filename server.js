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
const zlib  = require('zlib');

const sidearmEngine = require('C:/sb/providers/sidearm/sidearm_livestats_engine.cjs');

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

// ── Player photo enrichment caches ───────────────────────────────────────────
const playerPhotoCache = {}; // "season:normTeam:normName" → {ok,source,photoUrl,ts}
const _rosterPageCache = {}; // "domain:season" → [{normName,photoUrl}]  cached 24h
const _domainFetchTs   = {}; // domain → timestamp of last roster fetch (rate limit)
const espnSearchCache       = {}; // "normName:normTeam" → {athleteId,ts}  7d found / 1d not-found
const _imageValidationCache = {}; // url → {valid,ts}  24h TTL
// Populated by /api/historical-roster-backfill; keyed year → normTeam → normPlayer → photoUrl.
// Checked first in _backfillPlayerPhoto so cached photos are used without re-scraping.
const historicalPhotoCache = {};
// Populated by /api/sidearm-game-photos; keyed year → normTeam → normPlayer → photoUrl.
// Holds photos sourced directly from SIDEARM livestats feeds or SIDEARM-hosted roster pages.
const sidearmPhotoCache = {};
const _wikiPhotoCache = {}; // normName → {url,ts}  7d TTL
const waybackPhotoCache  = {}; // year → normTeam → normPlayer → photoUrl  (Wayback Machine)
let   _waybackLastFetch  = 0;  // global rate limiter for web.archive.org (ms timestamp)
const _waybackCdxCache   = {}; // "${pageUrl}:${year}" → snapshot or null
const _waybackTriedTeams = new Set(); // "${year}:${normTeam}" — on-demand Wayback tried this session
const pdfPhotoCache      = {}; // year → normTeam → normPlayer → '/pdf-images/.../n.jpg'
let   _pdfLastFetch      = 0;  // rate limiter for PDF downloads

// ─── Historical photo cache file ──────────────────────────────────────────────
const HISTORICAL_PHOTO_CACHE_FILE = path.join(__dirname, 'data', 'historical-photo-cache.json');
const SIDEARM_PHOTO_CACHE_FILE    = path.join(__dirname, 'data', 'sidearm-photo-cache.json');
const WAYBACK_PHOTO_CACHE_FILE    = path.join(__dirname, 'data', 'wayback-photo-cache.json');
const PDF_PHOTO_CACHE_FILE        = path.join(__dirname, 'data', 'pdf-photo-cache.json');
const PDF_IMAGE_DIR               = path.join(__dirname, 'public', 'pdf-images');

// ─── Coverage scanner ─────────────────────────────────────────────────────────
const COVERAGE_CACHE_FILE = path.join(__dirname, 'data', 'coverage-cache.json');
if (!global._coverageCache) global._coverageCache = {};
let _coverageScanActive = false;

const SCAN_TOURN = [
  // Postseason national
  { slug: 'march-madness',            name: 'March Madness',              minYear: 2002, maxGames: 67 },
  { slug: 'nit',                      name: 'NIT',                        minYear: 2002, maxGames: 32 },
  { slug: 'cbi',                      name: 'CBI',                        minYear: 2008, maxGames: 32 },
  { slug: 'cit',                      name: 'CIT',                        minYear: 2009, maxGames: 32 },
  { slug: 'cbc',                      name: 'College Basketball Crown',   minYear: 2025, maxGames: 7  },
  { slug: 'nbc',                      name: 'Basketball Classic',         minYear: 2021, maxGames: 3  },
  // Conference tournaments
  { slug: 'acc-tournament',           name: 'ACC Tournament',             minYear: 2002, maxGames: 15 },
  { slug: 'big-ten-tournament',       name: 'Big Ten Tournament',         minYear: 2002, maxGames: 15 },
  { slug: 'big-12-tournament',        name: 'Big 12 Tournament',          minYear: 2002, maxGames: 12 },
  { slug: 'sec-tournament',           name: 'SEC Tournament',             minYear: 2002, maxGames: 15 },
  { slug: 'big-east-tournament',      name: 'Big East Tournament',        minYear: 2002, maxGames: 15 },
  { slug: 'pac-12-tournament',        name: 'Pac-12 Tournament',          minYear: 2002, maxGames: 12 },
  { slug: 'american-tournament',      name: 'American Tournament',        minYear: 2014, maxGames: 12 },
  { slug: 'mountain-west-tournament', name: 'Mountain West Tournament',   minYear: 2002, maxGames: 12 },
  { slug: 'atlantic-10-tournament',   name: 'Atlantic 10 Tournament',     minYear: 2002, maxGames: 15 },
  { slug: 'wcc-tournament',           name: 'WCC Tournament',             minYear: 2002, maxGames: 10 },
  { slug: 'maac-tournament',          name: 'MAAC Tournament',            minYear: 2002, maxGames: 12 },
  { slug: 'mvc-tournament',           name: 'Missouri Valley Tournament', minYear: 2002, maxGames: 10 },
  { slug: 'mac-tournament',           name: 'MAC Tournament',             minYear: 2002, maxGames: 12 },
  { slug: 'sun-belt-tournament',      name: 'Sun Belt Tournament',        minYear: 2002, maxGames: 12 },
  { slug: 'cusa-tournament',          name: 'C-USA Tournament',           minYear: 2002, maxGames: 12 },
  { slug: 'big-sky-tournament',       name: 'Big Sky Tournament',         minYear: 2002, maxGames: 12 },
  { slug: 'big-south-tournament',     name: 'Big South Tournament',       minYear: 2002, maxGames: 12 },
  { slug: 'meac-tournament',          name: 'MEAC Tournament',            minYear: 2002, maxGames: 8  },
  { slug: 'swac-tournament',          name: 'SWAC Tournament',            minYear: 2002, maxGames: 8  },
  { slug: 'socon-tournament',         name: 'SoCon Tournament',           minYear: 2002, maxGames: 8  },
  { slug: 'caa-tournament',           name: 'CAA Tournament',             minYear: 2002, maxGames: 10 },
  { slug: 'big-west-tournament',      name: 'Big West Tournament',        minYear: 2002, maxGames: 8  },
  { slug: 'wac-tournament',           name: 'WAC Tournament',             minYear: 2002, maxGames: 12 },
  { slug: 'ivy-tournament',           name: 'Ivy Tournament',             minYear: 2002, maxGames: 4  },
  { slug: 'ovc-tournament',           name: 'OVC Tournament',             minYear: 2002, maxGames: 10 },
  { slug: 'asun-tournament',          name: 'ASUN Tournament',            minYear: 2002, maxGames: 10 },
  { slug: 'horizon-tournament',       name: 'Horizon League Tournament',  minYear: 2002, maxGames: 10 },
  { slug: 'summit-tournament',        name: 'Summit League Tournament',   minYear: 2002, maxGames: 8  },
  { slug: 'america-east-tournament',  name: 'America East Tournament',    minYear: 2002, maxGames: 8  },
  { slug: 'patriot-tournament',       name: 'Patriot League Tournament',  minYear: 2002, maxGames: 8  },
  { slug: 'nec-tournament',           name: 'NEC Tournament',             minYear: 2002, maxGames: 8  },
  { slug: 'southland-tournament',     name: 'Southland Tournament',       minYear: 2002, maxGames: 10 },
];

// Normalized team name → athletics roster domain (Sidearm Sports standard path)
const ATHLETICS_ROSTER_MAP = {
  // NIT / postseason common teams
  'lipscomb':           'lipscombsports.com',
  'george mason':       'gomason.com',
  'liberty':            'libertyflames.com',
  'wyoming':            'gowyoming.com',
  'yale':               'yalebulldogs.com',
  'unc wilmington':     'uncwsports.com',
  'uncw':               'uncwsports.com',
  'uc irvine':          'ucirvinesports.com',
  'unlv':               'unlvrebels.com',
  'seattle u':          'gofalcons.com',
  'st thomas':          'tommiesathletics.com',
  'kent state':         'kentstatesports.com',
  'army':               'goarmywestpoint.com',
  'penn':               'pennathletics.com',
  'louisiana tech':     'latechsports.com',
  // ACC
  'duke':               'goduke.com',
  'north carolina':     'goheels.com',
  'unc':                'goheels.com',
  'virginia':           'virginiasports.com',
  'nc state':           'gopack.com',
  'virginia tech':      'hokiesports.com',
  'pittsburgh':         'pittsburghpanthers.com',
  'pitt':               'pittsburghpanthers.com',
  'miami':              'hurricanesports.com',
  'georgia tech':       'ramblinwreck.com',
  'wake forest':        'wakeforestsports.com',
  'florida state':      'seminoles.com',
  'clemson':            'clemsontigers.com',
  'syracuse':           'cuse.com',
  'boston college':     'bceagles.com',
  'notre dame':         'und.com',
  'louisville':         'gocards.com',
  'stanford':           'gostanford.com',
  'california':         'calbears.com',
  // Big Ten
  'michigan':           'mgoblue.com',
  'michigan state':     'msuspartans.com',
  'michigan st':        'msuspartans.com',
  'ohio state':         'ohiostatebuckeyes.com',
  'indiana':            'iuhoosiers.com',
  'purdue':             'purduesports.com',
  'iowa':               'hawkeyesports.com',
  'illinois':           'fightingillini.com',
  'wisconsin':          'uwbadgers.com',
  'minnesota':          'gophersports.com',
  'nebraska':           'huskers.com',
  'penn state':         'gopsusports.com',
  'maryland':           'umterps.com',
  'rutgers':            'scarletknights.com',
  'northwestern':       'nusports.com',
  'ucla':               'uclabruins.com',
  'usc':                'usctrojans.com',
  'washington':         'gohuskies.com',
  'oregon':             'goducks.com',
  // Big 12
  'kansas':             'kuathletics.com',
  'texas':              'texassports.com',
  'baylor':             'baylorbears.com',
  'oklahoma':           'soonersports.com',
  'oklahoma state':     'okstate.com',
  'texas tech':         'texastechsports.com',
  'iowa state':         'cyclones.com',
  'kansas state':       'kstatesports.com',
  'kansas st':          'kstatesports.com',
  'tcu':                'gofrogs.com',
  'west virginia':      'wvsports.com',
  'cincinnati':         'gobearcats.com',
  'houston':            'uhcougars.com',
  'ucf':                'ucfknights.com',
  'byu':                'byucougars.com',
  'arizona':            'arizonawildcats.com',
  'arizona state':      'thesundevils.com',
  'utah':               'utahutes.com',
  'colorado':           'cubuffs.com',
  // SEC
  'kentucky':           'ukathletics.com',
  'auburn':             'auburntigers.com',
  'tennessee':          'utvols.com',
  'florida':            'floridagators.com',
  'alabama':            'rolltide.com',
  'lsu':                'lsusports.net',
  'arkansas':           'arkansasrazorbacks.com',
  'georgia':            'georgiadogs.com',
  'south carolina':     'gamecocksonline.com',
  'ole miss':           'olemisssports.com',
  'mississippi':        'olemisssports.com',
  'mississippi state':  'hailstate.com',
  'vanderbilt':         'vucommodores.com',
  'missouri':           'mutigers.com',
  'texas am':           '12thman.com',
  // Big East
  'connecticut':        'uconnhuskies.com',
  'uconn':              'uconnhuskies.com',
  'villanova':          'villanova.com',
  'marquette':          'gomarquette.com',
  'xavier':             'goxavier.com',
  'seton hall':         'shupirates.com',
  'georgetown':         'guhoyas.com',
  'providence':         'friars.com',
  'st johns':           'redstormsports.com',
  'creighton':          'gocreighton.com',
  'butler':             'butlersports.com',
  'depaul':             'depaulbluedemons.com',
  // Pac / WCC
  'gonzaga':            'gozags.com',
  'saint marys':        'smcgaels.com',
  'pepperdine':         'pepperdinesports.com',
  'portland':           'portlandpilots.com',
  'portland state':     'goviks.com',
  'portland st':        'goviks.com',
  // Mountain West
  'nevada':             'nevadawolfpack.com',
  'san diego state':    'goaztecs.com',
  'new mexico':         'golobos.com',
  'boise state':        'broncosports.com',
  'utah state':         'utahstateaggies.com',
  'air force':          'goairforcefalcons.com',
  'colorado state':     'csurams.com',
  'fresno state':       'gobulldogs.com',
  // American / others
  'memphis':            'gotigersgo.com',
  'wichita st':         'goshockers.com',
  'wichita state':      'goshockers.com',
  'tulsa':              'tulsahurricane.com',
  // A-10
  'dayton':             'daytonflyers.com',
  'vcu':                'vcuathletics.com',
  'davidson':           'davidsonwildcats.com',
  'rhode island':       'gorhody.com',
  'richmond':           'richmondspiders.com',
  'fordham':            'fordhamrams.com',
  'duquesne':           'goduquesne.com',
  'umass':              'umassathletics.com',
  'saint louis':        'slubillikens.com',
  'la salle':           'goexplorers.com',
  'george washington':  'gwsports.com',
  'temple':             'owlsports.com',
  // Missouri Valley / Mid-Major
  'northern iowa':      'unipanthers.com',
  'drake':              'godrakebulldogs.com',
  'illinois state':     'illinoisstatesports.com',
  'bradley':            'bradleybraves.com',
  'loyola chicago':     'loyolaramblers.com',
  'valparaiso':         'valpoathletics.com',
  // MAC
  'ohio':               'ohiobobcats.com',
  'kent st':            'kentstatesports.com',
  'western kentucky':   'wkusports.com',
  'western ky':         'wkusports.com',
  'middle tennessee':   'goblueraiders.com',
  'old dominion':       'odusports.com',
  // MAAC / Northeast
  'mount st marys':     'mountathletics.com',
  'mt st marys':        'mountathletics.com',
  'siena':              'sienasaints.com',
  'iona':               'icgaels.com',
  'marist':             'gomaristathletics.com',
  'niagara':            'purpleeagles.com',
  'rider':              'gobroncs.com',
  // Big South / Southern
  'winthrop':           'winthropeagles.com',
  'chattanooga':        'gomocs.com',
  'belmont':            'belmontbruins.com',
  // Patriot / Ivy+
  'holy cross':         'goholycross.com',
  'cornell':            'cornellbigred.com',
  'columbia':           'gocolumbialions.com',
  'princeton':          'goprincetontigers.com',
  'bucknell':           'bucknellbison.com',
  // OVC / SWAC / MEAC
  'murray state':       'goracers.com',
  'morehead state':     'msueagles.com',
  'austin peay':        'letsgopeay.com',
  'jackson state':      'jsusports.net',
  'coppin state':       'coppinstatesports.com',
  'coppin st':          'coppinstatesports.com',
  'hampton':            'hamptonpirates.com',
  'norfolk state':      'nsusports.com',
  // WAC / Southland / Sun Belt
  'oral roberts':       'oruathletics.com',
  'stephen f austin':   'sfajacks.com',
  'sam houston':        'gobearkats.com',
  'south alabama':      'usajaguars.com',
  'florida gulf coast': 'fgcuathletics.com',
  'east tennessee st':  'etsports.com',
  // Big West / West Coast misc
  'long beach state':   'longbeachstate.com',
  'santa barbara':      'ucsbgauchos.com',
  'cal poly':           'gopoly.com',
  'pacific':            'pacifictigers.com',
  // Big Sky / Summit / Horizon
  'montana':            'montanagrizzlies.com',
  'northern arizona':   'nauathletics.com',
  'oakland':            'goldengrizzlies.com',
  'wright state':       'wsuraiders.com',
  'cleveland state':    'csuvikings.com',
  'loyola md':          'loyolagreyhounds.com',
  // Pac extensions
  'washington state':   'wsucougars.com',
  'washington st':      'wsucougars.com',
  'oregon state':       'osubeavers.com',
  'oregon st':          'osubeavers.com',
  'cal state fullerton':'fullertontitans.com',
  'cal st fullerton':   'fullertontitans.com',
  'cs fullerton':       'fullertontitans.com',
  'cal state northridge':'gomatadors.com',
  // American misc
  'american':           'aueagles.com',
  'navy':               'navysports.com',
  'lehigh':             'lehighsports.com',
  'vermont':            'uvmathletics.com',
  'maine':              'umathletics.com',

  // ── ESPN "St." short-name aliases → full State ────────────────────────────
  // ESPN shortDisplayName often uses "Ohio St." which normPhoto→ "ohio st"
  'ohio st':            'ohiostatebuckeyes.com',
  'florida st':         'seminoles.com',
  'mississippi st':     'hailstate.com',
  'miss st':            'hailstate.com',
  'arizona st':         'thesundevils.com',
  'iowa st':            'cyclones.com',
  'penn st':            'gopsusports.com',
  'utah st':            'utahstateaggies.com',
  'boise st':           'broncosports.com',
  'colorado st':        'csurams.com',
  'fresno st':          'gobulldogs.com',
  'morehead st':        'msueagles.com',
  'jackson st':         'jsusports.net',
  'norfolk st':         'nsusports.com',
  'e tennessee st':     'etsports.com',
  'east tenn st':       'etsports.com',
  'etsu':               'etsports.com',
  'jacksonville st':    'jsujsports.com',

  // ── "W." / "E." direction abbreviations ──────────────────────────────────
  'w virginia':         'wvsports.com',
  'w kentucky':         'wkusports.com',
  'w ky':               'wkusports.com',
  'e kentucky':         'colonelsports.com',
  'eastern kentucky':   'colonelsports.com',
  'n iowa':             'unipanthers.com',
  'n colorado':         'uncobears.com',

  // ── "Fullerton" short form → Cal State Fullerton ─────────────────────────
  'fullerton':          'fullertontitans.com',
  'csuf':               'fullertontitans.com',

  // ── Mississippi Valley State ──────────────────────────────────────────────
  'miss valley st':     'mvsuathletics.com',
  'miss valley state':  'mvsuathletics.com',
  'mississippi valley st':    'mvsuathletics.com',
  'mississippi valley state': 'mvsuathletics.com',
  'mvsu':               'mvsuathletics.com',

  // ── Saint Mary's aliases ───────────────────────────────────────────────────
  'st marys':           'smcgaels.com',
  'st marys ca':        'smcgaels.com',
  'saint marys ca':     'smcgaels.com',
  // 'saint marys' already in map above

  // ── Saint Joseph's ────────────────────────────────────────────────────────
  'st josephs':         'sjuhawks.com',
  'saint josephs':      'sjuhawks.com',
  'st joes':            'sjuhawks.com',

  // ── Wisconsin-Milwaukee ───────────────────────────────────────────────────
  'wis milwaukee':      'uwmpanthers.com',
  'wisconsin milwaukee':'uwmpanthers.com',
  'uw milwaukee':       'uwmpanthers.com',
  'umilwaukee':         'uwmpanthers.com',

  // ── Arkansas-Pine Bluff ───────────────────────────────────────────────────
  'ark pine bluff':     'uapblions.com',
  'arkansas pine bluff':'uapblions.com',
  'uapb':               'uapblions.com',

  // ── Other common 2008-era tournament aliases ──────────────────────────────
  'southern ill':       'siuskyhawks.com',
  'southern illinois':  'siuskyhawks.com',
  's illinois':         'siuskyhawks.com',
  'siu':                'siuskyhawks.com',
  'long island':        'liposts.com',
  'liu':                'liposts.com',
  'n carolina':         'goheels.com',
  'n carolina state':   'gopack.com',
  'nc st':              'gopack.com',
  'n carolina st':      'gopack.com',
  'texas a&m':          '12thman.com',
  'usc upstate':        'spartansbulldogs.com',
  'kennesaw st':        'ksuowls.com',
  'kennesaw state':     'ksuowls.com',
  'south florida':      'gousfbulls.com',
  'usf':                'gousfbulls.com',
  'florida intl':       'fiusports.com',
  'florida international': 'fiusports.com',
  'fiu':                'fiusports.com',
  'albany':             'ualbanyathletics.com',
  'suny albany':        'ualbanyathletics.com',
  'uc davis':           'ucdavisaggies.com',
  'cal davis':          'ucdavisaggies.com',
  'uc riverside':       'ucrathletics.com',
  'uc santa barbara':   'ucsbgauchos.com',
  'ucsb':               'ucsbgauchos.com',
  'colgate':            'colgateraiders.com',
  'lafayette':          'goleopards.com',
  'sacred heart':       'sacredheartpioneers.com',
  'vmi':                'vmi.edu',
  'utc':                'gomocs.com',
  'unc asheville':      'uncabullldogs.com',
  'uncg':               'uncgspartans.com',
  'unc greensboro':     'uncgspartans.com',
  'drexel':             'drexeldragons.com',
  'hofstra':            'hofstrapride.com',
  'towson':             'towsontigers.com',
  'loyola marymount':   'lmulions.com',
  'lmu':                'lmulions.com',
  'cal state bakersfield': 'csub.edu',
  'cs bakersfield':     'csub.edu',
  'csub':               'csub.edu',
  'cal state long beach':  'longbeachstate.com',
  'long beach st':      'longbeachstate.com',
  'grand canyon':       'lopes.com',
  'gcu':                'lopes.com',
  'stony brook':        'goseawolves.com',
  'south carolina st':  'scstateathletics.com',
  'sc state':           'scstateathletics.com',
  'south carolina state': 'scstateathletics.com',
  'grambling':          'gsutigers.com',
  'grambling st':       'gsutigers.com',
  'grambling state':    'gsutigers.com',
  'prairie view':       'pvpanthers.com',
  'prairie view am':    'pvpanthers.com',
  'prairie view a&m':   'pvpanthers.com',
  'alcorn st':          'alcornsports.com',
  'alcorn state':       'alcornsports.com',
  'alabama st':         'bamastatesports.com',
  'alabama state':      'bamastatesports.com',
  'bethune cookman':    'bcuathletics.com',
  'bethune-cookman':    'bcuathletics.com',
  'florida am':         'rattlersports.com',
  'florida a&m':        'rattlersports.com',
  'famu':               'rattlersports.com',
  'md eastern shore':   'umes.edu',
  'maryland eastern shore': 'umes.edu',
  'umes':               'umes.edu',
  'delaware st':        'dsusports.net',
  'delaware state':     'dsusports.net',
  'morgan st':          'morganstatebears.com',
  'morgan state':       'morganstatebears.com',
  'howard':             'howardathletics.com',
  'nc at':              'ncataggies.com',
  'nc a&t':             'ncataggies.com',
  'north carolina at':  'ncataggies.com',
  'north carolina a&t': 'ncataggies.com',
  'ncat':               'ncataggies.com',
  'savannah st':        'ssutigers.com',
  'savannah state':     'ssutigers.com',
  'southeastern la':    'lionsports.net',
  'southeastern louisiana': 'lionsports.net',
  'selu':               'lionsports.net',
  'nicholls st':        'nicholls.edu',
  'nicholls state':     'nicholls.edu',
  'mcneese st':         'mcneesesports.com',
  'mcneese state':      'mcneesesports.com',
  'lamar':              'lamarcardinals.com',
  'corpus christi':     'goislanders.com',
  'texas am corpus christi': 'goislanders.com',
  'houston baptist':    'hbuhuskies.com',
  'hbu':                'hbuhuskies.com',
  'loyola new orleans': 'loyolawolfpack.com',
  'loyola no':          'loyolawolfpack.com',
  'new orleans':        'privateerssports.com',
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

// NCAA PBP fetcher — uses existing ncaaFetch + HASHES.pbp
async function fetchNcaaBasketballPbp(contestId) {
  try {
    const data = await ncaaFetch(
      'NCAA_GetGamecenterPbpBasketballById_web',
      HASHES.pbp,
      { contestId: String(contestId), staticTestEnv: null }
    );
    return data?.data?.playbyplay || null;
  } catch(e) {
    console.warn(`[NCAA PBP] fetch failed contestId=${contestId}: ${e.message}`);
    return null;
  }
}

// Generic ESPN GET helper — reused by team endpoints below.
function espnGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'site.api.espn.com',
      path: apiPath,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 12000,
    };
    https.get(options, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('ESPN JSON parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function getTodayDate() {
  const d   = new Date();
  const m   = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${m}/${day}/${d.getFullYear()}`;
}

// ─── PBP Normalization & Stats Engine ────────────────────────────────────────

// _pbpClassify — classify a single PBP text string into a normalized event type.
// Handles both ESPN live-text ("makes"/"misses" present-tense) and
// NCAA/structured text ("made"/"missed" past-tense).
// Returns { type, pts }.
function _pbpClassify(text) {
  const d = text.toLowerCase();

  // Helper: detect any "scored" signal regardless of tense
  const isMade   = d.includes('made')   || d.includes('makes');
  const isMissed = d.includes('missed') || d.includes('misses');

  // ── Free throws (check BEFORE generic "shot" to avoid "foul shot" false positives) ──
  if (d.includes('free throw') || d.includes('foul shot')) {
    if (isMade)   return { type: 'ft_made', pts: 1 };
    if (isMissed) return { type: 'ft_miss', pts: 0 };
    return { type: 'other', pts: 0 };
  }

  // ── Three-pointers ────────────────────────────────────────────────────────────────────
  const is3pt = d.includes('three point') || d.includes('three-point') ||
                d.includes('3-point')     || d.includes('3 point')     ||
                d.includes('3-pt')        || d.includes('3pt');
  if (is3pt) {
    if (isMade)   return { type: 'fg3_made', pts: 3 };
    if (isMissed) return { type: 'fg3_miss', pts: 0 };
  }

  // ── Two-point field goals ─────────────────────────────────────────────────────────────
  // Keywords that unambiguously indicate a field-goal attempt.
  // "jump shot" covers ESPN live text; "jumper" covers NCAA/structured ESPN.
  const FG_KEYWORDS = [
    'jump shot', 'jumper',
    'layup', 'lay up', 'lay-up',
    'dunk',
    'tip-in', 'tip in',
    'hook shot', 'hook',
    'two point', '2-pointer', '2 pointer',
    'driving', 'floater', 'runner',
    'pull-up', 'pull up', 'step back', 'fadeaway', 'finger roll',
  ];
  if (FG_KEYWORDS.some(k => d.includes(k))) {
    if (isMade)   return { type: 'fg2_made', pts: 2 };
    if (isMissed) return { type: 'fg2_miss', pts: 0 };
  }
  // Generic "shot" fallback — exclude free-throw/foul/rebound contexts already handled above
  if (d.includes('shot') && !d.includes('rebound') && !d.includes('foul') && !d.includes('free')) {
    if (isMade)   return { type: 'fg2_made', pts: 2 };
    if (isMissed) return { type: 'fg2_miss', pts: 0 };
  }

  // ── Non-scoring events ────────────────────────────────────────────────────────────────
  if (d.includes('offensive rebound')) return { type: 'reb_off',  pts: 0 };
  if (d.includes('defensive rebound')) return { type: 'reb_def',  pts: 0 };
  if (d.includes('rebound'))           return { type: 'reb',      pts: 0 };
  if (d.includes('assist'))            return { type: 'assist',   pts: 0 };
  if (d.includes('steal'))             return { type: 'steal',    pts: 0 };
  if (d.includes('block'))             return { type: 'block',    pts: 0 };
  if (d.includes('turnover'))          return { type: 'turnover', pts: 0 };
  if (d.includes('foul'))              return { type: 'foul',     pts: 0 };
  if (d.includes('timeout'))           return { type: 'timeout',  pts: 0 };
  if (d.includes('substitut') || d.includes(' in for ')) return { type: 'sub', pts: 0 };
  return { type: 'other', pts: 0 };
}

function _periodLabel(n) {
  if (n === 1) return '1st Half';
  if (n === 2) return '2nd Half';
  if (n >= 3)  return `OT${n - 2}`;
  return `Period ${n}`;
}

// normalizeEspnPbp — ESPN plays[] → NormalizedEvent[]
// homeTeamId: ESPN numeric team ID for the home team
//
// Classification strategy: ESPN's play.type.text ("Made Jumper", "Missed 3-Point Jumper",
// "Made Free Throw") is structured and reliable. Use it for shot classification; fall back
// to the full play text only when type.text is absent.
function normalizeEspnPbp(plays, homeTeamId, { silent = false } = {}) {
  const hId = String(homeTeamId || '');
  let _logCount = 0;
  return (plays || [])
    .filter(p => p && (p.text || p.shortText))
    .map(p => {
      const text = p.text || p.shortText || '';
      if (!silent && _logCount < 10) {
        console.log(`[CLASSIFY INPUT[${_logCount}]] text="${text.slice(0,80)}" | type.text="${p.type?.text||''}"`);
        _logCount++;
      }
      const { type, pts } = _pbpClassify(text);
      const tid      = String(p.team?.id || '');
      const isHome   = !!(hId && tid === hId);
      const period   = p.period?.number || 1;
      // Two-word limit: "Brenen Lorient Defensive Rebound." → "Brenen Lorient", not capturing "Defensive"
      const nameM    = text.match(/^([A-Z][a-zA-Z'-]+ [A-Z][a-zA-Z'-.]+)/);
      // ESPN 2026 format: "(Honor Huff assists)" — must check this FIRST
      // Older/NCAA format: "assisted by X"
      const assistM  = text.match(/\(([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-.]+)+)\s+assists?\)/i)
                    || text.match(/assisted\s+by\s+([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-.]+)+)/i);
      // Primary athlete ID: prefer type==='athlete', fallback to index 0
      const _ath = (p.athletes || []).find(a => a.type === 'athlete' || !a.type) || p.athletes?.[0];
      const athleteId = _ath?.athlete?.id ? String(_ath.athlete.id) : null;
      return {
        period,
        periodDisplay: _periodLabel(period),
        clock:        p.clock?.displayValue || '',
        team:         isHome ? 'home' : 'away',
        teamId:       tid,
        player:       nameM?.[1] || null,
        athleteId,
        type,
        pts,
        text,
        homeScore:    p.homeScore != null ? parseInt(p.homeScore) : null,
        awayScore:    p.awayScore != null ? parseInt(p.awayScore) : null,
        assistPlayer: assistM?.[1] || null,
      };
    });
}

// normalizeNcaaPbp — NCAA playbyplay.periods[] → NormalizedEvent[]
// Handles correct field names (homeScore/visitorScore), text fallbacks,
// deduplication, and assist extraction.
function normalizeNcaaPbp(periods, homeTeamId, { silent = false } = {}) {
  const hId  = String(homeTeamId || '');
  const seen = new Set();
  const events = [];
  let rawCount = 0;

  (periods || []).forEach(per => {
    const pNum  = per.periodNumber || 1;
    const pDisp = _periodLabel(pNum);

    (per.playbyplayStats || []).forEach(p => {
      rawCount++;
      const text = (p.eventDescription || p.homeText || p.visitorText || '').trim();
      if (!text) return;

      const tid    = String(p.teamId || '');
      const isHome = p.isHome === true || !!(hId && tid === hId);
      const clock  = String(p.contestClock || p.clock || '');

      // Score: prefer explicit per-play fields, fallback to "home-visitor" string
      let homeScore = null, awayScore = null;
      if (p.homeScore != null && p.visitorScore != null) {
        homeScore = parseInt(p.homeScore);
        awayScore = parseInt(p.visitorScore);
      } else if (p.currentScore) {
        const parts = String(p.currentScore).split('-');
        if (parts.length === 2) {
          homeScore = parseInt(parts[0]) || null;
          awayScore = parseInt(parts[1]) || null;
        }
      }

      // Deduplicate: NCAA sometimes sends the same play twice with minor text diffs
      const normText = text.toLowerCase().replace(/\s+/g, ' ');
      const dedupKey = `${pNum}|${clock}|${tid}|${normText}|${homeScore}|${awayScore}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      const { type, pts } = _pbpClassify(text);

      const nameM   = text.match(/^([A-Z][a-zA-Z'-]+ [A-Z][a-zA-Z'-.]+)/);
      const assistM = text.match(/\(([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-.]+)+)\s+assists?\)/i)
                   || text.match(/assisted\s+by\s+([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-.]+)+)/i);

      events.push({
        period:        pNum,
        periodDisplay: pDisp,
        clock,
        team:          isHome ? 'home' : 'away',
        teamId:        tid,
        player:        nameM?.[1]   || null,
        type,
        pts,
        text,
        homeScore,
        awayScore,
        assistPlayer:  assistM?.[1] || null,
      });
    });
  });

  if (!silent) console.log(`[NCAA normalize] events before/after dedupe: ${rawCount}/${events.length}`);
  return events;
}

// ── Player identity helpers ───────────────────────────────────────────────────

// Returns false for non-player PBP tokens: "Jump Ball", "Team Deadball",
// "Technical Foul", team names counted as players, etc.
// teamName should be the team's short display name (used to catch exact-name fakes).
function isRealPlayerName(name, teamName) {
  if (!name) return false;
  const n  = name.trim();
  if (!n)   return false;
  const nl = n.toLowerCase();

  // Exact blocklist (case-insensitive)
  const EXACT_BLOCK = new Set([
    'jump ball', 'official tv', 'technical foul', 'tv timeout',
    'timeout', 'deadball', 'offensive', 'defensive', 'team',
  ]);
  if (EXACT_BLOCK.has(nl)) return false;

  // Anything starting with "team " is a team pseudo-entry (Team Timeout, Team Deadball, …)
  if (nl.startsWith('team ')) return false;

  // Bad suffixes — also catches "Home Deadball", "Away Timeout", etc.
  const BAD_SUFFIXES = ['timeout', 'deadball', 'offensive', 'defensive'];
  if (BAD_SUFFIXES.some(s => nl.endsWith(s))) return false;

  // Exact match against team name (team counted as player)
  if (teamName && nl === teamName.toLowerCase()) return false;

  return true;
}

// Normalize a player name for fuzzy matching:
// lowercase, remove generational suffixes, strip punctuation, collapse spaces.
function _normPlayerName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a lookup map from ESPN boxscore.players:
//   { "<normName>\x00<teamId>": { athleteId, headshot }, "<normName>": ... }
// Headshot: uses ESPN CDN if not provided directly in the API response.
function _buildPlayerIdentityMap(boxscore) {
  const map = {};
  (boxscore?.players || []).forEach(teamEntry => {
    const tid = String(teamEntry.team?.id || '');
    (teamEntry.statistics || []).forEach(sg => {
      (sg.athletes || []).forEach(entry => {
        const ath = entry.athlete;
        if (!ath?.id || !ath?.displayName) return;
        const aid  = String(ath.id);
        const hs   = ath.headshot?.href
          || `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${aid}.png`;
        const norm = _normPlayerName(ath.displayName);
        const val  = { athleteId: aid, headshot: hs };
        map[norm + '\x00' + tid] = val;        // team-scoped (most precise)
        if (!map[norm]) map[norm] = val;        // name-only fallback
      });
    });
  });
  return map;
}

// Extract a specific player's per-game stats from an ESPN boxscore.
// Returns { pts, reb, ast, stl, blk, fg, fg3, ft, athleteId } or null.
function _parseBoxscorePlayerStats(boxscore, normName) {
  for (const teamEntry of (boxscore?.players || [])) {
    for (const sg of (teamEntry.statistics || [])) {
      const keys = sg.names || sg.keys || [];
      for (const entry of (sg.athletes || [])) {
        const ath = entry.athlete;
        if (!ath?.displayName) continue;
        if (_normPlayerName(ath.displayName) !== normName) continue;
        const stats = entry.stats || [];
        const get   = (...ks) => { for (const k of ks) { const i = keys.indexOf(k); if (i >= 0 && stats[i] != null) return stats[i]; } return null; };
        const parseFg = s => { if (!s || s === '--') return { m:0, a:0 }; const [m,a] = String(s).split('-').map(Number); return { m: m||0, a: a||0 }; };
        return {
          pts:       parseInt(get('PTS','pts') || 0),
          reb:       parseInt(get('REB','reb','TRB') || 0),
          ast:       parseInt(get('AST','ast') || 0),
          stl:       parseInt(get('STL','stl') || 0),
          blk:       parseInt(get('BLK','blk') || 0),
          fg:        parseFg(get('FG','fg')),
          fg3:       parseFg(get('3PT','3pt','3P')),
          ft:        parseFg(get('FT','ft')),
          athleteId: ath.id ? String(ath.id) : null,
          headshot:  ath.headshot?.href || null,
        };
      }
    }
  }
  return null;
}

// deriveStatsFromPbp — NormalizedEvent[] → DerivedStats
// DerivedStats: { home, away, periodScoring, leaders, derivedScore }
function deriveStatsFromPbp(events, { silent = false } = {}) {
  const players   = {};
  const typeCounts = {};
  const runTotals  = { home: { fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0,ast:0 },
                        away: { fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0,ast:0 } };
  let _shotLog = 0;
  let _astLog  = 0;

  function getP(side, name) {
    const key = `${side}:${name}`;
    if (!players[key]) players[key] = {
      name, team: side, espnId: null,
      pts:0, reb:0, oreb:0, dreb:0, ast:0, stl:0, blk:0, to:0,
      fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0, fouls:0,
    };
    return players[key];
  }

  const periodMap = {};
  events.forEach(ev => {
    const side = ev.team;
    const p    = getP(side, ev.player || 'Team');
    const pn   = ev.period;
    if (!periodMap[pn]) periodMap[pn] = { period: pn, periodDisplay: ev.periodDisplay, home: 0, away: 0 };
    // Capture ESPN athlete ID on first sighting for this player
    if (ev.athleteId && ev.player && !p.espnId) p.espnId = ev.athleteId;

    typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;

    if (!silent) {
      const isShot = ev.type.startsWith('fg') || ev.type.startsWith('ft');
      if (isShot && _shotLog < 10) {
        const rt = runTotals[side] || { fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0 };
        console.log(`[PBP shot[${_shotLog}]] type=${ev.type} pts=${ev.pts} team=${side} player="${ev.player||''}" text="${(ev.text||'').slice(0,60)}"`);
        console.log(`  running ${side}: fga=${rt.fga} fgm=${rt.fgm} fg3a=${rt.fg3a} fg3m=${rt.fg3m} fta=${rt.fta} ftm=${rt.ftm}`);
        _shotLog++;
      }
      if (ev.type === 'other') {
        const d = (ev.text || '').toLowerCase();
        if (d.includes('shot') || d.includes('jump') || d.includes('layup') ||
            d.includes('dunk') || d.includes('free throw') || d.includes('3-point') ||
            d.includes('made') || d.includes('missed')) {
          console.log(`[PBP unclassified] text="${(ev.text||'').slice(0,80)}" → 'other'`);
        }
      }
    }

    switch (ev.type) {
      case 'fg2_made':
        p.pts += 2; p.fgm++; p.fga++;
        periodMap[pn][side] += 2;
        runTotals[side].fgm++; runTotals[side].fga++;
        break;
      case 'fg2_miss':
        p.fga++;
        runTotals[side].fga++;
        break;
      case 'fg3_made':
        p.pts += 3; p.fg3m++; p.fg3a++; p.fgm++; p.fga++;
        periodMap[pn][side] += 3;
        runTotals[side].fg3m++; runTotals[side].fg3a++; runTotals[side].fgm++; runTotals[side].fga++;
        break;
      case 'fg3_miss':
        p.fg3a++; p.fga++;
        runTotals[side].fg3a++; runTotals[side].fga++;
        break;
      case 'ft_made':
        p.pts += 1; p.ftm++; p.fta++;
        periodMap[pn][side] += 1;
        runTotals[side].ftm++; runTotals[side].fta++;
        break;
      case 'ft_miss':
        p.fta++;
        runTotals[side].fta++;
        break;
      case 'reb_off':  p.reb++; p.oreb++;  break;
      case 'reb_def':  p.reb++; p.dreb++;  break;
      case 'reb':      p.reb++;            break;
      case 'assist':
        p.ast++;
        runTotals[side].ast++;
        if (!silent && _astLog < 20) {
          console.log(`[ASSIST DEBUG] text="${(ev.text||'').slice(0,80)}" team=${side} running_ast=${runTotals[side].ast}`);
          _astLog++;
        }
        break;
      case 'steal':    p.stl++;            break;
      case 'block':    p.blk++;            break;
      case 'turnover': p.to++;             break;
      case 'foul':     p.fouls++;          break;
    }
    if (ev.assistPlayer && (ev.type === 'fg2_made' || ev.type === 'fg3_made')) {
      getP(side, ev.assistPlayer).ast++;
      runTotals[side].ast++;
      if (!silent && _astLog < 20) {
        console.log(`[ASSIST DEBUG] text="${(ev.text||'').slice(0,80)}" team=${side} assist="${ev.assistPlayer}" running_ast=${runTotals[side].ast}`);
        _astLog++;
      }
    }
  });

  if (!silent) {
    console.log('[PBP type counts]', JSON.stringify(typeCounts));
    console.log('[PBP final runTotals home]', JSON.stringify(runTotals.home));
    console.log('[PBP final runTotals away]', JSON.stringify(runTotals.away));
  }

  function teamSummary(side) {
    const pp  = Object.values(players).filter(p => p.team === side);
    const tot = { pts:0,reb:0,oreb:0,dreb:0,ast:0,stl:0,blk:0,to:0,fgm:0,fga:0,fg3m:0,fg3a:0,ftm:0,fta:0,fouls:0 };
    pp.forEach(p => { Object.keys(tot).forEach(k => { tot[k] += p[k] || 0; }); });
    tot.fgPct  = tot.fga  ? Math.round(tot.fgm  / tot.fga  * 100) + '%' : '0%';
    tot.fg3Pct = tot.fg3a ? Math.round(tot.fg3m / tot.fg3a * 100) + '%' : '0%';
    tot.ftPct  = tot.fta  ? Math.round(tot.ftm  / tot.fta  * 100) + '%' : '0%';
    return { players: pp.sort((a, b) => b.pts - a.pts), totals: tot };
  }

  const home = teamSummary('home');
  const away = teamSummary('away');

  // Validation: points implied by made shots vs accumulated pts
  if (!silent) {
    function validateShots(side, tot) {
      const implied = (tot.fgm - tot.fg3m) * 2 + tot.fg3m * 3 + tot.ftm;
      if (tot.pts > 0 && implied !== tot.pts) {
        console.warn(`[PBP validate] ${side}: pts=${tot.pts} implied=${implied} diff=${tot.pts-implied}`);
      }
    }
    validateShots('home', home.totals);
    validateShots('away', away.totals);
  }

  function top(side, stat) {
    return Object.values(players).filter(p => p.team === side && p.name !== 'Team')
      .sort((a, b) => b[stat] - a[stat])[0] || null;
  }

  return {
    home,
    away,
    periodScoring: Object.values(periodMap).sort((a, b) => a.period - b.period),
    leaders: {
      points:   { home: top('home','pts'), away: top('away','pts') },
      rebounds: { home: top('home','reb'), away: top('away','reb') },
      assists:  { home: top('home','ast'), away: top('away','ast') },
    },
    derivedScore: { home: home.totals.pts, away: away.totals.pts },
  };
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

// ── Athletics roster photo helpers ───────────────────────────────────────────

// Call the SIDEARM livestats engine and return normalized roster players.
// Delegates all feed fetching and raw-JSON parsing to the engine (single source
// of truth at C:\sb\); this side only receives the clean data structure.
// Returns [{name, team, uniformNumber, photoUrl, personId}] or throws on engine error.
async function fetchSidearmRoster(feedUrl) {
  const gameId = (() => {
    try { return new URL(feedUrl).searchParams.get('game_id') || 'livestats'; } catch(_) { return 'livestats'; }
  })();
  const result = await sidearmEngine.run(gameId, feedUrl, { saveDebug: false });
  if (!result.ok) throw new Error(result.error || 'SIDEARM engine returned error');
  return result.data.roster || [];
}

// Normalize a name/team string for cache key and comparison.
function _normPhoto(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Returns true when two normalized player names are close enough to be the same person.
// Strategies run in order: exact → reversed → contains → last+initial.
// Reversed and contains must be checked BEFORE the last-name guard to fire correctly.
function _photoNameClose(a, b) {
  if (!a || !b) return false;
  if (a === b)  return true;

  const aW = a.split(' ').filter(Boolean);
  const bW = b.split(' ').filter(Boolean);
  if (!aW.length || !bW.length) return false;

  // Strategy 1: reversed name — "overton kevin" ↔ "kevin overton"
  if ([...aW].reverse().join(' ') === b) return true;
  if ([...bW].reverse().join(' ') === a) return true;

  // Strategy 2: contains — handles "jr"/"ii" suffixes on one side
  if (a.includes(b) || b.includes(a)) return true;

  // Strategies 3-4 require last names to match (≥3 chars)
  const aLast = aW[aW.length - 1];
  const bLast = bW[bW.length - 1];
  if (!aLast || !bLast || aLast.length < 3 || aLast !== bLast) return false;

  const aFirst = aW[0], bFirst = bW[0];

  // Strategy 3: exact first names (same last, same first)
  if (aFirst === bFirst) return true;

  // Strategy 4: initial match — "k" matches "kevin" and vice-versa
  if (aFirst.length === 1 && bFirst.startsWith(aFirst)) return true;
  if (bFirst.length === 1 && aFirst.startsWith(bFirst)) return true;

  return false;
}

// Parse a roster HTML page into [{normName, photoUrl}].
// Sources: <img> (alt/title/aria-label/data-name/data-src) + CSS background-image.
function _parseRosterPhotos(html, domain) {
  const players = [], seen = new Set();

  // Make a URL absolute; return null if it can't be resolved.
  function abs(src) {
    if (!src) return null;
    src = src.trim();
    if (src.startsWith('//'))   return 'https:' + src;
    if (src.startsWith('/'))    return 'https://' + domain + src;
    if (src.startsWith('http')) return src;
    return null;
  }

  // True if a URL looks like a player photo (not a logo/icon/placeholder).
  function isPhotoUrl(src) {
    if (!src) return false;
    if (/logo|icon|badge|sponsor|silhouette|placeholder|default|unavail|generic/i.test(src)) return false;
    return /\.(jpg|jpeg|png|webp)(\?[^"']*)?$/i.test(src) ||
           /sidearm|cdn\.|s3\.amazon|cloudfront|roster|headshot|athlete|player|photo|image/i.test(src);
  }

  // True if a string looks like a real person name.
  // Allows 1–6 words, hyphens, apostrophes, handles "Last, First" format.
  function isPersonName(s) {
    if (!s || s.length < 2 || s.length > 65) return false;
    // At least one word that starts with a capital letter
    if (!/[A-Z]/.test(s)) return false;
    const words = s.split(/[\s,]+/).filter(Boolean);
    if (words.length < 1 || words.length > 6) return false;
    if (/logo|icon|badge|sponsor|team|photo|image|player|headshot|mascot/i.test(s)) return false;
    return true;
  }

  // Extract the best name from an <img> tag's attributes (priority order).
  function nameFromImgAttrs(attrs) {
    const NAME_ATTRS = ['data-player-name', 'data-name', 'aria-label', 'title', 'alt'];
    for (const attr of NAME_ATTRS) {
      const re = new RegExp('\\b' + attr + '\\s*=\\s*["\']([^"\']{2,65})["\']', 'i');
      const m2 = attrs.match(re);
      if (m2 && isPersonName(m2[1])) return m2[1].trim();
    }
    return null;
  }

  function addPlayer(name, src) {
    const url = abs(src);
    if (!url || !isPhotoUrl(url)) return;
    if (!isPersonName(name)) return;
    // Handle "Last, First" format → normalise as "first last"
    let norm = name.replace(/^([^,]+),\s*(.+)$/, '$2 $1');
    const normN = _normPhoto(norm);
    if (!normN || seen.has(normN)) return;
    seen.add(normN);
    players.push({ normName: normN, photoUrl: url });
  }

  // ── Source 1: <img> tags ──────────────────────────────────────────────────
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const name  = nameFromImgAttrs(attrs);
    if (!name) continue;
    // Try src first, then data-src (lazy loading)
    const srcM     = attrs.match(/\bsrc\s*=\s*["']([^"'\s>]+)["']/i);
    const dataSrcM = attrs.match(/\bdata-src\s*=\s*["']([^"'\s>]+)["']/i);
    const src = srcM?.[1] || dataSrcM?.[1];
    if (src) addPlayer(name, src);
  }

  // ── Source 2: background-image CSS (some schools use div/span photo cards) ─
  const bgRe = /style\s*=\s*["'][^"']*background(?:-image)?\s*:\s*url\s*\(\s*["']?([^"')]+)["']?\s*\)[^"']*["']/gi;
  while ((m = bgRe.exec(html)) !== null) {
    const bgSrc = m[1];
    if (!isPhotoUrl(bgSrc)) continue;
    // Scan ±400 chars around the match for any name attribute
    const lo  = Math.max(0, m.index - 400);
    const ctx = html.slice(lo, m.index + m[0].length + 400);
    const NAME_ATTRS = ['data-player-name', 'data-name', 'aria-label', 'title', 'alt'];
    for (const attr of NAME_ATTRS) {
      const nm = ctx.match(new RegExp('\\b' + attr + '\\s*=\\s*["\']([A-Z][^"\']{2,60})["\']', 'i'));
      if (nm && isPersonName(nm[1])) { addPlayer(nm[1], bgSrc); break; }
    }
  }

  return players;
}

// Match a player in a parsed roster [{normName, photoUrl}] using three strategies.
// Returns the matched entry or null. Shared by _fetchRosterPhotos callers and backfill.
function _rosterMatchPlayer(roster, normN) {
  if (!roster || !roster.length || !normN) return null;
  let m = roster.find(r => r.normName === normN);
  if (!m) m = roster.find(r => _photoNameClose(r.normName, normN));
  if (!m) {
    const last = normN.split(' ').pop();
    if (last && last.length >= 5) {
      const hits = roster.filter(r => r.normName.split(' ').pop() === last);
      if (hits.length === 1) m = hits[0];
    }
  }
  return m || null;
}

// Look up a player in historicalPhotoCache (populated by /api/historical-roster-backfill).
// Team matching: exact normName first, then first-significant-word fuzzy (handles "Kansas Jayhawks"↔"Kansas").
// Player matching: exact → _photoNameClose (nicknames/initials/reversed) → unique last-name.
// Logs every attempt when the team has data so misses are visible in server logs.
// Returns { url, matchedAs, resolvedTeam } or null.
function findHistoricalPhoto(name, team, year) {
  const yearCache = historicalPhotoCache[String(year)];
  const normT     = _normPhoto(team);
  const normN     = _normPhoto(name);
  const lastName  = normN.split(' ').pop();

  // ── Team resolution: exact then first-significant-word fuzzy ──────────────
  let teamPhotos   = yearCache?.[normT];
  let resolvedTeam = normT;

  if ((!teamPhotos || !Object.keys(teamPhotos).length) && yearCache) {
    const firstWord = normT.split(' ').find(w => w.length >= 4);
    if (firstWord) {
      for (const [k, photos] of Object.entries(yearCache)) {
        if (k === normT) continue;
        const kFirst = k.split(' ')[0];
        if (kFirst === firstWord || k.startsWith(firstWord) || firstWord.startsWith(kFirst)) {
          if (Object.keys(photos).length > 0) {
            teamPhotos   = photos;
            resolvedTeam = k;
            break;
          }
        }
      }
    }
  }

  const hasTeam = !!(teamPhotos && Object.keys(teamPhotos).length > 0);
  if (!hasTeam) return null; // silently skip teams with no data (avoids noise for unscraped teams)

  // ── Player matching ────────────────────────────────────────────────────────
  // exact
  if (teamPhotos[normN]) {
    console.log(`[Historical cache lookup] year=${year} team=${team} normTeam=${resolvedTeam} hasTeam=yes player=${name} normPlayer=${normN} found=yes matchedAs=${normN}`);
    return { url: teamPhotos[normN], matchedAs: normN, resolvedTeam };
  }

  // close match (nickname, initial, reversed order, contains)
  for (const [k, url] of Object.entries(teamPhotos)) {
    if (_photoNameClose(k, normN)) {
      console.log(`[Historical cache lookup] year=${year} team=${team} normTeam=${resolvedTeam} hasTeam=yes player=${name} normPlayer=${normN} found=yes matchedAs=${k}`);
      return { url, matchedAs: k, resolvedTeam };
    }
  }

  // last name only — unique hit, minimum 4 chars to avoid noise
  if (lastName && lastName.length >= 4) {
    const hits = Object.entries(teamPhotos).filter(([k]) => k.split(' ').pop() === lastName);
    if (hits.length === 1) {
      console.log(`[Historical cache lookup] year=${year} team=${team} normTeam=${resolvedTeam} hasTeam=yes player=${name} normPlayer=${normN} found=yes matchedAs=${hits[0][0]} (last-name)`);
      return { url: hits[0][1], matchedAs: hits[0][0], resolvedTeam };
    }
  }

  console.log(`[Historical cache lookup] year=${year} team=${team} normTeam=${resolvedTeam} hasTeam=yes player=${name} normPlayer=${normN} found=no`);
  return null;
}

// Same lookup logic as findHistoricalPhoto but reads from sidearmPhotoCache.
// Returns { url, matchedAs, resolvedTeam } or null.
function findSidearmPhoto(name, team, year) {
  const yearCache = sidearmPhotoCache[String(year)];
  if (!yearCache) return null;
  const normT    = _normPhoto(team);
  const normN    = _normPhoto(name);
  const lastName = normN.split(' ').pop();

  let teamPhotos   = yearCache[normT];
  let resolvedTeam = normT;

  if ((!teamPhotos || !Object.keys(teamPhotos).length)) {
    const firstWord = normT.split(' ').find(w => w.length >= 4);
    if (firstWord) {
      for (const [k, photos] of Object.entries(yearCache)) {
        if (k === normT) continue;
        const kFirst = k.split(' ')[0];
        if (kFirst === firstWord || k.startsWith(firstWord) || firstWord.startsWith(kFirst)) {
          if (Object.keys(photos).length > 0) { teamPhotos = photos; resolvedTeam = k; break; }
        }
      }
    }
  }

  if (!teamPhotos || !Object.keys(teamPhotos).length) return null;

  if (teamPhotos[normN]) return { url: teamPhotos[normN], matchedAs: normN, resolvedTeam };
  for (const [k, url] of Object.entries(teamPhotos)) {
    if (_photoNameClose(k, normN)) return { url, matchedAs: k, resolvedTeam };
  }
  if (lastName && lastName.length >= 4) {
    const hits = Object.entries(teamPhotos).filter(([k]) => k.split(' ').pop() === lastName);
    if (hits.length === 1) return { url: hits[0][1], matchedAs: hits[0][0], resolvedTeam };
  }
  return null;
}

// Lookup in waybackPhotoCache — same structure and matching logic as findHistoricalPhoto.
// Returns { url, matchedAs, resolvedTeam } or null.
function findWaybackPhoto(name, team, year) {
  const yearCache = waybackPhotoCache[String(year)];
  if (!yearCache) return null;
  const normT    = _normPhoto(team);
  const normN    = _normPhoto(name);
  const lastName = normN.split(' ').pop();

  let teamPhotos   = yearCache[normT];
  let resolvedTeam = normT;

  if (!teamPhotos || !Object.keys(teamPhotos).length) {
    const firstWord = normT.split(' ').find(w => w.length >= 4);
    if (firstWord) {
      for (const [k, photos] of Object.entries(yearCache)) {
        if (k === normT) continue;
        const kFirst = k.split(' ')[0];
        if (kFirst === firstWord || k.startsWith(firstWord) || firstWord.startsWith(kFirst)) {
          if (Object.keys(photos).length > 0) { teamPhotos = photos; resolvedTeam = k; break; }
        }
      }
    }
  }

  if (!teamPhotos || !Object.keys(teamPhotos).length) return null;

  if (teamPhotos[normN]) return { url: teamPhotos[normN], matchedAs: normN, resolvedTeam };
  for (const [k, url] of Object.entries(teamPhotos)) {
    if (_photoNameClose(k, normN)) return { url, matchedAs: k, resolvedTeam };
  }
  if (lastName && lastName.length >= 4) {
    const hits = Object.entries(teamPhotos).filter(([k]) => k.split(' ').pop() === lastName);
    if (hits.length === 1) return { url: hits[0][1], matchedAs: hits[0][0], resolvedTeam };
  }
  return null;
}

// Validate that a URL resolves to a real image (not a 404 or tiny placeholder).
// Uses a HEAD request: checks status 200, content-type starts with "image/",
// and content-length > 2 KB (when provided). Results cached 24 h.
// ESPN CDN returns 404 for athletes without photos; some CDNs serve a
// generic silhouette — the size check catches those.
async function _validateImageUrl(url) {
  if (!url) return false;
  const cached = _imageValidationCache[url];
  if (cached && Date.now() - cached.ts < 86_400_000) return cached.valid;

  let valid = false, statusCode = 0;
  try {
    const parsed = new URL(url);
    await new Promise(resolve => {
      const opts = {
        hostname: parsed.hostname,
        path:     parsed.pathname + (parsed.search || ''),
        method:   'HEAD',
        headers:  { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' },
        timeout:  5000,
      };
      const req = https.request(opts, r => {
        r.resume(); // HEAD has no body — drain socket
        statusCode    = r.statusCode;
        const ct      = (r.headers['content-type'] || '').toLowerCase();
        const clRaw   = r.headers['content-length'];
        const cl      = clRaw ? parseInt(clRaw, 10) : null;
        valid = statusCode === 200
          && ct.startsWith('image/')
          && (cl === null || cl > 2000); // null = server omitted header → trust status+type
        resolve();
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  } catch(_) { valid = false; }

  console.log(`[Image validation] url=${url} status=${statusCode || 'error'} valid=${valid}`);
  _imageValidationCache[url] = { valid, ts: Date.now() };
  return valid;
}

// Validate ESPN CDN headshot URL for a given athlete ID.
// Cheaper than validating an arbitrary URL because we know the host.
// Returns the URL if valid, null otherwise.
async function _validatedCdnUrl(athleteId) {
  if (!athleteId) return null;
  const url = `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${athleteId}.png`;
  return (await _validateImageUrl(url)) ? url : null;
}

// Try the NBA headshot CDN for the same ESPN athlete ID.
// Useful for historical college players whose college CDN entry is gone but who went on to the NBA.
async function _validatedNbaCdnUrl(athleteId) {
  if (!athleteId) return null;
  const url = `https://a.espncdn.com/i/headshots/nba/players/full/${athleteId}.png`;
  return (await _validateImageUrl(url)) ? url : null;
}

// Search Wikipedia for a player photo using the public MediaWiki API.
// Two-step: search → pageimages. Caches 7 days. Returns a validated thumbnail URL or null.
async function _fetchWikipediaPhoto(name, team) {
  const cacheKey = `${_normPhoto(name)}:${_normPhoto(team)}`;
  const cached   = _wikiPhotoCache[cacheKey];
  if (cached && Date.now() - cached.ts < 7 * 86_400_000) return cached.url || null;

  const wikiGet = (path) => new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: 'en.wikipedia.org', path,
        headers: { 'User-Agent': 'CollegeOnTV/1.0 (educational; historical sports photos)', Accept: 'application/json' } },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('timeout')); });
  });

  let url = null;
  try {
    // Step 0: Wikipedia REST API direct lookup — fastest path for well-known players.
    // Tries the player's name directly as a page title; verifies the page is about a
    // person (type=standard) and mentions their last name in the summary extract.
    // tryRestTitle: fetch a Wikipedia REST summary and return a validated photo URL,
    // or null. Verifies the page is about a person (type=standard) and that the
    // player's last name appears in the article extract.
    const tryRestTitle = async (title) => {
      try {
        const summary = await wikiGet(`/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
        const thumb   = summary?.thumbnail?.source;
        if (!thumb) return null;
        if (summary.type === 'disambiguation') return 'disambiguation';
        if (summary.type !== 'standard') return null;
        const extract  = (summary.extract || '').toLowerCase();
        const lastName = _normPhoto(name).split(' ').pop();
        if (lastName && lastName.length >= 4 && !extract.includes(lastName)) return null;
        return (await _validateImageUrl(thumb)) ? thumb : null;
      } catch(_) { return null; }
    };

    const baseName = name.trim().replace(/\s+/g, '_');
    let restResult = await tryRestTitle(baseName);

    // If disambiguation, try common sport-specific page-title suffixes
    if (restResult === 'disambiguation') {
      const suffixes = [
        '_(basketball)', '_(basketball_player)',
        '_(American_football)', '_(American_football_player)',
        '_(basketball_player)', '_(NBA)',
      ];
      for (const sfx of suffixes) {
        const r = await tryRestTitle(baseName + sfx);
        if (r && r !== 'disambiguation') { restResult = r; break; }
      }
      if (restResult === 'disambiguation') restResult = null;
    }

    if (restResult) {
      console.log(`[Wikipedia photo] name=${name} team=${team} method=rest_direct url=found`);
      _wikiPhotoCache[cacheKey] = { url: restResult, ts: Date.now() };
      return restResult;
    }
    // REST API miss — fall through to MediaWiki search

    const normN     = _normPhoto(name);
    const nameWords = normN.split(' ').filter(w => w.length > 1);

    // Step 1: MediaWiki search with team name for specificity
    const trySearch = async (query) => {
      const q     = encodeURIComponent(query);
      const sData = await wikiGet(`/w/api.php?action=query&list=search&srsearch=${q}&srlimit=5&format=json`);
      return (sData?.query?.search || []).find(h => {
        const t = _normPhoto(h.title);
        return nameWords.every(w => t.includes(w));
      });
    };

    let match = await trySearch(`${name} ${team} basketball`);

    // Step 1b: retry without team name (helps players whose Wikipedia entry doesn't
    // mention the school, e.g. players known primarily for professional careers)
    if (!match) match = await trySearch(`${name} basketball player`);

    if (!match) {
      _wikiPhotoCache[cacheKey] = { url: null, ts: Date.now() };
      return null;
    }

    // Step 2: get thumbnail from pageimages
    const title = encodeURIComponent(match.title);
    const iData = await wikiGet(`/w/api.php?action=query&titles=${title}&prop=pageimages&pithumbsize=500&format=json`);
    const pages = iData?.query?.pages || {};
    const thumb = Object.values(pages)[0]?.thumbnail?.source || null;

    if (thumb) {
      const valid = await _validateImageUrl(thumb);
      url = valid ? thumb : null;
    }
    console.log(`[Wikipedia photo] name=${name} team=${team} page="${match.title}" url=${url ? 'found' : 'none'}`);
  } catch(e) {
    console.warn(`[Wikipedia photo] ${name}: ${e.message}`);
  }

  _wikiPhotoCache[cacheKey] = { url, ts: Date.now() };
  return url;
}

// Fetch and cache an entire team roster page from an athletics domain.
// Rate-limited per domain; caches results for 24 hours.
async function _fetchRosterPhotos(domain, season) {
  const key    = `${domain}:${season}`;
  const cached = _rosterPageCache[key];
  if (cached) return cached;

  const lastFetch = _domainFetchTs[domain] || 0;
  if (Date.now() - lastFetch < 2000) return []; // rate limit: ≥2s between fetches per domain
  _domainFetchTs[domain] = Date.now();

  const tryPath = async (path) => new Promise(resolve => {
    const opts = {
      hostname: domain,
      path,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'text/html' },
    };
    const req = https.get(opts, r => {
      // Follow one redirect
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const loc = r.headers.location;
        const u   = new URL(loc, `https://${domain}`);
        https.get({ ...opts, hostname: u.hostname, path: u.pathname + (u.search || '') }, r2 => {
          let b = ''; r2.on('data', c => b += c); r2.on('end', () => resolve(b));
        }).on('error', () => resolve(''));
        return;
      }
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
  });

  try {
    // Try standard Sidearm path first, then basketball-specific variant
    let html = await tryPath('/sports/mens-basketball/roster');
    if (html.length < 500) html = await tryPath('/sports/m-basketball/roster');

    const players = _parseRosterPhotos(html, domain);
    _rosterPageCache[key] = players;
    console.log(`[Player photo enrichment] cached ${players.length} photos from ${domain} season=${season}`);
    return players;
  } catch(e) {
    console.warn(`[Player photo enrichment] roster fetch failed ${domain}: ${e.message}`);
    _rosterPageCache[key] = [];
    return [];
  }
}

// Fetch a team's roster for a specific historical season by trying multiple
// URL patterns used by Sidearm Sports and other athletics CMS platforms.
// Cached as `${domain}:hist:${season}` so it never conflicts with the
// current-season cache in _fetchRosterPhotos.
// Tries up to MAX_CANDIDATES paths (including links discovered in HTML).
// Each candidate is validated: rejected if it looks like the current-season roster.
// Always respects the per-domain rate limit (_domainFetchTs).
async function _fetchHistoricalRosterPhotos(domain, season) {
  const cacheKey = `${domain}:hist:${season}`;
  if (_rosterPageCache[cacheKey]) return _rosterPageCache[cacheKey];

  const acad    = `${season - 1}-${String(season).slice(-2)}`;
  const yearStr = String(season);

  const candidates = [
    `/sports/mens-basketball/roster/${acad}`,
    `/sports/mens-basketball/roster/${yearStr}`,
    `/sports/mens-basketball/roster?season=${yearStr}`,
    `/sports/mens-basketball/roster/season/${acad}`,
    `/sports/mens-basketball/roster/season/${yearStr}`,
    `/sports/m-basketball/roster/${acad}`,
    `/sports/m-basketball/roster/${yearStr}`,
    `/sports/mbball/roster/${yearStr}`,
    `/sports/m-baskbl/roster/${yearStr}`,
    `/sports/mens-basketball/schedule/${yearStr}`,
  ];

  // Returns { html, resolvedPath } — resolvedPath is the final URL after any redirect.
  const tryPath = (path) => new Promise(resolve => {
    const opts = {
      hostname: domain, path,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'text/html' },
    };
    const req = https.get(opts, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        let u;
        try { u = new URL(r.headers.location, `https://${domain}`); } catch(_) { return resolve({ html: '', resolvedPath: path }); }
        const rp = u.pathname + (u.search || '');
        https.get({ ...opts, hostname: u.hostname, path: rp }, r2 => {
          let b = ''; r2.on('data', c => b += c); r2.on('end', () => resolve({ html: b, resolvedPath: rp }));
        }).on('error', () => resolve({ html: '', resolvedPath: path }));
        return;
      }
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ html: b, resolvedPath: path }));
    });
    req.on('error', () => resolve({ html: '', resolvedPath: path }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ html: '', resolvedPath: path }); });
  });

  // Validate that a fetched roster page is actually for the target season.
  // Two independent checks — both must pass:
  //   1. URL check: the RESOLVED path (after any redirect) must contain the year.
  //      If the server redirected /roster/2007-08 → /roster (current), resolvedPath
  //      has no year and we correctly reject it.  We fall back to checking the
  //      requested path only when there was NO redirect (resolvedPath === requestedPath).
  //   2. Image-URL year check (skipped for SIDEARM CDN uploads whose paths encode the
  //      upload date, not the content date).
  function _validateRosterSeason(players, requestedPath, resolvedPath) {
    const resolvedHasYear  = resolvedPath.includes(yearStr) || resolvedPath.includes(acad);
    const wasRedirected    = resolvedPath !== requestedPath;
    const requestedHasYear = requestedPath.includes(yearStr) || requestedPath.includes(acad);
    // Accept when the resolved destination has the year, OR the request had the year
    // and there was no redirect (page was served directly without rerouting to current season).
    const urlContainsYear  = resolvedHasYear || (!wasRedirected && requestedHasYear);

    const photoUrls  = players.filter(p => p.photoUrl).map(p => p.photoUrl);
    const cutoff     = season + 3;
    const curYear    = new Date().getFullYear();
    const imgYearRe  = /\/(\d{4})[\/\-_]/g;
    let checked = 0, wrong = 0;
    for (const u of photoUrls) {
      // SIDEARM CDN and school-hosted SIDEARM images encode the *upload* date,
      // not the player's season. Schools routinely re-upload historical photos
      // years later, so these URLs always look "recent" even for 2008 players.
      // Skip year validation for:
      //   - SIDEARM CDN (dxbhsrqyrr690.cloudfront.net, images.sidearmdev.com)
      //   - School-hosted SIDEARM uploads (/images/YYYY/MM/DD/ path pattern)
      if (u.includes('dxbhsrqyrr690.cloudfront.net') ||
          u.includes('images.sidearmdev.com') ||
          u.includes('sidearmsports.com') ||
          /\/images\/\d{4}\/\d{1,2}\/\d{1,2}\//.test(u)) continue;
      imgYearRe.lastIndex = 0;
      let m;
      while ((m = imgYearRe.exec(u)) !== null) {
        const y = parseInt(m[1], 10);
        if (y >= 2000 && y <= curYear) { checked++; if (y >= cutoff) wrong++; break; }
      }
    }
    const imageYearValid = checked === 0 || (wrong / checked) < 0.5;
    const valid          = urlContainsYear && imageYearValid;

    console.log(`[Historical roster validate] url=https://${domain}${requestedPath} resolvedPath=${resolvedPath} yearExpected=${season}(${acad}) urlContainsYear=${urlContainsYear} imageYearValid=${imageYearValid}(${wrong}/${checked}) valid=${valid}`);
    return valid;
  }

  // Scan HTML for anchor hrefs that look like historical roster links for this season.
  function _extractRosterLinks(html) {
    const found = [];
    const re    = /href=["']([^"']{4,200})["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (!/roster|mens-basketball|m-basketball|mbball|m-baskbl/i.test(href)) continue;
      if (!href.includes(yearStr) && !href.includes(acad)) continue;
      try {
        const u = new URL(href, `https://${domain}`);
        if (u.hostname !== domain) continue;
        const p = u.pathname + (u.search || '');
        if (!found.includes(p)) found.push(p);
      } catch(_) {}
    }
    return found.slice(0, 4);
  }

  const MAX_CANDIDATES = 8;
  let bestPlayers = [];
  const triedPaths = new Set();

  for (let i = 0; i < candidates.length && triedPaths.size < MAX_CANDIDATES; i++) {
    const path = candidates[i];
    if (triedPaths.has(path)) continue;
    triedPaths.add(path);

    const lastFetch = _domainFetchTs[domain] || 0;
    const wait      = 1500 - (Date.now() - lastFetch);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _domainFetchTs[domain] = Date.now();

    let html = '', resolvedPath = path;
    try {
      ({ html, resolvedPath } = await tryPath(path));
    } catch(_) {}

    if (!html || html.length < 300) {
      console.log(`[Historical roster candidate] url=https://${domain}${path} status=empty`);
      continue;
    }

    // Schedule page: extract roster links and inject them, don't parse players
    if (path.includes('/schedule/')) {
      const discovered = _extractRosterLinks(html);
      console.log(`[Historical roster candidate] url=https://${domain}${path} status=schedule discovered=${discovered.length}`);
      for (let j = discovered.length - 1; j >= 0; j--) {
        if (!triedPaths.has(discovered[j])) candidates.splice(i + 1, 0, discovered[j]);
      }
      continue;
    }

    const players = _parseRosterPhotos(html, domain);
    const photos  = players.filter(p => p.photoUrl).length;

    // Validate season before accepting
    if (!_validateRosterSeason(players, path, resolvedPath)) {
      console.log(`[Historical roster candidate] url=https://${domain}${path} status=wrong-season players=${players.length} — rejected`);
      // Still scan for roster links in case the page has year-specific links
      if (bestPlayers.length < 3) {
        const discovered = _extractRosterLinks(html);
        for (let j = discovered.length - 1; j >= 0; j--) {
          if (!triedPaths.has(discovered[j])) candidates.splice(i + 1, 0, discovered[j]);
        }
      }
      continue;
    }

    console.log(`[Historical roster candidate] url=https://${domain}${path} status=ok players=${players.length} photos=${photos}`);

    if (players.length > bestPlayers.length) bestPlayers = players;
    if (players.length >= 5 && photos >= 3) break;

    // Thin roster: scan for alternate year-specific URLs
    if (bestPlayers.length < 3) {
      const discovered = _extractRosterLinks(html);
      for (let j = discovered.length - 1; j >= 0; j--) {
        if (!triedPaths.has(discovered[j])) candidates.splice(i + 1, 0, discovered[j]);
      }
    }
  }

  _rosterPageCache[cacheKey] = bestPlayers;
  return bestPlayers;
}

// ─── Wayback Machine photo sources ────────────────────────────────────────────

// Query Wayback CDX API to find the best archived snapshot of pageUrl near targetYear.
// Filters to HTML pages with a 200 status. Picks the snapshot closest to April 1
// of the target year (after the tournament). Results cached in _waybackCdxCache.
// Rate-limited: 1.2 s minimum between calls to web.archive.org.
async function _queryWaybackCDX(pageUrl, targetYear) {
  const cacheKey = `${pageUrl}:${targetYear}`;
  if (cacheKey in _waybackCdxCache) return _waybackCdxCache[cacheKey];

  const gap = 1200 - (Date.now() - _waybackLastFetch);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _waybackLastFetch = Date.now();

  const from    = `${targetYear - 1}0601`;
  const to      = `${targetYear + 1}0601`;
  const encoded = encodeURIComponent(pageUrl);
  const apiPath = `/cdx/search/cdx?url=${encoded}&output=json&fl=timestamp,original,statuscode,mimetype` +
    `&filter=statuscode:200&filter=mimetype:text/html&from=${from}&to=${to}&limit=20&collapse=timestamp:8`;

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'web.archive.org',
        path: apiPath,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'application/json' },
      }, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error('cdx-timeout')); });
    });

    if (!Array.isArray(data) || data.length < 2) {
      return (_waybackCdxCache[cacheKey] = null);
    }

    const rows = data.slice(1); // skip header row: [urlkey,timestamp,original,mimetype,...]
    if (!rows.length) return (_waybackCdxCache[cacheKey] = null);

    // Closest snapshot to April 1 of the target year
    const targetNum = parseInt(`${targetYear}0401000000`, 10);
    let best = null, bestDiff = Infinity;
    for (const row of rows) {
      const ts = row[0];
      if (!ts || ts.length < 14) continue;
      const diff = Math.abs(parseInt(ts, 10) - targetNum);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { timestamp: ts, snapshotUrl: `https://web.archive.org/web/${ts}/${row[1]}` };
      }
    }

    console.log(`[wayback-cdx] url=${pageUrl} year=${targetYear} snapshots=${rows.length} best=${best?.timestamp || 'none'}`);
    return (_waybackCdxCache[cacheKey] = best);
  } catch(e) {
    console.warn(`[wayback-cdx] ${pageUrl}: ${e.message}`);
    return (_waybackCdxCache[cacheKey] = null);
  }
}

// Fetch an archived HTML page from the Wayback Machine.
// Follows up to 2 redirects. Rate-limited via _waybackLastFetch (shared with CDX).
// Returns HTML string or '' on error/timeout.
async function _fetchWaybackPage(snapshotUrl) {
  const gap = 1500 - (Date.now() - _waybackLastFetch);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _waybackLastFetch = Date.now();

  return new Promise(resolve => {
    const follow = (u, depth) => {
      if (depth > 2) return resolve('');
      let target;
      try { target = new URL(u); } catch(_) { return resolve(''); }
      const req = https.get({
        hostname: target.hostname,
        path: target.pathname + (target.search || ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'text/html' },
      }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          const loc = r.headers.location;
          return follow(loc.startsWith('http') ? loc : `https://${target.hostname}${loc}`, depth + 1);
        }
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve(body));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(15000, () => { req.destroy(); resolve(''); });
    };
    follow(snapshotUrl, 0);
  });
}

// Try to fetch a roster page for domain+year via Wayback Machine.
// Queries CDX for each standard roster URL candidate; fetches and parses the best snapshot.
// Returns [{normName, photoUrl}] — same shape as _fetchHistoricalRosterPhotos.
async function _fetchWaybackRosterPhotos(domain, year) {
  const acad    = `${year - 1}-${String(year).slice(-2)}`;
  const yearStr = String(year);

  const candidates = [
    `https://${domain}/sports/mens-basketball/roster/${acad}`,
    `https://${domain}/sports/mens-basketball/roster/${yearStr}`,
    `https://${domain}/roster.aspx?path=mbball&season=${acad}`,
    `https://${domain}/sports/mens-basketball/roster`,
    `https://${domain}/sports/m-basketball/roster/${acad}`,
    `https://${domain}/sports/m-basketball/roster/${yearStr}`,
    `https://${domain}/sports/mbball/roster/${yearStr}`,
    `https://${domain}/sports/mens-basketball/roster?season=${yearStr}`,
  ];

  let bestPlayers = [];

  for (const candidate of candidates) {
    const snapshot = await _queryWaybackCDX(candidate, year);
    if (!snapshot) continue;

    console.log(`[Wayback roster] domain=${domain} year=${year} snapshot=${snapshot.timestamp} url=${candidate}`);

    const html = await _fetchWaybackPage(snapshot.snapshotUrl);
    if (!html || html.length < 300) continue;

    // Wayback rewrites relative paths to /web/{ts}/... so abs() resolves them against web.archive.org
    const players = _parseRosterPhotos(html, 'web.archive.org');
    const photos  = players.filter(p => p.photoUrl).length;

    console.log(`[Wayback roster] domain=${domain} year=${year} players=${players.length} photos=${photos}`);

    if (players.length > bestPlayers.length) bestPlayers = players;
    if (bestPlayers.length >= 5 && photos >= 3) break;
  }

  return bestPlayers;
}

// ─── PDF media guide photo sources ────────────────────────────────────────────

// Extract all JPEG images embedded in a PDF buffer.
// Scans for JPEG SOI (FF D8 FF) → EOI (FF D9) byte sequences.
// Keeps only images between minBytes and maxBytes (headshot range).
function _extractJPEGsFromPDF(buf, minBytes = 8000, maxBytes = 800 * 1024) {
  const jpegs = [];
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0xFF && buf[i+1] === 0xD8 && buf[i+2] === 0xFF) {
      let end = -1;
      for (let j = i + 2; j < buf.length - 1; j++) {
        if (buf[j] === 0xFF && buf[j+1] === 0xD9) { end = j + 2; break; }
      }
      if (end > i) {
        const size = end - i;
        if (size >= minBytes && size <= maxBytes) jpegs.push(buf.slice(i, end));
        i = end - 1;
      }
    }
  }
  return jpegs;
}

// Pull PDF text tokens from a content-stream string.
// Handles (text) Tj and [(text)] TJ operators.
function _parsePDFTextTokens(streamStr, out) {
  const btRe = /BT([\s\S]{0,4000}?)ET/g;
  let m;
  while ((m = btRe.exec(streamStr)) !== null) {
    const block = m[1];
    const tjRe  = /\(([^)\\]{0,120}(?:\\.[^)\\]{0,120})*)\)\s*Tj/g;
    let t;
    while ((t = tjRe.exec(block)) !== null) out.push(t[1].replace(/\\(.)/g, '$1'));
    const tjArrRe = /\[([\s\S]{0,600}?)\]\s*TJ/g;
    while ((t = tjArrRe.exec(block)) !== null) {
      const sRe = /\(([^)\\]{0,120}(?:\\.[^)\\]{0,120})*)\)/g;
      let s;
      while ((s = sRe.exec(t[1])) !== null) out.push(s[1].replace(/\\(.)/g, '$1'));
    }
  }
}

// Extract readable text from a PDF buffer.
// Strategy A: decompress FlateDecode content streams with Node's built-in zlib.
// Strategy B: scan raw (uncompressed) BT/ET blocks as fallback.
// Returns a single joined string suitable for name searching.
function _extractPDFText(buf) {
  const raw   = buf.toString('binary'); // latin-1 preserves byte values
  const parts = [];

  // Strategy A — FlateDecode streams
  const flatRe = /\/Filter\s*(?:\/FlateDecode|\[(?:\s*\/\w+)*\s*\/FlateDecode(?:\s*\/\w+)*\s*\])\b[\s\S]*?stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = flatRe.exec(raw)) !== null) {
    try {
      const bytes = Buffer.from(m[1], 'binary');
      let decompressed;
      try      { decompressed = zlib.inflateSync(bytes); }
      catch(e1){ try { decompressed = zlib.inflateRawSync(bytes); } catch(e2) { continue; } }
      _parsePDFTextTokens(decompressed.toString('binary'), parts);
    } catch(_) {}
  }

  // Strategy B — raw streams (some older PDFs don't use compression)
  _parsePDFTextTokens(raw, parts);

  return parts.join(' ').replace(/[\x00-\x1F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Download a URL safely, aborting if the response exceeds maxBytes.
// Shares the _pdfLastFetch rate limiter (1.5 s between requests).
// Returns Buffer on success, null on failure / oversized.
async function _downloadPDFSafe(pdfUrl, maxBytes = 25 * 1024 * 1024) {
  const gap = 1500 - (Date.now() - _pdfLastFetch);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _pdfLastFetch = Date.now();

  return new Promise(resolve => {
    let target;
    try { target = new URL(pdfUrl); } catch(_) { return resolve(null); }

    const baseOpts = {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'application/pdf,*/*' },
    };

    const handleResp = (r, depth) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 3) {
        r.resume();
        let loc;
        try {
          loc = new URL(r.headers.location.startsWith('http')
            ? r.headers.location : `https://${target.hostname}${r.headers.location}`);
        } catch(_) { return resolve(null); }
        https.get({ hostname: loc.hostname, path: loc.pathname + (loc.search || ''), ...baseOpts },
          r2 => handleResp(r2, depth + 1)).on('error', () => resolve(null));
        return;
      }
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      const cl = parseInt(r.headers['content-length'] || '0', 10);
      if (cl > maxBytes) { r.resume(); return resolve(null); }

      const chunks = [];
      let total = 0;
      r.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) { r.destroy(); resolve(null); }
        else chunks.push(chunk);
      });
      r.on('end', () => resolve(total <= maxBytes ? Buffer.concat(chunks) : null));
    };

    const req = https.get(
      { hostname: target.hostname, path: target.pathname + (target.search || ''), ...baseOpts },
      r => handleResp(r, 0)
    );
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
  });
}

// Fetch HTML from a school domain path, respecting the per-domain rate limit.
async function _fetchHTMLForPDF(domain, reqPath) {
  const wait = 1500 - (Date.now() - (_domainFetchTs[domain] || 0));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _domainFetchTs[domain] = Date.now();

  return new Promise(resolve => {
    const opts = {
      hostname: domain, path: reqPath,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'text/html' },
    };
    const follow = (o, depth) => {
      if (depth > 2) return resolve('');
      const req = https.get(o, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          let loc;
          try { loc = new URL(r.headers.location.startsWith('http')
            ? r.headers.location : `https://${o.hostname}${r.headers.location}`); }
          catch(_) { return resolve(''); }
          return follow({ hostname: loc.hostname, path: loc.pathname + (loc.search || ''), headers: o.headers }, depth + 1);
        }
        let b = ''; r.on('data', c => b += c); r.on('end', () => resolve(b));
      });
      req.on('error', () => resolve(''));
      req.setTimeout(8000, () => { req.destroy(); resolve(''); });
    };
    follow(opts, 0);
  });
}

// Scrape a school's current basketball pages for media guide PDF links.
// Returns absolute PDF URLs (up to 3) that reference the target season.
async function _findPDFsOnSite(domain, year) {
  const acad     = `${year - 1}-${String(year).slice(-2)}`;
  const yearPats = [String(year), acad, String(year - 1), String(year).slice(-2)];
  const pagePaths = [
    '/sports/mens-basketball/',
    '/sports/mens-basketball/archives',
    '/sports/mens-basketball/media-guide',
    '/sports/m-basketball/',
  ];
  const found = new Set();

  for (const pg of pagePaths) {
    if (found.size >= 3) break;
    let html;
    try { html = await _fetchHTMLForPDF(domain, pg); } catch(_) { continue; }
    if (!html || html.length < 200) continue;

    const linkRe = /href=["']([^"']*\.pdf[^"']*?)["']/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1];
      const ctx  = html.slice(Math.max(0, m.index - 150), m.index + href.length + 150);
      if (!/guide|media|handbook|mbb|basketball/i.test(href + ctx)) continue;
      if (!yearPats.some(p => href.includes(p))) continue;
      try {
        const u = new URL(href, `https://${domain}`);
        if (u.hostname === domain || u.hostname.endsWith('.' + domain)) found.add(u.href);
      } catch(_) {}
      if (found.size >= 3) break;
    }
  }
  return [...found];
}

// Search Wayback Machine CDX for archived basketball media guide PDFs.
// Returns Wayback snapshot URLs (up to 3, sorted by proximity to the target season).
async function _findPDFsOnWayback(domain, year) {
  const from    = `${year - 1}0601`;
  const to      = `${year + 1}0601`;
  const apiPath = `/cdx/search/cdx?url=${encodeURIComponent(`${domain}/*.pdf`)}` +
    `&output=json&fl=timestamp,original,statuscode&filter=statuscode:200` +
    `&from=${from}&to=${to}&limit=40&collapse=original`;

  const gap = 1200 - (Date.now() - _waybackLastFetch);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _waybackLastFetch = Date.now();

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'web.archive.org', path: apiPath,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CollegeOnTV/1.0)', Accept: 'application/json' },
      }, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error('cdx-timeout')); });
    });

    if (!Array.isArray(data) || data.length < 2) return [];
    const rows = data.slice(1).filter(r => /guide|media|handbook|mbb|basketball/i.test(r[1]));
    if (!rows.length) return [];

    const targetNum = parseInt(`${year}0401000000`, 10);
    rows.sort((a, b) => Math.abs(parseInt(a[0],10) - targetNum) - Math.abs(parseInt(b[0],10) - targetNum));
    // Use if_ modifier so Wayback serves the raw file without HTML modification
    return rows.slice(0, 3).map(r => `https://web.archive.org/web/${r[0]}if_/${r[1]}`);
  } catch(e) {
    console.warn(`[pdf-backfill] wayback PDF CDX ${domain}: ${e.message}`);
    return [];
  }
}

// Match missing player names to JPEG images extracted from a PDF.
// Uses positional ordering: player names found earliest in text → earliest images.
// Returns { normPlayerName: jpegBuffer }.
function _matchPlayersToImages(missingNormNames, jpegs, pdfText) {
  const result = {};
  if (!jpegs.length || !missingNormNames.length) return result;

  const normText = pdfText.toLowerCase();

  // Find each name's first position in the extracted text; sort by position
  const positioned = missingNormNames
    .map(n => ({ n, pos: normText.indexOf(n) }))
    .filter(p => p.pos >= 0)
    .sort((a, b) => a.pos - b.pos);

  // Keep headshot-range images only (8 KB – 600 KB)
  const headshots = jpegs.filter(j => j.length >= 8000 && j.length <= 600 * 1024);

  // Skip the first image if we have more than enough (often a cover/logo)
  const skip     = headshots.length > positioned.length + 1 ? 1 : 0;
  const usable   = headshots.slice(skip, skip + positioned.length + 2);

  for (let i = 0; i < Math.min(positioned.length, usable.length); i++) {
    result[positioned[i].n] = usable[i];
  }
  return result;
}

// Core per-team PDF processing.
// Finds PDFs (site → Wayback), downloads, extracts images + text, matches players, persists images.
// Populates pdfPhotoCache[year][normTeam] and returns stats.
async function _processPDFForTeam(normTeam, domain, year, missingNormNames) {
  const yearKey = String(year);
  const imgDir  = path.join(PDF_IMAGE_DIR, yearKey, normTeam);

  // Already processed (even if empty — don't re-try without ?force=1)
  if (pdfPhotoCache[yearKey]?.[normTeam] !== undefined) {
    const n = Object.keys(pdfPhotoCache[yearKey][normTeam]).length;
    return { pdfsFound: 0, imagesExtracted: 0, playersMatched: n, cached: true };
  }

  // Find PDFs: current site first, then Wayback
  let pdfUrls = await _findPDFsOnSite(domain, year);
  if (!pdfUrls.length) pdfUrls = await _findPDFsOnWayback(domain, year);
  console.log(`[pdf-backfill] ${normTeam} year=${year}: found ${pdfUrls.length} PDF(s)`);

  if (!pdfPhotoCache[yearKey]) pdfPhotoCache[yearKey] = {};
  if (!pdfUrls.length) {
    pdfPhotoCache[yearKey][normTeam] = {}; // mark as tried → skip next run
    return { pdfsFound: 0, imagesExtracted: 0, playersMatched: 0 };
  }

  let allJpegs = [], pdfText = '', pdfsOk = 0;

  for (const pdfUrl of pdfUrls.slice(0, 3)) {
    const buf = await _downloadPDFSafe(pdfUrl, 25 * 1024 * 1024);
    if (!buf || buf.length < 100 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
      console.log(`[pdf-backfill] ${normTeam}: skip ${pdfUrl} (bad/missing)`);
      continue;
    }
    pdfsOk++;
    const jpegs = _extractJPEGsFromPDF(buf);
    const text  = _extractPDFText(buf);
    allJpegs    = allJpegs.concat(jpegs);
    pdfText    += ' ' + text;
    console.log(`[pdf-backfill] ${normTeam}: ${jpegs.length} jpegs, ${text.length} chars text from ${pdfUrl}`);
    if (allJpegs.length >= 35 && pdfText.length >= 3000) break;
  }

  const matched    = _matchPlayersToImages(missingNormNames, allJpegs, pdfText);
  const matchCount = Object.keys(matched).length;
  pdfPhotoCache[yearKey][normTeam] = {};

  if (matchCount > 0) {
    try { fs.mkdirSync(imgDir, { recursive: true }); } catch(_) {}
    let idx = 0;
    for (const [normName, jpegBuf] of Object.entries(matched)) {
      const filename = `${idx++}.jpg`;
      try {
        fs.writeFileSync(path.join(imgDir, filename), jpegBuf);
        pdfPhotoCache[yearKey][normTeam][normName] = `/pdf-images/${yearKey}/${normTeam}/${filename}`;
      } catch(e) {
        console.warn(`[pdf-backfill] write ${normTeam}/${filename}: ${e.message}`);
      }
    }
    console.log(`[pdf-backfill] ${normTeam} year=${year}: matched ${matchCount} players`);
  }

  return { pdfsFound: pdfUrls.length, pdfsDownloaded: pdfsOk, imagesExtracted: allJpegs.length, playersMatched: matchCount };
}

// Lookup a player in pdfPhotoCache — same matching logic as findHistoricalPhoto.
function findPDFPhoto(name, team, year) {
  const yearCache = pdfPhotoCache[String(year)];
  if (!yearCache) return null;
  const normT    = _normPhoto(team);
  const normN    = _normPhoto(name);
  const lastName = normN.split(' ').pop();

  let teamPhotos   = yearCache[normT];
  let resolvedTeam = normT;

  if (!teamPhotos || !Object.keys(teamPhotos).length) {
    const firstWord = normT.split(' ').find(w => w.length >= 4);
    if (firstWord) {
      for (const [k, photos] of Object.entries(yearCache)) {
        if (k === normT) continue;
        const kFirst = k.split(' ')[0];
        if (kFirst === firstWord || k.startsWith(firstWord) || firstWord.startsWith(kFirst)) {
          if (Object.keys(photos).length > 0) { teamPhotos = photos; resolvedTeam = k; break; }
        }
      }
    }
  }

  if (!teamPhotos || !Object.keys(teamPhotos).length) return null;

  if (teamPhotos[normN]) return { url: teamPhotos[normN], matchedAs: normN, resolvedTeam };
  for (const [k, url] of Object.entries(teamPhotos)) {
    if (_photoNameClose(k, normN)) return { url, matchedAs: k, resolvedTeam };
  }
  if (lastName && lastName.length >= 4) {
    const hits = Object.entries(teamPhotos).filter(([k]) => k.split(' ').pop() === lastName);
    if (hits.length === 1) return { url: hits[0][1], matchedAs: hits[0][0], resolvedTeam };
  }
  return null;
}

function _loadPDFPhotoCache() {
  try {
    if (fs.existsSync(PDF_PHOTO_CACHE_FILE)) {
      const raw    = JSON.parse(fs.readFileSync(PDF_PHOTO_CACHE_FILE, 'utf8'));
      Object.assign(pdfPhotoCache, raw);
      const years  = Object.keys(raw).length;
      const teams  = Object.values(raw).reduce((n, y) => n + Object.keys(y).length, 0);
      const photos = Object.values(raw).reduce((n, y) =>
        n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
      console.log(`[pdf-photo-cache] loaded ${years} years, ${teams} teams, ${photos} photos from disk`);
    }
  } catch(e) {
    console.warn('[pdf-photo-cache] load failed:', e.message);
  }
}

function _savePDFPhotoCache() {
  try {
    fs.writeFileSync(PDF_PHOTO_CACHE_FILE, JSON.stringify(pdfPhotoCache));
    const years  = Object.keys(pdfPhotoCache).length;
    const teams  = Object.values(pdfPhotoCache).reduce((n, y) => n + Object.keys(y).length, 0);
    const photos = Object.values(pdfPhotoCache).reduce((n, y) =>
      n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
    console.log(`[pdf-photo-cache] saved ${years} years, ${teams} teams, ${photos} photos to disk`);
  } catch(e) {
    console.warn('[pdf-photo-cache] save failed:', e.message);
  }
}

// Search ESPN for a college basketball player by name.
// Uses /apis/search/v2 (the same endpoint ESPN's own UI uses for autocomplete).
// Returns ESPN athlete ID string or null. Caches 7 days (found) / 1 day (not found).
async function searchESPNAthlete(name, team) {
  const normN = _normPhoto(name);
  const normT = _normPhoto(team);
  const key   = `${normN}:${normT}`;

  const cached = espnSearchCache[key];
  if (cached) {
    const ttl = cached.athleteId ? 7 * 86_400_000 : 86_400_000;
    if (Date.now() - cached.ts < ttl) return cached.athleteId || null;
  }

  let athleteId = null;
  try {
    const searchQ = encodeURIComponent(name.trim());
    const data = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'site.api.espn.com',
        path: `/apis/search/v2?query=${searchQ}&limit=10`,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      };
      const req = https.get(opts, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    // Response: { results: [ { type, contents: [ {uid, displayName, description, subtitle}, ... ] } ] }
    // First pass: NCAAM-only (most precise for active college players).
    // Second pass: include NBA/pro basketball — catches 2008 players now in the NBA.
    // Third pass: any sport — catches cross-sport athletes (e.g. football/basketball).
    let players = (data.results || []).flatMap(g =>
      (g.contents || []).filter(c =>
        c.type === 'player' &&
        /NCAAM|college|basketball/i.test(c.description || '')
      )
    );
    if (!players.length) {
      players = (data.results || []).flatMap(g =>
        (g.contents || []).filter(c =>
          c.type === 'player' &&
          /\bNBA\b|basketball/i.test(c.description || '')
        )
      );
    }
    if (!players.length) {
      players = (data.results || []).flatMap(g =>
        (g.contents || []).filter(c => c.type === 'player')
      );
    }

    // Extract numeric athlete ID from uid ("s:40~l:41~a:5176314" → "5176314")
    function uidToId(uid) {
      const m = (uid || '').match(/~a:(\d+)/);
      return m ? m[1] : null;
    }

    // Score candidates by team match; accept transfers (team mismatch is penalised, not rejected)
    let best = null, bestScore = -1;
    for (const p of players) {
      const id = uidToId(p.uid);
      if (!id) continue;

      const athTeam = _normPhoto(p.subtitle || ''); // "Auburn Tigers", "Lipscomb Bisons", …
      let score = 0;
      if (normT && athTeam) {
        if (athTeam === normT)                                       score = 3; // exact
        else if (athTeam.includes(normT) || normT.includes(athTeam)) score = 2; // substring
        else {
          const tFirst = normT.split(' ')[0], aFirst = athTeam.split(' ')[0];
          if (tFirst.length >= 4 && (aFirst.startsWith(tFirst) || tFirst.startsWith(aFirst))) score = 1;
          else score = 0; // wrong team — still keep as fallback (player may have transferred)
        }
      }
      if (score > bestScore) { bestScore = score; best = id; }
    }

    // Accept best match; if only one NCAAM player came back, take it regardless of team
    if (best || (players.length === 1 && uidToId(players[0].uid))) {
      athleteId = best || uidToId(players[0].uid);
    }

    console.log(`[ESPN fallback] name=${name} team=${team} found=${!!athleteId} athleteId=${athleteId || 'none'}`);
  } catch(e) {
    console.warn(`[ESPN fallback] search error: ${name}: ${e.message}`);
  }

  espnSearchCache[key] = { athleteId, ts: Date.now() };
  return athleteId;
}

// ─── Photo backfill helpers ────────────────────────────────────────────────────

// Returns name variants to try when the original search failed.
// Order: stripped-middle → nickname substitutions → initial+last → last-only.
// The original name is NOT included — caller already tried it.
function _relaxedNameVariants(rawName) {
  const norm  = _normPhoto(rawName);
  const words = norm.split(' ').filter(Boolean);
  if (words.length < 2) return [];

  const first = words[0];
  const last  = words[words.length - 1];
  const out   = new Set();

  // Strip middle name(s): "john michael smith" → "john smith"
  if (words.length >= 3) out.add(`${first} ${last}`);

  // Common nickname → formal name mappings (normalized keys)
  const NICK = {
    william:     ['bill','will','billy'],
    robert:      ['rob','bob','bobby'],
    james:       ['jim','jimmy'],
    michael:     ['mike'],
    joseph:      ['joe','joey'],
    anthony:     ['tony'],
    christopher: ['chris'],
    nicholas:    ['nick','nico'],
    matthew:     ['matt'],
    thomas:      ['tom','tommy'],
    benjamin:    ['ben'],
    samuel:      ['sam'],
    joshua:      ['josh'],
    jonathan:    ['jon'],
    daniel:      ['dan'],
    timothy:     ['tim'],
    alexander:   ['alex'],
    andrew:      ['andy','drew'],
    nathaniel:   ['nate'],
    zachary:     ['zach'],
    gregory:     ['greg'],
    dominic:     ['dom'],
    vincent:     ['vince'],
    richard:     ['rick','rich'],
    edward:      ['ed','eddie'],
    charles:     ['charlie','chuck'],
    patrick:     ['pat'],
    // Reverse nicknames: if the player goes by a nickname in the source
    bill:    ['william'], will: ['william'], billy: ['william'],
    bob:     ['robert'],  rob: ['robert'],   bobby: ['robert'],
    jim:     ['james'],   jimmy: ['james'],
    mike:    ['michael'],
    joe:     ['joseph'],  joey: ['joseph'],
    tony:    ['anthony'],
    chris:   ['christopher'],
    nick:    ['nicholas'], nico: ['nicholas'],
    matt:    ['matthew'],
    tom:     ['thomas'],  tommy: ['thomas'],
    ben:     ['benjamin'],
    sam:     ['samuel'],
    josh:    ['joshua'],
    jon:     ['jonathan'],
    dan:     ['daniel'],  danny: ['daniel'],
    tim:     ['timothy'],
    alex:    ['alexander'],
    andy:    ['andrew'],  drew: ['andrew'],
    nate:    ['nathaniel'],
    zach:    ['zachary'],
    greg:    ['gregory'],
    dom:     ['dominic'],
    vince:   ['vincent'],
    rick:    ['richard'], rich: ['richard'],
    ed:      ['edward'],  eddie: ['edward'],
    charlie: ['charles'], chuck: ['charles'],
    pat:     ['patrick'],
  };
  for (const nick of (NICK[first] || [])) out.add(`${nick} ${last}`);

  // First initial + last: "j smith"
  out.add(`${first[0]} ${last}`);

  // Last name only — used for athletics roster matching only, too broad for ESPN
  out.add(last);

  return [...out];
}

// True for seasons where photos are required / high-priority (full pipeline).
// For years before 2010, photos are optional — stats take priority.
function isPhotoRequiredYear(year) {
  return Number(year) >= 2010;
}

// Fetch ESPN summary for a game ID. Returns parsed JSON or {} on failure.
// Shared by stats-coverage and stats-backfill to avoid duplicating the raw https call.
async function _fetchEspnSummary(espnId) {
  return new Promise(resolve => {
    const opts = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${espnId}`,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000,
    };
    const req = https.get(opts, r => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch(_) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// Try to find a photo for one player using relaxed name variants.
// ESPN search is tried for all variants except last-only.
// Athletics roster is tried for all variants including last-only.
async function _backfillPlayerPhoto(name, team, year) {
  const variants = _relaxedNameVariants(name);
  if (!variants.length) return null;

  const normN    = _normPhoto(name);
  const words    = normN.split(' ').filter(Boolean);
  const lastName = words[words.length - 1] || '';

  // ── Priority 0: historicalPhotoCache (pre-scraped by historical-roster-backfill) ──
  // findHistoricalPhoto logs every lookup for teams that have data.
  const histHit = findHistoricalPhoto(name, team, year);
  if (histHit) {
    return { photoUrl: histHit.url, source: 'historical_athletics', matchedAs: histHit.matchedAs };
  }

  // ── Priority 0.5: Wayback Machine roster cache ───────────────────────────────
  // Only for historical seasons (> 2 years old) where school sites don't serve old pages.
  // Wayback and PDF scraping are expensive — skip automatically for pre-2010 seasons
  // where photos are optional; only use pre-cached results for those years.
  if (year < new Date().getFullYear() - 2) {
    const wbHit = findWaybackPhoto(name, team, year);
    if (wbHit) {
      return { photoUrl: wbHit.url, source: 'wayback_roster', matchedAs: wbHit.matchedAs };
    }

    // On-demand Wayback fetch — required years only; pre-2010 uses cache only
    if (isPhotoRequiredYear(year)) {
      const normT2  = _normPhoto(team);
      const domain2 = ATHLETICS_ROSTER_MAP[normT2];
      const wbKey   = `${year}:${normT2}`;
      if (domain2 && !_waybackTriedTeams.has(wbKey)) {
        _waybackTriedTeams.add(wbKey); // mark synchronously to prevent parallel duplicate fetches
        try {
          const wbRoster = await _fetchWaybackRosterPhotos(domain2, year);
          if (!waybackPhotoCache[String(year)]) waybackPhotoCache[String(year)] = {};
          waybackPhotoCache[String(year)][normT2] = {};
          for (const p of wbRoster) {
            if (p.photoUrl) waybackPhotoCache[String(year)][normT2][p.normName] = p.photoUrl;
          }
          if (wbRoster.some(p => p.photoUrl)) _saveWaybackPhotoCache();
          const wbHit2 = findWaybackPhoto(name, team, year);
          if (wbHit2) {
            return { photoUrl: wbHit2.url, source: 'wayback_roster', matchedAs: wbHit2.matchedAs };
          }
        } catch(e) {
          console.warn(`[wayback] on-demand fail team=${team} year=${year}: ${e.message}`);
        }
      }
    }
  }

  // ── Priority 0.6: PDF media guide cache ──────────────────────────────────────
  // Only use cached PDF results for pre-2010; live PDF scraping requires required year.
  if (year < new Date().getFullYear() - 2) {
    const pdfHit = findPDFPhoto(name, team, year);
    if (pdfHit) {
      return { photoUrl: pdfHit.url, source: 'pdf_media_guide', matchedAs: pdfHit.matchedAs };
    }
  }

  // ── Priority 1: ESPN search → college CDN ───────────────────────────────────
  // Search the original full name first, then fall through to relaxed variants.
  // This ensures players with uncommon names (e.g. "Sundiata Gaines") are tried
  // as-is before abbreviated forms like "s gaines" that ESPN cannot resolve.
  let foundEspnId = null;
  for (const variant of [normN, ...variants]) {
    if (variant === lastName) continue; // too ambiguous for ESPN
    const espnId = await searchESPNAthlete(variant, team);
    if (espnId) {
      const photoUrl = await _validatedCdnUrl(espnId);
      if (photoUrl) return { photoUrl, source: 'espn_search', matchedAs: variant, espnId };
      if (!foundEspnId) foundEspnId = espnId; // save for NBA CDN fallback
    }
  }

  // ── Priority 2: NBA ESPN CDN (same athlete ID, different sport path) ────────
  // Covers players whose college CDN entry expired but who went on to the NBA.
  if (foundEspnId) {
    const nbaUrl = await _validatedNbaCdnUrl(foundEspnId);
    if (nbaUrl) return { photoUrl: nbaUrl, source: 'espn_nba', matchedAs: normN, espnId: foundEspnId };
  }

  // ── Priority 3.5: SIDEARM photo cache (ingested via /api/sidearm-game-photos) ─
  const sidearmHit = findSidearmPhoto(name, team, year);
  if (sidearmHit) {
    return { photoUrl: sidearmHit.url, source: 'sidearm', matchedAs: sidearmHit.matchedAs };
  }

  // ── Priority 4: Athletics roster: historical first, current as fallback ─────
  const normT   = _normPhoto(team);
  const domain  = ATHLETICS_ROSTER_MAP[normT];
  const curYear = new Date().getFullYear();

  if (domain) {
    // Build the ordered roster list to search:
    //   old season  → historical URL patterns first, then current page
    //   recent year → current page only (player likely still on roster)
    const rosterSources = year < curYear - 1
      ? [
          { fetch: () => _fetchHistoricalRosterPhotos(domain, year), label: 'historical_athletics' },
          { fetch: () => _fetchRosterPhotos(domain, year),           label: 'athletics' },
        ]
      : [
          { fetch: () => _fetchRosterPhotos(domain, year),           label: 'athletics' },
        ];

    for (const src of rosterSources) {
      let roster;
      try { roster = await src.fetch(); } catch(_) { continue; }
      if (!roster || !roster.length) continue;

      for (const variant of variants) {
        const match = _rosterMatchPlayer(roster, variant);
        if (match && match.photoUrl) {
          console.log(`[Historical photo fallback] name=${name} team=${team} season=${year} source=${src.label} matchedAs=${variant} photoUrl=yes`);
          return { photoUrl: match.photoUrl, source: src.label, matchedAs: variant };
        }
      }
    }
  }

  // ── Final fallback: Wikipedia (last resort when no domain/roster/PDF/ESPN hit) ─
  if (year < new Date().getFullYear() - 1) {
    const wikiUrl = await _fetchWikipediaPhoto(name, team);
    if (wikiUrl) return { photoUrl: wikiUrl, source: 'wikipedia', matchedAs: normN };
    // Pre-2010: photos optional — mark as name_only, not an error
    if (!isPhotoRequiredYear(year)) {
      console.log(`[Historical photo fallback] name=${name} team=${team} season=${year} source=name_only_old_season`);
      return { photoUrl: null, source: 'name_only_old_season' };
    }
    console.log(`[Historical photo fallback] name=${name} team=${team} season=${year} source=unrecoverable_2008`);
    return { photoUrl: null, source: 'unrecoverable_2008' };
  }

  console.log(`[Historical photo fallback] name=${name} team=${team} season=${year} source=none matchedAs=none photoUrl=no`);
  return null;
}

// Shared helper — fetches and transforms all ESPN games for a given tournament slug + season.
// Used by /api/espn/tournament-games and /api/tournament/stats (Mode B: ?tournament+year).
async function _internalFetchTournamentContests(slug, season) {
  const POSTSEASON_NAMES = {
    'nit': ['NIT', 'NATIONAL INVITATION TOURNAMENT'],
    'cbi': ['CBI', 'COLLEGE BASKETBALL INVITATIONAL', 'ROMAN CBI'],
    'cit': ['CIT', 'COLLEGE INSIDER TOURNAMENT', 'COLLEGEINSIDER.COM TOURNAMENT', 'COLLEGEINSIDER.COM'],
    'cbc': ['CBC', 'COLLEGE BASKETBALL CROWN'],
    'nbc': ['BASKETBALL CLASSIC'],
  };

  const isConf = slug.endsWith('-tournament') && slug !== 'march-madness';
  const isMM   = slug === 'march-madness';
  let startD, endD;
  if (isConf) {
    startD = new Date(`${season}-02-24T12:00:00Z`);
    endD   = new Date(`${season}-03-20T12:00:00Z`);
  } else {
    startD = new Date(`${season}-03-12T12:00:00Z`);
    endD   = new Date(`${season}-04-10T12:00:00Z`);
  }

  const dates = [];
  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    dates.push(d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0'));
  }

  const EXTRA_MM_IDS = new Set(['220712561','230772640','240762329']);

  function isMMEvent(ev) {
    const comp = ev.competitions?.[0];
    const note  = comp?.notes?.[0]?.headline || '';
    const nu    = note.toUpperCase().trim();
    const group = (comp?.groups?.shortName || '').toUpperCase().trim();
    const NON_MM_IDS = [
      'NIT','CBI','CIT','CBC','BASKETBALL CLASSIC',
      'NATIONAL INVITATION','COLLEGE BASKETBALL INVITATIONAL',
      'COLLEGE INSIDER','COLLEGE BASKETBALL CROWN','ROMAN CBI','COLLEGEINSIDER',
    ];
    if (/\bCBI\b|\bCIT\b/.test(nu)) return false;
    const groupFull = (comp?.groups?.name || '').toUpperCase().trim();
    if (NON_MM_IDS.some(p => group.startsWith(p) || groupFull.includes(p))) return false;
    if (NON_MM_IDS.some(p => nu.startsWith(p))) return false;
    const NON_MM_CONTAINS = [
      'COLLEGE BASKETBALL CROWN','COLLEGE BASKETBALL INVITATIONAL',
      'COLLEGE INSIDER TOURNAMENT','BASKETBALL CLASSIC','NATIONAL INVITATION TOURNAMENT',
    ];
    if (NON_MM_CONTAINS.some(p => nu.includes(p))) return false;
    if (note.includes(' - ')) {
      const prefix = nu.split(' - ')[0].trim();
      if (!prefix.includes('NCAA') && !prefix.includes("MEN'S") &&
          !/^(EAST|WEST|SOUTH|MIDWEST)\s+REGION/.test(prefix) &&
          /\b(TOURNAMENT|CHAMPIONSHIP)\b/.test(prefix)) return false;
    }
    if (/\b(TOURNAMENT|CHAMPIONSHIP)\b/.test(nu)) {
      const isExplicitNCAA =
        nu.startsWith('CHAMPIONSHIP') || nu.includes('NCAA') || nu.includes("MEN'S") ||
        nu.includes('NATIONAL') || /^(EAST|WEST|SOUTH|MIDWEST)\s+REGION/.test(nu);
      if (!isExplicitNCAA) return false;
    }
    if (EXTRA_MM_IDS.has(ev.id)) return true;
    if (nu.startsWith("MEN'S BASKETBALL CHAMPIONSHIP") || nu.includes('NCAA TOURNAMENT')) return true;
    if (/^(EAST|WEST|SOUTH|MIDWEST)\s+REGION(AL)?(\s|$)/.test(nu)) return true;
    if (/\bREGION(AL)?\b/.test(nu)) return true;
    if (nu.startsWith('CHAMPIONSHIP')) return true;
    if (nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return true;
    if (nu.includes('ELITE 8') || nu.includes('ELITE EIGHT') || nu.includes('REGIONAL FINAL')) return true;
    if (nu.includes('FINAL FOUR') || nu.includes('NATIONAL SEMIFINAL')) return true;
    if (nu.includes('NATIONAL CHAMPIONSHIP') || nu.includes('NCAA CHAMPIONSHIP')) return true;
    const MM_RDS = ['First Four','First Round','Second Round','Sweet 16','Sweet Sixteen','Elite Eight','Final Four'];
    return MM_RDS.some(r => note.includes(r));
  }

  function matchesSlug(ev) {
    const comp      = ev.competitions?.[0];
    const note      = (comp?.notes?.[0]?.headline || '').toUpperCase();
    const group     = (comp?.groups?.shortName    || '').toUpperCase();
    const groupFull = (comp?.groups?.name         || '').toUpperCase();
    if (isMM) return isMMEvent(ev);
    if (POSTSEASON_NAMES[slug]) {
      if (POSTSEASON_NAMES[slug].some(n =>
        note.startsWith(n) || group.startsWith(n) || group === n || groupFull.includes(n)
      )) return true;
      const SHORT_TOKENS = { cbi: /\bCBI\b/, cit: /\bCIT\b/ };
      if (SHORT_TOKENS[slug]) return SHORT_TOKENS[slug].test(note);
      return false;
    }
    if (isConf) {
      const CONF_MAP = {
        'acc':'ACC','big-ten':'BIG TEN','big-12':'BIG 12','sec':'SEC',
        'big-east':'BIG EAST','pac-12':'PAC-12','american':'AMERICAN',
        'mountain-west':'MOUNTAIN WEST','atlantic-10':'A-10',
        'wcc':'WCC','maac':'MAAC','mvc':'MVC','mac':'MAC','sun-belt':'SUN BELT',
        'cusa':'CUSA','wac':'WAC','ovc':'OVC','big-sky':'BIG SKY',
        'big-south':'BIG SOUTH','meac':'MEAC','swac':'SWAC',
        'patriot':'PATRIOT','nec':'NEC','america-east':'AM. EAST',
        'southland':'SOUTHLAND','asun':'ASUN','horizon':'HORIZON',
        'summit':'SUMMIT','caa':'CAA','socon':'SOCON','ivy':'IVY','big-west':'BIG WEST',
      };
      const confSlug = slug.replace(/-tournament$/, '');
      const espnName = (CONF_MAP[confSlug] || confSlug.replace(/-/g,' ')).toUpperCase();
      return note.includes(espnName + ' TOURNAMENT') ||
             note.includes(espnName + ' CHAMPIONSHIP') ||
             note.includes(espnName + ' PLAYOFF') ||
             group.startsWith(espnName);
    }
    return false;
  }

  function fetchDay(dateStr) {
    return new Promise(resolve => {
      const ePath = `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&groups=50&limit=100`;
      const opts = { hostname:'site.api.espn.com', path:ePath, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} };
      https.get(opts, r => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => {
          try { resolve((JSON.parse(body).events||[]).filter(matchesSlug)); }
          catch(e) { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
  }

  const allEvents = [];
  for (let i = 0; i < dates.length; i += 5) {
    const batch = await Promise.all(dates.slice(i, i+5).map(fetchDay));
    batch.forEach(evs => allEvents.push(...evs));
  }

  const seen = new Set();
  const events = allEvents.filter(ev => { if(seen.has(ev.id)) return false; seen.add(ev.id); return true; });

  const contests = events.map(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(t => t.homeAway === 'home');
    const away = comp?.competitors?.find(t => t.homeAway === 'away');
    const status = comp?.status;
    const broadcast = comp?.broadcasts?.[0]?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '';
    return {
      contestId:    ev.id,
      ncaaContestId: null,
      gameState:    status?.type?.state === 'in' ? 'I' : status?.type?.state === 'post' ? 'F' : 'P',
      startDate:    ev.date ? new Date(ev.date).toLocaleDateString('en-US',{month:'2-digit',day:'2-digit',year:'numeric',timeZone:'America/New_York'}) : '',
      startTime:    ev.date ? new Date(ev.date).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'America/New_York'}) : '',
      startTimeEpoch: ev.date ? Math.floor(new Date(ev.date).getTime()/1000) : 0,
      broadcasterName: broadcast,
      roundDescription: comp?.notes?.[0]?.headline || comp?.groups?.shortName || '',
      roundNumber:  0,
      teams: [home, away].filter(Boolean).map(t => ({
        isHome:       t.homeAway === 'home',
        seoname:      (t.team?.location||'').toLowerCase().replace(/[^a-z0-9]+/g,'-'),
        nameShort:    t.team?.shortDisplayName || t.team?.displayName || '?',
        name6Char:    t.team?.abbreviation || '',
        score:        t.score != null ? parseInt(t.score) : null,
        isWinner:     t.winner || false,
        seed:         (t.curatedRank?.current >= 1 && t.curatedRank?.current <= 16) ? t.curatedRank.current : null,
        color:        t.team?.color ? '#'+t.team.color : '#1a3fa8',
        espnLogoUrl:  t.team?.logo || '',
        conferenceSeo: '',
      })),
    };
  });

  contests.sort((a,b) => a.startTimeEpoch - b.startTimeEpoch);

  if (isConf && contests.some(c => !c.roundDescription.includes(' - '))) {
    const uniqueDates = [...new Set(contests.map(c => c.startDate))].sort();
    const ROUND_LABELS = {
      2: ['Final','Semifinals'],
      3: ['Final','Semifinals','1st Round'],
      4: ['Final','Semifinals','Quarterfinals','1st Round'],
      5: ['Final','Semifinals','Quarterfinals','2nd Round','1st Round'],
      6: ['Final','Semifinals','Quarterfinals','2nd Round','1st Round','Play-In'],
    };
    const roundNames = ROUND_LABELS[uniqueDates.length] || ROUND_LABELS[5];
    const dateToRound = {};
    [...uniqueDates].reverse().forEach((d, i) => {
      dateToRound[d] = roundNames[Math.min(i, roundNames.length - 1)];
    });
    contests.forEach(c => {
      if (!c.roundDescription.includes(' - ')) c.roundDescription = dateToRound[c.startDate] || c.roundDescription;
    });
  }

  const TNMT_NAMES = {
    'march-madness': 'March Madness',
    'nit':           'National Invitation Tournament',
    'cbi':           'College Basketball Invitational',
    'cit':           'CollegeInsider.com Tournament',
    'cbc':           'College Basketball Crown',
    'nbc':           'Basketball Classic',
  };

  return { contests, TNMT_NAMES };
}

// ─── Coverage scanner helpers ─────────────────────────────────────────────────

function _loadCoverageCache() {
  try {
    if (fs.existsSync(COVERAGE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COVERAGE_CACHE_FILE, 'utf8'));
      Object.assign(global._coverageCache, raw);
      console.log(`[coverage] loaded ${Object.keys(raw).length} cached entries`);
    }
  } catch(e) {
    console.warn('[coverage] cache load failed:', e.message);
  }
}

function _saveCoverageCache() {
  try {
    fs.writeFileSync(COVERAGE_CACHE_FILE, JSON.stringify(global._coverageCache));
    console.log(`[coverage] saved ${Object.keys(global._coverageCache).length} entries to disk`);
  } catch(e) {
    console.warn('[coverage] cache save failed:', e.message);
  }
}

function _loadHistoricalPhotoCache() {
  try {
    if (fs.existsSync(HISTORICAL_PHOTO_CACHE_FILE)) {
      const raw   = JSON.parse(fs.readFileSync(HISTORICAL_PHOTO_CACHE_FILE, 'utf8'));
      Object.assign(historicalPhotoCache, raw);
      const years  = Object.keys(raw).length;
      const teams  = Object.values(raw).reduce((n, y) => n + Object.keys(y).length, 0);
      const photos = Object.values(raw).reduce((n, y) =>
        n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
      console.log(`[historical-photo-cache] loaded ${years} years, ${teams} teams, ${photos} photos from disk`);
    }
  } catch(e) {
    console.warn('[historical-photo-cache] load failed:', e.message);
  }
}

function _saveHistoricalPhotoCache() {
  try {
    fs.writeFileSync(HISTORICAL_PHOTO_CACHE_FILE, JSON.stringify(historicalPhotoCache));
    const years  = Object.keys(historicalPhotoCache).length;
    const teams  = Object.values(historicalPhotoCache).reduce((n, y) => n + Object.keys(y).length, 0);
    const photos = Object.values(historicalPhotoCache).reduce((n, y) =>
      n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
    console.log(`[historical-photo-cache] saved ${years} years, ${teams} teams, ${photos} photos to disk`);
  } catch(e) {
    console.warn('[historical-photo-cache] save failed:', e.message);
  }
}

function _loadSidearmPhotoCache() {
  try {
    if (fs.existsSync(SIDEARM_PHOTO_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SIDEARM_PHOTO_CACHE_FILE, 'utf8'));
      Object.assign(sidearmPhotoCache, raw);
      const years  = Object.keys(raw).length;
      const teams  = Object.values(raw).reduce((n, y) => n + Object.keys(y).length, 0);
      const photos = Object.values(raw).reduce((n, y) =>
        n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
      console.log(`[sidearm-photo-cache] loaded ${years} years, ${teams} teams, ${photos} photos from disk`);
    }
  } catch(e) {
    console.warn('[sidearm-photo-cache] load failed:', e.message);
  }
}

function _saveSidearmPhotoCache() {
  try {
    fs.writeFileSync(SIDEARM_PHOTO_CACHE_FILE, JSON.stringify(sidearmPhotoCache));
    const years  = Object.keys(sidearmPhotoCache).length;
    const teams  = Object.values(sidearmPhotoCache).reduce((n, y) => n + Object.keys(y).length, 0);
    const photos = Object.values(sidearmPhotoCache).reduce((n, y) =>
      n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
    console.log(`[sidearm-photo-cache] saved ${years} years, ${teams} teams, ${photos} photos to disk`);
  } catch(e) {
    console.warn('[sidearm-photo-cache] save failed:', e.message);
  }
}

function _loadWaybackPhotoCache() {
  try {
    if (fs.existsSync(WAYBACK_PHOTO_CACHE_FILE)) {
      const raw    = JSON.parse(fs.readFileSync(WAYBACK_PHOTO_CACHE_FILE, 'utf8'));
      Object.assign(waybackPhotoCache, raw);
      const years  = Object.keys(raw).length;
      const teams  = Object.values(raw).reduce((n, y) => n + Object.keys(y).length, 0);
      const photos = Object.values(raw).reduce((n, y) =>
        n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
      console.log(`[wayback-photo-cache] loaded ${years} years, ${teams} teams, ${photos} photos from disk`);
    }
  } catch(e) {
    console.warn('[wayback-photo-cache] load failed:', e.message);
  }
}

function _saveWaybackPhotoCache() {
  try {
    fs.writeFileSync(WAYBACK_PHOTO_CACHE_FILE, JSON.stringify(waybackPhotoCache));
    const years  = Object.keys(waybackPhotoCache).length;
    const teams  = Object.values(waybackPhotoCache).reduce((n, y) => n + Object.keys(y).length, 0);
    const photos = Object.values(waybackPhotoCache).reduce((n, y) =>
      n + Object.values(y).reduce((m, t) => m + Object.keys(t).length, 0), 0);
    console.log(`[wayback-photo-cache] saved ${years} years, ${teams} teams, ${photos} photos to disk`);
  } catch(e) {
    console.warn('[wayback-photo-cache] save failed:', e.message);
  }
}

// Probe a single ESPN game: check stats/pbp availability and player photo coverage.
// Uses the lightweight summary endpoint rather than fetching full boxscores.
async function _probeCoverageGame(gameId) {
  try {
    const data = await espnGet(
      `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gameId}`
    );
    const hasStats  = !!(data.boxscore?.players?.length);
    const hasPbp    = Array.isArray(data.plays) && data.plays.length > 2;
    const players   = (data.boxscore?.players || [])
      .flatMap(t => (t.statistics?.[0]?.athletes || []));
    const withPhoto = players.filter(p => p.athlete?.headshot?.href).length;
    return { hasStats, hasPbp, playerCount: players.length, withPhoto };
  } catch(e) {
    return { hasStats: false, hasPbp: false, playerCount: 0, withPhoto: 0 };
  }
}

// Scan one tournament+year: fetch game list, sample up to 5 games for depth metrics.
async function _scanTournamentYear(slug, year) {
  const key    = `${slug}:${year}`;
  const cached = global._coverageCache[key];
  if (cached && Date.now() - (cached.ts || 0) < 43200000) return cached.record;

  const tourn = SCAN_TOURN.find(t => t.slug === slug);
  if (!tourn) return null;

  const noData = {
    tournament: tourn.name, slug, year,
    games: 0, gamesWithStats: 0, gamesWithPbp: 0,
    players: 0, playersWithPhoto: 0,
    photoCoveragePct: 0, pbpCoveragePct: 0,
    status: 'no_data',
  };

  if (year < tourn.minYear) {
    global._coverageCache[key] = { record: noData, ts: Date.now() };
    console.log(`[coverage-cache:set] key=${key} status=no_data (before minYear)`);
    return noData;
  }

  let contests = [];
  try {
    const result = await _internalFetchTournamentContests(slug, year);
    contests = result.contests || [];
  } catch(e) {
    console.warn(`[coverage] ${slug}:${year}: ${e.message}`);
    global._coverageCache[key] = { record: { ...noData }, ts: Date.now() };
    console.log(`[coverage-cache:set] key=${key} status=no_data (fetch error)`);
    return { ...noData };
  }

  const games = contests.length;
  if (games === 0) {
    global._coverageCache[key] = { record: noData, ts: Date.now() };
    console.log(`[coverage-cache:set] key=${key} status=no_data (0 games found)`);
    return noData;
  }

  const completed   = contests.filter(c => c.gameState === 'F');
  const sample      = completed.slice(0, 5);
  let statsHits = 0, pbpHits = 0, totalPlayers = 0, photoHits = 0;

  for (const game of sample) {
    await new Promise(r => setTimeout(r, 400));
    const p = await _probeCoverageGame(game.contestId);
    if (p.hasStats) statsHits++;
    if (p.hasPbp)   pbpHits++;
    totalPlayers += p.playerCount;
    photoHits    += p.withPhoto;
  }

  const n         = sample.length || 1;
  const statsFrac = statsHits / n;
  const pbpFrac   = pbpHits   / n;
  const photoFrac = totalPlayers > 0 ? photoHits / totalPlayers : 0;

  const estGamesWithStats   = Math.round(statsFrac * games);
  const estGamesWithPbp     = Math.round(pbpFrac   * games);
  const avgPlayersPerGame   = totalPlayers / n;
  const estPlayers          = Math.round(avgPlayersPerGame * Math.min(games, 16));
  const estPlayersWithPhoto = Math.round(photoFrac * estPlayers);
  const photoCoveragePct    = Math.round(photoFrac * 100);
  const pbpCoveragePct      = Math.round(pbpFrac   * 100);

  // Small tournaments (maxGames ≤ 6) use a lower game-count threshold for "good"
  const gameThreshold = tourn.maxGames <= 6 ? 0.4 : 0.6;
  let status;
  if (games === 0) {
    status = 'no_data';
  } else if ((games / tourn.maxGames) >= gameThreshold && statsFrac >= 0.6) {
    status = 'good';
  } else {
    status = 'partial';
  }

  const record = {
    tournament: tourn.name, slug, year,
    games,
    gamesWithStats:    estGamesWithStats,
    gamesWithPbp:      estGamesWithPbp,
    players:           estPlayers,
    playersWithPhoto:  estPlayersWithPhoto,
    photoCoveragePct,
    pbpCoveragePct,
    status,
  };
  global._coverageCache[key] = { record, ts: Date.now() };
  console.log(`[coverage-cache:set] key=${key} status=${status} games=${games}`);
  _saveCoverageCache();
  return record;
}

// Background scan — processes one tournament/year at a time with paced delays.
async function _runCoverageScan(slugs, years) {
  if (_coverageScanActive) return;
  _coverageScanActive = true;
  try {
    for (const year of years) {
      for (const slug of slugs) {
        const key    = `${slug}:${year}`;
        const cached = global._coverageCache[key];
        if (cached && Date.now() - (cached.ts || 0) < 43200000) continue;
        console.log(`[coverage-scan] ${slug} ${year}`);
        await _scanTournamentYear(slug, year);
        await new Promise(r => setTimeout(r, 700));
      }
    }
    console.log('[coverage-scan] complete');
  } catch(e) {
    console.error('[coverage-scan]', e.message);
  } finally {
    _coverageScanActive = false;
  }
}

// Load persisted coverage data on startup
_loadCoverageCache();
_loadHistoricalPhotoCache();
_loadSidearmPhotoCache();
_loadWaybackPhotoCache();
_loadPDFPhotoCache();

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

  // /api/espn/tournament-games?slug=march-madness&season=2026
  // Returns all games for a given tournament and season year, scanned day-by-day from ESPN.
  if (pathname === '/api/espn/tournament-games') {
    try {
      const slug   = (query.slug   || 'march-madness').toLowerCase();
      const season = parseInt(query.season || new Date().getFullYear(), 10);
      const { contests, TNMT_NAMES } = await _internalFetchTournamentContests(slug, season);
      const name = TNMT_NAMES[slug] || slug.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
      return sendJSON(res, 200, { ok:true, slug, season, name, total:contests.length, contests });
    } catch(e) {
      console.error('[/api/espn/tournament-games]', e.message);
      return sendJSON(res, 500, { ok:false, error:e.message });
    }
  }


  // /api/espn/conf-standings?slug=acc-tournament&season=2024
  // Returns conference standings. Checks manual-standings.json override first (for seasons
  // where ESPN's historical data is known to be incomplete), then falls back to ESPN API.
  if (pathname === '/api/espn/conf-standings') {
    try {
      const slug   = (query.slug   || '').toLowerCase();
      const season = parseInt(query.season || new Date().getFullYear(), 10);

      // ── Manual override lookup ──────────────────────────────────────────────
      // Slug format: 'acc-tournament' → conf key 'acc'
      const confKey = slug.replace(/-tournament$/, '');
      try {
        const overridePath = path.join(__dirname, 'data', 'manual-standings.json');
        const mapPath      = path.join(__dirname, 'data', 'team-id-map.json');
        const overrideRaw  = fs.readFileSync(overridePath, 'utf8');
        const overrides    = JSON.parse(overrideRaw);
        const manual = overrides?.['mens-basketball']?.[confKey]?.[String(season)];
        if (manual && Array.isArray(manual) && manual.length) {

          // Load team-id-map for logo resolution
          let TEAM_ID_MAP = {};
          try { TEAM_ID_MAP = JSON.parse(fs.readFileSync(mapPath, 'utf8')); } catch(_) {}

          // Normalize team name to map key: lowercase, remove punctuation, collapse spaces
          function normalizeTeamName(name) {
            return (name || '').toLowerCase().replace(/[.'&]/g, '').replace(/\s+/g, ' ').trim();
          }
          // Also try "X state" → "X st" fallback
          function lookupTeamId(name) {
            const k = normalizeTeamName(name);
            if (TEAM_ID_MAP[k]) return TEAM_ID_MAP[k];
            const alt = k.replace(/ state$/, ' st');
            return (alt !== k && TEAM_ID_MAP[alt]) ? TEAM_ID_MAP[alt] : null;
          }

          function parseRec(s) { const m=(s||'').match(/^(\d+)-(\d+)/); return m?{w:+m[1],l:+m[2]}:{w:0,l:0}; }
          const lr = parseRec(manual[0]?.conf);

          const rows = manual.map(r => {
            const teamId = lookupTeamId(r.team);
            const rec    = parseRec(r.conf);
            const gb     = ((lr.w - rec.w) + (rec.l - lr.l)) / 2;
            return {
              rank:      r.rank,
              teamId:    teamId || '',
              teamName:  r.team,
              teamShort: r.team,
              teamLogo:  teamId ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${teamId}.png` : '',
              teamColor: '#1a3fa8',
              overall:   r.overall || '',
              conf:      r.conf    || '',
              gb:        gb <= 0 ? '-' : String(gb),
            };
          });

          return sendJSON(res, 200, { ok: true, conf: confKey.toUpperCase(), season, rows, source: 'manual' });
        }
      } catch(_) { /* file missing or key absent — fall through to ESPN */ }

      const CONF_GROUP = {
        'america-east-tournament':1, 'acc-tournament':2,
        'atlantic-10-tournament':3,  'big-east-tournament':4,
        'big-sky-tournament':5,      'big-south-tournament':6,
        'big-ten-tournament':7,      'big-12-tournament':8,
        'big-west-tournament':9,     'caa-tournament':10,
        'cusa-tournament':11,        'ivy-tournament':12,
        'maac-tournament':13,        'mac-tournament':14,
        'meac-tournament':16,        'mvc-tournament':18,
        'nec-tournament':19,         'ovc-tournament':20,
        'pac-12-tournament':21,      'patriot-tournament':22,
        'sec-tournament':23,         'socon-tournament':24,
        'southland-tournament':25,   'swac-tournament':26,
        'sun-belt-tournament':27,    'wcc-tournament':29,
        'wac-tournament':30,         'mountain-west-tournament':44,
        'horizon-tournament':45,     'asun-tournament':46,
        'summit-tournament':49,      'american-tournament':62,
      };

      const groupId = CONF_GROUP[slug];
      if (!groupId) return sendJSON(res, 404, { ok: false, error: 'Unknown conference slug' });

      const standingsPath = `/apis/v2/sports/basketball/mens-college-basketball/standings?group=${groupId}&season=${season}`;
      const data = await new Promise((resolve, reject) => {
        https.get({ hostname:'site.api.espn.com', path:standingsPath, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} }, r => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { reject(e); }
          });
        }).on('error', reject);
      });

      const confName = data?.name || '';
      const entries  = data?.standings?.entries || [];

      function getStat(stats, abbr) {
        const s = stats.find(x => x.abbreviation === abbr);
        return s ? { value: s.value, display: s.displayValue } : null;
      }

      // Parse "W-L" conference record string → { w, l, pct }
      function parseConfRec(str) {
        const m = (str || '').match(/^(\d+)-(\d+)/);
        if (!m) return { w: 0, l: 0, pct: 0 };
        const w = parseInt(m[1]), l = parseInt(m[2]);
        return { w, l, pct: (w + l) > 0 ? w / (w + l) : 0 };
      }

      const rows = entries.map(e => {
        const stats  = e.stats || [];
        const seed   = getStat(stats, 'SEED')?.value ?? 0;
        const season = getStat(stats, 'Season')?.display || '';
        const conf   = getStat(stats, 'VS CONF')?.display || '';
        return {
          seed,
          teamId:    e.team?.id    || '',
          teamName:  e.team?.displayName || '',
          teamShort: e.team?.shortDisplayName || e.team?.name || '',
          teamLogo:  e.team?.logos?.[0]?.href || '',
          teamColor: e.team?.color ? '#' + e.team.color : '#1a3fa8',
          overall: season,
          conf,
          _rec:    parseConfRec(conf),
          _ovRec:  parseConfRec(season),
        };
      });

      // Sort best-to-worst:
      // 1. Teams with ESPN seed: seed ascending (1 = best)
      // 2. Teams without seed (pre-2010): conference win-% descending
      // 3. Tiebreak: overall win-% descending (e.g. Virginia 17-12 > Georgia Tech 15-16 when both 7-9)
      // 4. Final tiebreak: conference win count descending
      rows.sort((a, b) => {
        const sa = a.seed === 0 ? 999 : a.seed;
        const sb = b.seed === 0 ? 999 : b.seed;
        if (sa !== sb) return sa - sb;
        if (Math.abs(a._rec.pct - b._rec.pct) > 0.0001) return b._rec.pct - a._rec.pct;
        if (Math.abs(a._ovRec.pct - b._ovRec.pct) > 0.0001) return b._ovRec.pct - a._ovRec.pct;
        return b._rec.w - a._rec.w;
      });

      // Compute conference GB from the leader (index 0 after sort) and assign rank
      const leaderRec = rows[0]?._rec || { w: 0, l: 0 };
      rows.forEach((r, idx) => {
        const gb = ((leaderRec.w - r._rec.w) + (r._rec.l - leaderRec.l)) / 2;
        r.gb   = gb <= 0 ? '-' : String(gb);
        r.rank = idx + 1;
        delete r._rec;
        delete r._ovRec;
      });

      return sendJSON(res, 200, { ok: true, conf: confName, season, rows, source: 'espn' });

    } catch(e) {
      console.error('[/api/espn/conf-standings]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/tournament-years?slug=cit
  // Returns years [minYear..currentYear] that have actual ESPN game data for the tournament.
  // Results are cached in memory for 6 hours to avoid hammering the ESPN API.
  if (pathname === '/api/espn/tournament-years') {
    try {
      const slug = (query.slug || 'march-madness').toLowerCase();

      if (!global._tournYearsCache) global._tournYearsCache = {};
      const cached = global._tournYearsCache[slug];
      if (cached && Date.now() - cached.ts < 21600000) {
        return sendJSON(res, 200, { ok: true, years: cached.years });
      }

      const MIN_YEAR = {
        'march-madness':2002,'nit':2002,'cbi':2008,'cit':2009,'cbc':2025,'nbc':2021,
        // conference tournaments (all started ≈2002; american started 2014)
        'american-tournament':2014,
      };
      const minYear = MIN_YEAR[slug] ?? 2002;
      const curYear = new Date().getFullYear();

      // Matching logic mirrors matchesSlug in tournament-games
      const PS_NAMES = {
        'nit': ['NIT','NATIONAL INVITATION TOURNAMENT'],
        'cbi': ['CBI','COLLEGE BASKETBALL INVITATIONAL','ROMAN CBI'],
        'cit': ['CIT','COLLEGE INSIDER TOURNAMENT','COLLEGEINSIDER.COM TOURNAMENT','COLLEGEINSIDER.COM'],
        'cbc': ['CBC','COLLEGE BASKETBALL CROWN'],
        'nbc': ['BASKETBALL CLASSIC'],
      };
      const SHORT_RX = { cbi: /\bCBI\b/, cit: /\bCIT\b/ };
      const MM_KW = ['FIRST ROUND','SECOND ROUND','FIRST FOUR','SWEET 16','ELITE EIGHT','FINAL FOUR','CHAMPIONSHIP','REGIONAL'];

      // Same ESPN group.shortName mapping as CONF_MAP in tournament-games
      const CONF_NAME_MAP = {
        'acc':'ACC','big-ten':'BIG TEN','big-12':'BIG 12','sec':'SEC',
        'big-east':'BIG EAST','pac-12':'PAC-12',
        'american':'AMERICAN','mountain-west':'MOUNTAIN WEST',
        'atlantic-10':'A-10','wcc':'WCC','maac':'MAAC',
        'mvc':'MVC','mac':'MAC','sun-belt':'SUN BELT',
        'cusa':'CUSA','wac':'WAC','ovc':'OVC','big-sky':'BIG SKY',
        'big-south':'BIG SOUTH','meac':'MEAC','swac':'SWAC',
        'patriot':'PATRIOT','nec':'NEC','america-east':'AM. EAST',
        'southland':'SOUTHLAND','asun':'ASUN','horizon':'HORIZON',
        'summit':'SUMMIT','caa':'CAA','socon':'SOCON',
        'ivy':'IVY','big-west':'BIG WEST',
      };
      const isConf = slug.endsWith('-tournament') && slug !== 'march-madness';
      const confKey = isConf ? slug.replace(/-tournament$/, '') : '';
      const confEspnName = isConf ? (CONF_NAME_MAP[confKey] || confKey.replace(/-/g,' ').toUpperCase()) : '';

      function hasGame(ev) {
        const comp = ev.competitions?.[0];
        const note  = (comp?.notes?.[0]?.headline || '').toUpperCase();
        const grp   = (comp?.groups?.shortName    || '').toUpperCase();
        const gFull = (comp?.groups?.name         || '').toUpperCase();
        if (slug === 'march-madness') return MM_KW.some(k => note.includes(k));
        if (PS_NAMES[slug]) {
          if (PS_NAMES[slug].some(n => note.startsWith(n) || grp.startsWith(n) || gFull.includes(n))) return true;
          return SHORT_RX[slug]?.test(note) ?? false;
        }
        if (isConf) {
          return note.includes(confEspnName + ' TOURNAMENT') ||
                 note.includes(confEspnName + ' CHAMPIONSHIP') ||
                 note.includes(confEspnName + ' PLAYOFF') ||
                 grp.startsWith(confEspnName);
        }
        return false;
      }

      function probeDate(dateStr) {
        return new Promise(resolve => {
          const ePath = `/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${dateStr}&groups=50&limit=100`;
          https.get({ hostname:'site.api.espn.com', path:ePath, headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'} }, r => {
            let body = '';
            r.on('data', c => body += c);
            r.on('end', () => {
              try { resolve((JSON.parse(body).events || []).some(hasGame)); }
              catch(e) { resolve(false); }
            });
          }).on('error', () => resolve(false));
        });
      }

      // Conference tournaments: span Feb 27 – Mar 17. Five dates cover all conferences.
      // Postseason (NIT/CBI/CIT): Mar 19 – Apr 5.
      const PROBE_MMDD = isConf
        ? ['0305', '0308', '0311', '0314', '0317']
        : ['0319', '0320', '0322', '0325', '0401'];

      // Build year list and check in batches of 15 to avoid overwhelming ESPN
      const yearList = [];
      for (let y = minYear; y <= curYear; y++) yearList.push(y);

      const valid = [];
      for (let i = 0; i < yearList.length; i += 15) {
        const batch = yearList.slice(i, i + 15);
        const batchResults = await Promise.all(
          batch.map(async y => {
            const hits = await Promise.all(PROBE_MMDD.map(d => probeDate(String(y) + d)));
            return hits.some(Boolean) ? y : null;
          })
        );
        batchResults.forEach(y => { if (y !== null) valid.push(y); });
      }

      valid.sort((a, b) => a - b);
      global._tournYearsCache[slug] = { years: valid, ts: Date.now() };
      return sendJSON(res, 200, { ok: true, years: valid });

    } catch(e) {
      console.error('[/api/espn/tournament-years]', e.message);
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

  // /api/espn/team?teamId=57&sport=basketball/mens-college-basketball
  if (pathname === '/api/espn/team') {
    try {
      const teamId = query.teamId;
      const sport  = query.sport || 'basketball/mens-college-basketball';
      if (!teamId) return sendJSON(res, 400, { ok: false, error: 'teamId required' });
      const data = await espnGet(`/apis/site/v2/sports/${sport}/teams/${teamId}`);
      return sendJSON(res, 200, { ok: true, team: data.team || null });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/team-schedule?teamId=57&season=2026&sport=...
  if (pathname === '/api/espn/team-schedule') {
    try {
      const teamId = query.teamId;
      const season = query.season || '';
      const sport  = query.sport || 'basketball/mens-college-basketball';
      if (!teamId) return sendJSON(res, 400, { ok: false, error: 'teamId required' });
      const qs = season ? `?season=${season}` : '';
      const data = await espnGet(`/apis/site/v2/sports/${sport}/teams/${teamId}/schedule${qs}`);
      return sendJSON(res, 200, { ok: true, events: data.events || [], team: data.team || null });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/team-stats?teamId=57&season=2026&sport=...
  if (pathname === '/api/espn/team-stats') {
    try {
      const teamId = query.teamId;
      const season = query.season || '';
      const sport  = query.sport || 'basketball/mens-college-basketball';
      if (!teamId) return sendJSON(res, 400, { ok: false, error: 'teamId required' });
      const qs = season ? `?season=${season}` : '';
      const data = await espnGet(`/apis/site/v2/sports/${sport}/teams/${teamId}/statistics${qs}`);
      return sendJSON(res, 200, { ok: true, splits: data.splits || null, team: data.team || null });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/team-roster?teamId=57&season=2026&sport=...
  if (pathname === '/api/espn/team-roster') {
    try {
      const teamId = query.teamId;
      const season = query.season || '';
      const sport  = query.sport || 'basketball/mens-college-basketball';
      if (!teamId) return sendJSON(res, 400, { ok: false, error: 'teamId required' });
      const qs = season ? `?season=${season}` : '';
      const data = await espnGet(`/apis/site/v2/sports/${sport}/teams/${teamId}/roster${qs}`);
      return sendJSON(res, 200, {
        ok: true,
        athletes: data.athletes || [],
        coach: data.coach || null,
        team: data.team || null,
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

  // /api/pbp/resolve — unified PBP resolver (ESPN first, NCAA fallback)
  // Params: gameId, ncaaContestId, homeTeamId, homeScore, awayScore
  if (pathname === '/api/pbp/resolve') {
    try {
      const gameId        = query.gameId        || null;
      const ncaaContestId = query.ncaaContestId || null;
      const homeTeamId    = query.homeTeamId    || null;
      const officialHome  = query.homeScore != null ? parseInt(query.homeScore) : null;
      const officialAway  = query.awayScore != null ? parseInt(query.awayScore) : null;

      if (!gameId && !ncaaContestId) {
        return sendJSON(res, 400, { ok: false, error: 'gameId or ncaaContestId required' });
      }

      let source = 'none', events = [];

      // Step 1: ESPN PBP (primary)
      if (gameId) {
        try {
          const espnData = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gameId}`
          );

          const rawPlays = espnData.plays || [];

          // Auto-detect homeTeamId from ESPN summary if frontend didn't send one
          // (happens when bracketData teams lack ESPN ID — e.g. ncaaOrgId is undefined)
          let effectiveHomeTeamId = homeTeamId;
          if (!effectiveHomeTeamId) {
            const hComp = (espnData.header?.competitions?.[0]?.competitors || [])
              .find(t => t.homeAway === 'home');
            const hTeam = (espnData.boxscore?.teams || [])
              .find(t => t.homeAway === 'home');
            effectiveHomeTeamId = String(hComp?.team?.id || hTeam?.team?.id || '');
            if (effectiveHomeTeamId) {
              console.log(`[ESPN] homeTeamId auto-detected from summary: ${effectiveHomeTeamId}`);
            }
          }

          if (rawPlays.length > 0) {
            events = normalizeEspnPbp(rawPlays, effectiveHomeTeamId);
            source = 'espn';
          }
        } catch (e) {
          console.error('[pbp/resolve] ESPN failed:', e.message);
        }
      }

      // Step 2: NCAA PBP fallback
      if (source === 'none' && ncaaContestId) {
        try {
          const ncaaData = await ncaaFetch('NCAA_GetGamecenterPbpBasketballById_web', HASHES.pbp, {
            contestId: String(ncaaContestId), staticTestEnv: null,
          });
          const periods = ncaaData?.data?.playbyplay?.periods || [];
          const total   = periods.reduce((s, p) => s + (p.playbyplayStats || []).length, 0);
          if (total > 0) {
            events = normalizeNcaaPbp(periods, homeTeamId);
            source = 'ncaa';
          }
        } catch (e) {
          console.error('[pbp/resolve] NCAA failed:', e.message);
        }
      }

      // Step 3: Coverage rating
      const coverage = events.length >= 100 ? 'full' : events.length >= 20 ? 'partial' : 'none';

      // Step 4: Derive stats from normalized events
      let stats      = null;
      let validation = { status: 'unverified', note: null };

      if (source !== 'none' && events.length > 0) {
        stats = deriveStatsFromPbp(events);

        // Step 5: Validate derived score vs official scoreboard
        if (officialHome != null && officialAway != null) {
          const dH   = stats.derivedScore.home;
          const dA   = stats.derivedScore.away;
          const diff = Math.abs(dH - officialHome) + Math.abs(dA - officialAway);
          validation = diff === 0
            ? { status: 'ok',       note: null }
            : { status: 'mismatch', note: `PBP: ${dH}-${dA} vs Official: ${officialHome}-${officialAway} (${diff} pt gap)` };
        }
      }

      return sendJSON(res, 200, {
        ok: true,
        source,
        coverage,
        events,
        stats,
        validation,
        qualityFlags: {
          pbpSource:        source,
          pbpCoverage:      coverage,
          statsAvailable:   stats !== null,
          validationStatus: validation.status,
          validationNote:   validation.note,
        },
      });
    } catch (e) {
      console.error('[/api/pbp/resolve]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // ── CollegeOnTV Rating helpers ────────────────────────────────────────────
  // Player rating: 0–9.8 per-game impact score from PBP-derived stats.
  // Coefficients are calibrated so that 9.8 requires a historically elite game.
  function calculateCollegeOnTvRating(p, ctx) {
    let r = 6.0;
    r += (p.pts   || 0) * 0.045;
    r += (p.reb   || 0) * 0.080;
    r += (p.oreb  || 0) * 0.090;
    r += (p.ast   || 0) * 0.100;
    r += (p.stl   || 0) * 0.180;
    r += (p.blk   || 0) * 0.180;
    r += (p.fg3m  || 0) * 0.025;
    r += (p.ftm   || 0) * 0.010;
    r -= (p.to    || 0) * 0.160;
    r -= ((p.fga  || 0) - (p.fgm  || 0)) * 0.035;
    r -= ((p.fta  || 0) - (p.ftm  || 0)) * 0.050;
    r -= (p.fouls || 0) * 0.025;
    if ((p.fga  || 0) >= 6 && (p.fgm  || 0) / p.fga  >= 0.55) r += 0.15;
    if ((p.fg3a || 0) >= 4 && (p.fg3m || 0) / p.fg3a >= 0.45) r += 0.10;
    if ((p.fta  || 0) >= 4 && (p.ftm  || 0) / p.fta  >= 0.90) r += 0.08;
    if (ctx && ctx.won) r += 0.08;
    return Math.round(Math.max(3.0, Math.min(9.8, r)) * 100) / 100;
  }
  // Team rating: 0–10 aggregate from per-game team averages.
  function calculateTeamRating(t) {
    if (!t.games) return null;
    const ppg   = t.pts / t.games;
    const apg   = t.ast / t.games;
    const topg  = t.to  / t.games;
    const spg   = t.stl / t.games;
    const bpg   = t.blk / t.games;
    const fgPct = t.fga > 0 ? t.fgm / t.fga : 0;
    let r = 6.0;
    r += (ppg  - 68)   * 0.04;
    r += (fgPct - 0.43) * 5.0;
    r += (apg  - 12)   * 0.05;
    r += (spg + bpg - 7) * 0.06;
    r -= (topg - 12)   * 0.06;
    return Math.round(Math.max(3.0, Math.min(10.0, r)) * 100) / 100;
  }

  // Shared helper: collect + resolve all player photos for a tournament.
  // Returns { players, sourceBreakdown, withPhoto, missingPlayers }.
  async function _resolveTournamentPlayerPhotos(slug, year) {
    const { contests } = await _internalFetchTournamentContests(slug, year);
    const completed = contests.filter(c => c.gameState === 'F').slice(0, 100);

    // ── Collect players from ESPN boxscores ──────────────────────────────────
    const playerMap = {};
    for (let i = 0; i < completed.length; i += 5) {
      const batch = completed.slice(i, i + 5);
      await Promise.allSettled(batch.map(async ({ contestId }) => {
        try {
          const summary = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${contestId}`
          );
          for (const teamEntry of (summary.boxscore?.players || [])) {
            const teamName = teamEntry.team?.shortDisplayName || teamEntry.team?.displayName || '?';
            for (const sg of (teamEntry.statistics || [])) {
              for (const entry of (sg.athletes || [])) {
                const ath = entry.athlete;
                if (!ath?.displayName || !isRealPlayerName(ath.displayName, teamName)) continue;
                const key = `${_normPhoto(ath.displayName)}:${_normPhoto(teamName)}`;
                if (playerMap[key]) continue;

                const espnId   = String(ath.id || '');
                const directHs = ath.headshot?.href || null;
                const headshot = directHs || (espnId
                  ? `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${espnId}.png`
                  : null);
                playerMap[key] = {
                  name: ath.displayName, team: teamName,
                  espnId: espnId || null,
                  headshot,
                  source: directHs ? 'espn_direct' : (espnId ? 'cdn' : 'none'),
                };
              }
            }
          }
        } catch(_) { /* skip failed games */ }
      }));
    }

    // ── Validate CDN-constructed headshots ───────────────────────────────────
    // When a player's college CDN photo is gone (common for 2008-era players),
    // immediately try the NBA CDN with the same espnId before falling through to
    // the full backfill chain. This catches players who went on to the NBA without
    // requiring an extra ESPN search round-trip.
    const allPlayers = Object.values(playerMap);
    const cdnPlayers = allPlayers.filter(p => p.source === 'cdn' && p.headshot);
    for (let i = 0; i < cdnPlayers.length; i += 5) {
      if (i > 0) await new Promise(r => setTimeout(r, 150));
      await Promise.allSettled(cdnPlayers.slice(i, i + 5).map(async p => {
        const valid = await _validateImageUrl(p.headshot);
        if (!valid) {
          if (p.espnId) {
            const nbaUrl = await _validatedNbaCdnUrl(p.espnId);
            if (nbaUrl) { p.headshot = nbaUrl; p.source = 'espn_nba'; return; }
          }
          p.headshot = null; p.source = 'none';
        }
      }));
    }

    // ── Check playerPhotoCache for prior hits ────────────────────────────────
    for (const p of allPlayers) {
      if (p.headshot) continue;
      const cacheKey = `${year}:${_normPhoto(p.team)}:${_normPhoto(p.name)}`;
      const cached   = playerPhotoCache[cacheKey];
      if (cached && cached.photoUrl) {
        p.headshot = cached.photoUrl;
        p.source   = cached.source;
      } else if (cached && (cached.source === 'unrecoverable_2008' || cached.source === 'name_only_old_season')) {
        p.source = cached.source;
      }
    }

    // ── Fill gaps: ESPN search + historical/current athletics ────────────────
    const stillMissing = allPlayers.filter(p => !p.headshot && p.source !== 'unrecoverable_2008' && p.source !== 'name_only_old_season');
    for (let i = 0; i < stillMissing.length; i += 5) {
      const batch = stillMissing.slice(i, i + 5);
      await Promise.allSettled(batch.map(async (p) => {
        const hit = await _backfillPlayerPhoto(p.name, p.team, year);
        if (hit && hit.photoUrl) {
          p.headshot = hit.photoUrl;
          p.source   = hit.source;
          const cacheKey = `${year}:${_normPhoto(p.team)}:${_normPhoto(p.name)}`;
          playerPhotoCache[cacheKey] = {
            ok: true, name: p.name, team: p.team,
            source: hit.source, photoUrl: hit.photoUrl,
            ts: Date.now(),
          };
        } else if (hit) {
          p.source = hit.source;
          const cacheKey = `${year}:${_normPhoto(p.team)}:${_normPhoto(p.name)}`;
          playerPhotoCache[cacheKey] = {
            ok: false, name: p.name, team: p.team,
            source: hit.source, photoUrl: null,
            ts: Date.now(),
          };
        }
      }));
    }

    // ── Build summary ────────────────────────────────────────────────────────
    const withPhoto = allPlayers.filter(p => p.headshot);
    const missingPlayers = allPlayers.filter(p => !p.headshot);
    const sourceBreakdown = {};
    allPlayers.forEach(p => {
      sourceBreakdown[p.source] = (sourceBreakdown[p.source] || 0) + 1;
    });

    return { players: allPlayers, gamesScanned: completed.length, sourceBreakdown, withPhoto, missingPlayers };
  }

  // /api/sidearm-game-photos?feedUrl=URL&year=2008[&team=TeamName]
  // Ingest player photos from a SIDEARM livestats feed into sidearmPhotoCache.
  // Two strategies:
  //   1. Direct:  Player.Photo field in the feed (populated for some schools)
  //   2. Domain:  scrape the feed URL's hostname for a historical basketball roster
  // The ingested photos become available as source "sidearm" in _backfillPlayerPhoto.
  if (pathname === '/api/sidearm-game-photos') {
    try {
      const feedUrl   = (query.feedUrl || '').trim();
      const yearParam = parseInt(query.year || '', 10);
      if (!feedUrl) return sendJSON(res, 400, { ok: false, error: 'feedUrl required' });
      if (!yearParam || yearParam < 2000 || yearParam > 2099) {
        return sendJSON(res, 400, { ok: false, error: 'valid year required (e.g. year=2008)' });
      }

      // ── Fetch + normalize via SIDEARM engine (single source of truth in C:\sb) ──
      let engineRoster;
      try {
        engineRoster = await fetchSidearmRoster(feedUrl);
      } catch(e) {
        return sendJSON(res, 502, { ok: false, error: `SIDEARM engine error: ${e.message}` });
      }

      const yearKey = String(yearParam);
      let fromFeed = 0, fromRoster = 0;

      // ── Strategy 1: Player.Photo embedded in the feed (engine surfaces as photoUrl) ─
      for (const player of engineRoster) {
        if (!player.photoUrl || !player.name || !player.team) continue;
        const normT = _normPhoto(query.team || player.team);
        const normN = _normPhoto(player.name);
        if (!sidearmPhotoCache[yearKey])       sidearmPhotoCache[yearKey] = {};
        if (!sidearmPhotoCache[yearKey][normT]) sidearmPhotoCache[yearKey][normT] = {};
        sidearmPhotoCache[yearKey][normT][normN] = player.photoUrl;
        fromFeed++;
      }

      // ── Strategy 2: Scrape the feedUrl's domain for a historical basketball roster ─
      // Application logic: merging a second photo source into sidearmPhotoCache.
      // Uses the home team name from the engine roster (first player's team).
      let scrapeDomain;
      try { scrapeDomain = new URL(feedUrl).hostname; } catch(_) { scrapeDomain = null; }

      if (scrapeDomain) {
        const homeTeamName = query.team
          || engineRoster.find(p => p.team)?.team
          || null;
        if (homeTeamName) {
          const normT = _normPhoto(homeTeamName);
          try {
            const scraped = await _fetchHistoricalRosterPhotos(scrapeDomain, yearParam);
            for (const p of scraped) {
              if (!p.photoUrl || !p.normName) continue;
              if (!sidearmPhotoCache[yearKey])         sidearmPhotoCache[yearKey] = {};
              if (!sidearmPhotoCache[yearKey][normT])  sidearmPhotoCache[yearKey][normT] = {};
              if (!sidearmPhotoCache[yearKey][normT][p.normName]) {
                sidearmPhotoCache[yearKey][normT][p.normName] = p.photoUrl;
                fromRoster++;
              }
            }
          } catch(e) {
            console.warn(`[sidearm-game-photos] roster scrape failed ${scrapeDomain}: ${e.message}`);
          }
        }
      }

      if (fromFeed + fromRoster > 0) _saveSidearmPhotoCache();

      const yearCache = sidearmPhotoCache[yearKey] || {};
      return sendJSON(res, 200, {
        ok: true,
        feedUrl,
        year:             yearParam,
        ingested:         fromFeed + fromRoster,
        fromFeed,
        fromRosterScrape: fromRoster,
        domain:           scrapeDomain || null,
        cacheTeamsThisYear:  Object.keys(yearCache).length,
        cachePhotosThisYear: Object.values(yearCache)
          .reduce((n, t) => n + Object.keys(t).length, 0),
      });
    } catch(e) {
      console.error('[/api/sidearm-game-photos]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/historical-cache-clear?year=2008
  // Delete a year's entry from historicalPhotoCache and persist to disk.
  if (pathname === '/api/historical-cache-clear') {
    const yearParam = query.year ? String(parseInt(query.year, 10)) : null;
    if (!yearParam) return sendJSON(res, 400, { ok: false, error: 'year required' });
    const had = !!historicalPhotoCache[yearParam];
    delete historicalPhotoCache[yearParam];
    _saveHistoricalPhotoCache();
    console.log(`[historical-cache-clear] year=${yearParam} had=${had}`);
    return sendJSON(res, 200, { ok: true, year: yearParam, cleared: true, hadData: had });
  }

  // /api/historical-cache-debug?year=2008
  // Inspect what's in historicalPhotoCache for a given year.
  if (pathname === '/api/historical-cache-debug') {
    const yearParam  = query.year ? String(parseInt(query.year, 10)) : null;
    const yearCache  = yearParam ? historicalPhotoCache[yearParam] : null;
    const allYears   = Object.keys(historicalPhotoCache).sort();

    if (yearParam && yearCache) {
      const teamEntries = Object.entries(yearCache)
        .map(([team, players]) => ({ team, playerCount: Object.keys(players).length }))
        .sort((a, b) => b.playerCount - a.playerCount);
      const totalPlayersCached = teamEntries.reduce((n, t) => n + t.playerCount, 0);
      const sampleTeams        = teamEntries.slice(0, 15);

      const firstRich = teamEntries.find(t => t.playerCount > 0);
      const samplePlayers = firstRich
        ? Object.entries(yearCache[firstRich.team]).slice(0, 15)
            .map(([normName, url]) => ({ normName, urlPrefix: (url || '').slice(0, 70) }))
        : [];

      return sendJSON(res, 200, {
        ok: true, year: yearParam,
        teamsInHistoricalPhotoCache: teamEntries.length,
        totalPlayersCached,
        sampleTeams,
        samplePlayers: { team: firstRich?.team || null, players: samplePlayers },
      });
    }

    return sendJSON(res, 200, {
      ok: true, year: null,
      yearsInCache: allYears,
      summary: allYears.map(y => ({
        year: y,
        teams:   Object.keys(historicalPhotoCache[y]).length,
        players: Object.values(historicalPhotoCache[y])
          .reduce((n, t) => n + Object.keys(t).length, 0),
      })),
    });
  }

  // /api/historical-roster-backfill?from=2005&to=2012&tournament=march-madness
  // Pre-scrapes official athletics historical rosters for every team in the tournament
  // across the specified year range. Results land in _rosterPageCache so subsequent
  // photo-backfill and photo-coverage calls benefit immediately.
  if (pathname === '/api/historical-roster-backfill') {
    try {
      const fromYear  = Math.max(2000, parseInt(query.from || 2005, 10));
      const toYear    = Math.min(new Date().getFullYear(), parseInt(query.to || 2012, 10));
      const tnmtParam = (query.tournament || 'march-madness').trim();
      const limit     = parseInt(query.limit || 0, 10); // 0 = no limit
      // force=1 clears stale _rosterPageCache entries so wrong-season data is re-scraped
      const force     = query.force === '1' || query.force === 'true';
      if (fromYear > toYear) return sendJSON(res, 400, { ok: false, error: 'from must be ≤ to' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      const yearsScanned = [];
      let teamsScanned = 0, rostersFound = 0, photosFound = 0;
      const failures = [], examples = [];
      let timedOut = false;
      const deadline = Date.now() + 60_000;

      outer: for (let year = fromYear; year <= toYear; year++) {
        const { contests } = await _internalFetchTournamentContests(slug, year);
        const completed    = contests.filter(c => c.gameState === 'F');

        const teamSet = new Set();
        for (const c of completed) {
          for (const t of (c.teams || [])) {
            if (t.nameShort && t.nameShort !== '?') teamSet.add(t.nameShort);
          }
        }
        const teams          = [...teamSet];
        const teamsToProcess = limit > 0 ? teams.slice(0, limit) : teams;
        yearsScanned.push({ year, teamsFound: teams.length, teamsProcessed: teamsToProcess.length, games: completed.length });

        // Wipe the whole year before processing so stale/wrong-season entries are gone.
        delete historicalPhotoCache[String(year)];
        _saveHistoricalPhotoCache();

        for (let i = 0; i < teamsToProcess.length; i += 3) {
          if (Date.now() > deadline) {
            timedOut = true;
            console.log(`[Historical roster prefill] timeout after 60s — returning partial results`);
            break outer;
          }

          const batch = teamsToProcess.slice(i, i + 3);
          await Promise.allSettled(batch.map(async (team, bi) => {
            const teamIdx = i + bi + 1;
            console.log(`[Progress] ${year} ${teamIdx}/${teamsToProcess.length} team=${team}`);

            const normT  = _normPhoto(team);
            const domain = ATHLETICS_ROSTER_MAP[normT];
            console.log(`[Historical roster prefill:start] year=${year} team=${team} domain=${domain || 'none'}`);

            if (!domain) {
              failures.push({ year, team, reason: 'no_domain' });
              return;
            }
            teamsScanned++;

            // Clear stale _rosterPageCache entry so _fetchHistoricalRosterPhotos re-scrapes.
            const histCacheKey = `${domain}:hist:${year}`;
            delete _rosterPageCache[histCacheKey];
            const yearKey = String(year);

            try {
              const roster = await _fetchHistoricalRosterPhotos(domain, year);
              const photos  = roster.filter(p => p.photoUrl).length;

              // Populate historicalPhotoCache — yearKey/normT already cleared above
              if (!historicalPhotoCache[yearKey]) historicalPhotoCache[yearKey] = {};
              historicalPhotoCache[yearKey][normT] = {};
              for (const p of roster) {
                if (p.photoUrl) historicalPhotoCache[yearKey][normT][p.normName] = p.photoUrl;
              }

              if (roster.length > 0) {
                rostersFound++;
                photosFound += photos;
                console.log(`[Historical roster prefill:hit] year=${year} team=${team} players=${roster.length} photos=${photos}`);
                if (examples.length < 10) examples.push({ year, team, domain, players: roster.length, photos });
              } else {
                // School website returned nothing — try Wayback Machine if time permits
                let wbSuccess = false;
                if (Date.now() <= deadline - 8000) {
                  try {
                    const wbRoster = await _fetchWaybackRosterPhotos(domain, year);
                    const wbPhotos = wbRoster.filter(p => p.photoUrl).length;
                    if (!waybackPhotoCache[yearKey]) waybackPhotoCache[yearKey] = {};
                    waybackPhotoCache[yearKey][normT] = {};
                    for (const p of wbRoster) {
                      if (p.photoUrl) waybackPhotoCache[yearKey][normT][p.normName] = p.photoUrl;
                    }
                    if (wbRoster.length > 0) {
                      rostersFound++;
                      photosFound += wbPhotos;
                      console.log(`[Historical roster prefill:wayback] year=${year} team=${team} players=${wbRoster.length} photos=${wbPhotos}`);
                      if (examples.length < 10) examples.push({ year, team, domain, players: wbRoster.length, photos: wbPhotos, source: 'wayback' });
                      wbSuccess = true;
                    }
                  } catch(e) {
                    console.warn(`[Historical roster prefill:wayback] year=${year} team=${team}: ${e.message}`);
                  }
                }
                if (!wbSuccess) {
                  console.log(`[Historical roster prefill:miss] year=${year} team=${team}`);
                  failures.push({ year, team, domain, reason: 'no_roster' });
                }
              }
            } catch(e) {
              console.log(`[Historical roster prefill:miss] year=${year} team=${team}`);
              failures.push({ year, team, domain, reason: e.message });
            }
          }));
        }
      }

      // Persist to disk so the cache survives server restarts
      _saveHistoricalPhotoCache();
      _saveWaybackPhotoCache();

      return sendJSON(res, 200, {
        ok: true,
        partial: timedOut,
        yearsScanned,
        teamsScanned,
        rostersFound,
        photosFound,
        failures: failures.slice(0, 100),
        examples,
      });
    } catch(e) {
      console.error('[/api/historical-roster-backfill]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/photo-coverage?tournament=National%20Invitation%20Tournament&year=2026
  // Diagnostic: for each real player in the tournament, report headshot source + coverage %.
  // Does NOT re-run the PBP pipeline — reads ESPN boxscores directly (faster).
  if (pathname === '/api/photo-coverage') {
    try {
      const tnmtParam = (query.tournament || '').trim();
      const year      = parseInt(query.year || new Date().getFullYear(), 10);
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      const { players, gamesScanned, sourceBreakdown, withPhoto, missingPlayers } =
        await _resolveTournamentPlayerPhotos(slug, year);

      if (!players.length) return sendJSON(res, 200, {
        ok: true, tournament: tnmtParam, year, slug,
        totalPlayers: 0, withPhoto: 0, missingPhoto: 0, coveragePct: 0,
        sourceBreakdown: {}, missingPlayers: [],
      });

      const coveragePct    = Math.round(withPhoto.length / players.length * 100);
      const photoRequired  = isPhotoRequiredYear(year);
      const missingIsProblem = photoRequired && missingPlayers.length > 0;
      console.log(`[Photo coverage] tournament=${tnmtParam} year=${year} total=${players.length}` +
        ` withPhoto=${withPhoto.length} coveragePct=${coveragePct}% photoRequired=${photoRequired}`);

      return sendJSON(res, 200, {
        ok: true,
        tournament:      tnmtParam,
        year,
        slug,
        photoRequired,
        missingIsProblem,
        gamesScanned,
        totalPlayers:    players.length,
        withPhoto:       withPhoto.length,
        missingPhoto:    missingPlayers.length,
        coveragePct,
        sourceBreakdown,
        missingPlayers:  missingPlayers.slice(0, 50).map(p => ({
          name: p.name, team: p.team,
          reason: photoRequired ? 'not_found' : 'name_only_old_season',
        })),
      });
    } catch(e) {
      console.error('[/api/photo-coverage]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/stats-coverage?tournament=march-madness&year=2008
  // Audit stats availability for every completed game in a tournament.
  // Returns per-game breakdown: box score, player stats, team stats, PBP.
  if (pathname === '/api/stats-coverage') {
    try {
      const tnmtParam = (query.tournament || '').trim();
      const year      = parseInt(query.year || new Date().getFullYear(), 10);
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      const { contests } = await _internalFetchTournamentContests(slug, year);
      const completed = contests.filter(c => c.gameState === 'F');

      if (!completed.length) {
        return sendJSON(res, 200, {
          ok: true, tournament: tnmtParam, slug, year,
          games: 0, gamesWithBoxScore: 0, gamesWithPlayerStats: 0,
          gamesWithTeamStats: 0, gamesWithPbp: 0, missingGames: [],
        });
      }

      let gamesWithBoxScore = 0, gamesWithPlayerStats = 0,
          gamesWithTeamStats = 0, gamesWithPbp = 0;
      const missingGames = [];

      // Check each game in parallel batches of 5
      for (let i = 0; i < completed.length; i += 5) {
        const batch = completed.slice(i, i + 5);
        await Promise.allSettled(batch.map(async (c) => {
          const espnId   = c.contestId || null; // ESPN event ID
          const homeTeam = c.teams?.find(t => t.isHome) || c.teams?.[0] || {};
          const awayTeam = c.teams?.find(t => !t.isHome) || c.teams?.[1] || {};
          let hasBoxScore = false, hasPlayerStats = false, hasTeamStats = false, hasPbp = false;

          if (espnId) {
            try {
              const data = await _fetchEspnSummary(espnId);
              const teams = data.boxscore?.teams || [];
              hasTeamStats   = teams.some(t => (t.statistics || []).length > 0);
              hasPlayerStats = teams.some(t => (t.athletes || []).some(a => (a.stats || []).length > 0));
              hasBoxScore    = hasPlayerStats || hasTeamStats;
              hasPbp         = (data.plays || []).length > 0;
            } catch(_) {}
          }

          if (hasBoxScore)     gamesWithBoxScore++;
          if (hasPlayerStats)  gamesWithPlayerStats++;
          if (hasTeamStats)    gamesWithTeamStats++;
          if (hasPbp)          gamesWithPbp++;

          if (!hasBoxScore && !hasPbp) {
            const reason = espnId ? 'espn_no_data' : 'no_espn_id';
            console.log(`[stats-missing] gameId=${espnId} home=${homeTeam.nameShort||''} away=${awayTeam.nameShort||''} round="${c.roundDescription||''}" reason=${reason}`);
            missingGames.push({
              gameId: espnId,
              home:   homeTeam.nameShort || homeTeam.name6Char || '',
              away:   awayTeam.nameShort || awayTeam.name6Char || '',
              date:   c.startDate || '',
              round:  c.roundDescription || '',
            });
          }
        }));
      }

      return sendJSON(res, 200, {
        ok: true,
        tournament:          tnmtParam,
        slug,
        year,
        games:               completed.length,
        gamesWithBoxScore,
        gamesWithPlayerStats,
        gamesWithTeamStats,
        gamesWithPbp,
        missingGames,
      });
    } catch(e) {
      console.error('[/api/stats-coverage]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/stats-backfill?tournament=march-madness&year=2008[&gameId=ESPNID]
  // For each game missing box score / team stats, tries multiple data sources in order:
  //   1. ESPN summary (fresh fetch — catches transient failures)
  //   2. Alternate ESPN ID (with/without leading-4 prefix migration)
  //   3. NCAA stats API (via date+team-name contestId discovery)
  // Always extracts final score from ESPN header even when full box score is unavailable.
  // Logs [stats-missing] gameId=... reason=... for every unresolved gap.
  if (pathname === '/api/stats-backfill') {
    try {
      const tnmtParam  = (query.tournament || '').trim();
      const year       = parseInt(query.year || new Date().getFullYear(), 10);
      const targetId   = query.gameId || null; // optional: limit to one game
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      const { contests } = await _internalFetchTournamentContests(slug, year);
      let games = contests.filter(c => c.gameState === 'F');
      if (targetId) games = games.filter(c => String(c.contestId) === String(targetId));

      // Parse box score presence from an ESPN summary response object
      function _espnHasData(data) {
        const teams = data.boxscore?.teams || [];
        const hasTeamStats   = teams.some(t => (t.statistics || []).length > 0);
        const hasPlayerStats = teams.some(t => (t.athletes || []).some(a => (a.stats || []).length > 0));
        const hasPbp         = (data.plays || []).length > 0;
        const competitors    = data.header?.competitions?.[0]?.competitors || [];
        const homeC          = competitors.find(c => c.homeAway === 'home');
        const awayC          = competitors.find(c => c.homeAway === 'away');
        const homeScore      = homeC?.score != null ? parseInt(homeC.score) : null;
        const awayScore      = awayC?.score != null ? parseInt(awayC.score) : null;
        const hasScore       = homeScore !== null && awayScore !== null;
        return { hasTeamStats, hasPlayerStats, hasBoxScore: hasPlayerStats || hasTeamStats, hasPbp, hasScore, homeScore, awayScore };
      }

      // Alternate ESPN IDs to probe for older games.
      // ESPN migrated many pre-2012 event IDs by prepending '4'; try both directions.
      function _altEspnIds(espnId) {
        const s = String(espnId);
        const alts = [];
        if (s.startsWith('4') && s.length > 8) alts.push(s.slice(1));
        else alts.push('4' + s);
        return alts;
      }

      const results  = [];
      const normName = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

      for (let i = 0; i < games.length; i += 3) {
        const batch = games.slice(i, i + 3);
        await Promise.allSettled(batch.map(async (c) => {
          const espnId   = c.contestId;
          const homeTeam = c.teams?.find(t => t.isHome)  || c.teams?.[0] || {};
          const awayTeam = c.teams?.find(t => !t.isHome) || c.teams?.[1] || {};
          const homeName = homeTeam.nameShort || homeTeam.name6Char || '';
          const awayName = awayTeam.nameShort || awayTeam.name6Char || '';

          let source = 'none', ncaaContestId = null;
          let hasBoxScore = false, hasTeamStats = false, hasPbp = false, hasScore = false;
          let homeScore = homeTeam.score, awayScore = awayTeam.score;
          const reasons = [];

          // ── Step 1: ESPN summary ───────────────────────────────────────────
          if (espnId) {
            const d = await _fetchEspnSummary(espnId);
            const r = _espnHasData(d);
            hasTeamStats = r.hasTeamStats; hasBoxScore = r.hasBoxScore;
            hasPbp = r.hasPbp; hasScore = r.hasScore;
            if (r.homeScore !== null) homeScore = r.homeScore;
            if (r.awayScore !== null) awayScore = r.awayScore;
            if (hasTeamStats || hasBoxScore) { source = 'espn'; }
            else if (hasPbp)                { source = 'espn_pbp_only'; }
            else if (hasScore)              { source = 'espn_score_only'; reasons.push('espn_score_only'); }
            else                            { reasons.push('espn_no_data'); }
          } else {
            reasons.push('no_espn_id');
          }

          // ── Step 2: Alternate ESPN ID ──────────────────────────────────────
          if (!hasBoxScore && !hasTeamStats && espnId) {
            for (const altId of _altEspnIds(espnId)) {
              const d = await _fetchEspnSummary(altId);
              const r = _espnHasData(d);
              if (r.hasTeamStats || r.hasBoxScore) {
                hasTeamStats = r.hasTeamStats; hasBoxScore = r.hasBoxScore; hasPbp = r.hasPbp;
                if (r.homeScore !== null) homeScore = r.homeScore;
                if (r.awayScore !== null) awayScore = r.awayScore;
                hasScore = r.hasScore;
                source = 'espn_alt_id';
                reasons.push(`espn_alt_id=${altId}`);
                break;
              }
            }
          }

          // ── Step 3: NCAA contestId discovery via date + team names ─────────
          if (!hasBoxScore && !hasTeamStats) {
            console.log(`[stats-missing] gameId=${espnId} home=${homeName} away=${awayName} reason=${reasons.join(',') || 'espn_no_data'}`);

            const rawDate = c.startDate || ''; // MM/DD/YYYY
            if (rawDate) {
              try {
                const parts    = rawDate.split('/').map(Number);
                const [m, d, y] = parts;
                const seasonYear = m >= 7 ? y : y - 1;
                const mmdd = `${String(m).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}`;

                const ncaaDay = await ncaaFetch('GetContests_web', HASHES.contests, {
                  sportCode: 'MBB', division: 1, seasonYear, contestDate: mmdd, week: null,
                });
                const dayContests = (ncaaDay?.data?.allContestData?.contests || ncaaDay?.data?.contests || []);
                const homeN = normName(homeName), awayN = normName(awayName);

                const match = dayContests.find(nc => {
                  const ts = (nc.teams || []).map(t => normName(t.nameShort || t.name6Char || t.name || ''));
                  const homeHit = ts.some(t => t.slice(0,5) === homeN.slice(0,5) || homeN.slice(0,5) === t.slice(0,5));
                  const awayHit = ts.some(t => t.slice(0,5) === awayN.slice(0,5) || awayN.slice(0,5) === t.slice(0,5));
                  return homeHit && awayHit;
                });

                if (match) {
                  ncaaContestId = String(match.contestId);
                  reasons.push(`ncaa_id=${ncaaContestId}`);
                } else {
                  reasons.push('ncaa_id_not_found');
                  console.log(`[stats-missing] gameId=${espnId} reason=ncaa_id_not_found date=${mmdd}`);
                }
              } catch(e) {
                reasons.push('ncaa_lookup_error');
                console.log(`[stats-missing] gameId=${espnId} reason=ncaa_lookup_error err=${e.message.slice(0,50)}`);
              }
            }

            // ── Step 4: NCAA team stats + box score ──────────────────────────
            if (ncaaContestId) {
              try {
                const [tsData, bsData] = await Promise.allSettled([
                  ncaaFetch('NCAA_GetGamecenterTeamStatsBasketballById_web', HASHES.teamStats,
                    { contestId: ncaaContestId, staticTestEnv: null }),
                  ncaaFetch('NCAA_GetGamecenterBoxscoreBasketballById_web', HASHES.boxscore,
                    { contestId: ncaaContestId, staticTestEnv: null }),
                ]);

                const tsBox = tsData.status === 'fulfilled' ? (tsData.value?.data?.teamBoxscore || []) : [];
                const bsBox = bsData.status === 'fulfilled' ? (bsData.value?.data?.teamBoxscore || []) : [];

                if (tsBox.some(t => t.teamStats && Object.keys(t.teamStats).length > 0)) {
                  hasTeamStats = true; source = 'ncaa';
                }
                if (bsBox.some(t => (t.playerStats || []).length > 0)) {
                  hasBoxScore = true; source = 'ncaa';
                }
                if (!hasTeamStats && !hasBoxScore) {
                  reasons.push('ncaa_api_empty');
                  console.log(`[stats-missing] gameId=${espnId} ncaaId=${ncaaContestId} reason=ncaa_api_empty`);
                }
              } catch(e) {
                reasons.push('ncaa_api_error');
                console.log(`[stats-missing] gameId=${espnId} ncaaId=${ncaaContestId} reason=ncaa_api_error err=${e.message.slice(0,50)}`);
              }
            }
          }

          // Final log for completely unresolved games
          if (!hasBoxScore && !hasTeamStats && !hasPbp) {
            const finalReason = hasScore ? 'score_only' : 'no_data_found';
            console.log(`[stats-missing] gameId=${espnId} home=${homeName} away=${awayName} reason=${finalReason}`);
          }

          results.push({
            gameId: espnId, ncaaContestId,
            home: homeName, away: awayName,
            homeScore, awayScore,
            date: c.startDate || '', round: c.roundDescription || '',
            source,
            hasScore, hasTeamStats, hasBoxScore, hasPbp,
            reason: reasons.join(',') || 'ok',
          });
        }));
      }

      const resolved  = results.filter(r => r.hasTeamStats || r.hasBoxScore).length;
      const scoreOnly = results.filter(r => r.hasScore && !r.hasTeamStats && !r.hasBoxScore).length;
      const noData    = results.filter(r => !r.hasScore && !r.hasTeamStats && !r.hasBoxScore).length;

      return sendJSON(res, 200, {
        ok: true, tournament: tnmtParam, slug, year,
        total: results.length, resolved, scoreOnly, noData,
        games: results,
      });
    } catch(e) {
      console.error('[/api/stats-backfill]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/pdf-media-guide-backfill?tournament=march-madness&year=2008&limit=5
  // For each team still missing player photos, search for basketball media guide PDFs,
  // download them (≤25 MB each, ≤3 per team), extract embedded JPEG headshots, match
  // players by text position, and cache results in pdfPhotoCache.
  // Add ?force=1 to reprocess teams already in the cache.
  if (pathname === '/api/pdf-media-guide-backfill') {
    try {
      const tnmtParam = (query.tournament || '').trim();
      const year      = parseInt(query.year  || 2008, 10);
      const limit     = Math.min(parseInt(query.limit || 5, 10), 64);
      const force     = query.force === '1';
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      // Resolve current missing players
      const { players, missingPlayers } = await _resolveTournamentPlayerPhotos(slug, year);

      // Group missing players by normTeam
      const byTeam = {};
      for (const p of missingPlayers) {
        const normT = _normPhoto(p.team);
        if (!byTeam[normT]) byTeam[normT] = { team: p.team, normTeam: normT, players: [] };
        byTeam[normT].players.push(_normPhoto(p.name));
      }

      // Filter: must have domain mapping; skip already-cached unless ?force=1
      const yearKey = String(year);
      const toProcess = Object.values(byTeam).filter(t => {
        if (!ATHLETICS_ROSTER_MAP[t.normTeam]) return false;
        if (force) return true;
        return pdfPhotoCache[yearKey]?.[t.normTeam] === undefined;
      }).slice(0, limit);

      const results = [];
      let totalPDFs = 0, totalImages = 0, totalMatched = 0;

      for (const t of toProcess) {
        const domain = ATHLETICS_ROSTER_MAP[t.normTeam];
        try {
          const r = await _processPDFForTeam(t.normTeam, domain, year, t.players);
          totalPDFs    += r.pdfsFound   || 0;
          totalImages  += r.imagesExtracted || 0;
          totalMatched += r.playersMatched  || 0;
          results.push({ team: t.team, normTeam: t.normTeam, domain, ...r });
        } catch(e) {
          results.push({ team: t.team, normTeam: t.normTeam, domain, error: e.message });
        }
      }

      _savePDFPhotoCache();

      // Re-estimate coverage including newly matched players
      const baseCoverage = players.length - missingPlayers.length;
      const newCoverage  = players.length
        ? Math.round((baseCoverage + totalMatched) / players.length * 100) : 0;

      return sendJSON(res, 200, {
        ok: true,
        tournament: tnmtParam, slug, year,
        totalPlayers:   players.length,
        initialMissing: missingPlayers.length,
        teamsProcessed: toProcess.length,
        totalPDFsFound: totalPDFs,
        totalImagesExtracted: totalImages,
        totalPlayersMatched: totalMatched,
        estimatedCoveragePct: newCoverage,
        results,
      });
    } catch(e) {
      console.error('[/api/pdf-media-guide-backfill]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/photo-missing-teams?tournament=march-madness&year=2008
  // Diagnostic: group players with no photo by team. Shows normTeam, hasDomain, domain,
  // missingCount, and sample player names so you can quickly spot domain-map gaps.
  if (pathname === '/api/photo-missing-teams') {
    try {
      const tnmtParam = (query.tournament || '').trim();
      const year      = parseInt(query.year || new Date().getFullYear(), 10);
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      const { players, missingPlayers, sourceBreakdown, withPhoto } =
        await _resolveTournamentPlayerPhotos(slug, year);

      // Group missing players by team, sorted by missing count desc
      const byTeam = {};
      for (const p of missingPlayers) {
        if (!byTeam[p.team]) {
          const normT  = _normPhoto(p.team);
          const domain = ATHLETICS_ROSTER_MAP[normT];
          // Check whether any historical or wayback data exists for this team+year
          const hasHistorical = !!(historicalPhotoCache[String(year)]?.[normT] &&
            Object.keys(historicalPhotoCache[String(year)][normT]).length > 0);
          const hasWayback    = !!(waybackPhotoCache[String(year)]?.[normT] &&
            Object.keys(waybackPhotoCache[String(year)][normT]).length > 0);
          byTeam[p.team] = {
            team: p.team, normTeam: normT, hasDomain: !!domain, domain: domain || null,
            hasHistoricalCache: hasHistorical, hasWaybackCache: hasWayback,
            missingCount: 0, samplePlayers: [],
          };
        }
        byTeam[p.team].missingCount++;
        if (byTeam[p.team].samplePlayers.length < 4) byTeam[p.team].samplePlayers.push(p.name);
      }

      const teams = Object.values(byTeam).sort((a, b) => b.missingCount - a.missingCount);
      const noDomainTeams = teams.filter(t => !t.hasDomain);

      return sendJSON(res, 200, {
        ok: true,
        tournament:   tnmtParam,
        year,
        totalPlayers: players.length,
        missingTotal: missingPlayers.length,
        coveragePct:  players.length
          ? Math.round(withPhoto.length / players.length * 100) : 0,
        sourceBreakdown,
        missingByTeam: teams,
        noDomainCount: noDomainTeams.length,
        noDomainTeams: noDomainTeams.map(t => ({ team: t.team, normTeam: t.normTeam })),
      });
    } catch(e) {
      console.error('[/api/photo-missing-teams]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/photo-backfill?tournament=march-madness&year=2026
  // Targeted backfill: for players still missing after shared resolution, tries
  // _backfillPlayerPhoto a second time and stores new hits in playerPhotoCache.
  // Men's College Basketball only.
  if (pathname === '/api/photo-backfill') {
    try {
      const tnmtParam = (query.tournament || '').trim();
      const year      = parseInt(query.year || new Date().getFullYear(), 10);
      if (!tnmtParam || !year) return sendJSON(res, 400, { ok: false, error: 'tournament and year required' });

      const normTnmt = tnmtParam.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const SLUG_MAP = {
        'national-invitation-tournament': 'nit', 'nit': 'nit',
        'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
        'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
        'college-insider-com-tournament':  'cit', 'cit': 'cit',
        'college-basketball-crown':        'cbc', 'cbc': 'cbc',
        'basketball-classic':              'nbc', 'nbc': 'nbc',
      };
      const slug = SLUG_MAP[normTnmt] || normTnmt;

      // ── Optional: clear playerPhotoCache 'none' entries so they get re-evaluated ─
      // Use ?clearNone=1 when new sources have been added (new domains, Wikipedia fixes, etc.)
      if (query.clearNone === '1') {
        const prefix = `${year}:`;
        let cleared = 0;
        for (const k of Object.keys(playerPhotoCache)) {
          if (k.startsWith(prefix) && playerPhotoCache[k].source === 'none') {
            delete playerPhotoCache[k];
            cleared++;
          }
        }
        // Also clear wiki cache for this year's players so Wikipedia is retried
        for (const k of Object.keys(_wikiPhotoCache)) {
          if (_wikiPhotoCache[k].url === null) { delete _wikiPhotoCache[k]; }
        }
        console.log(`[photo-backfill] clearNone=1: cleared ${cleared} none entries + wiki cache`);
      }

      // ── Optional SIDEARM pre-seed: ingest roster photos before main backfill ─
      // Pass ?feedUrls=URL1,URL2,... (comma-separated) or ?feedUrl=URL (single).
      // fetchSidearmRoster delegates all fetching/parsing to the C:\sb engine.
      const rawFeedUrls = (query.feedUrls || query.feedUrl || '').trim();
      let sidearmSeeded = 0;
      if (rawFeedUrls) {
        const feedList  = rawFeedUrls.split(',').map(u => u.trim()).filter(Boolean);
        const yearKey   = String(year);
        for (const fu of feedList) {
          try {
            const roster = await fetchSidearmRoster(fu);
            for (const player of roster) {
              if (!player.photoUrl || !player.name || !player.team) continue;
              const normT = _normPhoto(player.team);
              const normN = _normPhoto(player.name);
              if (!sidearmPhotoCache[yearKey])       sidearmPhotoCache[yearKey] = {};
              if (!sidearmPhotoCache[yearKey][normT]) sidearmPhotoCache[yearKey][normT] = {};
              if (!sidearmPhotoCache[yearKey][normT][normN]) {
                sidearmPhotoCache[yearKey][normT][normN] = player.photoUrl;
                sidearmSeeded++;
              }
            }
          } catch(e) {
            console.warn(`[photo-backfill] SIDEARM seed failed for ${fu}: ${e.message}`);
          }
        }
        if (sidearmSeeded > 0) _saveSidearmPhotoCache();
        console.log(`[photo-backfill] SIDEARM pre-seed: seeded=${sidearmSeeded} from ${feedList.length} feed(s)`);
      }

      // ── Shared resolution (same logic as photo-coverage) ─────────────────────
      const { players, missingPlayers: initialMissingPlayers } =
        await _resolveTournamentPlayerPhotos(slug, year);

      // ── Backfill: retry only players still missing after shared resolution ───
      let recovered = 0, stillMissing = 0;
      const details = [];

      for (let i = 0; i < initialMissingPlayers.length; i += 5) {
        if (i > 0) await new Promise(r => setTimeout(r, 200));
        const batch = initialMissingPlayers.slice(i, i + 5);

        await Promise.allSettled(batch.map(async (p) => {
          const hit = await _backfillPlayerPhoto(p.name, p.team, year);
          if (hit && hit.photoUrl) {
            p.headshot = hit.photoUrl;
            p.source   = hit.source;
            const cacheKey = `${year}:${_normPhoto(p.team)}:${_normPhoto(p.name)}`;
            playerPhotoCache[cacheKey] = {
              ok: true, name: p.name, team: p.team,
              source: hit.source, photoUrl: hit.photoUrl,
              ts: Date.now(),
            };
            recovered++;
            details.push({ name: p.name, team: p.team, result: 'found', source: hit.source, matchedAs: hit.matchedAs });
            console.log(`[photo-backfill] name=${p.name} team=${p.team} result=found source=${hit.source} matchedAs=${hit.matchedAs}`);
          } else if (hit) {
            p.source = hit.source;
            const cacheKey = `${year}:${_normPhoto(p.team)}:${_normPhoto(p.name)}`;
            playerPhotoCache[cacheKey] = {
              ok: false, name: p.name, team: p.team,
              source: hit.source, photoUrl: null,
              ts: Date.now(),
            };
            stillMissing++;
            details.push({ name: p.name, team: p.team, result: hit.source, source: hit.source });
            console.log(`[photo-backfill] name=${p.name} team=${p.team} result=${hit.source} source=${hit.source}`);
          } else {
            stillMissing++;
            details.push({ name: p.name, team: p.team, result: 'none', source: 'none' });
            console.log(`[photo-backfill] name=${p.name} team=${p.team} result=none source=none`);
          }
        }));
      }

      const nowWithPhoto = players.filter(p => p.headshot).length;
      const coveragePct  = players.length ? Math.round(nowWithPhoto / players.length * 100) : 0;

      return sendJSON(res, 200, {
        ok: true,
        tournament:     tnmtParam,
        slug,
        year,
        totalPlayers:   players.length,
        initialMissing: initialMissingPlayers.length,
        sidearmSeeded,
        recovered,
        stillMissing,
        newCoveragePct: coveragePct,
        details,
      });
    } catch(e) {
      console.error('[/api/photo-backfill]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/player-photo?name=Kevin Overton&team=Lipscomb&season=2026
  // Source priority: espn_search → athletics_roster → none
  // Results cached per (season, normTeam, normName) for 24h (found) or 1h (not-found).
  if (pathname === '/api/player-photo') {
    try {
      const name   = (query.name   || '').trim();
      const team   = (query.team   || '').trim();
      const season = parseInt(query.season || new Date().getFullYear(), 10);
      if (!name || !team) return sendJSON(res, 400, { ok: false, error: 'name and team required' });

      const normN    = _normPhoto(name);
      const normT    = _normPhoto(team);
      const cacheKey = `${season}:${normT}:${normN}`;

      // Check photo cache (24h TTL for found results, 1h for not-found)
      const cached = playerPhotoCache[cacheKey];
      if (cached) {
        const ttl = cached.source === 'none' ? 3_600_000 : 86_400_000;
        if (Date.now() - cached.ts < ttl) return sendJSON(res, 200, cached);
      }

      let photoUrl = null, source = 'none';

      // ── Priority 1: ESPN athlete search → college CDN → NBA CDN ───────────────
      // searchESPNAthlete now widens to NBA/pro profiles when no NCAAM result exists,
      // which catches 2008 players who went on to professional careers.
      const espnId = await searchESPNAthlete(name, team);
      if (espnId) {
        const validated = await _validatedCdnUrl(espnId);
        if (validated) {
          photoUrl = validated;
          source   = 'espn_search';
        } else {
          const nbaUrl = await _validatedNbaCdnUrl(espnId);
          if (nbaUrl) { photoUrl = nbaUrl; source = 'espn_nba'; }
        }
      }

      // ── Priority 1.5: Wikipedia (historical seasons only) ───────────────────────
      if (!photoUrl && season < new Date().getFullYear() - 1) {
        const wikiUrl = await _fetchWikipediaPhoto(name, team);
        if (wikiUrl) { photoUrl = wikiUrl; source = 'wikipedia'; }
      }

      // ── Priority 2: Athletics roster — historical season, then current ──────────
      if (!photoUrl) {
        const domain  = ATHLETICS_ROSTER_MAP[normT];
        const curYear = new Date().getFullYear();
        if (domain) {
          // Priority 3: historical roster URLs for the requested season
          // Only attempt when the season is old enough that the player has graduated
          if (season < curYear - 1) {
            const histRoster = await _fetchHistoricalRosterPhotos(domain, season);
            const match      = _rosterMatchPlayer(histRoster, normN);
            if (match && match.photoUrl) {
              photoUrl = match.photoUrl;
              source   = 'historical_athletics';
              console.log(`[Historical photo fallback] name=${name} team=${team} season=${season} source=historical_athletics matchedAs=${match.normName} photoUrl=yes`);
            }
          }

          // Priority 4: current athletics roster (fallback for recent seasons or when historical failed)
          if (!photoUrl) {
            const rosterPlayers = await _fetchRosterPhotos(domain, season);
            const match         = _rosterMatchPlayer(rosterPlayers, normN);
            if (match && match.photoUrl) {
              photoUrl = match.photoUrl;
              source   = 'athletics';
              console.log(`[Player photo fallback] name=${name} team=${team} source=athletics matched=${match.normName}`);
            } else if (rosterPlayers.length > 0) {
              const sample = rosterPlayers.slice(0, 5).map(p => p.normName).join(' | ');
              console.log(`[Photo miss debug] boxName=${normN} candidateRosterNames=[${sample}]`);
            }
          }
        }
      }
      // ── SIDEARM photo cache (populated by /api/sidearm-game-photos) ───────────
      if (!photoUrl) {
        const sidearmHit = findSidearmPhoto(name, team, season);
        if (sidearmHit) {
          photoUrl = sidearmHit.url;
          source   = 'sidearm';
        }
      }

      if (!photoUrl) console.log(`[Player photo fallback] name=${name} team=${team} source=none`);

      const result = { ok: true, name, team, source, photoUrl, ts: Date.now() };
      playerPhotoCache[cacheKey] = result;
      return sendJSON(res, 200, result);
    } catch(e) {
      console.error('[/api/player-photo]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/tournament/stats?gameIds=id1,id2,...          (Mode A — explicit IDs)
  // /api/tournament/stats?tournament=NIT&year=2026     (Mode B — auto-discover)
  // Aggregates PBP-derived stats across multiple games for tournament statistics page.
  if (pathname === '/api/tournament/stats') {
    try {
      let raw     = query.gameIds     || '';
      let rawNcaa = query.ncaaGameIds || '';
      let espnIds = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
      const _modeB_dateMap = {}; // espnId → YYYY-MM-DD; populated in Mode B for NIT discovery

      // ── Mode B: ?tournament=...&year=... → auto-discover gameIds ─────────────
      if (!espnIds.length && query.tournament && query.year) {
        const tnmtYear = parseInt(query.year, 10);
        // Normalize tournament name → slug (handles full name or short alias)
        const tnmtNorm = (query.tournament || '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const SLUG_ALIASES = {
          'national-invitation-tournament': 'nit', 'nit': 'nit',
          'march-madness': 'march-madness', 'ncaa-tournament': 'march-madness',
          'college-basketball-invitational': 'cbi', 'cbi': 'cbi',
          'college-insider-com-tournament': 'cit', 'cit': 'cit',
          'college-basketball-crown': 'cbc', 'cbc': 'cbc',
          'basketball-classic': 'nbc', 'nbc': 'nbc',
        };
        const tnmtSlug = SLUG_ALIASES[tnmtNorm] || tnmtNorm;
        console.log(`[tournament/stats Mode B] slug=${tnmtSlug} year=${tnmtYear}`);
        const { contests } = await _internalFetchTournamentContests(tnmtSlug, tnmtYear);
        const completed = contests.filter(c => c.gameState === 'F');
        espnIds = completed.map(c => c.contestId).slice(0, 100);
        rawNcaa = completed.map(c => c.ncaaContestId || '').join(',');
        // Build date map for NIT discovery: ESPN summary may lack startDate for historical games
        completed.forEach(c => {
          if (c.startTimeEpoch) _modeB_dateMap[c.contestId] = new Date(c.startTimeEpoch * 1000).toISOString().slice(0, 10);
        });
        // Auto-inject nitYear / mmlYear if not already in query
        if (!query.nitYear  && tnmtSlug === 'nit')           query.nitYear  = String(tnmtYear);
        if (!query.mmlYear  && tnmtSlug === 'march-madness') query.mmlYear  = String(tnmtYear);
        console.log(`[tournament/stats Mode B] total=${contests.length} completed=${completed.length} ids=${espnIds.length}`);
        if (!espnIds.length) return sendJSON(res, 200, {
          ok: true, available: false, gamesRequested: 0, gamesProcessed: 0,
          message: 'No completed games found for this tournament/year',
          players: [], teams: [], summary: {},
        });
      }

      if (!espnIds.length) return sendJSON(res, 400, { ok: false, error: 'gameIds required' });

      // Pair ESPN IDs with NCAA IDs by position (ncaaId may be '' if unavailable)
      const ncaaIds = rawNcaa.split(',').map(s => s.trim());
      const games   = espnIds.map((espnId, i) => ({ espnId, ncaaId: ncaaIds[i] || '', knownDate: _modeB_dateMap[espnId] || null }));

      // ── MML bracket pre-fetch (March Madness only) ────────────────────────
      // mmlYear param = calendar year (e.g. 2026). NCAA seasonYear = mmlYear - 1
      // because March is before July in the academic-year definition.
      // Builds a team-pair → contestId map so First Four games get ncaaIds.
      let mmlContestMap = null;
      if (query.mmlYear) {
        const mmlCalYear   = parseInt(query.mmlYear);
        const mmlSeasonYr  = mmlCalYear - 1; // NCAA seasonYear for a spring tournament
        try {
          const mmlData     = await ncaaFetch('scores_bracket_web', HASHES.mmlBracket, { seasonYear: mmlSeasonYr });
          const mmlContests = mmlData?.data?.mmlContests || [];
          mmlContestMap = {};
          mmlContests.forEach(c => {
            if (!c.contestId) return;
            const teams = (c.teams || []).map(t => _normTeam2(t.nameShort || t.nickname || '')).filter(Boolean).sort();
            if (teams.length === 2) mmlContestMap[teams.join('|')] = String(c.contestId);
          });
          console.log(`[MML bracket] loaded ${mmlContests.length} contests (season=${mmlSeasonYr}), ${Object.keys(mmlContestMap).length} team-pair keys`);
        } catch(e) {
          console.warn(`[MML bracket] pre-fetch failed: ${e.message}`);
        }
      }
      // _normTeam2: longer normalized string for mml lookup (full name, not 5-char prefix)
      function _normTeam2(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

      // ── NIT NCAA ID discovery setup ────────────────────────────────────────
      // nitYear triggers per-game NCAA contest discovery with score verification.
      // Uses a lazy date cache to avoid duplicate NCAA API calls for the same day.
      // Runs even when ESPN PBP succeeds so every game's NCAA ID is catalogued.
      const isNitDiscovery  = !!query.nitYear;
      const nitDateCache    = {};  // gameDate → ncaaContests[]
      const nitReport       = [];  // per-game discovery results (always collected)

      // Compute confidence score for a single NCAA contest candidate.
      // Returns 0 if either team doesn't match (candidate rejected).
      function _nitConfidence(c, homeTeam, awayTeam, homeScore, awayScore) {
        const teams = c.teams || [];
        if (!teams.some(t => _teamMatch(homeTeam, t))) return 0;
        if (!teams.some(t => _teamMatch(awayTeam, t))) return 0;

        let conf = 40; // base: both teams matched by prefix

        // Tournament context bonus — NIT-labelled contest is a strong additional signal
        const tCtx = [
          c.tournamentName, c.bracketName, c.contestTypeDesc,
          c.contestTypeName, c.seasonTypeName, c.tournament,
        ].filter(Boolean).join(' ').toUpperCase();
        if (tCtx && (tCtx.includes('NIT') || tCtx.includes('NATIONAL INVITATION'))) {
          conf += 20;
        }

        // Exact normalized name match bonus (stronger than prefix)
        const normH = _normTeam(homeTeam), normA = _normTeam(awayTeam);
        teams.forEach(t => {
          const nn = _normTeam(t.nameShort || t.name6Char || t.nameOfficial || '');
          if (nn === normH || nn === normA) conf += 15;
        });

        // Score verification — strongest signal against false positives
        if (homeScore != null && awayScore != null) {
          const cScores = teams.map(t => parseInt(t.score) || 0).sort((a, b) => a - b);
          const eScores = [homeScore, awayScore].sort((a, b) => a - b);
          if (cScores[0] === eScores[0] && cScores[1] === eScores[1]) {
            conf += 35; // exact score match
          } else if (
            Math.abs(cScores[0] - eScores[0]) <= 1 &&
            Math.abs(cScores[1] - eScores[1]) <= 1
          ) {
            conf += 10; // ±1 (OT rounding / reporting lag)
          }
        }

        return conf;
      }

      const isDebug       = query.debug === '1';
      const processed     = [];
      const missingPbpGames = []; // spec field: missingPbpGames

      // Normalize a team name for fuzzy matching (remove punctuation, lowercase)
      const _normTeam = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      // Returns true when both normalized names share at least their first 5 chars
      const _teamMatch = (espnName, ncaaTeam) => {
        const en = _normTeam(espnName);
        const nn = _normTeam(ncaaTeam.nameShort || ncaaTeam.name6Char || ncaaTeam.nameOfficial || '');
        if (en.length < 4 || nn.length < 4) return false;
        return en.slice(0, 5) === nn.slice(0, 5) || en.includes(nn.slice(0, 4)) || nn.includes(en.slice(0, 4));
      };

      // Derive a human-readable failure reason from statuses
      const _failReason = (espnSt, ncaaSt) => {
        if (espnSt.startsWith('fetch_error')) return 'ESPN API request failed';
        if (ncaaSt === 'missing_id')          return 'No ESPN PBP; NCAA contest ID not linked (scoreboard merge gap)';
        if (ncaaSt === 'no_match_found')      return 'No ESPN PBP; NCAA day-roster team-name lookup found no confident match';
        if (ncaaSt === 'fetch_failed')        return 'No ESPN PBP; NCAA API returned an error';
        if (ncaaSt === 'empty_periods')       return 'No ESPN PBP; NCAA returned no play periods for this contest';
        if (ncaaSt.startsWith('too_few'))     return `No ESPN PBP; NCAA PBP has too few usable events (${ncaaSt})`;
        if (ncaaSt.startsWith('recovered_too_few')) return `No ESPN PBP; recovered NCAA ID via team match but too few events`;
        if (ncaaSt === 'recovery_error')      return 'No ESPN PBP; NCAA day-roster lookup attempt threw an error';
        return `ESPN: ${espnSt} | NCAA: ${ncaaSt}`;
      };

      // Fetch summaries in parallel batches of 8
      for (let i = 0; i < games.length; i += 8) {
        const batch = games.slice(i, i + 8);
        const settled = await Promise.allSettled(batch.map(async ({ espnId, ncaaId: _ncaaId, knownDate }) => {
          let ncaaId    = _ncaaId; // mutable so recovery can update it
          let espnPbpStatus = 'empty';
          let ncaaPbpStatus = 'not_attempted';

          let espnData;
          try {
            espnData = await espnGet(
              `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${espnId}`
            );
          } catch(fetchErr) {
            return { _missing: true, espnEventId: espnId, ncaaContestId: ncaaId,
                     espnPbpStatus: `fetch_error: ${fetchErr.message}`, ncaaPbpStatus: 'not_attempted' };
          }

          const bsTeams    = espnData.boxscore?.teams || [];
          const hBs        = bsTeams.find(t => t.homeAway === 'home');
          const aBs        = bsTeams.find(t => t.homeAway === 'away');
          const comps      = espnData.header?.competitions?.[0] || {};
          const hComp      = (comps.competitors || []).find(t => t.homeAway === 'home');
          const aComp      = (comps.competitors || []).find(t => t.homeAway === 'away');
          const homeTeamId = String(hComp?.team?.id || hBs?.team?.id || '');
          const homeTeam   = hComp?.team?.shortDisplayName || hBs?.team?.shortDisplayName || '?';
          const awayTeam   = aComp?.team?.shortDisplayName || aBs?.team?.shortDisplayName || '?';
          const gameDate   = (comps.startDate || comps.date || '').slice(0, 10) || knownDate || null;
          const round      = comps.notes?.[0]?.headline || null;
          const finalScore = hComp?.score != null
            ? `${hComp.score}-${aComp?.score ?? '?'}` : null;
          const homeScore  = hComp?.score != null ? parseInt(hComp.score) : null;
          const awayScore  = aComp?.score != null ? parseInt(aComp.score) : null;

          // ── NIT NCAA ID discovery (runs when nitYear param set, !ncaaId) ──────
          // Discovers NCAA contestId using date + team name + score verification.
          // Runs regardless of ESPN PBP status so every game's NCAA ID is recorded.
          // A lazy per-date cache avoids duplicate NCAA API calls for the same day.
          const _nit = { attempted: false, confidence: 0, ncaaId: null, reason: 'skipped', topCandidates: [] };
          if (isNitDiscovery && !ncaaId && gameDate) {
            _nit.attempted = true;
            try {
              // Lazy-load NCAA contests for this date
              if (!nitDateCache[gameDate]) {
                const d          = new Date(gameDate + 'T12:00:00Z');
                const mmdd       = `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
                const seasonYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
                const ncaaDay    = await ncaaFetch('GetContests_web', HASHES.contests,
                  { sportCode: 'MBB', division: 1, seasonYear, contestDate: mmdd, week: null });
                nitDateCache[gameDate] = ncaaDay?.data?.contests || [];
                console.log(`[NIT discovery] cached ${nitDateCache[gameDate].length} NCAA contests for ${gameDate}`);
              }
              const dayContests = nitDateCache[gameDate];

              // Score all candidates; keep the highest-confidence one
              let best = null, bestConf = 0;
              const scored = [];
              for (const c of dayContests) {
                const conf = _nitConfidence(c, homeTeam, awayTeam, homeScore, awayScore);
                if (conf > 0) {
                  const tCtx = [c.tournamentName, c.bracketName, c.contestTypeDesc].filter(Boolean).join('|') || null;
                  scored.push({
                    contestId: String(c.contestId),
                    conf,
                    teams: (c.teams || []).map(t => t.nameShort || t.nameOfficial || t.name6Char || '?'),
                    tCtx,
                  });
                }
                if (conf > bestConf) { bestConf = conf; best = c; }
              }
              // Retain top-3 candidates for unmatched-game diagnosis
              _nit.topCandidates = scored.sort((a, b) => b.conf - a.conf).slice(0, 3);

              _nit.confidence = bestConf;
              if (best && bestConf >= 50) {
                // Accepted: at least both-team prefix match (40) + one exact (15) or score (35)
                _nit.ncaaId = String(best.contestId);
                _nit.reason = bestConf >= 75 ? 'team+score' : 'team_match';
                ncaaId      = _nit.ncaaId;
                console.log(`[NIT discovery] MATCHED espnId=${espnId} ncaaId=${ncaaId} conf=${bestConf} (${homeTeam} vs ${awayTeam} ${gameDate})`);
              } else if (best && bestConf > 0) {
                _nit.reason = `low_confidence(${bestConf})`;
                console.log(`[NIT discovery] REJECTED conf=${bestConf}<50 (${homeTeam} vs ${awayTeam} ${gameDate})`);
              } else {
                _nit.reason = 'no_team_match';
                console.log(`[NIT discovery] NO MATCH for ${homeTeam} vs ${awayTeam} on ${gameDate} (${dayContests.length} candidates)`);
              }
            } catch(nitErr) {
              _nit.reason = `error:${nitErr.message}`;
              console.warn(`[NIT discovery] error espnId=${espnId}: ${nitErr.message}`);
            }
          }
          // Accumulate report entry (even when not attempted, so the report has full coverage)
          if (isNitDiscovery) {
            nitReport.push({
              espnId,
              date:          gameDate,
              homeTeam,
              awayTeam,
              finalScore,
              ncaaId:        _nit.ncaaId,
              confidence:    _nit.confidence,
              matched:       !!_nit.ncaaId,
              reason:        _nit.reason,
              topCandidates: _nit.topCandidates,
            });
          }

          // ── ESPN PBP (primary) ──────────────────────────────────────────────
          let events    = [];
          let pbpSource = null;
          const espnPlays = espnData.plays || [];
          if (espnPlays.length) {
            const espnEvents = normalizeEspnPbp(espnPlays, homeTeamId, { silent: true });
            if (espnEvents.length >= 20) {
              events       = espnEvents;
              pbpSource    = 'espn';
              espnPbpStatus = 'ok';
            } else {
              espnPbpStatus = `too_few(${espnEvents.length})`;
            }
          } else {
            espnPbpStatus = 'empty';
          }

          // ── NCAA PBP (fallback with provided ID) ────────────────────────────
          if (!pbpSource && ncaaId) {
            const ncaaPbp = await fetchNcaaBasketballPbp(ncaaId);
            if (ncaaPbp?.periods?.length) {
              const ncaaEvents = normalizeNcaaPbp(ncaaPbp.periods, '', { silent: true });
              if (ncaaEvents.length >= 20) {
                events       = ncaaEvents;
                pbpSource    = 'ncaa';
                ncaaPbpStatus = 'ok';
                console.log(`[PBP resolver] selected source=ncaa for gameId=${espnId}`);
              } else {
                ncaaPbpStatus = `too_few(${ncaaEvents.length})`;
              }
            } else {
              ncaaPbpStatus = ncaaPbp ? 'empty_periods' : 'fetch_failed';
            }
          }

          // ── Recovery 1: MML bracket contestId lookup (March Madness) ──────────
          if (!pbpSource && !ncaaId && mmlContestMap) {
            const h = _normTeam2(homeTeam), a = _normTeam2(awayTeam);
            const mmlKey = [h, a].sort().join('|');
            const mmlId  = mmlContestMap[mmlKey];
            if (mmlId) {
              console.log(`[MML lookup] contestId=${mmlId} for ${homeTeam} vs ${awayTeam}`);
              const ncaaPbp = await fetchNcaaBasketballPbp(mmlId);
              if (ncaaPbp?.periods?.length) {
                const ncaaEvents = normalizeNcaaPbp(ncaaPbp.periods, '', { silent: true });
                if (ncaaEvents.length >= 20) {
                  events        = ncaaEvents;
                  pbpSource     = 'ncaa';
                  ncaaId        = mmlId;
                  ncaaPbpStatus = `mml_bracket(${mmlId})`;
                  console.log(`[MML lookup] SUCCESS source=ncaa events=${ncaaEvents.length} gameId=${espnId}`);
                  console.log(`[Recovered NCAA ContestId] game: ${homeTeam} vs ${awayTeam} | ncaaContestId: ${mmlId} | source: mmlBracket | pbpEvents: ${ncaaEvents.length}`);
                } else {
                  ncaaPbpStatus = `mml_too_few(${ncaaEvents.length})`;
                }
              } else {
                ncaaPbpStatus = `mml_no_periods`;
              }
            }
          }

          // ── Recovery 2: find NCAA ID by date + team-name matching ─────────────
          // Only attempt when no ID was available; avoids re-trying a known ID.
          if (!pbpSource && !ncaaId && gameDate) {
            try {
              const d         = new Date(gameDate + 'T12:00:00Z');
              const mmdd      = `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;
              const seasonYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
              const ncaaDay   = await ncaaFetch('GetContests_web', HASHES.contests,
                { sportCode: 'MBB', division: 1, seasonYear, contestDate: mmdd, week: null });
              const dayContests = ncaaDay?.data?.contests || [];

              const match = dayContests.find(c => {
                const teams = c.teams || [];
                return teams.some(t => _teamMatch(homeTeam, t)) &&
                       teams.some(t => _teamMatch(awayTeam, t));
              });

              if (match) {
                ncaaId = String(match.contestId);
                console.log(`[PBP recovery] matched NCAA contestId=${ncaaId} for ${homeTeam} vs ${awayTeam} on ${gameDate}`);
                const ncaaPbp = await fetchNcaaBasketballPbp(ncaaId);
                if (ncaaPbp?.periods?.length) {
                  const ncaaEvents = normalizeNcaaPbp(ncaaPbp.periods, '', { silent: true });
                  if (ncaaEvents.length >= 20) {
                    events       = ncaaEvents;
                    pbpSource    = 'ncaa';
                    ncaaPbpStatus = `recovered(${ncaaId})`;
                    console.log(`[PBP recovery] SUCCESS source=ncaa for gameId=${espnId}`);
                  } else {
                    ncaaPbpStatus = `recovered_too_few(${ncaaEvents.length})`;
                  }
                } else {
                  ncaaPbpStatus = `recovered_no_periods`;
                }
              } else {
                ncaaPbpStatus = 'no_match_found';
                console.log(`[PBP recovery] no NCAA match for ${homeTeam} vs ${awayTeam} on ${gameDate} (${dayContests.length} contests checked)`);
              }
            } catch(recoveryErr) {
              ncaaPbpStatus = 'recovery_error';
              console.warn(`[PBP recovery] error for gameId=${espnId}: ${recoveryErr.message}`);
            }
          } else if (!pbpSource && !ncaaId) {
            ncaaPbpStatus = 'missing_id';
          }

          // ── No usable PBP from any source ────────────────────────────────────
          if (!events.length) {
            return {
              _missing:      true,
              gameId:        espnId,
              espnEventId:   espnId,
              ncaaContestId: ncaaId || null,
              date:          gameDate,
              round,
              homeTeam,
              awayTeam,
              finalScore,
              espnPbpStatus,
              ncaaPbpStatus,
              failureReason: _failReason(espnPbpStatus, ncaaPbpStatus),
            };
          }

          const gameStats = deriveStatsFromPbp(events, { silent: true });

          // ── Enrich PBP player names → ESPN athlete IDs from boxscore ──────────
          // The boxscore is more reliable than p.athletes in the play stream.
          const _idMap = _buildPlayerIdentityMap(espnData.boxscore);
          if (Object.keys(_idMap).length) {
            let _ec = 0;
            [[gameStats.home, hBs], [gameStats.away, aBs]].forEach(([stats, bsTeam]) => {
              const tid = String(bsTeam?.team?.id || '');
              (stats.players || []).forEach(p => {
                if (p.espnId) return; // already captured from play athletes array
                const norm = _normPlayerName(p.name);
                const hit  = _idMap[norm + '\x00' + tid] || _idMap[norm];
                if (hit) {
                  p.espnId   = hit.athleteId;
                  p.headshot = hit.headshot;
                  if (_ec++ < 10) {
                    console.log(`[Player photo enrichment] name=${p.name} team=${bsTeam?.team?.displayName || '?'} athleteId=${p.espnId} headshot=yes`);
                  }
                }
              });
            });
          }

          return { gameId: espnId, pbpSource,
                   home: { team: hBs?.team || null, stats: gameStats.home },
                   away: { team: aBs?.team || null, stats: gameStats.away },
                   score: gameStats.derivedScore };
        }));

        settled.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            if (r.value._missing) missingPbpGames.push(r.value);
            else processed.push(r.value);
          } else if (r.status === 'rejected') {
            missingPbpGames.push({
              _missing: true, gameId: '?', espnEventId: '?', ncaaContestId: null,
              espnPbpStatus: `rejected: ${r.reason?.message || 'unknown'}`,
              ncaaPbpStatus: 'not_attempted',
              failureReason: 'Promise rejected — likely ESPN fetch network error',
            });
          }
        });
      }

      // ── Always log missing games to console ─────────────────────────────────
      if (missingPbpGames.length) {
        console.log(`\n[Missing PBP] ${missingPbpGames.length} game(s) with no usable PBP:`);
        missingPbpGames.forEach((g, i) => {
          console.log(
            `  ${i + 1}. ${g.homeTeam || '?'} vs ${g.awayTeam || '?'}` +
            ` | ${g.date || '?'} | round=${g.round || '?'}` +
            ` | espnId=${g.espnEventId} | ncaaId=${g.ncaaContestId || 'none'}` +
            ` | score=${g.finalScore || '?'}` +
            `\n       espn=${g.espnPbpStatus} | ncaa=${g.ncaaPbpStatus}` +
            `\n       reason: ${g.failureReason}`
          );
        });
      }

      if (!processed.length) {
        return sendJSON(res, 200, {
          ok: true, available: false, gamesProcessed: 0, gamesRequested: espnIds.length,
          ...(isDebug ? { missingPbpGames } : {}),
        });
      }

      // ── Aggregate player stats across all processed games ─────────────────
      const playerAgg = {}; // key: name + '\x00' + teamName
      const teamAgg   = {}; // key: ESPN team id

      processed.forEach(({ home, away, score, gameId }) => {
        [[home, score.home, score.away], [away, score.away, score.home]].forEach(([side, myScore, oppScore]) => {
          const teamInfo = side.team;
          const tName    = teamInfo?.shortDisplayName || teamInfo?.displayName || '?';
          const tid      = teamInfo?.id;
          const teamWon  = myScore > oppScore;

          // Players
          (side.stats.players || []).forEach(p => {
            if (!isRealPlayerName(p.name, tName)) return;
            const key = p.name + '\x00' + tName;
            const hs  = p.espnId
              ? `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${p.espnId}.png`
              : null;
            if (!playerAgg[key]) {
              playerAgg[key] = { name: p.name, team: tName, logo: teamInfo?.logo || '',
                espnId: p.espnId || null, headshot: hs,
                games: 0, pts:0, reb:0, oreb:0, ast:0, stl:0, blk:0, to:0,
                fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0, fouls:0,
                wins: 0, ratingSum: 0 };
            }
            const a = playerAgg[key];
            // Update espnId/headshot if first game for this player had it missing
            if (p.espnId && !a.espnId) { a.espnId = p.espnId; a.headshot = hs; }
            a.games++;
            ['pts','reb','oreb','ast','stl','blk','to','fgm','fga','fg3m','fg3a','ftm','fta','fouls']
              .forEach(k => { a[k] += p[k] || 0; });
            if (teamWon) a.wins++;
            a.ratingSum += calculateCollegeOnTvRating(p, { won: teamWon });
          });

          // Team
          if (!tid) return;
          if (!teamAgg[tid]) {
            teamAgg[tid] = { name: tName, logo: teamInfo.logo || '',
              color: teamInfo.color ? '#' + teamInfo.color : '#1a3fa8',
              games: 0, pts:0, reb:0, oreb:0, ast:0, stl:0, blk:0, to:0, fouls:0,
              fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0 };
          }
          const t   = teamAgg[tid];
          const tot = side.stats.totals || {};
          t.games++;
          ['pts','reb','oreb','ast','stl','blk','to','fouls','fgm','fga','fg3m','fg3a','ftm','fta']
            .forEach(k => { t[k] += tot[k] || 0; });
        });
      });

      // ── Tournament summary ────────────────────────────────────────────────
      const gameSummaries = processed.map(({ gameId, home, away, score }) => ({
        gameId,
        home: home.team?.shortDisplayName || '?',
        away: away.team?.shortDisplayName || '?',
        homeScore: score.home,
        awayScore: score.away,
        total: score.home + score.away,
      }));
      const totalPts  = gameSummaries.reduce((s, g) => s + g.total, 0);
      const sorted    = [...gameSummaries].sort((a, b) => b.total - a.total);

      const _rawPlayers = Object.values(playerAgg);
      const playerList = _rawPlayers
        .filter(p => {
          // Belt-and-suspenders: catch any ghosts that slipped past the loop guard
          if (!isRealPlayerName(p.name, p.team)) return false;
          // No identity (espnId + headshot both null) AND no meaningful stats → ghost row
          if (!p.espnId && !p.headshot) {
            const statSum = p.pts + p.reb + p.ast + p.stl + p.blk + p.fgm + p.fga + p.ftm + p.fta;
            if (statSum === 0) return false;
          }
          return true;
        })
        .map(p => ({
          ...p,
          cotv_rating: p.games > 0 ? Math.round(p.ratingSum / p.games * 100) / 100 : null,
        }));
      console.log(`[tournament/stats] players: ${_rawPlayers.length} raw → ${playerList.length} real (removed ${_rawPlayers.length - playerList.length} ghost rows)`);

      const teamList = Object.values(teamAgg).map(t => ({
        ...t,
        ratingAvg: calculateTeamRating(t),
      }));

      // ── NIT discovery summary (always included when nitYear sent) ────────────
      const nitSummary = isNitDiscovery ? (() => {
        const matched   = nitReport.filter(r => r.matched);
        const unmatched = nitReport.filter(r => !r.matched);
        const avgConf   = nitReport.length
          ? Math.round(nitReport.reduce((s, r) => s + r.confidence, 0) / nitReport.length)
          : 0;
        console.log(`[NIT discovery] SUMMARY total=${nitReport.length} matched=${matched.length} unmatched=${unmatched.length} avgConf=${avgConf}`);
        return {
          total:         nitReport.length,
          matched:       matched.length,
          unmatched:     unmatched.length,
          avgConfidence: avgConf,
          matchedGames: matched.map(r => ({
            espnId: r.espnId, date: r.date,
            homeTeam: r.homeTeam, awayTeam: r.awayTeam,
            ncaaId: r.ncaaId, confidence: r.confidence, reason: r.reason,
          })),
          unmatchedGames: unmatched.map(r => ({
            espnId: r.espnId, date: r.date,
            homeTeam: r.homeTeam, awayTeam: r.awayTeam,
            reason: r.reason, topCandidates: r.topCandidates,
          })),
        };
      })() : null;

      return sendJSON(res, 200, {
        ok: true,
        available: true,
        gamesProcessed:  processed.length,
        gamesRequested:  espnIds.length,
        players: playerList,
        teams:   teamList,
        summary: {
          games:          processed.length,
          totalPts,
          avgPtsPerTeam:  processed.length ? Math.round(totalPts / processed.length / 2 * 10) / 10 : 0,
          highGame:       sorted[0]                          || null,
          lowGame:        sorted[sorted.length - 1]          || null,
        },
        ...(isNitDiscovery ? { nitDiscovery: nitSummary, nitDiscoveryDetail: nitReport } : {}),
        ...(isDebug        ? { missingPbpGames } : {}),
      });
    } catch(e) {
      console.error('[/api/tournament/stats ERROR]', e.stack || e.message);
      return sendJSON(res, 500, { ok: false, error: 'stats_failed', message: e.message });
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
      // Known play-in/opening-round games that have no ESPN note and must be included manually.
      // Games with no note (or unrecognizable note) that are confirmed NCAA tournament games.
      const EXTRA_MM_IDS = new Set([
        '220712561', // 2002 Opening Round: Siena vs Alcorn St (empty note)
        '230772640', // 2003 Opening Round: Texas Southern vs UNC Asheville
        '240762329', // 2004 Opening Round: note="ST LOUIS REGION PLAY-IN" (ends with PLAY-IN, not REGION)
      ]);
      function isMMGame(ev) {
        if(EXTRA_MM_IDS.has(ev.id)) return true;
        const note = ev.competitions?.[0]?.notes?.[0]?.headline || '';
        const nu = note.toUpperCase();
        if(nu.trimStart().startsWith("MEN'S BASKETBALL CHAMPIONSHIP") || nu.includes("NCAA TOURNAMENT")) return true;
        // Pre-2010 ESPN format: directional region notes e.g. "SOUTH REGION", "EAST REGIONAL",
        // "WEST REGION AT SALT LAKE CITY UT", "SOUTH REGION - PLAY-IN-GAME".
        if(/^(EAST|WEST|SOUTH|MIDWEST)\s+REGION(AL)?(\s|$)/.test(nu.trim())) return true;
        // City-based region notes, optionally followed by location: e.g. "ATLANTA REGION",
        // "AUSTIN REGIONAL AT NASHVILLE TN", "SYRACUSE REGIONAL PLAY-IN AT DAYTON OH".
        if(/\bREGION(AL)?\b/.test(nu)) return true;
        // Championship note starting with "CHAMPIONSHIP" (bare or with location, e.g. "CHAMPIONSHIP AT INDIANAPOLIS").
        if(nu.trim().startsWith('CHAMPIONSHIP')) return true;
        // Handle pre-2016 short all-caps notes without NCAA prefix
        if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return true;
        if(nu.includes('ELITE 8') || nu.includes('ELITE EIGHT') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return true;
        if(nu.includes('FINAL FOUR') || nu.includes('NATIONAL SEMIFINAL')) return true;
        if(nu.includes('NATIONAL CHAMPIONSHIP') || nu.includes('NCAA CHAMPIONSHIP')) return true;
        if((nu.includes('1ST ROUND') || nu.includes('2ND ROUND') || nu.includes('3RD ROUND')) && nu.includes('NCAA')) return true;
        if((nu.includes('OPENING ROUND') || nu.includes('PLAY-IN')) && nu.includes('NCAA')) return true;
        return MM_ROUNDS.some(r => note.includes(r)) && nu.includes('NCAA');
      }
      function getRoundFromNote(note) {
        const nu = note.toUpperCase();
        if(nu.includes('1ST ROUND') || nu.includes('FIRST ROUND')) return 'First Round';
        if(nu.includes('2ND ROUND') || nu.includes('SECOND ROUND')) return 'Second Round';
        if(nu.includes('SWEET 16') || nu.includes('SWEET SIXTEEN') || nu.includes('REGIONAL SEMIFINAL')) return 'Sweet 16';
        if(nu.includes('ELITE EIGHT') || nu.includes('ELITE 8') || nu.includes('REGIONAL FINAL') || nu.includes('REGIONAL CHAMPIONSHIP')) return 'Elite Eight';
        if(nu.includes('FINAL FOUR') || nu.includes('NATIONAL SEMIFINAL')) return 'Final Four';
        if(nu.includes('CHAMPIONSHIP') && (nu.includes('NATIONAL') || nu.includes('NCAA')) || nu.trim().startsWith('CHAMPIONSHIP')) return 'Championship';
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

      // Build list of dates to check.
      // Start from Mar 12 to capture Opening Round play-in games (e.g. 2002 was March 12).
      const dates = [];
      for(let d = new Date(`${year}-03-12T12:00:00Z`); d <= new Date(`${year}-04-10T12:00:00Z`); d.setDate(d.getDate()+1)) {
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

        // 2002 Opening Round (play-in): Siena vs Alcorn State, March 12 — empty ESPN note
        '220712561':101,
        // 2002 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        // East: Maryland(1)/Siena, Wisconsin/St.John's, Tulsa/Marquette, Kentucky/Valparaiso, TexasTech/SIU, Georgia/Murray, NCSt/MichSt, UConn/Hampton
        '224000016':201,'224000017':202,'224000019':203,'224000020':204,'224000023':205,'224000024':206,'224000026':207,'224000027':208,
        // West: Cincinnati(1)/BostonU, UCLA/OleMiss, Missouri/Miami, OhioSt/Davidson, Gonzaga/Wyoming, Arizona/UCSB, Xavier/Hawaii, Oklahoma(2)/UIC
        '224000001':209,'224000002':210,'224000004':211,'224000005':212,'224000008':213,'224000009':214,'224000011':215,'224000012':216,
        // South: Duke(1)/Winthrop, NotreDame/Charlotte, Indiana/Utah, USC/UNCWilmington, Cal/Penn, Pitt/CCon, OklaSt/KentSt, Alabama(2)/FAU
        '224000047':217,'224000048':218,'224000050':219,'224000051':220,'224000054':221,'224000055':222,'224000057':223,'224000058':224,
        // Midwest: Kansas(1)/HolyCross, Stanford/WKU, Florida/Creighton, Illinois/SanDiego, Texas/BC, MissSt/McNeese, Oregon/Montana, WakeForest/Pepperdine
        '224000032':225,'224000033':226,'224000035':227,'224000036':228,'224000039':229,'224000040':230,'224000043':231,'224000042':232,
        // 2002 Second Round
        '224000018':301,'224000021':302,'224000025':303,'224000028':304,
        '224000003':305,'224000006':306,'224000010':307,'224000013':308,
        '224000049':309,'224000052':310,'224000056':311,'224000059':312,
        '224000034':313,'224000037':314,'224000041':315,'224000044':316,
        // 2002 Sweet 16
        '224000022':401,'224000029':402,'224000007':403,'224000014':404,'224000053':405,'224000060':406,'224000038':407,'224000045':408,
        // 2002 Elite Eight: East=501, West=502, South=503(Indiana), Midwest=504(Kansas)
        '224000030':501,'224000015':502,'224000061':503,'224000046':504,
        // 2002 Final Four: 601=Kansas/Maryland, 602=Oklahoma/Indiana
        '224000062':601,'224000031':602,
        // 2002 Championship: Maryland vs Indiana (note="NCAA CHAMPIONSHIP" — fixed in isMMGame below)
        '224000063':701,

        // 2003 Opening Round (play-in): Texas Southern vs UNC Asheville, March 18
        // note="SOUTH REGION - PLAY-IN-GAME"; winner (UNC Asheville) feeds into South R64 vs Texas
        '230772640':101,
        // 2003 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        // East: Oklahoma(1)/SC State, California/NC State, Mississippi St/Butler, Louisville/Austin Peay, Oklahoma St/Penn, Syracuse/Manhattan, Saint Joseph's/Auburn, Wake Forest/ETSU
        '234000032':201,'234000033':202,'234000035':203,'234000036':204,'234000039':205,'234000040':206,'234000042':207,'234000043':208,
        // West: Arizona(1)/Vermont, Cincinnati/Gonzaga, Notre Dame/Milwaukee, Illinois/Western KY, Creighton/C Michigan, Duke/Colorado St, Memphis/Arizona St, Kansas/Utah State
        '234000001':209,'234000002':210,'234000004':211,'234000005':212,'234000008':213,'234000009':214,'234000011':215,'234000012':216,
        // South: Texas(1)/UNC Asheville, LSU/Purdue, UConn/BYU, Stanford/San Diego, Maryland/UNC Wilmington, Xavier/Troy, Michigan St/Colorado, Florida/Sam Houston
        '234000016':217,'234000017':218,'234000019':219,'234000020':220,'234000023':221,'234000024':222,'234000026':223,'234000027':224,
        // Midwest: Kentucky(1)/IU Indy, Oregon/Utah, Wisconsin/Weber St, Dayton/Tulsa, Missouri/S Illinois, Marquette/Holy Cross, Indiana/Alabama, Pitt/Wagner
        '234000047':225,'234000048':226,'234000050':227,'234000051':228,'234000054':229,'234000055':230,'234000057':231,'234000058':232,
        // 2003 Second Round
        '234000034':301,'234000037':302,'234000041':303,'234000044':304,
        '234000003':305,'234000006':306,'234000010':307,'234000013':308,
        '234000018':309,'234000021':310,'234000025':311,'234000028':312,
        '234000049':313,'234000052':314,'234000056':315,'234000059':316,
        // 2003 Sweet 16
        '234000038':401,'234000045':402,'234000007':403,'234000014':404,'234000022':405,'234000029':406,'234000053':407,'234000060':408,
        // 2003 Elite Eight: East=501(Oklahoma/Syracuse→Syracuse wins), West=502(Arizona/Kansas→Kansas wins), South=503, Midwest=504
        '234000046':501,'234000015':502,'234000030':503,'234000061':504,
        // 2003 Final Four: 601=East(Syracuse/501)+South(Texas/503) [left side], 602=West(Kansas/502)+Midwest(Marquette/504) [right side]
        '234000062':601,'234000031':602,
        // 2003 Championship: Kansas vs Syracuse (note="NCAA CHAMPIONSHIP")
        '234000063':701,

        // 2004 Opening Round: note="ST LOUIS REGION PLAY-IN" (winner=UAB, feeds into Midwest R64 vs Washington)
        '240762329':101,
        // 2004 First Round: East(EastRutherford)=201-208, West(Phoenix)=209-216, South(Atlanta)=217-224, Midwest(StLouis)=225-232
        // East Rutherford: Saint Joseph's/Liberty, Texas Tech/Charlotte, Florida/Manhattan, Wake Forest/VCU, Wisconsin/Richmond, Pitt/UCF, Memphis/South Carolina, Oklahoma St/E Washington
        '244000001':201,'244000002':202,'244000004':203,'244000005':204,'244000008':205,'244000009':206,'244000011':207,'244000012':208,
        // Phoenix (West): Stanford/UTSA, Alabama/S Illinois, Syracuse/BYU, Maryland/UTEP, Vanderbilt/W Michigan, NC State/Louisiana, DePaul/Dayton, UConn/Vermont
        '244000032':209,'244000033':210,'244000035':211,'244000036':212,'244000039':213,'244000040':214,'244000042':215,'244000043':216,
        // Atlanta (South): Duke/Alabama St, Seton Hall/Arizona, Illinois/Murray St, Cincinnati/ETSU, North Carolina/Air Force, Texas/Princeton, Xavier/Louisville, Mississippi St/Monmouth
        '244000016':217,'244000017':218,'244000019':219,'244000020':220,'244000023':221,'244000024':222,'244000026':223,'244000027':224,
        // St Louis (Midwest): Kentucky/Florida A&M, Washington/UAB, Providence/Pacific, Kansas/UIC, Boston College/Utah, Georgia Tech/Northern Iowa, Michigan St/Nevada, Gonzaga/Valparaiso
        '244000047':225,'244000048':226,'244000050':227,'244000051':228,'244000054':229,'244000055':230,'244000057':231,'244000058':232,
        // 2004 Second Round
        '244000003':301,'244000006':302,'244000010':303,'244000013':304,
        '244000034':305,'244000037':306,'244000041':307,'244000044':308,
        '244000018':309,'244000021':310,'244000025':311,'244000028':312,
        '244000049':313,'244000052':314,'244000056':315,'244000059':316,
        // 2004 Sweet 16
        '244000007':401,'244000014':402,'244000038':403,'244000045':404,'244000022':405,'244000029':406,'244000053':407,'244000060':408,
        // 2004 Elite Eight: East=501, West(Phoenix)=502, South(Atlanta)=503, Midwest(StLouis)=504
        '244000015':501,'244000046':502,'244000030':503,'244000061':504,
        // 2004 Final Four: 601=East(OklahomaState/501)+Midwest(GeorgiaTech/504) [left], 602=West(UConn/502)+South(Duke/503) [right]
        '244000031':601,'244000062':602,
        // 2004 Championship: UConn vs Georgia Tech (note="CHAMPIONSHIP")
        '244000063':701,

        // 2010 First Four (Opening Round: only 1 play-in game)
        '300752737':101,
        // 2010 First Round (seed-ordered)
        '300770096':201,'300770251':202,'300780218':203,'300780275':204,'300770269':205,'300770167':206,'300780228':207,'300780277':208,
        '300780183':209,'300782250':210,'300772086':211,'300770238':212,'300782752':213,'300780221':214,'300770252':215,'300772306':216,
        '300780150':217,'300780025':218,'300780245':219,'300782509':220,'300770087':221,'300770239':222,'300770257':223,'300770222':224,
        '300772305':225,'300772439':226,'300780127':227,'300780120':228,'300772633':229,'300770046':230,'300780197':231,'300780194':232,
        // 2010 Second Round
        '300790096':301,'300800275':302,'300790167':303,'300800277':304,
        '300800183':305,'300792086':306,'300800221':307,'300792306':308,
        '300800150':309,'300802509':310,'300790239':311,'300790222':312,
        '300792305':313,'300800120':314,'300792633':315,'300800194':316,
        // 2010 Sweet 16
        '300840096':401,'300840277':402,'300840183':403,'300842306':404,'300850150':405,'300850239':406,'300850127':407,'300850194':408,
        // 2010 Elite Eight
        '300860096':501,'300862306':502,'300870150':503,'300870127':504,
        // 2010 Final Four: 601=East(501)+West(502), 602=South(503)+Midwest(504)
        '300930150':601,'300930127':602,
        // 2010 Championship
        '300950150':701,

        // 2005 Opening Round (play-in): Oakland vs Alabama A&M, March 15
        // note="SYRACUSE REGIONAL PLAY-IN AT DAYTON OH"; winner (Oakland) feeds into East R64 vs North Carolina
        '250742473':101,
        // 2005 First Round: East(Syracuse)=201-208, West(Albuquerque)=209-216, South(Austin)=217-224, Midwest(Chicago)=225-232
        // Syracuse/East: North Carolina/Oakland, Minnesota/Iowa State, Villanova/New Mexico, Florida/Ohio, Wisconsin/Northern Iowa, Kansas/Bucknell, Charlotte/NC State, UConn/UCF
        '254000016':201,'254000017':202,'254000019':203,'254000020':204,'254000023':205,'254000024':206,'254000026':207,'254000027':208,
        // Albuquerque/West: Washington/Montana, Pacific/Pitt, Georgia Tech/G Washington, Louisville/Louisiana, Texas Tech/UCLA, Gonzaga/Winthrop, West Virginia/Creighton, Wake Forest/Chattanooga
        '254000001':209,'254000002':210,'254000004':211,'254000005':212,'254000008':213,'254000009':214,'254000011':215,'254000012':216,
        // Austin/South: Duke/Delaware St, Stanford/Mississippi St, Michigan St/Old Dominion, Syracuse/Vermont, Utah/UTEP, Oklahoma/Niagara, Cincinnati/Iowa, Kentucky/E Kentucky
        '254000032':217,'254000033':218,'254000035':219,'254000036':220,'254000039':221,'254000040':222,'254000042':223,'254000043':224,
        // Chicago/Midwest: Illinois/FDU, Texas/Nevada, Alabama/Milwaukee, Boston College/Penn, LSU/UAB, Arizona/Utah State, S Illinois/Saint Mary's, Oklahoma St/SE Louisiana
        '254000047':225,'254000048':226,'254000050':227,'254000051':228,'254000054':229,'254000055':230,'254000057':231,'254000058':232,
        // 2005 Second Round
        '254000018':301,'254000021':302,'254000025':303,'254000028':304,
        '254000003':305,'254000006':306,'254000010':307,'254000013':308,
        '254000034':309,'254000037':310,'254000041':311,'254000044':312,
        '254000049':313,'254000052':314,'254000056':315,'254000059':316,
        // 2005 Sweet 16
        '254000022':401,'254000029':402,'254000007':403,'254000014':404,'254000038':405,'254000045':406,'254000053':407,'254000060':408,
        // 2005 Elite Eight: East=501, West(Albuq)=502, South(Austin)=503, Midwest(Chicago)=504
        '254000030':501,'254000015':502,'254000046':503,'254000061':504,
        // 2005 Final Four: 601=East(NC/501)+South(Michigan St/503) [left], 602=West(Louisville/502)+Midwest(Illinois/504) [right]
        '254000062':601,'254000031':602,
        // 2005 Championship: Illinois vs North Carolina (note="NCAA CHAMPIONSHIP")
        '254000063':701,

        // 2006 Opening Round (play-in): Monmouth vs Hampton, March 14
        // note="MINNEAPOLIS REGIONAL PLAY-IN AT DAYTON OH"; winner (Monmouth) feeds into Midwest R64 vs Villanova
        '260732405':101,
        // 2006 First Round: East(WashDC)=201-208, West(Oakland)=209-216, South(Atlanta)=217-224, Midwest(Minneapolis)=225-232
        // Washington DC/East: UConn/UAlbany, Kentucky/UAB, Washington/Utah State, Illinois/Air Force, Michigan St/George Mason, North Carolina/Murray St, Wichita St/Seton Hall, Tennessee/Winthrop
        '264000016':201,'264000017':202,'264000019':203,'264000020':204,'264000023':205,'264000024':206,'264000026':207,'264000027':208,
        // Oakland/West: Memphis/Oral Roberts, Arkansas/Bucknell, Pitt/Kent State, Kansas/Bradley, Indiana/San Diego St, Gonzaga/Xavier, Marquette/Alabama, UCLA/Belmont
        '264000001':209,'264000002':210,'264000004':211,'264000005':212,'264000008':213,'264000009':214,'264000011':215,'264000012':216,
        // Atlanta/South: Duke/Southern, G Washington/UNC Wilmington, Syracuse/Texas A&M, LSU/Iona, West Virginia/S Illinois, Iowa/N'Western St, California/NC State, Texas/Penn
        '264000047':217,'264000048':218,'264000050':219,'264000051':220,'264000054':221,'264000055':222,'264000057':223,'264000058':224,
        // Minneapolis/Midwest: Villanova/Monmouth, Arizona/Wisconsin, Nevada/Montana, Boston College/Pacific, Oklahoma/Milwaukee, Florida/South Alabama, Georgetown/Northern Iowa, Ohio State/Davidson
        '264000032':225,'264000033':226,'264000035':227,'264000036':228,'264000039':229,'264000040':230,'264000042':231,'264000043':232,
        // 2006 Second Round
        '264000018':301,'264000021':302,'264000025':303,'264000028':304,
        '264000003':305,'264000006':306,'264000010':307,'264000013':308,
        '264000049':309,'264000052':310,'264000056':311,'264000059':312,
        '264000034':313,'264000037':314,'264000041':315,'264000044':316,
        // 2006 Sweet 16
        '264000022':401,'264000029':402,'264000007':403,'264000014':404,'264000053':405,'264000060':406,'264000038':407,'264000045':408,
        // 2006 Elite Eight: East(WashDC)=501, West(Oakland)=502, South(Atlanta)=503, Midwest(Minneapolis)=504
        '264000030':501,'264000015':502,'264000061':503,'264000046':504,
        // 2006 Final Four: 601=East(George Mason/501)+Midwest(Florida/504) [left], 602=West(UCLA/502)+South(LSU/503) [right]
        '264000062':601,'264000031':602,
        // 2006 Championship: UCLA vs Florida (note="CHAMPIONSHIP AT INDIANAPOLIS")
        '264000063':701,

        // 2007 Opening Round (play-in): Florida A&M vs Niagara, March 13
        // note="WEST REGION AT DAYTON OH" (no PLAY-IN keyword); winner (Niagara) feeds into West R64 vs Kansas
        '270720315':101,
        // 2007 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        // East: North Carolina/E Kentucky, Marquette/Michigan St, USC/Arkansas, Texas/New Mexico St, Vanderbilt/G Washington, Washington St/Oral Roberts, Boston College/Texas Tech, Georgetown/Belmont
        '274000016':201,'274000017':202,'274000019':203,'274000020':204,'274000023':205,'274000024':206,'274000026':207,'274000027':208,
        // West: Kansas/Niagara, Kentucky/Villanova, Virginia Tech/Illinois, S Illinois/Holy Cross, Duke/VCU, Pitt/Wright St, Indiana/Gonzaga, UCLA/Weber St
        '274000001':209,'274000002':210,'274000004':211,'274000005':212,'274000008':213,'274000009':214,'274000011':215,'274000012':216,
        // South: Ohio State/C Connecticut, BYU/Xavier, Tennessee/Long Beach St, Virginia/UAlbany, Louisville/Stanford, Texas A&M/Penn, Nevada/Creighton, Memphis/North Texas
        '274000032':217,'274000033':218,'274000035':219,'274000036':220,'274000039':221,'274000040':222,'274000042':223,'274000043':224,
        // Midwest: Florida/Jackson St, Arizona/Purdue, Butler/Old Dominion, Maryland/Davidson, Notre Dame/Winthrop, Oregon/Miami OH, UNLV/Georgia Tech, Wisconsin/Texas A&M-CC
        '274000047':225,'274000048':226,'274000050':227,'274000051':228,'274000054':229,'274000055':230,'274000057':231,'274000058':232,
        // 2007 Second Round
        '274000018':301,'274000021':302,'274000025':303,'274000028':304,
        '274000003':305,'274000006':306,'274000010':307,'274000013':308,
        '274000034':309,'274000037':310,'274000041':311,'274000044':312,
        '274000049':313,'274000052':314,'274000056':315,'274000059':316,
        // 2007 Sweet 16
        '274000022':401,'274000029':402,'274000007':403,'274000014':404,'274000038':405,'274000045':406,'274000053':407,'274000060':408,
        // 2007 Elite Eight: East=501, West=502, South=503, Midwest=504
        '274000030':501,'274000015':502,'274000046':503,'274000061':504,
        // 2007 Final Four: 601=East(Georgetown/501)+South(Ohio State/503) [left], 602=West(UCLA/502)+Midwest(Florida/504) [right]
        '274000062':601,'274000031':602,
        // 2007 Championship: Florida vs Ohio State (note="CHAMPIONSHIP AT ATLANTA GA")
        '274000063':701,

        // 2008 Opening Round (play-in): Coppin State vs Mount St. Mary's, March 18
        // note="Men's Basketball Championship - Opening Round AT DAYTON OH"; winner (Mount St Mary's) feeds into East R64 vs North Carolina
        '280782154':101,
        // 2008 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        // East: North Carolina/Mount St Mary's, Indiana/Arkansas, Notre Dame/George Mason, Washington St/Winthrop, Oklahoma/Saint Joseph's, Louisville/Boise St, Butler/South Alabama, Tennessee/American
        '284000047':201,'284000048':202,'284000050':203,'284000051':204,'284000054':205,'284000055':206,'284000057':207,'284000058':208,
        // West: UCLA/Miss Valley St, BYU/Texas A&M, Drake/Western KY, UConn/San Diego, Purdue/Baylor, Xavier/Georgia, West Virginia/Arizona, Duke/Belmont
        '284000032':209,'284000033':210,'284000035':211,'284000036':212,'284000039':213,'284000040':214,'284000042':215,'284000043':216,
        // South: Memphis/UT Arlington, Mississippi St/Oregon, Michigan St/Temple, Pitt/Oral Roberts, Marquette/Kentucky, Stanford/Cornell, Miami/Saint Mary's, Texas/Austin Peay
        '284000016':217,'284000017':218,'284000019':219,'284000020':220,'284000023':221,'284000024':222,'284000026':223,'284000027':224,
        // Midwest: Kansas/Portland St, UNLV/Kent State, Clemson/Villanova, Vanderbilt/Siena, USC/Kansas St, Wisconsin/Fullerton, Gonzaga/Davidson, Georgetown/UMBC
        '284000001':225,'284000002':226,'284000004':227,'284000005':228,'284000008':229,'284000009':230,'284000011':231,'284000012':232,
        // 2008 Second Round
        '284000049':301,'284000052':302,'284000056':303,'284000059':304,
        '284000034':305,'284000037':306,'284000041':307,'284000044':308,
        '284000018':309,'284000021':310,'284000025':311,'284000028':312,
        '284000003':313,'284000006':314,'284000010':315,'284000013':316,
        // 2008 Sweet 16
        '284000053':401,'284000060':402,'284000038':403,'284000045':404,'284000022':405,'284000029':406,'284000007':407,'284000014':408,
        // 2008 Elite Eight: East=501, West=502, South=503, Midwest=504
        '284000061':501,'284000046':502,'284000030':503,'284000015':504,
        // 2008 Final Four: 601=East(NC/501)+Midwest(Kansas/504), 602=South(Memphis/503)+West(UCLA/502)
        '284000031':601,'284000062':602,
        // 2008 Championship: Kansas vs Memphis
        '284000063':701,

        // 2009 Opening Round (play-in): Alabama State vs Morehead State, March 17
        // note="MEN'S BASKETBALL CHAMPIONSHIP - OPENING ROUND AT DAYTON OH"; winner (Morehead St) feeds into Midwest R64 vs Louisville
        '290762011':101,
        // 2009 First Round: East=201-208, West=209-216, South=217-224, Midwest=225-232
        // East: Pitt/ETSU, Oklahoma St/Tennessee, Florida St/Wisconsin, Xavier/Portland St, UCLA/VCU, Villanova/American, Texas/Minnesota, Duke/Binghamton
        '294000016':201,'294000017':202,'294000019':203,'294000020':204,'294000023':205,'294000024':206,'294000026':207,'294000027':208,
        // West: UConn/Chattanooga, BYU/Texas A&M, Purdue/Northern Iowa, Washington/Mississippi St, Marquette/Utah State, Missouri/Cornell, California/Maryland, Memphis/CSU Northridge
        '294000001':209,'294000002':210,'294000004':211,'294000005':212,'294000008':213,'294000009':214,'294000011':215,'294000012':216,
        // South: North Carolina/Radford, LSU/Butler, Illinois/Western KY, Gonzaga/Akron, Arizona St/Temple, Syracuse/SF Austin, Clemson/Michigan, Oklahoma/Morgan St
        '294000032':217,'294000033':218,'294000035':219,'294000036':220,'294000039':221,'294000040':222,'294000042':223,'294000043':224,
        // Midwest: Louisville/Morehead St, Ohio State/Siena, Utah/Arizona, Wake Forest/Cleveland St, West Virginia/Dayton, Kansas/N Dakota St, Boston College/USC, Michigan St/Robert Morris
        '294000047':225,'294000048':226,'294000050':227,'294000051':228,'294000054':229,'294000055':230,'294000057':231,'294000058':232,
        // 2009 Second Round
        '294000018':301,'294000021':302,'294000025':303,'294000028':304,
        '294000003':305,'294000006':306,'294000010':307,'294000013':308,
        '294000034':309,'294000037':310,'294000041':311,'294000044':312,
        '294000049':313,'294000052':314,'294000056':315,'294000059':316,
        // 2009 Sweet 16
        '294000022':401,'294000029':402,'294000007':403,'294000014':404,'294000038':405,'294000045':406,'294000053':407,'294000060':408,
        // 2009 Elite Eight: East=501, West=502, South=503, Midwest=504
        '294000030':501,'294000015':502,'294000046':503,'294000061':504,
        // 2009 Final Four: 601=East(Villanova/501)+South(NC/503), 602=West(UConn/502)+Midwest(Michigan St/504)
        '294000062':601,'294000031':602,
        // 2009 Championship: North Carolina vs Michigan St
        '294000063':701,
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
          } else if(nu.includes('NATIONAL CHAMPIONSHIP') || nu.includes('CHAMPIONSHIP GAME') || nu.includes('NCAA CHAMPIONSHIP') || nu.trim().startsWith('CHAMPIONSHIP')) {
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

      const MANUAL_LOGOS = {
        'LIUB': 'https://upload.wikimedia.org/wikipedia/en/thumb/8/8d/LIU_Brooklyn_Blackbirds_logo.svg/200px-LIU_Brooklyn_Blackbirds_logo.svg.png',
        'LIU':  'https://upload.wikimedia.org/wikipedia/en/thumb/8/8d/LIU_Brooklyn_Blackbirds_logo.svg/200px-LIU_Brooklyn_Blackbirds_logo.svg.png',
      };

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
            teamId: t.team?.id || null,
            espnLogoUrl: t.team?.logo || t.team?.logos?.[0]?.href || MANUAL_LOGOS[t.team?.abbreviation || ''] || null,
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

  // /api/player?name=...&team=...&season=...&athleteId=...&gameIds=...
  // Returns player identity, full season stats, tournament stats, and per-game log.
  if (pathname === '/api/player') {
    try {
      const { name, team, athleteId, gameIds, season } = query;
      if (!name) return sendJSON(res, 400, { ok: false, error: 'name required' });

      const normName = _normPlayerName(name);
      let headshot   = athleteId
        ? `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${athleteId}.png`
        : null;

      // Per-game breakdown: parse each game's ESPN boxscore for this player
      const recentGames = [];
      if (gameIds) {
        const ids = gameIds.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
        const settled = await Promise.allSettled(ids.map(async gid => {
          const d = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gid}`
          );
          const ps = _parseBoxscorePlayerStats(d.boxscore, normName);
          if (!ps) return null;
          if (!headshot && ps.headshot) headshot = ps.headshot;
          if (!headshot && ps.athleteId)
            headshot = `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${ps.athleteId}.png`;

          const comps = d.header?.competitions?.[0] || {};
          const hComp = (comps.competitors || []).find(c => c.homeAway === 'home');
          const aComp = (comps.competitors || []).find(c => c.homeAway === 'away');
          const tComp = (comps.competitors || []).find(c =>
            _normPlayerName(c.team?.displayName || '') === _normPlayerName(team || '') ||
            _normPlayerName(c.team?.shortDisplayName || '') === _normPlayerName(team || ''));
          const oppComp = tComp?.homeAway === 'home' ? aComp : hComp;
          return {
            gameId:   gid,
            date:     comps.startDate ? comps.startDate.slice(0, 10) : null,
            round:    comps.notes?.[0]?.headline || null,
            opponent: oppComp?.team?.shortDisplayName || oppComp?.team?.displayName || '?',
            oppScore: oppComp?.score ?? null,
            myScore:  tComp?.score ?? null,
            pts: ps.pts, reb: ps.reb, ast: ps.ast, stl: ps.stl, blk: ps.blk,
            fg: `${ps.fg.m}-${ps.fg.a}`,
            fg3: `${ps.fg3.m}-${ps.fg3.a}`,
            ft: `${ps.ft.m}-${ps.ft.a}`,
          };
        }));
        settled.forEach(r => { if (r.status === 'fulfilled' && r.value) recentGames.push(r.value); });
        recentGames.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      }

      // ── Tournament stats: aggregate per-game totals from recentGames ─────────
      let tournamentStats = null;
      if (recentGames.length) {
        const g = recentGames.length;
        let pts=0, reb=0, ast=0, stl=0, blk=0;
        let fgm=0, fga=0, fg3m=0, fg3a=0, ftm=0, fta=0;
        for (const gm of recentGames) {
          pts += gm.pts || 0; reb += gm.reb || 0; ast += gm.ast || 0;
          stl += gm.stl || 0; blk += gm.blk || 0;
          const pf = s => { const [m,a] = (s || '0-0').split('-').map(Number); return [m||0, a||0]; };
          const [fm,fa]  = pf(gm.fg);  fgm+=fm;  fga+=fa;
          const [tm,ta]  = pf(gm.fg3); fg3m+=tm; fg3a+=ta;
          const [xm,xa]  = pf(gm.ft);  ftm+=xm;  fta+=xa;
        }
        tournamentStats = {
          games:  g,
          pts:    +(pts/g).toFixed(1),
          reb:    +(reb/g).toFixed(1),
          ast:    +(ast/g).toFixed(1),
          stl:    +(stl/g).toFixed(1),
          blk:    +(blk/g).toFixed(1),
          fgPct:  fga  > 0 ? +(fgm/fga*100).toFixed(1)   : null,
          fg3Pct: fg3a > 0 ? +(fg3m/fg3a*100).toFixed(1) : null,
          ftPct:  fta  > 0 ? +(ftm/fta*100).toFixed(1)   : null,
          fgm, fga, fg3m, fg3a, ftm, fta,
        };
      }

      // ── Season stats: fetch from ESPN athlete statistics API ─────────────────
      let seasonStats = null;
      if (athleteId) {
        try {
          const statsData = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/athletes/${athleteId}/statistics`
          );
          const statMap = {};
          const cats = [
            ...(statsData?.statistics?.[0]?.splits?.categories || []),
            ...(statsData?.athlete?.statistics?.splits?.categories || []),
          ];
          for (const cat of cats) {
            for (const s of (cat?.stats || [])) {
              if (s.name && s.value != null) statMap[s.name] = s.value;
            }
          }
          const games = statMap.gamesPlayed ?? statMap.games ?? null;
          if (games && games >= 1) {
            seasonStats = {
              source: 'espn',
              games,
              pts:    statMap.avgPoints                          ?? null,
              reb:    statMap.avgRebounds                        ?? null,
              ast:    statMap.avgAssists                         ?? null,
              stl:    statMap.avgSteals                          ?? null,
              blk:    statMap.avgBlocks                          ?? null,
              to:     statMap.avgTurnovers                       ?? null,
              fgPct:  statMap.fieldGoalPct                       ?? null,
              fg3Pct: statMap.threePointPct                      ?? null,
              ftPct:  statMap.freeThrowPct                       ?? null,
              fgm:    statMap.fieldGoalsMade                     ?? null,
              fga:    statMap.fieldGoalsAttempted                ?? null,
              fg3m:   statMap.threePointFieldGoalsMade           ?? null,
              fg3a:   statMap.threePointFieldGoalsAttempted      ?? null,
              ftm:    statMap.freeThrowsMade                     ?? null,
              fta:    statMap.freeThrowsAttempted                ?? null,
            };
          }
        } catch(e) {
          console.error('[/api/player] season stats:', e.message);
        }
      }

      return sendJSON(res, 200, {
        ok: true, name, team: team || null, season: parseInt(season) || null,
        athleteId: athleteId || null, headshot,
        seasonStats, tournamentStats, recentGames,
      });
    } catch(e) {
      console.error('[/api/player]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/player/profile?name=Kevin%20Overton&team=Auburn&season=2026
  // Standalone profile: no gameIds required. Resolves athlete identity from
  // name+team (playerPhotoCache → ESPN search), fetches season stats and recent
  // game log via ESPN athlete event log, then returns a complete profile.
  // Reuses: searchESPNAthlete, playerPhotoCache, _parseBoxscorePlayerStats,
  //         _normPlayerName, _normPhoto, espnGet.
  if (pathname === '/api/player/profile') {
    try {
      const name   = (query.name   || '').trim();
      const team   = (query.team   || '').trim();
      const season = parseInt(query.season || new Date().getFullYear(), 10);
      if (!name || !team) return sendJSON(res, 400, { ok: false, error: 'name and team required' });

      const normN    = _normPhoto(name);
      const normT    = _normPhoto(team);
      const normName = _normPlayerName(name);

      // ── Step 1: Headshot + athlete ID ────────────────────────────────────────
      let headshot  = null;
      let athleteId = null;

      // Check playerPhotoCache (current + prior season to handle transfers)
      for (const yr of [season, season - 1]) {
        const c = playerPhotoCache[`${yr}:${normT}:${normN}`];
        if (c && c.source !== 'none' && c.photoUrl) { headshot = c.photoUrl; break; }
      }

      // ESPN search → authoritative athlete ID
      const espnId = await searchESPNAthlete(name, team);
      if (espnId) {
        athleteId = espnId;
        if (!headshot) headshot = `https://a.espncdn.com/i/headshots/mens-college-basketball/players/full/${espnId}.png`;
      }

      // ── Step 2: Season stats ──────────────────────────────────────────────────
      let seasonStats = null;
      if (athleteId) {
        try {
          const sd = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/athletes/${athleteId}/statistics`
          );
          const statMap = {};
          const cats = [
            ...(sd?.statistics?.[0]?.splits?.categories || []),
            ...(sd?.athlete?.statistics?.splits?.categories || []),
          ];
          for (const cat of cats) {
            for (const s of (cat?.stats || [])) {
              if (s.name && s.value != null) statMap[s.name] = s.value;
            }
          }
          const games = statMap.gamesPlayed ?? statMap.games ?? null;
          if (games && games >= 1) {
            seasonStats = {
              source: 'espn', games,
              pts:    statMap.avgPoints                          ?? null,
              reb:    statMap.avgRebounds                        ?? null,
              ast:    statMap.avgAssists                         ?? null,
              stl:    statMap.avgSteals                          ?? null,
              blk:    statMap.avgBlocks                          ?? null,
              to:     statMap.avgTurnovers                       ?? null,
              fgPct:  statMap.fieldGoalPct                       ?? null,
              fg3Pct: statMap.threePointPct                      ?? null,
              ftPct:  statMap.freeThrowPct                       ?? null,
              fgm:    statMap.fieldGoalsMade                     ?? null,
              fga:    statMap.fieldGoalsAttempted                ?? null,
              fg3m:   statMap.threePointFieldGoalsMade           ?? null,
              fg3a:   statMap.threePointFieldGoalsAttempted      ?? null,
              ftm:    statMap.freeThrowsMade                     ?? null,
              fta:    statMap.freeThrowsAttempted                ?? null,
            };
          }
        } catch(e) {
          console.warn('[/api/player/profile] season stats:', e.message);
        }
      }

      // ── Step 3: Game log via ESPN athlete event log ───────────────────────────
      let recentGames = [];
      if (athleteId) {
        try {
          const evData = await espnGet(
            `/apis/site/v2/sports/basketball/mens-college-basketball/athletes/${athleteId}/eventlog?season=${season}`
          );
          const items   = evData?.eventLog?.items || [];
          const gameIds = items
            .map(ev => ev.id || ev.event?.id)
            .filter(Boolean)
            .slice(-20);

          if (gameIds.length) {
            const normTeam = _normPlayerName(team);
            const settled  = await Promise.allSettled(gameIds.map(async gid => {
              try {
                const d  = await espnGet(
                  `/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${gid}`
                );
                const ps = _parseBoxscorePlayerStats(d.boxscore, normName);
                if (!ps) return null;
                if (!headshot && ps.headshot) headshot = ps.headshot;
                const comps   = d.header?.competitions?.[0] || {};
                const tComp   = (comps.competitors || []).find(c =>
                  _normPlayerName(c.team?.displayName      || '') === normTeam ||
                  _normPlayerName(c.team?.shortDisplayName || '') === normTeam);
                const oppComp = tComp?.homeAway === 'home'
                  ? (comps.competitors || []).find(c => c.homeAway === 'away')
                  : (comps.competitors || []).find(c => c.homeAway === 'home');
                return {
                  gameId:   String(gid),
                  date:     comps.startDate?.slice(0, 10) || null,
                  round:    comps.notes?.[0]?.headline || null,
                  opponent: oppComp?.team?.shortDisplayName || oppComp?.team?.displayName || '?',
                  oppScore: oppComp?.score ?? null,
                  myScore:  tComp?.score  ?? null,
                  pts: ps.pts, reb: ps.reb, ast: ps.ast, stl: ps.stl, blk: ps.blk,
                  fg:  `${ps.fg.m}-${ps.fg.a}`,
                  fg3: `${ps.fg3.m}-${ps.fg3.a}`,
                  ft:  `${ps.ft.m}-${ps.ft.a}`,
                };
              } catch(_) { return null; }
            }));
            recentGames = settled
              .filter(r => r.status === 'fulfilled' && r.value)
              .map(r => r.value)
              .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
          }
        } catch(e) {
          console.warn('[/api/player/profile] event log:', e.message);
        }
      }

      // ── Step 4: Aggregate game-log stats ──────────────────────────────────────
      let tournamentStats = null;
      if (recentGames.length) {
        const g = recentGames.length;
        let pts=0, reb=0, ast=0, stl=0, blk=0, fgm=0, fga=0, fg3m=0, fg3a=0, ftm=0, fta=0;
        const pf = s => { const [m,a]=(s||'0-0').split('-').map(Number); return [m||0, a||0]; };
        for (const gm of recentGames) {
          pts+=gm.pts||0; reb+=gm.reb||0; ast+=gm.ast||0; stl+=gm.stl||0; blk+=gm.blk||0;
          const [fm,fa]=pf(gm.fg);  fgm+=fm; fga+=fa;
          const [tm,ta]=pf(gm.fg3); fg3m+=tm; fg3a+=ta;
          const [xm,xa]=pf(gm.ft);  ftm+=xm; fta+=xa;
        }
        tournamentStats = {
          games:  g,
          pts:    +(pts/g).toFixed(1),  reb:    +(reb/g).toFixed(1),
          ast:    +(ast/g).toFixed(1),  stl:    +(stl/g).toFixed(1),
          blk:    +(blk/g).toFixed(1),
          fgPct:  fga  > 0 ? +(fgm/fga*100).toFixed(1)   : null,
          fg3Pct: fg3a > 0 ? +(fg3m/fg3a*100).toFixed(1) : null,
          ftPct:  fta  > 0 ? +(ftm/fta*100).toFixed(1)   : null,
          fgm, fga, fg3m, fg3a, ftm, fta,
        };
      }

      return sendJSON(res, 200, {
        ok: true, name, team, season,
        athleteId: athleteId || null,
        headshot,
        seasonStats,
        tournamentStats,
        recentGames,
      });
    } catch(e) {
      console.error('[/api/player/profile]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/coverage-scan?from=2002&to=2026[&slug=march-madness,nit][&force=1][&sync=1]
  // Returns per-tournament/year Men's CBB coverage metrics.
  // Default: returns cache immediately, queues background scan for missing entries.
  // sync=1: awaits each missing scan before responding (best for small slug+year requests).
  if (pathname === '/api/coverage-scan') {
    try {
      const curYear    = new Date().getFullYear();
      const fromYear   = Math.max(2002, parseInt(query.from || '2002'));
      const toYear     = Math.min(curYear, parseInt(query.to || String(curYear)));
      const slugFilter = query.slug ? query.slug.split(',').map(s => s.trim()) : null;
      const force      = query.force === '1';
      const sync       = query.sync  === '1';

      const tournList = slugFilter
        ? SCAN_TOURN.filter(t => slugFilter.includes(t.slug))
        : SCAN_TOURN;

      const years = [];
      for (let y = fromYear; y <= toYear; y++) years.push(y);

      if (force) {
        for (const t of tournList) {
          for (const year of years) {
            const k = `${t.slug}:${year}`;
            delete global._coverageCache[k];
            console.log(`[coverage-cache:clear] key=${k}`);
          }
        }
      }

      // ── Sync mode: scan missing entries NOW before building results ──────────
      if (sync) {
        const yearsDesc = [...years].sort((a, b) => b - a);
        for (const year of yearsDesc) {
          for (const t of tournList) {
            const key = `${t.slug}:${year}`;
            if (!global._coverageCache[key]) {
              console.log(`[coverage-scan:sync] ${t.slug} ${year}`);
              await _scanTournamentYear(t.slug, year);
            }
          }
        }
      }

      // ── Build results from cache ─────────────────────────────────────────────
      const results = [];
      const missing  = [];

      for (const t of tournList) {
        for (const year of years) {
          const key    = `${t.slug}:${year}`;
          const cached = global._coverageCache[key];
          if (cached) {
            console.log(`[coverage-cache:hit] key=${key}`);
            results.push(cached.record);
          } else {
            console.log(`[coverage-cache:miss] key=${key}`);
            results.push({
              tournament: t.name, slug: t.slug, year,
              games: null, gamesWithStats: null, gamesWithPbp: null,
              players: null, playersWithPhoto: null,
              photoCoveragePct: null, pbpCoveragePct: null,
              status: 'pending',
            });
            missing.push({ slug: t.slug, year });
          }
        }
      }

      // ── Background scan for still-missing entries (non-sync mode only) ───────
      if (!sync && missing.length > 0 && !_coverageScanActive) {
        const mSlugs = [...new Set(missing.map(m => m.slug))];
        const mYears = [...new Set(missing.map(m => m.year))].sort((a, b) => b - a);
        _runCoverageScan(mSlugs, mYears).catch(e =>
          console.error('[coverage-scan] bg error:', e.message)
        );
      }

      results.sort((a, b) => a.year - b.year || a.slug.localeCompare(b.slug));

      return sendJSON(res, 200, {
        ok: true,
        scanning:     _coverageScanActive,
        cachedCount:  results.filter(r => r.status !== 'pending').length,
        pendingCount: missing.length,
        generatedAt:  new Date().toISOString(),
        results,
      });
    } catch(e) {
      console.error('[/api/coverage-scan]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // ── NCAAF Football Endpoints ──────────────────────────────────────────────

  const NCAAF_CONF_GROUPS = {
    'sec': 8, 'big-ten': 5, 'acc': 1, 'big-12': 4,
    'pac-12': 9, 'mountain-west': 17, 'american': 62,
    'sun-belt': 37, 'mac': 15, 'cusa': 12, 'fbs': 80
  };

  // /api/espn/football/scoreboard?date=20240915&week=3&season=2024&seasontype=2
  if (pathname === '/api/espn/football/scoreboard') {
    try {
      const date       = query.date;
      const week       = query.week;
      const season     = query.season || new Date().getFullYear().toString();
      const seasontype = query.seasontype || '2';
      const groups     = query.groups || '80';
      let espnPath;
      if (date) {
        espnPath = `/apis/site/v2/sports/football/college-football/scoreboard?dates=${date}&groups=${groups}&limit=100&seasontype=${seasontype}`;
      } else if (week) {
        espnPath = `/apis/site/v2/sports/football/college-football/scoreboard?week=${week}&season=${season}&seasontype=${seasontype}&groups=${groups}&limit=100`;
      } else {
        espnPath = `/apis/site/v2/sports/football/college-football/scoreboard?season=${season}&seasontype=${seasontype}&groups=${groups}&limit=100`;
      }
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
      const contests = (data.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(t => t.homeAway === 'home');
        const away = comp?.competitors?.find(t => t.homeAway === 'away');
        const status = comp?.status;
        const broadcast = comp?.broadcasts?.[0]?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '';
        let gameState = 'P';
        if (status?.type?.state === 'in') gameState = 'I';
        else if (status?.type?.state === 'post') gameState = 'F';
        return {
          contestId: ev.id,
          gameState,
          currentPeriod: (() => {
            if (status?.type?.state !== 'in') return '';
            const p = status?.period || 1;
            return p <= 4 ? `Q${p}` : `OT${p - 4}`;
          })(),
          contestClock: status?.type?.state === 'in' ? status?.displayClock || '' : '',
          finalMessage: gameState === 'F' ? 'FINAL' : '',
          startDate: ev.date ? new Date(ev.date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'America/New_York' }) : '',
          startTime: ev.date ? new Date(ev.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) : '',
          startTimeEpoch: ev.date ? Math.floor(new Date(ev.date).getTime() / 1000) : 0,
          broadcasterName: broadcast,
          roundDescription: comp?.notes?.[0]?.headline || comp?.groups?.shortName || 'FBS Football',
          source: 'ESPN',
          teams: [
            home ? {
              isHome: true,
              nameShort: home.team?.shortDisplayName || home.team?.name || '?',
              name6Char: home.team?.abbreviation || '',
              score: home.score != null ? parseInt(home.score) : null,
              isWinner: home.winner || false,
              teamRank: home.curatedRank?.current < 26 ? home.curatedRank?.current : null,
              seed: null,
              color: home.team?.color ? '#' + home.team.color : '#1a3fa8',
              espnLogoUrl: home.team?.logo,
            } : null,
            away ? {
              isHome: false,
              nameShort: away.team?.shortDisplayName || away.team?.name || '?',
              name6Char: away.team?.abbreviation || '',
              score: away.score != null ? parseInt(away.score) : null,
              isWinner: away.winner || false,
              teamRank: away.curatedRank?.current < 26 ? away.curatedRank?.current : null,
              seed: null,
              color: away.team?.color ? '#' + away.team.color : '#ef4444',
              espnLogoUrl: away.team?.logo,
            } : null,
          ].filter(Boolean),
        };
      });
      return sendJSON(res, 200, { ok: true, contests, season, week: week || null, total: contests.length });
    } catch(e) {
      console.error('[/api/espn/football/scoreboard]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/football/rankings?poll=ap|coaches
  if (pathname === '/api/espn/football/rankings') {
    try {
      const poll = (query.poll || 'ap').toLowerCase();
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: '/apis/site/v2/sports/football/college-football/rankings',
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
      const polls = data.rankings || [];
      const targetName = poll === 'coaches' ? 'coaches' : 'ap';
      const found = polls.find(p => p.name?.toLowerCase().includes(targetName)) || polls[0];
      if (!found) return sendJSON(res, 404, { ok: false, error: 'Rankings not found' });
      const rankings = (found.ranks || []).map(r => ({
        rank: r.current,
        prevRank: r.previous || null,
        nameShort: r.team?.shortDisplayName || r.team?.name || '?',
        espnLogo: r.team?.logo || null,
        wins: r.recordSummary?.split('-')?.[0] || null,
        losses: r.recordSummary?.split('-')?.[1] || null,
        points: r.points || null,
      }));
      return sendJSON(res, 200, { ok: true, poll: found.name, rankings });
    } catch(e) {
      console.error('[/api/espn/football/rankings]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/football/summary?gameId=401628567
  if (pathname === '/api/espn/football/summary') {
    try {
      const gameId = query.gameId;
      if (!gameId) return sendJSON(res, 400, { ok: false, error: 'gameId required' });
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: `/apis/site/v2/sports/football/college-football/summary?event=${gameId}`,
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
        drives: data.drives || null,
        scoringPlays: data.scoringPlays || [],
        leaders: data.leaders || [],
        header: data.header || null,
      });
    } catch(e) {
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/football/standings?season=2024&group=8
  if (pathname === '/api/espn/football/standings') {
    try {
      const season = query.season || new Date().getFullYear().toString();
      const group  = query.group  || '80';
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'site.api.espn.com',
          path: `/apis/v2/sports/football/college-football/standings?group=${group}&season=${season}`,
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
      const children = data.children || [];
      const rows = [];
      let rank = 1;
      for (const div of children) {
        for (const entry of (div.standings?.entries || [])) {
          const t = entry.team || {};
          const stats = entry.stats || [];
          const stat = (key) => {
            const s = stats.find(s => s.name === key || s.abbreviation === key || s.shortDisplayName === key);
            return s ? (s.displayValue || s.value?.toString() || '') : '';
          };
          rows.push({
            rank: rank++,
            division: div.name || '',
            teamId: t.id || '',
            teamName: t.shortDisplayName || t.displayName || t.name || '?',
            teamLogo: t.logos?.[0]?.href || null,
            teamColor: t.color ? '#' + t.color : '#1a3fa8',
            overall: stat('overall'),
            conf: stat('vs. Conf.') || stat('conferenceRecord') || stat('Conference'),
            gb: stat('gamesBehind') || '',
          });
        }
      }
      if (!rows.length) {
        const entries = data.standings?.entries || data.entries || [];
        let r = 1;
        for (const entry of entries) {
          const t = entry.team || {};
          const stats = entry.stats || [];
          const stat = (key) => {
            const s = stats.find(s => s.name === key || s.abbreviation === key);
            return s ? (s.displayValue || '') : '';
          };
          rows.push({
            rank: r++,
            division: '',
            teamId: t.id || '',
            teamName: t.shortDisplayName || t.displayName || t.name || '?',
            teamLogo: t.logos?.[0]?.href || null,
            teamColor: t.color ? '#' + t.color : '#1a3fa8',
            overall: stat('overall'),
            conf: stat('vs. Conf.') || stat('conferenceRecord'),
            gb: stat('gamesBehind') || '',
          });
        }
      }
      return sendJSON(res, 200, { ok: true, season, group, rows });
    } catch(e) {
      console.error('[/api/espn/football/standings]', e.message);
      return sendJSON(res, 500, { ok: false, error: e.message });
    }
  }

  // /api/espn/football/cfp-bracket?season=2024
  if (pathname === '/api/espn/football/cfp-bracket') {
    try {
      const season = parseInt(query.season || '2024');
      if (season < 2014) return sendJSON(res, 400, { ok: false, error: 'CFP started in 2014' });
      async function fetchFbDay(dateStr) {
        return new Promise((resolve) => {
          const p = `/apis/site/v2/sports/football/college-football/scoreboard?dates=${dateStr}&groups=80&limit=100&seasontype=3`;
          const opts = { hostname: 'site.api.espn.com', path: p, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } };
          https.get(opts, r => {
            let body = '';
            r.on('data', c => body += c);
            r.on('end', () => {
              try { resolve(JSON.parse(body).events || []); }
              catch(e) { resolve([]); }
            });
          }).on('error', () => resolve([]));
        });
      }
      const dates = [];
      for (let d = new Date(`${season}-12-20T12:00:00Z`); d <= new Date(`${season + 1}-01-25T12:00:00Z`); d.setDate(d.getDate() + 1)) {
        dates.push(d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'));
      }
      const allEvents = [];
      for (let i = 0; i < dates.length; i += 5) {
        const batch = dates.slice(i, i + 5);
        const results = await Promise.all(batch.map(fetchFbDay));
        results.forEach(evs => allEvents.push(...evs));
      }
      const seen = new Set();
      const events = allEvents.filter(ev => { if (seen.has(ev.id)) return false; seen.add(ev.id); return true; });
      events.sort((a, b) => new Date(a.date) - new Date(b.date));
      const contests = events.map((ev, i) => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(t => t.homeAway === 'home');
        const away = comp?.competitors?.find(t => t.homeAway === 'away');
        const status = comp?.status;
        let gameState = 'P';
        if (status?.type?.state === 'in') gameState = 'I';
        else if (status?.type?.state === 'post') gameState = 'F';
        return {
          bracketId: i + 1,
          contestId: ev.id,
          gameState,
          startDate: ev.date ? new Date(ev.date).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'America/New_York' }) : '',
          startTime: ev.date ? new Date(ev.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }) : '',
          startTimeEpoch: ev.date ? Math.floor(new Date(ev.date).getTime() / 1000) : 0,
          broadcasterName: comp?.broadcasts?.[0]?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '',
          roundDescription: comp?.notes?.[0]?.headline || ev.name || 'CFP Game',
          teams: [
            home ? {
              isHome: true,
              nameShort: home.team?.shortDisplayName || '?',
              name6Char: home.team?.abbreviation || '',
              score: home.score != null ? parseInt(home.score) : null,
              isWinner: home.winner || false,
              seed: home.seed ? parseInt(home.seed) : null,
              color: home.team?.color ? '#' + home.team.color : '#1a3fa8',
              espnLogoUrl: home.team?.logo,
            } : null,
            away ? {
              isHome: false,
              nameShort: away.team?.shortDisplayName || '?',
              name6Char: away.team?.abbreviation || '',
              score: away.score != null ? parseInt(away.score) : null,
              isWinner: away.winner || false,
              seed: away.seed ? parseInt(away.seed) : null,
              color: away.team?.color ? '#' + away.team.color : '#ef4444',
              espnLogoUrl: away.team?.logo,
            } : null,
          ].filter(Boolean),
        };
      });
      return sendJSON(res, 200, { ok: true, season, total: contests.length, contests });
    } catch(e) {
      console.error('[/api/espn/football/cfp-bracket]', e.message);
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
