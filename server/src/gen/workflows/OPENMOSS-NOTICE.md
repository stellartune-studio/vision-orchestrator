# OpenMOSS prompt attribution

The MOSS API graph `moss_txt2img.json` contains a system-prompt text at node
`18_14`. That text is unchanged relative to this repository's recorded Comfy
MOSS Base API baseline (`catalog/official-moss-base-46e060ea.json`). Its opening
matches the current Comfy MOSS template's system prompt. The [Comfy template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_t2i.json)
says its prompt upsampler system prompt was written from the official
[OpenMOSS MOSS-Image Prompt Enhancer](https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md).
The OpenMOSS repository is distributed under [Apache License 2.0](https://github.com/OpenMOSS/MOSS-Image/blob/main/LICENSE);
the full Apache-2.0 text is retained in the repository root `LICENSE`.
The Comfy template's separate MIT notice is `COMFY-TEMPLATES-LICENSE.txt`.

VO modifies the graph around the prompt: it chooses the SFT UNET, changes the
user-prompt input, dimensions, seed and output prefix, and removes a resolution
selector compared with the recorded Base API baseline. The system prompt itself
was not changed in that comparison. VO's graph uses native Comfy node classes;
we did not find OpenMOSS plugin-specific node classes. This does not establish
the exact historical upstream revision or every dependency's rights. The root
OpenMOSS repository showed no `NOTICE` file at the checked location on
2026-10-29. Retain any additional applicable notices discovered by further
source-lineage review; model weights and their terms are separate.
