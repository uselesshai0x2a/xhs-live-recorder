XHS Live Recorder
=================

1. Edit config\auth.json and replace the placeholder Cookie and X-S values.
2. Edit config\target.json to configure polling targets.
3. Edit config\recording.json to configure recording behavior.
4. Double-click start.cmd, or run xhs-live-recorder.exe in a terminal.

Runtime output:
- logs\       one console log file per process start
- recordings\ recorded FLV files and task metadata

Command-line options:
- xhs-live-recorder.exe --once
- xhs-live-recorder.exe --target <target-id>

ffmpeg.exe is owned by this package and must remain beside
xhs-live-recorder.exe. No system Node.js or FFmpeg installation is required.
