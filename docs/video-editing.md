# Local video edit MVP

The stage exposes a small edit flow for a successful generated MP4: trim a time range and optionally burn user-supplied SRT subtitles into the result. The source asset is never modified. Each edit writes a new project-owned `edited-video` asset whose metadata records the source asset ID/hash, selected range, and subtitle text/hash. This is a derived media asset, not an approved blueprint revision or a generation record.

## Runtime requirements

The server calls local FFmpeg and FFprobe executables with argument arrays (no shell). Install them separately and make them available on `PATH`, or set server-side `FFMPEG_BIN` and `FFPROBE_BIN` to their executable paths. The app does not install binaries or download media tools. Editing is unavailable when either executable cannot run; generation and other project actions remain independent. Burning subtitles additionally requires an FFmpeg build with the `subtitles` filter (libass); on builds without it, edits that include `subtitles_srt` fail with an FFmpeg error while plain trims still work.

## Current limits

- Input is an MP4 asset owned by the current project. Source paths are resolved and confined to the configured asset root.
- Start/end are seconds; end must be within the probed source duration and the selected range cannot exceed one hour.
- SRT is optional, limited to 128 KiB and 500 cues; cues are relative to the edited output and must fit inside the selected range. ASS override tags are refused.
- Output is MP4 (H.264 video, AAC audio when present). This is a re-encode, not a lossless cut. Output duration is probed and compared with the requested duration; a mismatch or failed export is not registered as an asset.
- The API accepts any project-owned MP4 asset, including a previously derived `edited-video` asset; the UI currently exposes the edit action only on succeeded video generation records, so re-editing a derived clip has no UI entry point.
- This MVP does not provide transitions, multiple clips, audio mixing, subtitle transcription/editing, or a timeline. It does not inspect visual quality; check the saved result in the preview before using it elsewhere.
