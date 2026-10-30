# Model weight licenses

Checked: 2026-10-29.

- The application source license is Apache-2.0 (see [`LICENSE`](../LICENSE)).
  This file covers third-party model weights only.
- This repository does not ship model weight files; workflows reference
  filenames that the operator downloads from upstream (environment setup:
  [README](../README.md#real-generation-comfyui), [`.env.example`](../.env.example)).
- Licenses can change; re-check upstream before redistribution or
  contest claims (e.g. "Open Weights Only").
- Australia is not listed in the MiniMax Excluded Territories;
  submission display destinations and commercial use still need separate
  review. This file is not legal advice.

| Local filename | Upstream model | Source URL | License (as of check date) | Redistribution / notes |
| --- | --- | --- | --- | --- |
| `qwen_image_2.1_turbo_int8_convrot.safetensors` | Qwen-Image-2.1-Turbo | https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo | Qwen RESEARCH LICENSE AGREEMENT (non-commercial / research-evaluation only; commercial needs separate license) | Local file is INT8/convrot quantized; exact quantizer revision unconfirmed. Weights not bundled in this repo. |
| `qwen3vl_8b_int8_convrot.safetensors` | Qwen3-VL-8B-Instruct | https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct | Apache License 2.0 | Quantized local filename; exact conversion provenance unconfirmed. |
| `qwen_image_2.1_vae_bf16.safetensors` | Qwen Image VAE (2.1-named local file) | https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo and/or https://huggingface.co/Qwen/Qwen-Image | unconfirmed whether this exact VAE file follows the Qwen Research License (2.1 family) or Apache-2.0 (original Qwen-Image). Original Qwen-Image card states Apache-2.0; 2.1 Turbo uses the Research License. | Do not claim a firm license for this local filename until file provenance is matched. Weights not bundled. |
| `fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors` | FastVideo-FastH3-8-Step-V2 (MiniMax H3 derivative) | https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2 | MiniMax H3 COMMUNITY LICENSE AGREEMENT (same family as MiniMax-H3; territorial exclusions include EU, UK, Korea, USA; additional commercial terms above revenue threshold) | LICENSE raw: https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2/raw/main/LICENSE . Local pruned INT8 file revision/provenance unconfirmed. |
| `minimax_h3_video_vae_int8_convrot.safetensors` | MiniMax-H3 video VAE | https://huggingface.co/MiniMaxAI/MiniMax-H3 (Comfy repack: https://huggingface.co/Comfy-Org/MiniMax-H3) | MiniMax H3 COMMUNITY LICENSE AGREEMENT | LICENSE raw: https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE |
| `minimax_h3_audio_vae_fp32.safetensors` | MiniMax-H3 audio VAE | https://huggingface.co/MiniMaxAI/MiniMax-H3 (Comfy repack: https://huggingface.co/Comfy-Org/MiniMax-H3) | MiniMax H3 COMMUNITY LICENSE AGREEMENT | LICENSE raw: https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/LICENSE |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | Qwen3-VL-32B (encoder used with MiniMax H3) | Base: https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct ; MiniMax note + https://huggingface.co/Comfy-Org/MiniMax-H3 ; NVFP4 conversion often cited from cybermotaz/Qwen3-VL-32B-Instruct-NVFP4 | Apache License 2.0 for the Qwen3-VL base (stated in the MiniMax-H3 LICENSE additional note) | Quantized AWQ/NVFP4 local conversion provenance unconfirmed beyond Comfy-Org packaging. |

| `moss_image_sft_int8_convrot.safetensors` | MOSS-Image-SFT (INT8 convrot Comfy repack) | https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT ; Comfy-Org: https://huggingface.co/Comfy-Org/MOSS-Image | Apache License 2.0 (OpenMOSS-Team LICENSE + Comfy-Org card `license: apache-2.0`) | Default image UNET. Weights not bundled. |
| `qwen3.5_9b_w4a8_gptq.safetensors` | Qwen3.5-9B (MOSS text encoder, GPTQ W4A8) | Base: https://huggingface.co/Qwen/Qwen3.5-9B ; packaged under https://huggingface.co/Comfy-Org/MOSS-Image (`text_encoders/`) | Apache License 2.0 for the Qwen3.5-9B base (HF card `license: apache-2.0`); exact GPTQ/W4A8 single-file conversion provenance unconfirmed beyond Comfy-Org packaging | CLIPLoader `type: moss_image`. |
| `flux2-vae_small.safetensors` | FLUX.2-small-decoder / flux2-vae (MOSS VAE) | Packaged in https://huggingface.co/Comfy-Org/MOSS-Image (`vae/`); related upstream https://huggingface.co/black-forest-labs/FLUX.2-small-decoder | Apache-2.0 via Comfy-Org/MOSS-Image packaging (repo card); upstream BFL single-file license was not re-fetched here (unconfirmed beyond packager card) | VAELoader filename `flux2-vae_small.safetensors`. |
| `wan2.2_ti2v_5B_fp16.safetensors` | Wan2.2-TI2V-5B | https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B ; Comfy-Org: https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged | Apache License 2.0 (HF `license: apache-2.0`; LICENSE.txt https://github.com/Wan-Video/Wan2.2/blob/main/LICENSE.txt) | Default video UNET (fp16). No fp8 TI2V-5B file listed on the Comfy-Org 2.2 repack at check time. |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | UMT5-XXL (Wan text encoder, fp8 scaled) | https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged (`split_files/text_encoders/`) | License of this exact fp8 single-file unconfirmed beyond Comfy-Org packaging (base umT5 family is commonly Apache-2.0; do not claim without matching the packaged file) | CLIPLoader `type: wan`. Shared with Wan 2.1 repack. |
| `wan2.2_vae.safetensors` | Wan2.2 VAE | https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged (`split_files/vae/`) | Apache License 2.0 with the Wan2.2 family (same LICENSE as Wan-AI/Wan2.2) | VAELoader for Wan2.2 TI2V. |

Notes (2026-10-29 Apache defaults):

- Default generation path is MOSS-Image SFT INT8 (`moss_txt2img.json`) + Wan2.2-TI2V-5B (`wan22_ti2v_i2v.json`).
- Qwen-Image-2.1-Turbo and FastH3/MiniMax H3 remain available as non-default legacy workflows (`GEN_PROFILE=qwen-image-2.1-turbo*` / `COMFY_VIDEO_WORKFLOW=.../fasth3_i2v.json`); their rows above stay for that opt-in path.
- MOSS has no first-class img2img on the default path; use legacy `qwen21_img2img.json` via the Qwen profile when reference-edit is required. Upstream MOSS edit LoRA exists but is not wired here.
