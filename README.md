# StepSync

<img width="972" height="756" alt="StepSync Editor and Analyzer Screenshot" src="https://github.com/user-attachments/assets/8477dca6-05be-4c03-9f1e-5b08e4406559" />

**StepSync** is a browser-based rhythm chart synchronization studio, drum-stem analyzer, difficulty planner, 4-key (`D F J K`) StepMania simulator, and interactive cockpit screensaver visualizer with built-in WebM video export. It combines interactive BPM/offset alignment, client-side drum stem separation (DSP HPSS or WebGPU HT-Demucs), customizable frequency-band-to-arrow mapping, per-section visual preset choreography, and live playtesting in one workspace.

## Video Demos

### Simulation Gameplay Recording (Exported directly from StepSync)

Recorded directly via StepSync's built-in Screensaver WebM exporter during live simulation playback with per-section visual preset auto-switching:

[![Watch StepSync Simulation Recording on YouTube](https://img.youtube.com/vi/ZOYOFpBrak4/hqdefault.jpg)](https://www.youtube.com/watch?v=ZOYOFpBrak4)

> Direct link: [https://www.youtube.com/watch?v=ZOYOFpBrak4](https://www.youtube.com/watch?v=ZOYOFpBrak4)

### Editor & Analyzer Walkthrough

Watch drum stem detection, difficulty planning, and StepMania simulator playback:

[![Watch StepSync Walkthrough on YouTube](https://img.youtube.com/vi/IhdTr6K_CL4/hqdefault.jpg)](https://www.youtube.com/watch?v=IhdTr6K_CL4)

> Direct link: [https://www.youtube.com/watch?v=IhdTr6K_CL4](https://www.youtube.com/watch?v=IhdTr6K_CL4)

---

## Key Features

### 1. Dual Waveform Alignment & Manual Grid Note Editing
- **Live Scrolled Waveform & Static Overview Grid**: Drag-and-drop `.mp3`, `.wav`, `.ogg`, or `.m4a` tracks with synchronized beat lines, bar numbers, section cue markers, and a white playback cursor across both views.
- **Interactive Sync Handles**: Drag the `Start`, `Half`, and `End` beat markers directly on the static waveform to lock BPM and offset to visual transients.
- **Non-Destructive Note Editing (`Pan & Sync` | `Edit Notes`)**:
  - Snap additions to **`1/4`**, **`1/8`**, **`1/16`**, or **`Free`** timing.
  - Click an existing hit marker to suppress/delete it, or click an empty snapped grid slot to paint a note for the active instrument brush.
  - Stored as a `manualEdits` (`suppressions` + `additions`) layer with **Undo** and **Reset**, preserving manual edits whenever detection sliders or sync parameters change.

### 2. Real-Time Log Spectrum & Band Soloing
- **8192-Point FFT Logarithmic Analyzer (`20 Hz – 18 kHz`)**: Inspects either the live **`Output`** bus (post-volume audio mix + synthesized simulator hits) or the isolated **`Drum Stem`**.
- **Interactive Band Auditioning**: Click and drag across the spectrum to solo an exact Hz slice and click **Use Solo** in the Lane Manager to assign those bounds directly to a drum lane.

### 3. Drum Stem Studio & Configurable Lane Manager
- **Client-Side Drum Isolation**: Run **Instant DSP (HPSS)** or **WebGPU AI (HT-Demucs / ONNX Runtime Web)** inside a background Web Worker, or import/download a pre-separated `*_drums.wav` stem.
- **Default Drum Lanes**:
  - **Kick** (`35–140 Hz`, default `J`, `Fixed`, `Max 1/8`)
  - **Snare / Clap** (`180–2500 Hz`, default `K`, `Fixed`, `Max 1/16`)
  - **Hi-Hat** (`4500–16000 Hz`, default `D`, `Alt: F`, `Max 1/16`)
  - **Tom** (`110–300 Hz`, default `F`, `Fixed`, `Max 1/16`)
- **Flexible Key & Rate Mapping**: Assign any primary key (`D F J K`) plus optional alternation (`Fixed` or **`Alt: <other 3 keys>`**), grid-locked limiters (`Max 1/N`, `On 1/N`), per-band sensitivity, `Snap to 16th Grid`, and `Full Mix` / `Drums Only` / `Blend` auditioning.

### 4. Song Structure, Difficulty Matrix & Section Visual Presets
- **Section Timeline**: Define song sections by beat (`Intro`, `Chorus`, `Verse`, `Instrumental`, etc.) with **`Sparse`**, **`Medium`**, or **`Dense`** tags mirrored onto both waveform grids and the simulator highway.
- **Per-Section Screensaver Preset Auto-Switching**: Assign an optional **`Preset`** column (`— Keep`, `1 · GLSL`, `2 · Wormhole`, `3 · Rain`, `4 · MilkDrop`) to each section in **Sections & Difficulty** so the Screensaver visualizer automatically transitions presets as playback crosses section boundaries.
- **3×3 Difficulty × Density Matrix**: Configure note subdivision caps (`Off`, `1/1`–`1/16`, `All`) and simultaneous chord caps (`1 · Single`, `2 · Jump`, `3 · Hand`, `All Chords`) resolved by Lane Manager priority for **`Easy`**, **`Normal`**, and **`Hard`**.
- **Live Density Telemetry**: Switch between **`AVG`** (inputs per beat) and **`CNT`** (total inputs) and filter by `All lanes`, arrow key, or instrument band.

### 5. Playable 4-Key Simulator, Scoring & Sim Sound Modes
- **Live Chart Playtest**: Play the generated **`Easy`**, **`Normal`**, or **`Hard`** chart in real time with `D F J K` or Arrow keys against StepMania timing windows (`Marvelous <= 22.5ms`, `Perfect <= 45ms`, `Great <= 90ms`, `Good <= 135ms`, `Boo <= 180ms`, `Miss > 180ms`), Accuracy %, Combo/Max Combo, and signed millisecond offset callouts.
- **Latency Calibration & Overdub Recording**: Calibrate input delay with an 8-beat rhythm prompt and record/quantize manual taps alongside detected drum notes.
- **Simulated Drum Audio (`Demo` | `Sync` | `Input`)**:
  - **`Demo`**: Auto-plays the chart at `MARVELOUS 0ms`, ignores player key inputs, resets score on entry/exit, and displays **`Demotest Score`**.
  - **`Sync`**: Auto-plays enabled simulated drum sounds in lockstep with playback regardless of player input while scoring your **`Playtest Score`**.
  - **`Input`**: Plays enabled simulated drum sounds strictly when you hit keys (`Kick`, `Snare`, `Hi-Hat`, `Tom`) with dedicated **Audio** and **Sim Sound** volume sliders.

### 6. Screensaver Mode — Futuristic Cockpit Visualizer
- **4 Procedural Audio-Reactive Presets** (switchable manually via dashboard buttons / keys `1`–`4` or automatically per song section):
  1. **`GLSL Space`**: Deep-space WebGL shader paired with a 3D perspective dot-matrix audio spectrum terrain.
  2. **`Wormhole`**: High-speed warp tunnel modulated by real-time beat and bass energy.
  3. **`Music Rain`**: Neon rain streaks and beat-synchronized atmospheric ripples.
  4. **`MilkDrop`**: Galactic kaleidoscope feedback shader driven by live FFT spectrum energy.
- **Solid Cockpit Frame & Spaceship U-Yoke**:
  - Wide panoramic windshield and side windows framed by mirrored cockpit pillars (`[\  /]`) connecting the ceiling console to a solid lower dashboard.
  - **U-Shaped Spaceship Yoke**: Steers smoothly with a two-bar (`BAR A` / `BAR B`) groove engine and drum impulses—and in **`Input`** mode, reacts directly to your live **Kick**, **Snare**, and **Tom** key hits.
- **Integrated 4-Key Highway & Dashboard HUD**:
  - Optional toggleable falling-arrow highway (`D F J K`) raining down over the yoke toward the dashboard hit line, with hit/miss judgement, combo count, and signed millisecond offset rendered directly below the receptors.
  - **Embedded Left & Right Dashboard Displays**: Left display shows live BPM/bar telemetry or switches automatically to **`Demotest Score` / `Playtest Score`** when the game highway is active; right display hosts preset selectors, fullscreen toggle (with automatic viewport-proportional HUD upscaling), highway visibility toggle, and live Kick / Snare / Tom / Hi-Hat meters.
  - **Body Language Tuning Strip**: Packed directly below the Screensaver viewport (`Pink Panther`, `Percussion`, `Snare Counters Kick`, and `Drum Orientation`) so they stay dedicated to Screensaver mode.

### 7. Built-In WebM Video Recording (Landscape & Vertical 9:16)
- **Configurable Resolution (Cogwheel Selector)**: Click the cogwheel next to **`Export WebM`** in Screensaver mode to choose **`1280×720`** (default 16:9), **`1920×1080`** (16:9 Full HD), **`720×1280`** (vertical 9:16 for Shorts / Reels / TikTok with a dedicated portrait cockpit layout), or custom even `W×H` dimensions with proportionally scaled video bitrate and live aspect-ratio preview.
- **Composite Canvas + Web Audio Capture**: Records the full cockpit scene, windshield shader/effect, active falling-arrow highway, dashboard HUD displays, and real-time Web Audio output (music + simulated drum audio) directly to a downloadable `.webm` file.
- **Mode-Preserving Armed Start (`Press space to begin`)**: Clicking **`Export WebM`** keeps your currently selected `Sim Sound` mode (`Demo`, `Sync`, or `Input`) and enters an armed standby prompt (`Press space to begin`) so you can focus the window and get your hands on `D F J K` before recording and playback begin.

### 8. StepMania Export, Portable Project JSON & Local Caching
- **Generated Outputs**: Copy or inspect **`.sm Header`**, **`LLM Prompt`** (annotated beat/section/instrument event map), and **`Project JSON`**.
- **Portable `.stepsync.json`**: **`Save JSON` / `Load JSON`** (or **`Download .json` / `Import .json`**) serializes the complete `StepSyncProject` (`version: 1`) state including sync, sections (with visual presets), difficulty matrix, lane rules, simulator settings, manual edits, and cached drum events.
- **Analysis Cache & Automatic IndexedDB Persistence**: Export/import `.stepsync.cache` bundles (separated drum stem + spectral cache) and resume tracks automatically via browser IndexedDB caching, with default demo companion assets (`166.m4a`, `166.stepsync.json`, `166.stepsync.cache`) bundled in `public/`.

---

## Keyboard Shortcuts

| Context | Key | Action |
| :--- | :--- | :--- |
| Global | `Space` | Play / Pause (or start armed WebM capture in Screensaver) |
| Editor | `M` | Toggle Metronome |
| Editor | `T` | Tap Tempo (4-tap average) |
| Editor | `ArrowUp` / `ArrowDown` | Nudge offset by `±5 ms` |
| Editor | `ArrowLeft` / `ArrowRight` | Seek backward / forward by 1 bar |
| Simulator / Screensaver | `D` / `F` / `J` / `K` or `Arrow Keys` | Hit Left / Down / Up / Right panels |
| Screensaver | `1` / `2` / `3` / `4` | Switch visual preset (`GLSL Space`, `Wormhole`, `Music Rain`, `MilkDrop`) |

---

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- A modern Chromium/WebAudio browser (Chrome/Edge recommended for optional **WebGPU AI** HT-Demucs stem separation and hardware-accelerated WebM recording; **Instant DSP (HPSS)** works in any WebAudio browser)

### Installation & Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

### Scripts

```bash
npm run dev       # Start Vite development server on port 3000
npm run build     # Build production bundle to dist/
npm run preview   # Preview the production build locally
npm run lint      # Run TypeScript type-checking (tsc --noEmit)
```

---

## Project Structure

```text
public/
├── 166.m4a                       # Default demo audio track
├── 166.stepsync.json             # Default project configuration (including section visual presets)
└── 166.stepsync.cache            # Precomputed stem & spectral cache for instant startup
src/
├── App.tsx                       # Workspace state, audio loading, planner UI, project JSON export/import
├── types.ts                      # Shared TypeScript interfaces (Section, DrumLaneRule, StepSyncProject, etc.)
├── index.css                     # Tailwind CSS v4 base styles and dark-mode select defaults
├── components/
│   ├── GlobalTransport.tsx       # Top transport controls, loop toggle, beat/time readout
│   ├── SpectrumVisualizer.tsx    # 8192-FFT log spectrum analyzer & band solo selector
│   ├── Waveform.tsx              # Real-time scrolled waveform with beat/section markers
│   ├── StaticWaveform.tsx        # Static alignment grid, draggable sync handles & Edit Notes mode
│   ├── StemStudio.tsx            # Drum separation launcher, auditioning & Lane Manager
│   ├── Simulator.tsx             # 4-key StepMania highway, scoring, calibration, Sim Sound & Screensaver host
│   └── ScreensaverVisualizer.tsx # Futuristic cockpit visualizer, 4 presets, highway overlay & WebM exporter
├── lib/
│   ├── AudioEngine.ts            # Web Audio playback, lookahead drum synth scheduler, capture bus & solo filters
│   ├── audioProcessing.ts        # Client-side BPM/offset estimation and transient detection
│   ├── drumAnalysis.ts           # Spectral flux band extraction, alt-lane mapping, matrix & manual edits
│   ├── fft.ts                    # Radix-2 FFT plan for STFT / spectral processing
│   ├── projectCache.ts           # IndexedDB persistence & .stepsync.cache bundle serialization
│   ├── rhythmBodyLanguage.ts     # Two-bar cockpit groove physics, drum impulse rig & preset definitions
│   ├── stemWorkerClient.ts       # Web Worker coordinator for HPSS & ONNX WebGPU HT-Demucs
│   └── utils.ts                  # Shared utility helpers
└── workers/
    ├── drumStem.worker.ts        # Background DSP (HPSS) & WebGPU HT-Demucs stem isolation worker
    └── spectralCache.worker.ts   # Background 4096-FFT spectral cache builder for custom Hz lanes
```

---

## License

Licensed under the [MIT License](./LICENSE). Copyright © 2026 fernicar.