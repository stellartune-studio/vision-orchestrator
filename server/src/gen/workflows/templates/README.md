# Official ComfyUI template workflows — API format

Unmodified conversions of the official ComfyUI template workflows stored at
`vendor/ComfyUI/ComfyUI/user/default/workflows/`. These are base material for
optimization; **no VO generation profile selects them yet**. Each file is in
ComfyUI API (prompt) format: `{ "<nodeId>": { "class_type", "inputs" } }`.

Converted by `scripts/comfy-ui2api.py`, which expands embedded subgraphs
(`definitions.subgraphs`, instance ids namespaced as `<instance>_<inner>`),
resolves `widgets_values_named` values onto widget-bound inputs, wraps literal
list values in `{"__value__": [...]}` (a bare list is the API encoding of a
link), passes through bypassed nodes, and drops `MarkdownNote`/muted nodes.

Re-run:

```powershell
python scripts/comfy-ui2api.py `
  "..\..\..\vendor\ComfyUI\ComfyUI\user\default\workflows" `
  "server\src\gen\workflows\templates"
```

## Verified environment

- Vendored ComfyUI `0.42.1`, `vendor/ComfyUI/ComfyUI/.venv` (torch 2.12.1+cu130,
  CUDA available). `standalone-env` is not the working runtime.
- Offline node registry: 680 `NODE_CLASS_MAPPINGS` entries
  (`nodes_replacements.py` fails offline because it needs a running
  `PromptServer`; no template node depends on it).
- Model search paths = vendored `ComfyUI/models/` (only
  `checkpoints/v1-5-pruned-emaonly-fp16.safetensors`) plus the Desktop instance
  file `%APPDATA%/Comfy Desktop/instance-model-paths/inst-1792141784927.yaml`
  → `base_path = stellartune-studio/models` with all category mappings.
- Every template was run through the backend's `execution.validate_prompt`
  offline. Verdicts below; "structurally valid" means class types, links,
  input names and combo choices all resolve against this environment.

## Per-workflow status

| File | Nodes | Models referenced | Validation | Gap |
| --- | --- | --- | --- | --- |
| `audio_yue2_music_cover.json` | 13 | yue2_3b_int8_convrot, sheetsage2_bf16 | FAIL | `sheetsage2_bf16.safetensors` not in `models/audio_encoders`; input `yue2_reference_song.flac` absent |
| `audio_yue2_text2music.json` | 16 | yue2_3b_int8_convrot | OK | — |
| `basic_datatype_conversion.json` | 20 | — | OK | — |
| `basic_mask_operations_and_compositing.json` | 37 | — | OK | input `example.png` exists |
| `image_krea2_turbo_int8_image_style_reference.json` | 26 | krea2_turbo_int8_convrot, qwen3vl_4b_fp8_scaled, qwen_image_vae, krea2_style_reference (loras) | OK | input `krea2_reference_image.png` absent (user must supply a reference) |
| `image_moss_image_base_t2i.json` | 17 | moss_image_base_int8_convrot, qwen3.5_9b_w4a8_gptq, flux2-vae_small | OK | — |
| `image_moss_image_t2i_bboxes.json` | 20 | **moss_image_sft_int8_convrot**, qwen3.5_9b_w4a8_gptq, flux2-vae_small | OK* | `moss_image_sft_int8_convrot.safetensors` absent; `moss_image_base_int8_convrot` is the local variant — swap `18_1.unet_name` when optimizing |
| `image_qwen_image_2_1_turbo_image_edit.json` | 22 | qwen_image_2.1_turbo_int8_convrot, qwen3vl_8b_int8_convrot, qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot, qwen_image_2.1_vae_bf16 | OK | input `ballet_dancer_photography_minimalist_architecture.png` absent |
| `llm_qwen3vl_text_gen.json` | 4 | qwen3vl_4b_fp8_scaled | OK | — |
| `utility_birefnet_remove_background.json` | 7 | birefnet | FAIL | `birefnet.safetensors` not in `models/background_removal`; input `the_lily_veil.png` absent |
| `utility_image_stitch.json` | 9 | — | FAIL | inputs `angle_1..4.png` absent |
| `utility_seedvr2_3b_int8_upscale_image.json` | 13 | seedvr2_3b_int8_convrot, seedvr2_ema_vae_fp16 | FAIL | input `watch_macro_shot.png` absent |
| `utility_seedvr2_3b_int8_upscale_video.json` | 20 | seedvr2_3b_int8_convrot, seedvr2_ema_vae_fp16 | FAIL | input `grainy_perfume_shot_crf32.mp4` absent |
| `utility_video_frame_interpolation.json` | 10 | film_net_fp16 | FAIL | input `white_armored_warrior.mp4` absent |
| `video_fastvideo_fasth3_i2v.json` | 22 | fastvideo_fasth3_8step_v2_pruned_int8_convrot, qwen3vl_32b_minimax_h3_nvfp4_awq, minimax_h3_video_vae_int8_convrot, minimax_h3_audio_vae_fp32 | FAIL | input `red_line_barrier.png` absent |
| `video_fastvideo_fasth3_t2v.json` | 20 | (same four FastH3 files) | OK | — |

\* `validate_prompt` returned valid even though node `18_1` reports
`value_not_in_list`; the file check above is authoritative for model presence.
Treat as "needs the model or a model swap" before execution.

FAIL here means "cannot run end-to-end as-is" — either a referenced model file
is missing locally or the template's example input asset is not in
`ComfyUI/input/`. All remaining validation errors are of exactly these two
kinds; no structural or type errors remain after conversion.

## Missing model files (referenced but not on disk)

| File | Category dir | Used by |
| --- | --- | --- |
| `sheetsage2_bf16.safetensors` | `models/audio_encoders/` (empty) | YuE2 music cover |
| `birefnet.safetensors` | `models/background_removal/` (empty) | BiRefNet remove background |
| `moss_image_sft_int8_convrot.safetensors` | `models/diffusion_models/` | MOSS bbox variant (base variant is present) |

`models/huggingface-cache/hub/` also holds GGUF blobs (Irodori-TTS, Laya,
Qwen3.8-27B, embeddinggemma-2, Qwen3-ASR, gemma-4-12B) used by HF-hub style
nodes; those are not part of the ComfyUI folder-path search and no template
workflow references them.

## Notes for optimization

- `video_fastvideo_fasth3_*` share subgraph `4c314f31` (First Last Frame to
  Video). The existing pinned `fasth3_i2v.json` predates this template and
  wires different node ids — compare before merging.
- `image_qwen_image_2_1_turbo_image_edit.json` uses the `qwen3.5_9b_..._pe_i2i`
  editor encoder plus `qwen3vl_8b`; the pinned `qwen21_img2img.json` contract
  stays authoritative for VO's edit path until a profile is updated.
- `SaveVideo`/`SaveAudioAdvanced` expose `COMFY_DYNAMICCOMBO_V3` inputs
  (`format`, `format.codec`, `codec`, …) as widget-bound inputs; they were
  emitted verbatim and validate, so keep the flattened names when editing.
- `ImageCompare.compare_view` is required but never serialized by the UI; the
  converter emits `{}` (the node ignores the value).
