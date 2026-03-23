# CollegeOnTV 🏀

NCAA Men's Basketball D-I — Live Scores & Stats
Inspired by SofaScore

## Quick Start

```bash
# 1. Go to the project folder
cd collegeontv

# 2. Start the server (zero dependencies needed!)
node server.js

# 3. Open your browser
http://localhost:3000
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health check |
| `GET /api/contests?date=MM/DD/YYYY` | Get all games for a date |
| `GET /api/schedule?date=MM/DD/YYYY` | Full schedule + live info |
| `GET /api/bracket` | NCAA bracket data |

## Project Structure

```
collegeontv/
├── server.js          ← Backend (pure Node.js, no dependencies)
├── public/
│   └── index.html     ← Frontend (SofaScore-style UI)
└── README.md
```

## Features
- ✅ Live scores with auto-refresh every 30s
- ✅ Filter: Live / Final / Upcoming
- ✅ Date navigation
- ✅ Search by team or conference
- ✅ Conference grouping (ACC, Big Ten, SEC...)
- ✅ Game detail with score, period, broadcaster
- ✅ Vote "Who will win?"
- ✅ Favorites (saved in localStorage)
