#!/usr/bin/env python3
"""Turns the meeting recorder's files into a speaker-labelled transcript.

    python3 recorder/make_transcript.py <work-folder> <recording-folder> [<recording-folder> ...]
        [--follow] [--prompt "Ana, Ben, Mibbit"] [--speakers N] [--me Ana] [--title "Monday sync"]

Each recording folder is one run of the recorder (system.caf, mic.caf,
status.json); several are joined in the order given.

It works through the recording in 5-minute chunks, so with --follow it can
start while the meeting is still going and only has the last few minutes left
to do when the recorder stops. Finished chunks are kept, so it can be re-run.

The two tracks are mixed into one before transcribing. The microphone also
hears the call coming out of the speakers, so it is turned down whenever the
call itself is making sound; otherwise everyone else would be heard twice.

Anything the microphone repeats that still gets transcribed (the tracks drifted,
or the call track dropped out for a while) is recognised afterwards and removed;
what only the microphone heard and nobody on the call said is the person at
this Mac, named with --me.

Writes into the work folder:
    transcript.md     the full transcript as transcribed (Speaker 1, Speaker 2, ...)
    for-bot.txt       the cleaned-up lines, ready for the Mibbit Notes bot
    cleanup.json      what the clean-up removed and who was at this Mac
    audio.wav         the mixed recording

Needs the audio-video-analysis skill's scripts (uv, ffmpeg, whisper); nothing
here uses AI credits.
"""
import argparse
import audioop
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime
from pathlib import Path

SKILL = Path.home() / ".claude/skills/audio-video-analysis/scripts"
CHUNK = int(os.environ.get("MEETING_CHUNK_SECONDS", 300))  # seconds of meeting per chunk
PAD = 2      # each chunk also hears this much of its neighbours, so words on the edge aren't cut
MIC_GAIN = 2.5
DUCK = "sidechaincompress=threshold=0.015:ratio=20:attack=5:release=400"


def log(message):
    print(f"[{datetime.now():%H:%M:%S}] {message}", flush=True)


def find_ffmpeg():
    cached = Path.home() / ".cache/audio-video-analysis/bin/ffmpeg"
    found = str(cached) if cached.exists() else shutil.which("ffmpeg")
    if not found:
        sys.exit("ffmpeg is missing. Run the audio-video-analysis skill's check_setup.py first.")
    return found


FFMPEG = find_ffmpeg()


def run(command, **kwargs):
    return subprocess.run([str(c) for c in command], check=True, **kwargs)


def media_seconds(path):
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


class Part:
    """One run of the recorder."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.system = self.folder / "system.caf"
        self.mic = self.folder / "mic.caf"
        if not self.system.exists():
            sys.exit(f"No system.caf in {self.folder}")

    def status(self):
        try:
            return json.loads((self.folder / "status.json").read_text())
        except (OSError, ValueError):
            return {}

    def recording(self):
        s = self.status()
        return s.get("state") in ("starting", "recording") and alive(s.get("pid"))

    def seconds(self):
        """How much of the call has been recorded so far."""
        if self.recording():
            return float(self.status().get("system", {}).get("seconds") or 0)
        return media_seconds(self.system)

    def has_mic(self):
        return self.mic.exists() and self.mic.stat().st_size > 8192

    def mic_lag(self):
        """Seconds the microphone track started after the call track (negative: before)."""
        s = self.status()
        first_call = parse_time(s.get("system", {}).get("firstAudioAt"))
        first_mic = parse_time(s.get("mic", {}).get("firstAudioAt"))
        return (first_mic - first_call).total_seconds() if first_call and first_mic else 0.0

    def mix(self, start, end, out, call_out=None, mic_out=None):
        """Writes [start, end) of this part as 16 kHz mono: the mix, and optionally each track alone."""
        length = end - start
        command = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", self.system]
        call = "[0:a]aresample=16000,pan=mono|c0=0.5*c0+0.5*c1"
        if not self.has_mic():
            graph = f"{call}[mix]"
            maps = [("[mix]", out)]
            if call_out:
                graph = f"{call},asplit=2[mix][callonly]"
                maps.append(("[callonly]", call_out))
        else:
            mic_start = start - self.mic_lag()
            delay_ms = int(round(max(-mic_start, 0) * 1000))
            command += ["-ss", f"{max(mic_start, 0):.3f}", "-t", f"{max(length - delay_ms / 1000, 0.1):.3f}", "-i", self.mic]
            mic = f"[1:a]aresample=16000,pan=mono|c0=c0,adelay={delay_ms}:all=1"
            graph = (
                f"{call},asplit=3[call][key][callonly];"
                f"{mic},asplit=2[micraw][miconly];"
                f"[micraw][key]{DUCK}[ducked];"
                f"[ducked]volume={MIC_GAIN}[mine];"
                f"[call][mine]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mix]"
            )
            maps = [("[mix]", out), ("[callonly]", call_out or "-"), ("[miconly]", mic_out or "-")]
        command += ["-filter_complex", graph]
        for label, target in maps:
            if target == "-":
                command += ["-map", label, "-f", "null", "-"]
            else:
                command += ["-map", label, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", target]
        run(command)


def transcribe(wav, out, prompt, threads):
    command = ["uv", "run", SKILL / "transcribe.py", wav, "--out", out, "--model", "medium", "--language", "en", "--threads", threads]
    if prompt:
        command += ["--prompt", prompt]
    run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def chunk_plan(part_seconds, finished):
    """Chunk index → (keep_from, keep_to, audio_from, audio_to) for the chunks that can be done now."""
    plan = []
    index = 0
    while True:
        keep_from = index * CHUNK
        keep_to = keep_from + CHUNK
        if finished:
            if keep_from >= part_seconds - 1 and index > 0:
                break
            last = keep_to >= part_seconds - 1
            plan.append((index, keep_from, part_seconds if last else keep_to, max(keep_from - PAD, 0), part_seconds if last else min(keep_to + PAD, part_seconds)))
            if last:
                break
        else:
            if part_seconds < keep_to + PAD + 1:
                break
            plan.append((index, keep_from, keep_to, max(keep_from - PAD, 0), keep_to + PAD))
        index += 1
    return plan


def kept_segments(chunk_json, keep_from, keep_to, audio_from, offset):
    """A chunk's segments on the whole meeting's clock, without the words that belong to its neighbours."""
    out = []
    for seg in json.loads(Path(chunk_json).read_text()).get("segments", []):
        words = []
        for w in seg.get("words") or []:
            middle = audio_from + (w["start"] + w["end"]) / 2
            if keep_from <= middle < keep_to:
                words.append({**w, "start": round(w["start"] + audio_from + offset, 3), "end": round(w["end"] + audio_from + offset, 3)})
        if not words:
            continue
        out.append({
            **{k: v for k, v in seg.items() if k not in ("id", "words", "start", "end", "text")},
            "start": words[0]["start"], "end": words[-1]["end"],
            "text": " ".join(w["word"].strip() for w in words), "words": words,
        })
    return out


def join_wavs(paths, out):
    with wave.open(str(out), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        for path in paths:
            with wave.open(str(path), "rb") as source:
                while True:
                    frames = source.readframes(160000)
                    if not frames:
                        break
                    target.writeframes(frames)


def norm(word):
    return re.sub(r"[^a-z0-9']", "", word.lower())


def clock(seconds):
    return "%02d:%02d:%02d" % (seconds // 3600, seconds // 60 % 60, seconds % 60)


def classify_words(work):
    """Every transcribed word, marked with where its sound came from.

    The microphone hears the call coming out of the speakers, and when the two
    tracks drift apart (or the call track drops out) that copy gets transcribed
    as well. A word is "mic only" when the call track was silent while it was
    said. A run of mic-only words that repeats what the call just said is an
    echo and is dropped. What's left of the mic-only words was really said in
    the room, or is the microphone covering for a call track that went quiet.
    """
    transcript = json.loads((work / "transcript.json").read_text())
    words = []
    for line in transcript.get("utterances", []):
        for w in line.get("words", []):
            if not w["word"].startswith("["):  # not a marker like [unintelligible 3s]
                words.append({"start": w["start"], "end": w["end"], "word": w["word"].strip(), "speaker": line["speaker"], "mic_only": False, "keep": True, "in_room": False})
    if not (work / "mic-only.wav").exists():
        return words

    with wave.open(str(work / "call-only.wav"), "rb") as call:
        total = call.getnframes()
        for w in words:
            call.setpos(min(int(max(w["start"], 0) * 16000), max(total - 1, 0)))
            frames = call.readframes(max(int((w["end"] - w["start"]) * 16000), 800))
            w["mic_only"] = (audioop.rms(frames, 2) if frames else 0) < 104  # below -50 dB: the call was silent
    # A lone word that disagrees with both neighbours is a timing wobble, not a change of source.
    for i in range(1, len(words) - 1):
        before, after = words[i - 1], words[i + 1]
        if before["mic_only"] == after["mic_only"] != words[i]["mic_only"] and after["start"] - before["end"] < 2:
            words[i]["mic_only"] = before["mic_only"]

    runs, run = [], None
    for i, w in enumerate(words):
        if w["mic_only"] and run and run[-1] == i - 1 and w["start"] - words[i - 1]["end"] < 1.5:
            run.append(i)
        elif w["mic_only"]:
            run = [i]
            runs.append(run)
        else:
            run = None
    from_call = [i for i, w in enumerate(words) if not w["mic_only"]]
    cursor = 0
    for run in runs:
        start = words[run[0]]["start"]
        while cursor < len(from_call) and words[from_call[cursor]]["start"] < start - 45:
            cursor += 1
        recent = []
        for j in from_call[cursor:]:
            if words[j]["start"] > start + 3:
                break
            recent.append(norm(words[j]["word"]))
        mine = [norm(words[i]["word"]) for i in run]
        if len(mine) < 3:
            echoed = set(range(len(mine))) if all(m in recent for m in mine) else set()
        else:
            blocks = difflib.SequenceMatcher(None, mine, recent, autojunk=False).get_matching_blocks()
            echoed = {k for b in blocks if b.size >= 3 for k in range(b.a, b.a + b.size)}
            if len(echoed) >= 0.6 * len(mine):
                echoed = set(range(len(mine)))
        for k, i in enumerate(run):
            words[i]["keep"] = k not in echoed
            words[i]["in_room"] = k not in echoed
    return words


def write_for_bot(work, me):
    """for-bot.txt: the transcript without echoes, with the person at this Mac named."""
    words = classify_words(work)
    kept = [w for w in words if w["keep"]]

    # A voice the call track never carried belongs to someone in the room with this Mac.
    heard, on_call = {}, {}
    for w in kept:
        heard[w["speaker"]] = heard.get(w["speaker"], 0) + 1
        on_call[w["speaker"]] = on_call.get(w["speaker"], 0) + (not w["mic_only"])
    here = {s for s in heard if on_call[s] < 0.2 * heard[s]} if (work / "mic-only.wav").exists() else set()
    rename = {s: me for s in here} if me and len(here) == 1 else {}
    # The start of their sentence is often credited to whoever spoke just before: give them the whole run.
    i = 0
    while i < len(kept):
        j = i
        while j + 1 < len(kept) and kept[j + 1]["in_room"] and kept[i]["in_room"] and kept[j + 1]["start"] - kept[j]["end"] < 1.5:
            j += 1
        locals_in_run = {w["speaker"] for w in kept[i:j + 1]} & here
        if kept[i]["in_room"] and len(locals_in_run) == 1:
            for w in kept[i:j + 1]:
                w["speaker"] = next(iter(locals_in_run))
        i = j + 1

    lines, line = [], None
    for w in kept:
        who = rename.get(w["speaker"], w["speaker"])
        if line is None or who != line["who"] or w["start"] - line["end"] > 20 or (w["start"] - line["start"] > 30 and line["text"][-1] in ".?!"):
            line = {"who": who, "start": w["start"], "end": w["end"], "text": w["word"]}
            lines.append(line)
        else:
            line["text"] += " " + w["word"]
            line["end"] = w["end"]
    text = "\n".join(f"[{clock(l['start'])}] {l['who']}: {re.sub(r' +-', '-', l['text'])}" for l in lines) + "\n"
    (work / "for-bot.txt").write_text(text)

    call_words = [w for w in words if not w["mic_only"]]
    report = {
        "words": len(words),
        "echo_words_dropped": len(words) - len(kept),
        "words_only_the_microphone_heard": sum(w["in_room"] for w in kept),
        "speakers_in_the_room": sorted(rename.get(s, s) for s in here),
        "call_track_last_heard_at": clock(max(w["end"] for w in call_words)) if call_words else None,
        "lines": len(lines),
    }
    (work / "cleanup.json").write_text(json.dumps(report, indent=1))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("work")
    parser.add_argument("parts", nargs="+")
    parser.add_argument("--follow", action="store_true", help="keep going until the recorder stops")
    parser.add_argument("--prompt", default="", help="names and terms to spell correctly, comma separated")
    parser.add_argument("--speakers", type=int, default=-1, help="how many people spoke, if known")
    parser.add_argument("--title", default="Meeting")
    parser.add_argument("--me", default="", help="name of the person at this Mac, to label what only the microphone heard")
    parser.add_argument("--redo", action="store_true", help="join and separate the voices again, even if that was already done")
    args = parser.parse_args()

    work = Path(args.work)
    chunks = work / "chunks"
    chunks.mkdir(parents=True, exist_ok=True)
    parts = [Part(p) for p in args.parts]

    done = set()
    while True:
        busy = False
        still_recording = any(p.recording() for p in parts)
        for number, part in enumerate(parts):
            finished = not part.recording()
            for index, keep_from, keep_to, audio_from, audio_to in chunk_plan(part.seconds(), finished):
                # A chunk made while recording is complete; the last chunk of a part is only made once it has stopped.
                name = f"p{number}_c{index:03d}" + ("" if keep_to == keep_from + CHUNK and audio_to == keep_to + PAD else "_end")
                out = chunks / f"{name}.json"
                done.add((number, index))
                if out.exists():
                    continue
                busy = True
                wav = chunks / f"{name}.wav"
                started = time.time()
                part.mix(audio_from, audio_to, wav)
                # Leave the Mac room to breathe while the call is still on.
                transcribe(wav, out, args.prompt, 4 if still_recording else 0)
                wav.unlink(missing_ok=True)
                log(f"part {number + 1}, minutes {keep_from // 60}–{-(-int(keep_to) // 60)} transcribed in {time.time() - started:.0f}s")
                still_recording = any(p.recording() for p in parts)
        if not any(p.recording() for p in parts) and not busy:
            break
        if not args.follow and not busy:
            log("The recorder is still going. Run again when it stops, or use --follow.")
            return
        if not busy:
            time.sleep(10)

    if (work / "transcript.json").exists() and not args.redo:
        log("The voices were already separated (use --redo to do that again).")
    else:
        build(work, chunks, parts, args)

    report = write_for_bot(work, args.me)
    log(f"Done: {report['lines']} lines → {work / 'for-bot.txt'}")
    if report["echo_words_dropped"]:
        log(f"  dropped {report['echo_words_dropped']} words that were the microphone repeating the call")
    if report["speakers_in_the_room"]:
        log(f"  at this Mac: {', '.join(report['speakers_in_the_room'])}")


def build(work, chunks, parts, args):
    """Joins the chunks, separates the voices and writes transcript.md."""
    log("Recording finished. Joining the pieces…")
    segments, offset = [], 0.0
    mixes, calls, mics = [], [], []
    have_mic = all(p.has_mic() for p in parts)
    for number, part in enumerate(parts):
        seconds = part.seconds()
        for index, keep_from, keep_to, audio_from, _ in chunk_plan(seconds, True):
            candidates = [chunks / f"p{number}_c{index:03d}.json", chunks / f"p{number}_c{index:03d}_end.json"]
            source = next((c for c in candidates if c.exists()), None)
            if not source:
                sys.exit(f"Chunk {index} of part {number + 1} is missing.")
            segments += kept_segments(source, keep_from, keep_to, audio_from, offset)
        mix, call, mic = (work / f"part{number}-{kind}.wav" for kind in ("mix", "call", "mic"))
        part.mix(0, seconds, mix, call, mic if part.has_mic() else None)
        mixes.append(mix)
        calls.append(call)
        mics.append(mic)
        offset += media_seconds(mix)
    for i, seg in enumerate(segments):
        seg["id"] = i

    join_wavs(mixes, work / "audio.wav")
    join_wavs(calls, work / "call-only.wav")
    if have_mic:
        join_wavs(mics, work / "mic-only.wav")
    for path in mixes + calls + mics:
        path.unlink(missing_ok=True)

    raw = {
        "source": str(work / "audio.wav"), "model": "medium", "compute_type": "int8", "language": "en",
        "duration": round(offset, 3), "settings": {"beam_size": 5, "vad": True, "prompt": args.prompt or None, "chunk_seconds": CHUNK},
        "segments": segments,
    }
    (work / "transcript_raw.json").write_text(json.dumps(raw))

    log("Working out who spoke when…")
    diarize = ["uv", "run", SKILL / "diarize.py", work / "audio.wav", "--out", work / "diarization.json"]
    if args.speakers > 0:
        diarize += ["--num-speakers", args.speakers]
    run(diarize, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(["uv", "run", SKILL / "build_transcript.py", work / "transcript_raw.json", work / "diarization.json", "--out-dir", work, "--title", args.title],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    log(f"Transcript: {offset / 60:.1f} minutes, {len(segments)} segments → {work / 'transcript.md'}")


if __name__ == "__main__":
    main()
