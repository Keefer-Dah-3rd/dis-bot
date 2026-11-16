# Mibbit Notes bot

A Discord bot for the Mibbit team. It collects notes, decisions and action items, files them into a forum channel by tag, posts a Monday round-up, and turns meeting transcripts into summaries you can ask questions about.

It runs **on demand**. It sleeps until someone uses a command or presses a button, wakes for that one job, and goes back to sleep. A timer wakes it on Monday mornings for the digest. Nothing needs to stay running on anyone's computer.

## What it does

| How | What happens |
|---|---|
| `/note` | Saves whatever you type. Add `#idea`, `#bug`, `#design`, `#feedback` or `#decision` to tag it, or pick a tag. |
| Right-click a message → **Apps → Save as note** | Saves someone else's message with a link back to it. You can change the tag right after. |
| `/decide` | Logs a decision and why. Posted so everyone sees it. |
| `/todo` | Creates an action item for someone (pings them) with a **Mark done** button. |
| `/todos` | Lists open action items and lets you mark them done. |
| `/notes search`, `recent`, `tag`, `delete` | Finds or removes notes. Only you see the results. |
| `/digest` | Posts the weekly round-up now. It also posts itself every Monday at 9:00 (New York time). |
| `/setup` | Creates the bot's channels (#notes, #meeting-notes, #weekly-digest) and sets the Monday timer. |
| `/meeting summarize` | Summarizes a transcript file, or this channel's last few hours, into **⭐ Important**, **🔄 Changes** and **❓ Open questions**, posted in #meeting-notes. *Needs AI.* |
| **Ask a question** (button under each summary) | Opens a small form. The answer, with where in the meeting it came from, is posted in the summary's thread. *Needs AI.* |
| `/meeting ask`, `list`, `notes` | Ask by command, see recent meetings, or download a meeting's full numbered notes. |

In #notes, each tag has **one post** (💡 Ideas, 🎨 Design, 🐛 Bugs, 💬 Feedback, ✅ Decisions, 📋 Action items, 📝 General), and notes land as replies inside the right one. Changing a note's tag moves it.

Because the bot isn't listening all the time, it can't react to 📌 or to plain messages. Use the right-click menu and the **Ask a question** button instead.

---

## Where it runs

On **Supabase** (free plan): a small function that Discord calls, plus a database for the notes. Supabase pauses free projects that look unused for a week, so the timer also does a tiny check-in once a day. It uses no AI and costs nothing. If the bot ever stops answering, open the project in the Supabase dashboard and click **Restore**.

## One-time setup

The Discord side (the app, its settings, adding it to the server) is already done. To put the bot on Supabase:

1. **Create the project.** At [supabase.com](https://supabase.com), **New project** in your free organization → name it `mibbit-notes`. For the database password, use **Generate a password**: the bot never needs it. You can untick **Data API**, since the bot talks to the database directly.
2. **Give this folder access.** In Supabase, open **Account → Access Tokens** ([link](https://supabase.com/dashboard/account/tokens)) → **Generate new token**. Paste it after `SUPABASE_ACCESS_TOKEN=` in `.env`.
3. **Link this folder to the project** (the project ID is in its dashboard address):
   ```bash
   npx supabase link --project-ref <project-id>
   ```
4. **Create the tables:**
   ```bash
   npx supabase db push --remote
   ```
5. **Deploy.** This uploads the bot, saves its settings in Supabase, registers the commands and points Discord at the bot:
   ```bash
   npm run deploy
   ```
6. In Discord, run **`/setup`** once. That sets the Monday timer, and reuses the channels if they already exist.

After changing the code, just run `npm run deploy` again.

## Meeting notes (optional, uses AI)

AI is **off** until an Anthropic API key is added, and nothing is spent while it's off.

1. At [console.anthropic.com](https://console.anthropic.com), go to **API Keys** → **Create Key** and copy it.
2. Paste it after `ANTHROPIC_API_KEY=` in `.env`, then run `npm run deploy`.

**Cost:** only summaries and questions use tokens. Notes, search, the digest and the bot sleeping don't. Rough estimate: 5–10¢ to summarize an hour-long meeting, about 4¢ for the first question on it, and well under 1¢ for follow-ups within a few minutes. `npm run try-meeting` runs a real summary of the sample meeting in the terminal and prints what it cost.

**Transcripts it reads:** `.vtt` (Zoom, Google Meet, Teams), `.srt`, and `.txt`/`.md` (including Otter exports and "Name: text" notes). It doesn't read audio or video files: export the transcript from your meeting tool, or see “Notes from a voice call” below.

Very long meetings may hit Supabase's 150-second limit per request. The bot then says Claude took too long. Split the transcript into parts.

## Notes from a voice call (recorded on a Mac)

The bot can't join a voice call, so a small Mac app records the call on the computer of someone who's in it. Tell the others it's being recorded.

1. **Record.** Start the recorder; a red **● REC** timer appears in the menu bar. macOS asks once for the microphone and once for system audio.
   ```bash
   open "recorder/build/Mibbit Meeting Recorder.app" --args ~/Desktop/meeting
   ```
   It records Discord's sound (everyone else) and the microphone (you) into that folder. Stop it from the menu-bar item.
2. **Transcribe.** Free, and runs on the Mac; it takes about as long as the meeting did. Add `--follow` to start while the meeting is still going, so only the last few minutes are left at the end.
   ```bash
   python3 recorder/make_transcript.py ~/Desktop/meeting/notes ~/Desktop/meeting --me Ana --speakers 3
   ```
   `--me` is the name of the person at the recording Mac, and `--speakers` is how many people talked, if you know.
3. **Post.** Sends the transcript to the bot, which summarizes it and posts in #meeting-notes like `/meeting summarize` (this is the step that uses AI).
   ```bash
   npm run post-meeting -- ~/Desktop/meeting/notes/for-bot.txt "Monday sync"
   ```

Everyone except the person at the recording Mac comes out as "Speaker 1", "Speaker 2"… Rename them in `for-bot.txt` before posting if you know who is who.

If the recording Mac plays the call through speakers, its microphone hears everyone twice. The transcript step removes those repeats (`cleanup.json` says how many words it dropped). Headphones avoid the problem altogether.

Recordings are private: keep them out of this folder, which is a public repository.

## Not built yet

- The bot joining a voice call itself, so nobody has to run the recorder.
- Turning meeting action items into `/todo` items automatically.

---

## For engineers

- **Runtime:** a Supabase Edge Function (Deno), `supabase/functions/discord-bot/index.ts`, receiving Discord HTTP interactions (Ed25519-verified) at `/functions/v1/discord-bot`. Slow work (AI, posting, forum filing) runs after the 3-second ack via `EdgeRuntime.waitUntil`, then edits the original response through the interaction webhook.
- **Shared code:** everything runtime-neutral is in `supabase/functions/_shared/`, which Node tests import directly:
  - `app.js`: routing and the timer endpoint.
  - `notes-handlers.js` and `meeting-handlers.js`: the commands.
  - `filing.js`: forum posts. A per-note Postgres advisory lock prevents duplicate copies.
  - `db.js`: the Postgres repository.
  - `discord-api.js`: REST calls.
  - `meetings.js`: prompts, schemas and rendering.
  - `transcript.js`: parsing.
  - `ai.js`: the Anthropic SDK, with structured outputs and server-side refusal fallback. It only exists when `ANTHROPIC_API_KEY` is set.
- **Database:** `supabase/migrations/`. Every table has row-level security on with no policies, so only the function's own connection reads data. Search uses a generated `tsvector` column.
- **Timers:** pg_cron + pg_net, created by `/setup` (`setup.js#scheduleTimers`): the Monday digest at the configured local hour (both daylight-saving variants), plus one daily check-in. The URL and `CRON_SECRET` live only in the database.
- **Settings (Supabase secrets, set by `npm run deploy`):** `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `CRON_SECRET`, `DIGEST_TZ` (defaults to your computer's timezone), `DIGEST_DAY`, `DIGEST_HOUR`, and optionally `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
- **Recorder:** `recorder/main.swift` is a menu-bar app that records Discord with a Core Audio process tap (macOS 14.4+) and the default microphone into two CAF files. The tap sits in an aggregate device with no output sub-device: tying it to a real output device clocks the capture off that device, which resampled the call wrongly when the rates differed and silenced it when the device went away. Build it with `recorder/build.sh`. Both files are timed by the host clock (gaps are padded with silence, so the tracks stay aligned when audio is dropped), and a watchdog rebuilds the tap when the app's audio processes or the output device change, or when the app is playing but nothing arrives. `recorder/make_transcript.py` mixes the tracks (ducking the microphone under the call, since it also hears the speakers), transcribes in 5-minute chunks with the `audio-video-analysis` skill's scripts, diarizes the whole meeting once, then drops words that only the microphone heard and that repeat what the call just said. `POST /discord-bot/ingest` (same secret as the timer) takes the transcript and runs the `/meeting summarize` pipeline.
- **Tests:** `npm test`. They drive the whole bot with signed interactions against PGlite (real Postgres in-process), a fake Discord and a fake Claude, so they cost nothing.
- **Token use:** `npm run token-report` estimates tokens per summary and question without calling Claude. Savings in place:
  - Claude gets the notes without timestamps or "um/uh", and only the 15 latest decisions.
  - The summary is sent as plain text.
  - At most 3 Q&As from the last 30 minutes go with each question.
  - Lists are capped at 5 items, with at most 3 citations each.
  - Repeat transcripts reuse the existing summary.
