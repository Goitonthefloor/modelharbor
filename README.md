# ModelHarbor

Local AI chat models in one click: no terminal, no cloud, no account.

ModelHarbor looks at your hardware, picks a matching llama.cpp backend, downloads
models straight from HuggingFace and then opens a chat that is already set up the
right way.

```
┌──────────────┐   1. detect hardware      ┌───────────────────────────┐
│  ModelHarbor │ ────────────────────────► │ CPU / GPU / VRAM / NPU    │
│  (desktop)   │                           └───────────────────────────┘
│              │   2. pick a backend       CUDA · ROCm · Vulkan · Metal
│              │   3. load a model         HuggingFace (GGUF, resumable)
│              │   4. start llama-server   presets: Creative / Deterministic / …
└──────────────┘
```

## What it does

- **Setup without prior knowledge.** ModelHarbor detects your operating system, CPU, RAM,
  GPUs (NVIDIA, AMD, Intel, Apple) and NPUs. It then recommends a backend and downloads it.
- **Plenty of backends.** Depending on the platform, llama.cpp builds for CUDA (12.4 / 13.5),
  ROCm/HIP, Vulkan, Metal, SYCL, OpenVINO and CPU are available.
- **Models that match your machine.** For every model the catalog shows whether it fits
  fully into VRAM, is partly offloaded to the GPU, or only runs in RAM. The app also picks
  a matching quantization (Q4_K_M, Q6_K and so on).
- **Models from your own folders.** Under Setup → *Additional model folders* you can add any
  folder that already holds models — an existing LM Studio collection, a second drive, a NAS
  share. Those models show up in the *Installed* tab with an **External** badge and their source
  folder, and load exactly like downloaded ones. Nested layouts (`publisher/model/file.gguf`)
  are scanned two levels deep, GGUF splits and ONNX folders are recognised, and the hardware
  fit is calculated for them too. External models are never deleted by the app: *Remove* only
  takes the folder off the list, the files stay where they are.
- **Per-model settings, including KV cache quantization.** The gear icon on any model (and in
  the chat header for the loaded one) opens a settings dialog stored per model: context length,
  GPU layers, flash attention (auto/on/off), **separate K and V cache types**
  (`f16, bf16, f32, q8_0, q5_1, q5_0, q4_1, q4_0, iq4_nl`), batch and micro-batch size, CPU
  threads, mlock, mmap off and RoPE base/scale — the same knobs LM Studio exposes. A live
  readout shows the KV cache size for the chosen context and types, and the hardware fit is
  recalculated with them (q4_0/q4_0 needs about 28 % of the f16 cache). A quantized V cache
  forces flash attention, as llama.cpp requires. Empty fields fall back to the global defaults;
  models with overrides carry a **Custom** badge.
- **An API server for your agents.** The new **Server** tab (between *Models* and *Setup*)
  turns the loaded model into an OpenAI-compatible endpoint that agents and tools can call:
  pick a model and preset, press **Start server**, and copy the ready-made connection details.
  You get the base URL (`http://127.0.0.1:1234/v1`), the stable model name **`ModelHarbor`**
  (it stays the same when you switch models), the endpoints, and copyable **curl**, **Python
  (openai SDK)** and **JSON** examples. A **LAN switch** binds the server to `0.0.0.0` and shows
  the real LAN addresses, so other machines in your network can use it. An **API key** can be
  generated with one click and is then enforced on every `/v1/*` call (`/health` stays open for
  monitoring); turning the LAN switch on without a key shows a visible warning. **CORS** can be
  restricted to same-origin, and **parallel requests** sets how many agents are served at once
  (note that llama.cpp splits the context window across those slots). The built-in chat uses the
  same server and sends the key automatically, and the server log is shown live in the tab.
- **The model's own context window.** ModelHarbor reads `context_length` straight from the GGUF
  metadata and shows it in the per-model settings dialog ("Model context window: N tokens").
  The context length is set per model, and exceeding the trained window produces a visible
  warning with a hint about RoPE scaling instead of silently degrading quality.
- **HuggingFace search.** You can search any GGUF repo, check file size and the hardware
  estimate before downloading, and then load it. Downloads resume after an interruption and
  multi-part models are fetched completely.
- **Four presets** with real llama.cpp sampler chains:
  - **Balanced**: everyday use, questions and explanations
  - **Creative**: more variety (DRY + XTC)
  - **Deterministic**: greedy sampling with a fixed seed, so it is reproducible
  - **Code / Reasoning**: cool sampling with a repetition brake
- **NPU detection.** Intel NPUs, AMD XDNA and the Apple Neural Engine are shown. Where it makes
  sense (Intel NPU with OpenVINO) there is an experimental option for it. Otherwise the chat
  honestly runs on GPU or CPU.
- **Reasoning models.** Models such as Qwen3 show their `reasoning_content` as a collapsible
  train of thought, kept separate from the actual answer.
- **Speed readout.** After every answer the chat footer shows prompt tokens, response tokens
  and the rate actually reached in `tok/s` — measured from the first to the last stream delta,
  not estimated.
- **Handling.** Stop button (or `Esc`) during an answer, chat history with copy and regenerate.
  The interface is available in German and English (switchable in the setup, no restart needed)
  and keeps working offline after the first download.
- **Unload & reload.** One click on **Unload** gives immediate feedback and frees the model from
  memory. The red button then turns into the green **“Load last model”** — the last model used is
  back with a single click (including preset and GPU fit).
- **Usable all round.** The model tabs can be switched with the arrow keys, the active tab has a
  clear underline, and every action has visible focus and press feedback. Confirmations (switch
  model, delete, remove backend) are shown as dedicated dialogs, messages as dismissible notices
  that screen readers pick up as well.
- **Auto-update.** On startup the app silently checks the GitHub releases for a newer version.
  If there is one, a dialog asks: **Update now** downloads the matching package
  (AppImage/installer) directly — a status bar shows the progress — and you open the file
  afterwards with one click. No update, no interruption. The setup view also offers a manual
  check (“Check for updates”).

## Installation

The ready-made packages live in `dist/`:

| Platform | File | Status |
|---|---|---|
| Windows 10/11 (x64) | `dist/ModelHarbor Setup 1.7.2.exe` | built with `npm run dist:win` (Wine cross-build, unsigned) |
| Linux (x64) | `dist/ModelHarbor-1.7.2.AppImage` | built, start-tested (126 MB) |
| macOS (Apple Silicon / Intel) | `ModelHarbor-1.2.2-arm64.dmg` / `-x64.dmg` | build with `npm run dist:mac` (on a Mac) |

Both current packages are attached to the [GitHub release](https://github.com/Goitonthefloor/modelharbor/releases/latest)
as `ModelHarbor-1.7.2.AppImage` and `ModelHarbor-Setup-1.7.2.exe`.

On first start the app walks you through the setup: check hardware, install a backend,
pick a model.

> The packages are not signed. On first start Windows shows a SmartScreen warning
> (“More info” → “Run anyway”). On macOS the first start asks for a right click → “Open”.
> ModelHarbor sends no telemetry. Downloads only come from `huggingface.co` and
> `github.com`.

## Building it yourself

You need Node.js ≥ 20 and npm.

```bash
npm install
npm start                 # development mode
npm test                  # backend unit tests (hardware, presets, server args)
python3 scripts/ui-smoke.py   # renderer smoke test (needs Playwright + Chromium)
npm run dist:linux        # AppImage
npm run dist:win          # NSIS installer
npm run dist:mac          # DMG
```

The renderer smoke test (`scripts/ui-smoke.py`) loads the interface headless in Chromium,
mocks the Electron bridge and checks the main flows: unload → “Load last model”, toast
messages, keyboard tab navigation, confirmation dialogs, plus the language switch
(German → English → German). Expected exit code: 0.

The packages land in `dist/`. Windows and macOS packages are best built on the respective
system (or in CI). Cross-builds from Linux to Windows only work with Wine.

What I have tested so far: Linux (development and AppImage, CPU backend, model download,
chat with Qwen3-4B) and Windows 11 (hardware detection, CUDA recommendation, installing the
NSIS package). More hardware combinations are next on the list. See below for details.

## Data paths

| Content | Windows | Linux | macOS |
|---|---|---|---|
| Settings | `%APPDATA%\ModelHarbor` | `~/.config/ModelHarbor` | `~/Library/Application Support/ModelHarbor` |
| Models | `…\ModelHarbor\models` | `~/.config/ModelHarbor/models` | `…/ModelHarbor/models` |
| Backends | `…\ModelHarbor\backends` | `~/.config/ModelHarbor/backends` | `…/ModelHarbor/backends` |

You can change the model and backend folders in the app under **Setup → Settings**.

## How ModelHarbor detects the hardware

| Platform | GPU | VRAM | NPU |
|---|---|---|---|
| Windows | `nvidia-smi`, WMI (`Win32_VideoController`) | `nvidia-smi`; an estimate for AMD and Intel | `Get-PnpDevice` (ComputeAccelerator / AI Boost / XDNA / Hexagon) |
| Linux | `nvidia-smi`, `lspci`, sysfs | `nvidia-smi`, `/sys/class/drm/*/mem_info_vram_total` | `lspci` (Processing Accelerators), `/dev/accel/*` |
| macOS | `system_profiler SPDisplaysDataType` | unified memory (Apple Silicon: about 66 % of RAM) | Apple Neural Engine (informational only) |

The backend recommendation follows this logic:

1. **Apple Silicon**: Metal build.
2. **NVIDIA**: CUDA, because it is clearly faster than Vulkan. Vulkan is the alternative.
3. **AMD on Linux**: ROCm if the runtime is present. Otherwise Vulkan.
4. **AMD on Windows**: Vulkan, because it runs reliably. ROCm is available as an experimental option.
5. **Intel**: Vulkan. SYCL is experimental. OpenVINO only when an Intel NPU is detected.
6. **No GPU**: CPU build.

## How the model fit is calculated

I estimate the memory requirement like this:

```
need ≈ file size + KV cache + overhead
KV cache ≈ parameters × 0.045 GB × (context / 4096)
```

That yields four levels: **fits in VRAM**, **partly on GPU**, **runs in RAM** and **too large**.
For the quantization the app takes the largest quant that still fits with a safety margin. It
stays below 65 % of the budget so that speed does not suffer.

## Presets in detail

| Preset | Temp | Top-K | Top-P | Min-P | Special feature |
|---|---|---|---|---|---|
| Balanced | 0.70 | 40 | 0.92 | 0.05 | default sampler chain |
| Creative | 1.05 | 80 | 0.96 | 0.02 | DRY 0.8 + XTC 0.4 |
| Deterministic | 0.00 | 1 | 1.00 | 0.00 | seed 42, greedy |
| Code / Reasoning | 0.20 | 20 | 0.95 | 0.05 | DRY 0.5, long repeat range |

When a model starts, the app passes all preset parameters to `llama-server`. In the chat it
applies the main parameters again with every request, so a preset change takes effect at once.

## Under the hood

- **Electron**: main process and renderer with `contextIsolation`, Node does not run in the renderer.
- **llama.cpp**: binaries from the official `ggml-org/llama.cpp` releases. The app automatically
  takes the newest build that ships binary assets.
- **llama-server** runs as a local process and exposes an OpenAI-compatible API on `127.0.0.1`.
- The chat streams via SSE directly from the renderer.
- **Updates** come from the GitHub releases (`Goitonthefloor/modelharbor`): semver comparison in
  the main process, download of the platform-matching package with progress status. The check is
  a silent `GET /repos/…/releases/latest` — no account, no telemetry.
- No telemetry. Apart from HuggingFace and the GitHub releases there are no cloud calls.

> **Sandbox note (Linux AppImage):** an AppImage cannot ship the setuid binary needed for the
> Chromium sandbox. That is why the package starts with `--no-sandbox`. This is common for
> AppImages. The app loads only local files (`file://`) and talks only to the `llama-server` it
> started itself on `127.0.0.1`. If you want the sandbox, build with
> `npm run dist:linux -- --dir` and start `dist/linux-unpacked/modelharbor` with your own
> `chrome-sandbox`. Window association works through `desktopName` and
> `syncDesktopName` (`StartupWMClass=modelharbor`).

## Troubleshooting

**“No backend installed”**: open the setup and install the recommended backend. This needs
internet once. After that everything runs offline.

**Model does not load or crashes**: usually VRAM is not enough. Lower the GPU layers in the setup
(for example from 999 to 20) or reduce the context size.

**AMD on Windows is slow**: Vulkan is the stable route. ROCm is experimental and depends on the
driver.

**Apple Silicon**: Metal is active automatically. With unified memory the VRAM figure shown is
only an estimate.

## Feedback wanted

So far ModelHarbor runs on my own machines. Hardware detection and backend selection are
therefore mainly tested for the configurations I have myself. Next I want to test more
combinations, for example AMD GPUs, Intel systems, notebooks with hybrid graphics and macOS.

If you try ModelHarbor, I would love to hear:

- **what kind of system you have** (operating system, CPU, RAM, GPU, NPU if any)
- **which backend was detected and installed**, and whether the chat works
- **what did not work**, ideally with the error text or a screenshot

The easiest way is an [issue](https://github.com/Goitonthefloor/modelharbor/issues).
Short replies like “works” or “does not work” already help me a lot.

## License

**ModelHarbor License 1.0: free to use, distribution only with a license.**

| Allowed free of charge | Only with a written license (fee required) |
|---|---|
| Private, educational and internal use | Passing it on to third parties |
| Commercial use **inside your own** company, on any number of devices | Publishing, mirroring, uploading to other sites, app stores, package repositories |
| Trying it out, testing, benchmarking | Selling, renting, bundling with products |
| Modifications for your own needs | Running it as a service for third parties (SaaS/PaaS) |

Forks and public copies are not allowed. The fork feature of this repository is disabled as
well.

This is deliberately **not** an open-source license in the OSI sense but a *source-available*
license. The binding text is in [`LICENSE`](LICENSE) and is maintained in German and English
(the English text is authoritative); an informal German summary follows at the end of that file.

Questions about the license are welcome as an issue in the repository or through the contact
details in the GitHub profile.

**Third-party components** keep their own licenses: Electron (MIT), llama.cpp (MIT; downloaded
by the user at runtime and not bundled), yauzl (MIT), tar (ISC).
