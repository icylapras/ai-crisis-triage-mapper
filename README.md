# AI Crisis Triage Mapper

Two roles, three routes, and one live crisis picture:

- **`/user`** — a reporter can type a crisis report or start a low-latency
  Gemini Live voice conversation. The voice assistant listens, responds aloud,
  and can hand structured incident details to responders.
- **`/responder`** — a live, sortable event feed beside an interactive 3D
  globe. Zoom into a country to filter the feed; select an event for its full
  AI summary and a Google Maps directions link.
- **`/news`** — a calm, responsive local crisis briefing.

The reporter and news views use the Neural Expressive visual system, while the
responder view keeps the operational data dense and scannable.

Built with **FastAPI** and **React + Vite**.

> **No API key? Typed reporting still works.** Without `GEMINI_API_KEY`, the
> backend uses deterministic triage/support fallbacks. Gemini Live voice mode
> requires a key and displays a recoverable error when one is unavailable.

## Prerequisites

- Python 3.10+
- Node.js 18+ and npm
- A [Gemini API key](https://aistudio.google.com/apikey) for Gemini Live voice
  and live extraction
- A modern browser with microphone and AudioWorklet support

## Project layout

```text
google_hackathon/
├── backend/
│   ├── main.py                    # Gemini triage, mock mode, SQLite, REST
│   ├── live_support.py            # Gemini Live session + responder tool
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── public/pcm-recorder-worklet.js
    ├── public/countries.geojson   # bundled country borders
    └── src/
        ├── live/LiveVoiceClient.js
        ├── pages/UserPage.jsx
        ├── pages/NewsPage.jsx
        ├── pages/ResponderPage.jsx
        ├── components/ReportOverlay.jsx
        ├── utils/geo.js
        └── api.js
```

## Run the backend

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt

# Optional: enable Gemini instead of deterministic mock mode.
cp backend/.env.example backend/.env
# Edit backend/.env and set GEMINI_API_KEY.
# Optional: override GEMINI_MODEL, GEMINI_LIVE_MODEL, or GEMINI_LIVE_VOICE.

cd backend
uvicorn main:app --reload --port 8000
```

The API runs at `http://localhost:8000`; interactive documentation is available
at `/docs`. `GET /` reports whether extraction is in `gemini` or `mock` mode.

## Run the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open the printed URL, normally `http://localhost:5173`. The app redirects to
`/user`.

To use another backend origin:

```bash
cp frontend/.env.example frontend/.env
```

Then set `VITE_API_BASE_URL` in `frontend/.env`.

## End-to-end flow

1. Submit a typed report, or press the microphone to start Gemini Live.
2. Typed reports use `POST /api/triage` and `POST /api/support`.
3. Voice mode streams 16 kHz PCM over `/ws/live-support`; Gemini returns
   24 kHz voice audio plus input/output transcripts.
4. When Gemini has enough incident information, its
   `submit_responder_report` tool stores the report through the same SQLite
   report pipeline as typed triage. The tool is idempotent within a session.
5. `/responder` polls `GET /api/reports` approximately every four seconds.
6. Sort by urgency or recency, zoom to filter by country, and select any event
   to inspect its summary, personal details, location, and directions.

Critical events use neon red for urgency above 7; elevated events use neon
yellow.

## Gemini Live voice flow

The browser never receives the long-lived Gemini API key. It sends raw
microphone PCM to the FastAPI WebSocket, which owns the Google GenAI SDK
session. Server-side voice activity detection lets the user interrupt Gemini;
the browser immediately clears queued playback when an interruption event
arrives. Transcript chunks populate the same conversation UI as typed chat.

The system prompt follows psychological-first-aid priorities: check immediate
safety, listen without pressuring the person, offer one practical step at a
time, and link the person to responders. The assistant does not claim to be an
emergency service and does not confirm a handoff until the report tool succeeds.

Gemini Live is a preview API. The configured default is
`gemini-3.1-flash-live-preview`, and the dedicated live model can be changed
with `GEMINI_LIVE_MODEL`. See the
[official Gemini Live documentation](https://ai.google.dev/gemini-api/docs/live-api).

To test the UI:

1. Start the backend and frontend with the commands above.
2. Open `http://localhost:5173/user`.
3. Press the microphone and allow browser microphone access.
4. Speak naturally, pause for Gemini to answer, and interrupt while it is
   speaking to verify barge-in.
5. Provide an incident and location, then confirm that the responder handoff
   appears in the conversation and on `/responder`.
6. Press the waveform to end the session and return to typed input.

## API reference

| Method | Endpoint | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/triage` | `{ "raw_text": "…" }` | Stored structured report |
| `POST` | `/api/support` | `{ "raw_text": "…", "history": [] }` | Calming response and immediate actions |
| `GET` | `/api/reports` | — | All reports, newest first |
| `GET` | `/` | — | Health and current extraction mode |
| `WS` | `/ws/live-support` | Binary 16 kHz PCM + JSON control frames | Binary 24 kHz PCM + transcript/handoff events |

A report contains `id`, `created_at`, `name`, `age`, `urgency`, `title`,
`summary`, `notes`, `other_data`, `location`, `lat`, and `lng`. Missing text
fields return as `"n/a"` and missing coordinates as `null`.

## Notes

- Gemini triage/support and deterministic fallbacks live in `backend/main.py`.
- Gemini Live setup, crisis prompt, interruption handling, and the responder
  tool live in `backend/live_support.py`.
- Data persists in `backend/crisis.db`, which is gitignored.
- Globe layers, filtering, polling, and urgency colors live in
  `frontend/src/pages/ResponderPage.jsx`.
