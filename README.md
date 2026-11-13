# Mibbit Notes bot

A Discord bot for the Mibbit team that collects notes from anywhere in the server and files them into a forum channel, organized by tag.

## What it does

| How | What happens |
|---|---|
| `/note` | Saves whatever you type. Add `#idea`, `#bug`, `#design`, `#feedback` or `#decision` to the text to tag it, or pick a tag. |
| Right-click a message → **Apps → Save as note** | Saves someone else's message, with a link back to it. You can pick a tag right after. |
| React **📌** to any message | Saves it straight away. The bot reacts ✅ so you know it worked. |
| `/decide` | Logs a decision and why it was made. Posts it in the channel so everyone sees. |
| `/todo` | Creates an action item for someone (pings them). It has a **Mark done** button. |
| `/todos` | Lists open action items, all of them or one person's, and lets you mark them done. |
| `/notes search`, `recent`, `tag` | Finds notes. Only you see the results. |
| `/notes delete` | Removes a note (only the person who wrote or saved it, or a moderator). |
| `/setup` | Creates the bot's channels: #notes, #meeting-notes, #weekly-digest. |
| `/digest` | Posts the weekly round-up right now. It also posts on its own every Monday at 9:00. |
| `/meeting summarize` | Summarizes a meeting from a transcript file, or from this channel's last few hours, and posts it in **#meeting-notes**. *Needs AI, see below.* |
| Ask in the meeting's thread, or **@mention** the bot | Answers questions about the meeting from its full notes. *Needs AI.* |
| `/meeting ask`, `list`, `notes` | Ask by command, see recent meetings, or download a meeting's full numbered notes. |

In the notes forum, each tag gets **one post** (💡 Ideas, 🎨 Design, 🐛 Bugs, 💬 Feedback, ✅ Decisions, 📋 Action items, 📝 General), and every note lands as a reply inside the right one. Changing a note's tag moves it.

---

## First-time setup (about 10 minutes)

### 1. Create the bot in Discord

1. Go to <https://discord.com/developers/applications> and sign in.
2. Click **New Application**, name it (e.g. *Mibbit Notes*) and accept the terms.
3. Optional: on **General Information**, upload an icon.

### 2. Turn on the Bot settings

1. Click **Bot** in the left menu.
2. Scroll to **Privileged Gateway Intents** and switch on **Message Content Intent**. This lets the 📌 reaction read the message it's on. Click **Save Changes**.
3. Switch off **Public Bot** so only you can add it to servers. Save again. If Discord says a private app can't have a default install link, go to **Installation** in the left menu, set **Install Link** to **None**, save, and try again.

### 3. Copy the token

Still on the **Bot** page, click **Reset Token**, confirm, and **Copy**. Treat it like a password: don't paste it in Discord or share it.

### 4. Paste the token into `.env`

Open the `.env` file in this folder and paste the token after `DISCORD_TOKEN=`, with no spaces or quotes. Save the file.

### 5. Start the bot

In a terminal, in this folder:

```bash
npm start
```

The first time, it prints a link starting with `https://discord.com/oauth2/authorize…`. Open it, choose the Mibbit server and click **Authorize**. Within a few seconds the terminal shows `Commands ready in "…"`.

### 6. Create the channels

In any channel of the Mibbit server, run `/setup`. The bot creates a **Mibbit Notes** category with three channels:

- **#notes**: a forum where every saved note lands, with one post per tag.
- **#meeting-notes**: where every meeting summary is posted, each with its own thread for questions.
- **#weekly-digest**: the Monday round-up.

Already have channels you'd rather use? Pick them in `/setup` (`forum:`, `meetings_channel:`, `digest_channel:`) and the bot creates only what's missing. Running `/setup` again is safe: it never makes duplicates.

Done! Try `/note text: the onboarding should start with a sound #idea`.

---

## Meeting notes (optional, uses AI)

### What you get

`/meeting summarize file:<transcript>` (or `hours:2` to use this channel's recent messages) posts in **#meeting-notes**, wherever you run the command:

- **⭐ Important**: key points, decisions (with the reason) and action items (with owner and due date).
- **🔄 Changes**: what's different from before, for example *Launch date: ~~Dec 1~~ → **Dec 8***. The bot compares against the decision log, so a meeting that reverses an earlier decision shows up here.
- **❓ Open questions**: anything left unsettled.
- The **full notes** as an attached file, numbered `S1`, `S2`, … Every item in the summary carries a tag like `S12 · 4:05` showing where it was said.

The bot also starts a **thread** under the summary. Ask anything in it ("who's doing the checklist?", "why did launch move?") and it answers from the full notes, cites where the answer came from, and says plainly when the notes don't cover something. In the thread it only answers messages that look like questions, so "thanks!" doesn't get a reply. @mentioning the bot works anywhere: it uses the meeting you replied to, or the latest one. Decisions from the meeting are added to the decision log too.

**Transcripts it reads:** `.vtt` (Zoom, Google Meet, Teams), `.srt`, and `.txt`/`.md` (including Otter exports and plain "Name: text" notes). Audio and video files aren't supported yet. Export the transcript from your meeting tool instead.

### Turning it on

AI is **off** until you add a key, and nothing is spent while it's off.

1. Go to <https://console.anthropic.com>, then **API Keys** → **Create Key**, and copy it.
2. Paste it after `ANTHROPIC_API_KEY=` in `.env` and restart the bot. The terminal says `Meeting AI: on`.

**Cost:** each summary and each answer uses API credits from that Console account. Rough estimate: around 10¢ to summarize an hour-long meeting, and a few cents or less per question (follow-up questions within a few minutes reuse the cached notes and are much cheaper). Check real usage in the Console.

---

## Things to know

- **The bot is online only while `npm start` is running** on this computer. Close the terminal or let the Mac sleep, and the bot goes offline. Notes are saved in the `data/` folder, so nothing is lost. Moving it to an always-on host is the next step once you're happy with it.
- **Stop it** with `Ctrl + C` in the terminal.
- **Change the digest time** with `DIGEST_DAY` and `DIGEST_HOUR` in `.env`, then restart.
- If something goes wrong, the bot replies "Something went wrong", and the details show in the terminal.

## Not built yet

- **Meeting notes straight from audio or a voice call.** This needs a speech-to-text step first. Transcript files and channel messages already work.
- Turning meeting action items into `/todo` items automatically. This needs a way to match names in a transcript to Discord members.
- Syncing notes to Notion, Linear or GitHub.

## For engineers

Node 22 + discord.js 14 + SQLite (better-sqlite3, FTS5 for search) + `@anthropic-ai/sdk`. `src/index.js` wires the events, `src/filing.js` handles forum posts, `src/db.js` handles storage, and `src/digest.js` builds the weekly round-up. Meetings: `src/transcript.js` parses transcripts into numbered segments, `src/meetings.js` has the prompts, JSON schemas and rendering, `src/meeting-handlers.js` has the Discord side, and `src/ai.js` is the API client (structured outputs, server-side refusal fallback, created only when `ANTHROPIC_API_KEY` is set). Each meeting stores its raw transcript plus segments. Q&A sends the full notes in a cached system block, along with the last 4 Q&As about that meeting. Run tests with `npm test`: they use a fake Discord and a fake Claude, so they cost nothing. `npm run token-report` estimates the tokens each summary and question sends, without calling Claude. Run it after changing prompts to check nothing grew. Savings already in place: Claude gets the notes without timestamps or "um/uh", only the 15 latest decisions (dates and text only), the summary as plain text, and at most 3 Q&As from the last 30 minutes. Lists are capped at 5 items with ≤3 citations each, repeat transcripts reuse the existing summary, and @mentions that aren't questions get a free tip. Nothing has been evaluated against the real model yet. Commands register per server on startup, so they appear instantly.
