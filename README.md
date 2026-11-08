# Lights — Smart edition

A modified copy of [c4rl05/Lights](https://github.com/c4rl05/Lights) (the HelloEnjoy WebGL
experience made for Ellie Goulding's *Lights*). The original visuals are driven by data
hand-made for that one song. This edition analyzes **any song** and drives the same
choreography from it.

## Run

The page has to be served over http (opening `index.html` directly as a file won't work,
because the browser blocks the audio analyzer and the image reads on `file://`).

**Easiest (macOS):** double-click `start.command` in this folder. A Terminal window opens,
starts a small local web server and opens the page in your browser. Keep that window open
while you use it, and close it to stop. The first time, macOS may refuse to open a
downloaded script; then right-click `start.command` → **Open** → **Open**.

**From a terminal (any OS with Python 3):** in this folder run

```bash
python3 serve.py
```

Then open <http://localhost:8000> in **Chrome** or **Edge** (needed for "Playing audio";
upload and microphone also work in Safari / Firefox). Stop the server with `Ctrl+C`.
`serve.py` is `python3 -m http.server` that only listens on this computer and tells the
browser not to cache, so updates show up on a normal reload. Any static web server works too.

**Your own songs:** put audio files in `my-music/`. Each one appears as a button in the
picker. The folder is ignored by git, so your music never gets committed.

**Using it:** pick a source in the panel (**Upload a song**, a song from `my-music/`, or drag a
file onto the page), wait a few seconds for the analysis, then press **PLAY**. The panel shows
the song's sections, where the singer is heard, where the scene changes and why, and which
show the song got. **Remix** (or `R` on the start screen) switches to another show.

## Music sources

| Source | How it works |
| --- | --- |
| **Upload a song** (or drag & drop) | The whole file is analyzed before playback (a few seconds), then the light show is laid out on the song's structure. MP3, WAV, OGG, M4A, FLAC; whatever the browser can decode. |
| **Playing audio** | Captures a browser tab or the whole screen with its sound (Chrome / Edge desktop; tick **Share audio** in the picker). Analyzed in real time. |
| **Microphone** | Real-time analysis of whatever the mic hears (speakers in the room, a live band…). |
| **Original song** | The untouched original experience with its hand-made timing. |

After a song ends, **REPLAY** plays it again and **NEW SONG** opens the picker.
During playback: `Esc` or the ✕ button goes back (in live mode it plays the outro first),
`H` toggles a small HUD with the current section, BPM and phase, and `[` / `]` move the
visuals 10 ms later / earlier. Use them if your speakers add delay (Bluetooth, TV), and the
setting is remembered.

## What gets analyzed

Uploaded files (`js/smart/analyzer-worker.js`, runs in a Web Worker):

- **Tempo**: onset-strength autocorrelation, then a dynamic-programming beat tracker
  (Ellis 2007 / librosa style). Beats drive every pulse event in the scene.
- **Bars & downbeats**: 4/4 bar phase picked from bass hits and chord changes.
- **Energy per bar**: loudness + bass presence + onset density, normalized within the song.
- **Section boundaries**: timbre / harmony / energy novelty between neighbouring bars, plus
  **rhythm changes** (16-step drum pattern and kick / snare / hi-hat density per bar).
- **Singer**: lead-vocal detection from centre-panned energy in the voice range combined with
  pitch movement (vibrato and slides, which synths, bass and keys don't have). On the original
  song, whose authors shipped the real vocal track, it marks 98 % of frames correctly as singing
  and finds the first entry at 7.4 s (real: 7.2 s) and the last note at 200.3 s (real: 200.25 s).
- **Tempo changes**: local tempo every second over 6 s windows; real tempo changes (> 6 %,
  lasting) are detected and the beat tracker follows them. On a 90 → 120 → 100 BPM test
  track the changes are found at 63.9 s and 128.8 s (real: 64 s and 128 s).
- **Choreography mapping**: the original experience has 23 phases grouped into
  intro → verse → chorus → verse → chorus → bridge → break → chorus → bridge → outro.
  A dynamic-programming fit places those sections on the song's bars so that high-energy
  scenes land on choruses and drops, the "break" freeze lands on the biggest breakdown right
  before a big return, and the outro fades with the song's end. **Scene changes are pulled onto
  musical events**: the singer coming in (strongest after an instrumental stretch), the singer
  stopping, a tempo change, or a rhythm change. Every phase change then snaps to the beat
  nearest to such an event within about a bar. The panel's timeline shows the vocal parts (white)
  and why each scene starts there (pink: singer, yellow: tempo, cyan: rhythm).
- **Voice volume** (the glowing trail you steer): vocal-range energy of the centre channel,
  dimmed where nobody sings; its sparkler flares and the stars burst when the singer comes in.
- **Spectrum** (the terrain waves in the bridge sections): 64 log-spaced bands, auto-gained
  per band so quiet and loud masters look the same.
- **Camera speed** scales with the tempo (the original was built for 120 BPM).
- **Album art**: an embedded MP3 cover is drawn into the dot "avatars" on the terrain.
- Uploads are decoded at a fixed 22,050 Hz, so the analysis is identical on every computer.

**Shows** (`Show` in `js/smart/SmartLights.js`): every song keeps the outline found by the
analysis, but which scene plays each part varies. The three chorus scenes (light trails and
words, avatars, spotlights) come in any order and the two bridge scenes either way round,
giving 12 shows. Each show also has its own camera heights, angles and zoom per scene, and its
own sky colour. A song gets its own show by default; REMIX steps through the others and is
remembered per song. Scenes in the original hand over state to the scene that followed them
(words floating in the air, a flattened ground, spotlights left on), so when the order
changes, a short transition cleans up: the words explode, the ground grows back, the
spotlights switch off. The original song keeps its original order.

**Beat-locked motion** (`Groove` in `js/smart/SmartLights.js`): motions that follow the music
move on the beat instead of drifting. Gliding motion reads as late, even when it starts on
time, so:
- Spotlights move like concert moving heads: on every beat each one snaps (in about 0.1 s) to
  the next position of its pattern and holds. The first beat of a bar throws them wide, and the
  beams cross in between. In quiet passages they move every other beat.
- Ground dots pump in size and the terrain brightens on every beat, stronger on the bar.
- New ground circles are born on each bar's first beat, words float on 2- or 4-bar cycles, and
  the sky colour sweeps over 4 bars.
- Balls change shape fast enough to land on the beat.

**Hit-level sync****Hit-level sync** (the `Pulse` layer in `js/smart/SmartLights.js`): the analyzer also
finds every kick, snare/clap, hi-hat and accent, plus a loudness curve and the "impact"
moments where a section explodes (drops, chorus entries, the return after a break). Each
gets a visible reaction in every section of the show:

| Musical event | Visual reaction |
| --- | --- |
| Beat (stronger on the first beat of each bar) | Instant camera zoom-punch and dip; sky, spotlights and terrain flash; ground dots pump; spotlights jump to their next position |
| Clap / snare on beats 2 and 4 | White sparks on the ground |
| Hi-hat on a beat or half-beat | Stars sparkle in groups |
| Accent on a beat | Balls inflate / deflate, light flash |
| Singer comes in | The voice's sparkler flares, stars burst |
| Impact (drop, return after a break) | Whole ground flashes white, strongest zoom |
| Loudness | Camera cruises slower in quiet parts and faster in loud ones; sky and stars dim and brighten |

Every reaction is instant on the beat and fades within ~0.15–0.3 s, and only on-beat events
trigger anything (off-beat kicks and percussion fills are left out), so the picture pulses
with the song instead of flickering.

Visuals are drawn ~35 ms ahead of the player's position (the time a frame takes to reach the
screen). Chrome's player position already includes the sound card's latency. Speakers that add
their own delay (Bluetooth headphones, TVs) can be calibrated: press `T` while a song plays and
tap Space on the beat 8 times. `[` and `]` fine-tune by 10 ms. Both are remembered.

Live audio (`LiveEngine` in `js/smart/SmartLights.js`): real-time tempo estimate,
a phase-locked beat clock that snaps to detected onsets, and a director that advances
phases on bar boundaries when the energy changes. The singer coming in (live vocal detection
with the same centre + pitch-movement method) or a lasting tempo change starts the next phase
on the following bar; the intro ends when the singer starts. A sudden rise in a verse jumps to
the chorus scenes, a breakdown triggers the break, and the return of the beat triggers the
big final-chorus scene. Phases loop for as long as the audio keeps playing.

Tested with the original song: the detected tempo is 119.7 BPM (actual 120), and the break,
final chorus, bridge and outro land within a quarter second of the hand-made timing. On a
synthetic EDM track with a known structure, every drop, break and the outro was placed on
the correct bar.

## Files

- `js/smart/analyzer-worker.js`: offline analysis (new)
- `js/smart/SmartLights.js`: song picker, live engine, patches to the original prototypes (new)
- `css/smart.css`: picker / HUD styles (new)
- `start.command`, `serve.py`: local launcher and no-cache local server (new)
- `my-music/`: your own songs, git-ignored (new)
- `index.html`: loads the new files, removed the original site's analytics snippet
- `js/Lights.js`, `js/lights/tiles/CannonManager.js`: the end-of-song fade used a fixed
  208 s, now relative to the song's end

The original code is otherwise untouched; everything is applied by patching prototypes
at load time.

## Limitations

- System-wide audio capture depends on browser and OS. Chrome / Edge on Windows can share
  system audio; on macOS, tab audio is the reliable option. Alternatively, route system
  audio into a virtual input device (e.g. BlackHole) and pick **Microphone**.
- Section mapping assumes 4/4 and a pop/electronic-like build. Free-tempo music (classical,
  ambient) still gets beats and energy, but the section mapping is rougher.
- Vocal detection has no machine-learning model. A centre-panned lead instrument with vibrato
  (clarinet, violin, ney) can count as "singing", and a mono recording relies on pitch
  movement alone. Choruses that are fairly dense can also hide short vocal pauses.
- Songs shorter than about 30 s fall back to evenly spaced sections.
- The upstream repository has no license file; the original code, images and music belong to
  their authors (HelloEnjoy, Cherrytree / Polydor). Keep this for personal use unless you have
  permission.
