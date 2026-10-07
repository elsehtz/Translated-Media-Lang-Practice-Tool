# Overview

Egyptian Arabic Life Media Translation Practice Tool

### (Current Use: El Dahih player)

Watch every El Dahih (الدحيح) episode with the Arabic transcript and English side by side, following along as the video plays.

## Start

Double-click **start.command**. The first run sets itself up (about a minute), then the player opens in your browser at http://localhost:8765. Keep the Terminal window open while you watch; close it to stop.

If macOS says it can't open the file, right-click it and choose **Open**. You can also run `bash start.command` from Terminal inside this folder.

## How it works

- **Episode list**: built from the channels in `sources.json` (the original Da7ee7 channel, AJ+ Kibreet, and New Media Academy). It refreshes itself every few days; "Refresh list" does it now.
- **Transcripts**: when you open an episode, the app reads that video's captions from YouTube. Arabic comes from the official captions, or YouTube's auto-generated ones when there are none. English comes from YouTube's translation of the Arabic, or the official English captions when the episode has them (switch with "Translated / Official EN"). Each transcript is cached in `data/` after the first load.
- Needs Python 3.10 or newer for the best results (`brew install python`).

## Using the player

| | |
|---|---|
| Click a line | jump the video there |
| Scroll the transcript | pauses follow-along; "Jump to current line" resumes |
| Space / K | play or pause |
| ← / → | previous / next line |
| F | turn follow-along on or off |
| / | search episodes |
| Esc | back to the library |

⇄ swaps the Arabic and English columns, and A− / A+ changes the text size.

## If captions won't load

YouTube sometimes briefly refuses caption requests from a network that makes a lot of them. Wait a few minutes and press "Try again". Restarting `start.command` also updates the helper libraries, which fixes most breakages after YouTube changes something.
