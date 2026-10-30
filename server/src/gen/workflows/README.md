# ComfyUI generation workflows

The default `comfy-sdk` path uses MOSS-Image SFT for text-to-image and
Wan2.2 TI2V 5B for image-to-video through the official `@comfyorg/sdk` and
Comfy API proxy. A limited API-driven 512×512 image and short video smoke passed on an RTX 3060;
browser acceptance and production quality remain unverified. The Qwen and FastH3 paths below are legacy opt-ins; their
historical evidence does not validate the defaults. A saved user-selected
workflow can override these defaults. See `docs/model-licenses.md` for model
licenses and unresolved provenance, and the top-level `README.md` for
environment setup.

| File | Use | Main bindings |
| --- | --- | --- |
| `moss_txt2img.json` | Default text-to-image; no reference-image edit. | MOSS SFT INT8, Qwen3.5 encoder and FLUX2 small VAE; see `server/src/index.ts`. |
| `wan22_ti2v_i2v.json` | Default image-to-video with one first frame. | Wan2.2 5B, UMT5 encoder and Wan VAE; graph uses a fixed frame count; see `server/src/index.ts`. |
| `txt2img.json` | Explicit legacy Qwen text-to-image profile. | Qwen Image 2.1 Turbo and Qwen3-VL encoder; license differs from app source. |
| `qwen21_img2img.json` | Explicit legacy Qwen single-reference edit. | Pinned graph and SHA contract; license differs from app source. |
| `fasth3_i2v.json` | Explicit legacy FastH3 first-frame video. | MiniMax H3 terms apply; not the default video graph. |
| `img2img.json` | Retired SD 1.5 development fixture. | Do not use as a normal-generation fallback. |

The model files are expected under the ComfyUI model search path. The current
Comfy Desktop generated instance configuration under
`%APPDATA%/Comfy Desktop/instance-model-paths/<active-instance>.yaml` sets
`base_path` to the shared Studio `models/` directory and maps `diffusion_models`,
`text_encoders`, and `vae`. Do not edit this generated file by hand. Its path
mapping does not prove that a running ComfyUI process has registered or loaded
the models. The server does not download, copy, or configure model weights.

## Prompt guides and node source

When present, `.agents/skills/qwen-image-prompt-en/` gives prompt-writing
guidance for Qwen images. For MiniMax H3 video prompts, use the local
`.agents/skills/h3-prompt-writing/` and its I2VA section in
`references/base-en.txt`. The current VO adapter supports only one starting
image and does not expose H3 text-to-video, first/last-frame, last-frame, full
reference, or audio-only modes (T2VA, FL2VA, L2VA, and Ref2VA). The eight
style-specific MiniMax generator skills depend on MiniMax Hub canvas and
generation tools; this Comfy adapter does not provide those tools. Use them
only as creative guidance where their requirements fit the VO input contract,
and preserve the user's requested content.

The Qwen and FastH3 node implementations are present in the vendored ComfyUI
core under `comfy_extras/nodes_qwen.py` and
`comfy_extras/nodes_minimax_h3.py`; they are not separate packages in
`custom_nodes/`. Source presence does not prove that the currently running
ComfyUI registered them. Check the live node catalog before claiming runtime
readiness. `data/assets/minimax-h3/` contains example media, not model weights
or implicit generation inputs.

## Legacy Qwen and FastH3 API graph input contract

`txt2img.json` node IDs used by `ComfySdkBackend`:

- Prompt and fixed empty negative prompt: `6.prompt`, `6.negative_prompt`
- Seed: `7.noise_seed`
- Output size: `11.width` / `11.height` (the app converts image dimensions to
  the Qwen packed-latent crop units)
- Output: `14`

The Qwen reference graph uses prompt node `6`, noise node `7`, reference image
loader `1`, encoder resolution `6.resolution`, and output node `13`.

For the bundled reference workflow, VO probes the managed reference image,
calculates the Qwen node's actual 32-pixel canvas, and requires an explicit
confirmation of that candidate. The confirmation records the source hash,
original requested dimensions, encoder resolution and chosen canvas. VO stages
and re-hashes the source before SDK submission, then probes the generated file
before accepting it. A changed source, unavailable probe or mismatched output
is reported rather than silently accepted. Retry must retain the confirmation.

This path uses an existing `ffprobe` executable, configurable with the
`FFPROBE_BIN` environment variable; no binary or package is installed by VO.
ffprobe is maintained by the FFmpeg project; FFmpeg's license depends on its
build configuration (see [FFmpeg legal](https://ffmpeg.org/legal.html)). A
missing or unusable executable blocks this exact-size preflight explicitly.
The probe accepts only files inside managed asset storage, restricts protocols,
and checks EXIF orientation separately because ffprobe may not report it.
Ambiguous metadata is rejected. This integration does not imply character
identity fidelity across generations.

The bundled FastH3 graph binds output width and height to node `142`. Its
dimensions must both be positive multiples of 32. Explicit pixel pairs in the
approved output policy take precedence over aspect defaults; incompatible or
missing dimensions are rejected before SDK submission rather than silently
rounded. User-selected workflows have their own bindings and validation.

The Qwen text graph is SHA-256 pinned in
`server/src/gen/qwenImageTextProfile.ts`. The reference/edit graph is pinned in
`server/src/gen/qwenImageEditProfile.ts`. The API graphs must use the exact
model filenames and node links validated by those profile readers.

To author a workflow, export API format from ComfyUI. Canvas JSON using
`nodes` and `links` is not executable through the SDK. Do not replace either
Qwen profile graph with a canvas file or an SD 1.5 checkpoint graph.

## templates/

`templates/` holds API-format conversions of the official ComfyUI template
workflows from `vendor/ComfyUI/ComfyUI/user/default/workflows/`, produced by
`scripts/comfy-ui2api.py`. They are unoptimized reference material for future
profiles — no `WorkflowSpec` reads them. See `templates/README.md` and
`templates/manifest.json` for per-workflow model/input status against the
local install.

## Exact-byte workflow integrity

`qwen21_img2img.json` is an approved input pinned by
`QWEN_IMAGE_EDIT_WORKFLOW_SHA256` in `qwenImageEditProfile.ts`. Its approved
source SHA-256 is
`9f5480090edf7e0bcbc391ded0f9f702c2da297875ec307cdae40d17a0ef7b15`.
The source has CRLF line endings; `.gitattributes` disables Git text
normalization for this exact file so a clean checkout reproduces those bytes.
The exact-path whitespace policy recognizes CR as part of each line ending
while retaining normal trailing-blank/blank-EOF/space-before-tab checks.
Other workflow files and repository-wide line-ending settings are unchanged.

Git's former normalized LF blob had SHA-256
`79bda3a7c3a46255676c97793286364e0befa9edf85b4eed011f0e521f51d844`,
which failed the existing integrity guard in a clean checkout even though the
JSON values were equal. Preserve the approved bytes; do not replace the
expected hash merely to accept normalized or generated content.

```mermaid
flowchart LR
    Approved[Approved raw workflow bytes] --> Git[Git blob: text normalization disabled]
    Git --> Checkout[Clean checkout: same bytes]
    Checkout --> Guard[Existing SHA-256 integrity guard]
    Guard --> Parser[Existing JSON and SDK contract validation]
```

This preservation fix changes neither parsed JSON, node settings, expected
hash nor runtime signature/approval behavior. Existing profile/config tests
exercise the guard; mock tests and a successful web build are not evidence
of a real ComfyUI generation. Revisit this exception only with an explicitly
reviewed replacement workflow and matching provenance/byte-integrity tests.

## Template attribution and limits

The `templates/` conversions are derived from Comfy Org's workflow template
repository, https://github.com/Comfy-Org/workflow_templates, distributed under
its MIT license. The copyright and permission notice is retained in
`COMFY-TEMPLATES-LICENSE.txt`. The default MOSS/Wan graphs are adaptations;
`3918487` describes the Wan graph as based on the official 5B template, while
the MOSS graph shares the official template's node structure. The exact source
revision and complete modification lineage for both default graphs remain to be
confirmed; the MIT notice is retained provisionally and is not proof of that
lineage or of model and media rights. Verify all bundled workflow and example
media provenance before public release. Model weights are not included.

The checked-in `catalog/official-moss-base-46e060ea.json` records source
revision `46e060ea88eb07adecf07197ec384c54a70e030c` and an upstream source
hash. Comparing it with the candidate MOSS graph found 16 shared node IDs,
all with the same class, and 11 unchanged node objects. This is evidence of
similarity to that baseline, not complete proof of the adaptation chain.
The MIT license at that source revision is the notice included above.

## Source comparison performed for release review

The candidate MOSS API graph was compared with the recorded official MOSS Base
API baseline at revision `46e060ea88eb07adecf07197ec384c54a70e030c`: 16 node IDs
are shared with identical class names; 11 entire node objects are unchanged.
The differing inputs are UNET filename (Base → SFT), prompt, width/height,
seed and output filename prefix; a ResolutionSelector node is removed. This
is a bounded structural comparison, not proof of an unbroken source chain.

The [official Wan 2.2 TI2V template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_5B_ti2v.json)
contains the same named Wan latent node 55, first-image loader 56, CreateVideo 57
and SaveVideo 58. Its displayed node 55 defaults are 1280×704 and 121 frames,
where the candidate API graph uses 832×480 and 49 frames; candidate node 56 is
connected as the first image, whereas the source canvas currently marks that
node bypassed. This is a comparison against the current upstream page, not a
complete conversion diff or proof of the exact original revision. Obtain and
compare that revision before making a definitive provenance claim.

## Current upstream Wan canvas comparison

Read-only comparison on 2026-10-29 of the [current upstream canvas](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_wan2_2_5B_ti2v.json)
with `wan22_ti2v_i2v.json` found the same 12 executable node IDs and classes;
the upstream canvas also has MarkdownNote 59, omitted from the API graph.
The canvas lists the same model filenames, sampler settings (20 steps, CFG 5,
uni_pc/simple, denoise 1), sampling shift 8 and 24 fps. Differences observed:
node 55 defaults 1280×704 / 121 frames upstream versus 832×480 / 49 in the
candidate; upstream LoadImage 56 is bypassed, while candidate connects it;
positive prompt and output prefix are changed and the candidate uses seed 42
before runtime injection. Negative prompt matches. The repository converter
refused the current upstream canvas because node 37 lacked named widget mapping;
therefore this is a manual bounded comparison, not a complete automated graph
diff. The exact historical source revision and conversion chain remain unknown.
The candidate's runtime bindings inject prompt, seed, dimensions and first image.

The MOSS upsampler includes a system prompt associated with OpenMOSS's Prompt
Enhancer. See `OPENMOSS-NOTICE.md` for attribution, Apache-2.0 license location,
and the bounded comparison; the Comfy template MIT notice remains separate.
The exact source revision is a provenance and reproducibility limitation, not
itself an additional condition stated by the Comfy template MIT license.
