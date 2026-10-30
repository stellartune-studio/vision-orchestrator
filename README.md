# Vision Orchestrator — 制作設計図 (ProjectBlueprint)

An AI video studio where you work as the **director** (監督), not the
production staff. Through chat, you and an LLM grow a structured
production blueprint — intent, story, characters, materials,
constraints — and only approved content flows into generation.

VO is for creators developing short video concepts who want to shape the
story and visual references before generating a reviewable clip. Its current
end-to-end product path is the freestyle mode: consult, approve a blueprint and
script, generate an image or short video, then save and review the result.

## Requirements

- **Node.js 24.22.1** (exact — uses `node:sqlite` and native TS type
  stripping; `.nvmrc` pins it)
- **pnpm 12.x**
- Optional, for real generation: local **ComfyUI** +
  [`comfy-api-proxy`](https://github.com/Comfy-Org/comfy-api-proxy)
  (Python package). The dedicated local setup uses ComfyUI on `:8288` and
  the SDK proxy on `:8289`; existing environments can use different ports.
  See [Real generation (ComfyUI)](#real-generation-comfyui) below.

## Quick start (fully offline)

```powershell
pnpm install
pnpm dev        # server :8787 + web :5173 (Vite proxies /api)
```

The dedicated local setup uses these separate loopback endpoints:

| Component | Default port | Purpose |
| --- | ---: | --- |
| VO API | `8787` | App API; Vite proxies `/api` here |
| VO web (Vite) | `5173` | Browser UI |
| ComfyUI | `8288` | Local node/model discovery and generation runtime |
| Comfy SDK proxy | `8289` | SDK-compatible generation API used by VO |

Existing Comfy installations may use other ports. Set the server-side
`COMFY_DISCOVERY_URL` and `COMFY_BASE_URL` for that environment; these values
describe configured endpoints and do not prove that a service is running.

Open http://localhost:5173. With the default `.env` (`LLM_PROVIDER=mock`,
`GEN_BACKEND=mock`) the whole consult→propose→approve→save→resume→generate
image loop runs offline with a **MOCK** badge shown in the UI. The mock backend
does not generate video; the video path requires the ComfyUI integration below.

```powershell
cp .env.example .env   # then edit for real integrations
```

## Layout

```
shared/   @vo/shared — types & API DTOs (no React, no provider specifics)
server/   Node + TS backend: node:http + node:sqlite + @comfyorg/sdk
  src/db/migrations/   numbered SQL migrations (append-only)
  src/repos/           the ONLY layer that contains SQL
  src/domain/          seeding templates + 3-axis state derivation
  src/llm/             DirectorLLMProvider (mock | openai-compatible | kaname)
  src/gen/             GenerationBackend + inputBuilder + workflow JSON
  test/                node:test — schema, FK, conflicts, e2e
web/      React + Vite frontend (plain CSS, React state only)
scripts/  ComfyUI environment setup, converters and verification helpers
docs/     approval-lifecycle.md, data-model.md, model-licenses.md,
          video-editing.md
.kaname/  agent profile for the optional Kaname LLM provider
```

`data/` (app database and generated assets) and `runtime/` (managed ComfyUI
environment) are created at runtime and are not part of this package.

## Verification

```powershell
pnpm test         # server + web tests (node:test)
pnpm typecheck    # all packages
```

## What "approved" means here

See `docs/approval-lifecycle.md`. In short: revisions are immutable,
the adopted pointer moves only with a matching `expected_version`
(409 on conflict), LLM proposals stay unconfirmed until you adopt
them, and approved content is never overwritten — alternatives are new
revisions.

## Real generation (ComfyUI)

The application is Apache-2.0; models, VAEs, text encoders and other
components have their own licenses. Model weights are not shipped: obtain
them from upstream and check `docs/model-licenses.md` before use. You can
choose supported ComfyUI workflows through configuration; custom workflows
must meet the app's input and validation requirements. Check the licenses
of any models and components you add yourself. Generation runs against a
local ComfyUI through `comfy-api-proxy` and the official `@comfyorg/sdk`.

- Set `GEN_BACKEND=comfy-sdk` plus `COMFY_BASE_URL` (SDK proxy) and
  `COMFY_DISCOVERY_URL` (ComfyUI) in `.env`; see `.env.example`.
- `scripts/setup-comfy.ps1` installs a managed ComfyUI at a pinned upstream
  revision into `runtime/` with locked Python dependencies
  (`scripts/comfy-requirements.lock.txt`) and starts it on the dedicated
  loopback ports. It never downloads model weights.
- Defaults: MOSS-Image SFT for text-to-image (`moss_txt2img.json`) and
  Wan2.2 TI2V 5B for image-to-video (`wan22_ti2v_i2v.json`). Legacy Qwen
  image and FastH3 video graphs remain opt-in via `GEN_PROFILE` /
  `COMFY_VIDEO_WORKFLOW`; their weights carry different licenses.
- A saved per-project workflow selection overrides the bundled defaults;
  approval gates still run before every submission. See
  `server/src/gen/workflows/README.md` for graph contracts, integrity
  pinning and provenance notes.

Director chat LLM options:

- `LLM_PROVIDER=openai-compatible` + `OPENAI_BASE_URL` / `OPENAI_MODEL` /
  `OPENAI_API_KEY` (server-side only)
- `LLM_PROVIDER=kaname` drives the chat through an installed Kaname CLI
  (`KANAME_BIN` / `KANAME_AGENT` / `KANAME_WORKDIR`, profile
  `.kaname/agents/vision-director.toml`; Kaname resolves credentials
  itself)

For the trim-and-caption editing flow, see `docs/video-editing.md`; it
requires locally installed FFmpeg and FFprobe and never changes the source
asset.

## Status and limitations

Only the `freestyle` mode is connected to the complete creation flow today;
the other five mode cards are previews. Character references and profiles are
versioned and can be pinned into production, but profile authoring currently
uses a JSON editor. A/B result selection is temporary UI state, not a saved
creative decision. DAW, MIDI, waveform editing, text animation and a shared
timeline are not implemented.

Package verification status (see `PACKAGE-MANIFEST.json`):
`pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck` and the
Vite build passed in a separate copy; the mock API path was exercised over
HTTP. A fresh registry download, real GPU generation and the full MV UI
flow remain untested; mock results are not real-generation evidence.

## License

Apache-2.0 — see `LICENSE`. Third-party dependencies keep their own
licenses (notably `@comfyorg/sdk`; consult each package's terms). Bundled
workflow templates derive from Comfy Org's MIT-licensed templates — see
`server/src/gen/workflows/COMFY-TEMPLATES-LICENSE.txt` and
`server/src/gen/workflows/OPENMOSS-NOTICE.md`. Model weights are not
included and remain under their upstream licenses
(`docs/model-licenses.md`).

## Cost notes

- Mock mode: free, offline.
- OpenAI-compatible LLM: whatever your endpoint charges.
- Comfy Cloud API needs a paid tier; the self-hosted
  comfy-api-proxy + ComfyUI path has no API fee (your GPU does the
  work).
