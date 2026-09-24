# SnapVote 📸

A password-protected photo party game in the spirit of Kahoot. The host picks the tasks, everyone snaps a photo on their phone before the timer runs out, people vote anonymously for their favourites (up to 3, never their own), points go up on the scoreboard, and the night ends with a top-10 ceremony and a drum-roll reveal of #1.

It runs **free on Cloudflare Workers**. It's always on: no sleeping, no wiped photos, no credit card, and it works from any network.

---

## Put it online: everything in the browser, nothing to install (about 10 minutes, one time)

You need two free accounts: **GitHub**, which keeps the code, and **Cloudflare**, which runs the game. No credit card is needed for either.

**1. Put the files on GitHub**
1. Sign up at <https://github.com/signup>, or log in.
2. Create a new repository at <https://github.com/new>. Name it `snapvote`, choose **Public** and click **Create repository**. The code contains no passwords or photos, so public is safe.
3. On the next page, click **uploading an existing file**.
4. Unzip the SnapVote download: in Windows, right-click it → **Extract All**. Open the extracted folder, select **everything inside it** (Ctrl+A) and **drag it all into the GitHub page**. Wait until every file is listed, then click **Commit changes**.

**2. Deploy it on Cloudflare**
1. Open this link, replacing `YOUR-GITHUB-NAME` with your GitHub username:
   `https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-NAME/snapvote`
2. Log in to Cloudflare, or sign up (free), and connect your GitHub account when asked.
3. On the setup page, keep the Worker name **`snapvote`** and enter your two passwords:
   - **SITE_PASSWORD**, the player password, which you give to players
   - **ADMIN_PASSWORD**, the admin password, which you keep to yourself

   Each needs at least 8 characters, and they must be different.
4. Click the deploy button at the bottom of the page. After a minute or two you get your link, like `https://snapvote.<your-name>.workers.dev`.

Then open `<your link>/host` and log in with the admin password.

| | What it's for | Share it? |
|---|---|---|
| **Player password** | Joining games and seeing the photos | ✅ Give it to the people playing |
| **Admin password** | Hosting games, the admin panel, downloading and deleting photos | ❌ Keep it to yourself |

To change a password later: in the Cloudflare dashboard, go to **Workers & Pages → snapvote → Settings → Variables and Secrets**, edit it, and click **Deploy**. Until both passwords are set properly, the site shows an "Almost ready" page with these same steps, and nothing else is reachable.

**Updating:** any change pushed to the GitHub repository Cloudflare created for you is deployed automatically.

<details>
<summary>Alternative: deploy from your own computer (needs Node.js installed)</summary>

1. Install Node.js LTS from <https://nodejs.org>.
2. Double-click `deploy-mac.command` (Mac) or `deploy-windows.cmd` (Windows), or run `./deploy-linux.sh`.
3. Log in to Cloudflare in the browser window that opens. The script uploads SnapVote, creates both passwords, prints your link and saves everything in `SNAPVOTE-ACCESS.txt`. Run it again to publish updates, or use `--reset-passwords` to make new passwords.
</details>

## Running a game

1. Open **`<your link>/host`** on the laptop connected to the big screen, and log in with the admin password.
2. Add rounds: a task (or tap **🎲 Idea**), points per vote, photo time, voting time and an optional example image. Your setup is saved as you type.
3. Click **Create game**. The screen shows a **QR code** and a 5-letter game code.
4. Players **scan the QR code**, enter the player password once per device, and pick a nickname. Late arrivals can join any time before the ceremony.
5. Click **Start**. For each round:
   - **Photo time**: everyone sees the task and a countdown. They can take a photo directly or pick one from their phone. The big screen shows who has submitted. The round moves on as soon as everyone has submitted, or you can end it early.
   - **Voting**: an anonymous, shuffled gallery. Each player sees everyone's photos except their own, taps up to 3 favourites and locks in.
   - **Results**: photos are shown with names and votes. Each vote is worth the round's points.
6. After the last round, click **Start the ceremony** and reveal places from #10 upwards. Final scores stay hidden until then, so the #1 reveal (drum-roll, then confetti on every phone) is a real surprise. Ties share a place, and joint winners are revealed together.

**Moderation:** on the host screen you can remove a player (×) or an individual photo at any time. Removing a photo also takes back its points.

## Getting the photos

- On the **host screen**, after the ceremony: **📦 Download all photos (.zip)**.
- In the **admin panel** (`<your link>/admin`): every game ever played, with a storage meter, a photo gallery, a zip download and a delete button.

The zip is organised by round, and each file is named by its place and number of votes. It also includes `results.csv` and `results.json`:

```
SnapVote ABCDE 2026-09-24/
  Round 01 - Something red/
    01 - 5 votes - Alice.jpg
    02 - 3 votes - Bob.jpg
    _example image.jpg
  Round 02 - Best fake smile/
    ...
  results.csv
  results.json
```

## What it costs and the free-plan limits

Nothing. Everything fits inside Cloudflare's Workers **free plan**:

- **5 GB of storage.** Photos are shrunk on the phone before upload, to at most 1440 px and about 150–600 KB each, so that's over 10,000 photos. The admin panel shows how much you've used; download and delete old games to free space.
- **About 100,000 requests a day.** A 30-person game night uses a small fraction of that.
- **3,000 build minutes a month** for automatic deploys from GitHub. Each deploy takes about a minute.
- If you ever hit a daily limit, requests fail until the next day. You're **never charged**, because the free plan has no card on file.

## Security and privacy

- Nothing can be seen or joined without the player password, and hosting or downloads need the separate admin password. Both are stored as encrypted Cloudflare secrets, never in the files.
- Password guessing is blocked for 15 minutes after 10 wrong tries from the same network address.
- Photos are **re-encoded on the phone**. This strips hidden metadata such as **GPS location**. The server only accepts real JPEG, PNG or WebP images.
- The gallery is anonymous. Photo ids are random and aren't linked to player ids, and the ceremony never sends the winner's name to phones before its reveal.
- Pages are marked `noindex`, so search engines won't list your game.

## Trying it on your own computer first (optional)

```bash
npm install
npm run dev        # → http://localhost:8787, player password "player-pass", admin password "admin-pass"
npm test           # unit tests for the game rules
```

## Troubleshooting

- **“You need a workers.dev subdomain”:** open <https://dash.cloudflare.com> → Workers & Pages, pick a free subdomain, then retry the deploy.
- **A player's phone says “Reconnecting…”:** this is normal when they switch to the camera app. It reconnects on its own the moment they come back.
- **Lost the passwords:** set new ones in the Cloudflare dashboard (**Workers & Pages → snapvote → Settings → Variables and Secrets**).
- **The deploy fails with a name mismatch:** the Worker name on the setup page must be `snapvote`, matching `wrangler.jsonc`.
- **"Almost ready" page:** the passwords are missing, too short, identical, or still the example text. The page lists the fix.

## How it's built (for the curious)

- `src/index.js`: the Worker. It enforces the password gate on every request and routes requests to the pages, the API, photos and live updates.
- `src/hub.js`: a single Durable Object holding every game. It stores photos, votes and scores in SQLite, keeps each screen in sync over WebSockets, and runs the round timers with alarms, so they keep ticking even if the host's laptop sleeps.
- `src/logic.js`: the pure game rules (validation, anonymous shuffling, vote sanitising, tie-aware ranking), covered by `npm test`.
- `public/`: plain HTML, CSS and JS with no build step. The zip export (fflate) and the QR code (qrcode-generator), both MIT-licensed, are bundled in `public/vendor/`.
