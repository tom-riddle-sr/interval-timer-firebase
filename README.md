# Interval Timer

An iOS-style web-based interval training timer with cloud sync and workout history.

**Live demo:** <https://tom-riddle-sr.github.io/interval-timer-firebase/>

## Features

- **Multi-stage customization** — add, remove, drag-reorder; each stage has a name, duration, and color
- **Round cycling** — 1 to 99 rounds per workout
- **Sound cues** — countdown beeps for the last 3 seconds, transition bell, completion chord (Web Audio API)
- **Voice prompts** — Traditional Chinese (zh-TW) speech announcements via SpeechSynthesis
- **One-tap presets** — Tabata / HIIT / EMOM / Warm-up
- **iOS-style UI** — rounded cards, dark mode, SF font, blur modal sheets, SVG progress ring
- **Wake Lock** — keeps the screen on during a workout
- **Keyboard shortcuts** — Space to pause, ←/→ to skip, Esc to exit
- **Cloud sync** — Google sign-in syncs settings across devices via Firestore
- **Workout history** — every completed session is logged automatically
- **Stats dashboard** — total workouts, total time, current streak, weekly count
- **Offline-friendly** — falls back to `localStorage` when not signed in

## Tech Stack

- **Frontend:** vanilla HTML / CSS / ES modules — no framework, no build step
- **Auth:** Firebase Authentication (Google provider)
- **Database:** Cloud Firestore (asia-east1)
- **Hosting:** GitHub Pages
- **CI/CD:** GitHub Actions (auto-deploy on push to `main`)

## Project Structure

```
interval-timer-firebase/
├── index.html                      # Markup (3 screens + history + modal)
├── style.css                       # iOS-style theming
├── app.js                          # Timer logic, audio, voice, sync, history
├── firebase.js                     # Firebase Auth + Firestore wrapper
├── firestore.rules                 # Per-user security rules
├── .github/workflows/deploy.yml    # GitHub Pages auto-deploy
└── README.md
```

## Data Model (Firestore)

Each authenticated user has a private document tree:

```
users/{uid}/
├── meta/settings              # rounds, voice/sound toggles, stages[]
└── workouts/{auto-id}         # one document per completed workout
    ├── startedAt:    number   (epoch ms)
    ├── completedAt:  serverTimestamp
    ├── durationSec:  number
    ├── rounds:       number
    └── stages: [
        { name, duration, color, phase }
      ]
```

Security rules ensure that only the matching user can read or write their own data:

```
match /users/{uid}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```

## Local Development

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# then visit http://localhost:8080
```

The app works without sign-in — it simply uses `localStorage` instead of Firestore.

## Deployment

Every push to `main` triggers a GitHub Actions workflow that publishes the site to GitHub Pages within 1–2 minutes.

```bash
git add .
git commit -m "your changes"
git push
```

To watch the deploy:

```bash
gh run watch
```

## Setting Up Your Own Firebase Backend

If you fork this and want your own Firebase project:

1. **Create a Firebase project** at <https://console.firebase.google.com/>.
2. **Add a Web app** under *Project settings → Your apps → `</>`*. Copy the `firebaseConfig` object.
3. **Replace** the `firebaseConfig` in [`firebase.js`](./firebase.js) with your own.
4. **Enable Google sign-in:** *Build → Authentication → Sign-in method → Google → Enable.*
5. **Authorize your domain:** *Authentication → Settings → Authorized domains → add your GitHub Pages host* (e.g. `your-username.github.io`).
6. **Create Firestore:** *Build → Firestore Database → Create database → Production mode → asia-east1*.
7. **Apply security rules:** *Firestore → Rules → paste the contents of [`firestore.rules`](./firestore.rules) → Publish*.

The `apiKey` in `firebaseConfig` is a **public web key** — it is safe to commit. Real protection comes from the security rules and authorized-domain list.

## Keyboard Shortcuts (during a workout)

| Key | Action |
|-----|--------|
| `Space` | Pause / Resume |
| `→` | Next stage |
| `←` | Previous stage / Restart current stage |
| `Esc` | Exit workout |

## Browser Requirements

- Modern Chrome / Safari / Edge / Firefox
- Voice prompts require the `SpeechSynthesis` API (built into all major browsers)
- Screen-wake requires the Wake Lock API (supported on most mobile browsers)

## License

MIT
