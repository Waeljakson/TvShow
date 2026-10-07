# TvShow

TvShow is a **local-first digital signage server** for displaying videos and images on a TV through its web browser.

## Architecture

- **Laptop = server + storage + control panel**
- **TV = browser only**
- Media files remain on the laptop hard drive.
- No database is required.
- No media files are uploaded to GitHub or cloud storage.
- The app stores only local settings under `runtime/config.json` (ignored by Git).

## Supported media

- Video: MP4, WebM, M4V
- Images: JPG, JPEG, PNG, WebP, GIF

For maximum Smart TV browser compatibility, use **H.264 MP4** for videos.

## Windows quick start

1. Install Node.js 20 or newer.
2. Download or clone this repository to the laptop.
3. Double-click `start.bat`.
4. Open the control panel:
   - `http://localhost:3000/admin`
5. Default admin PIN:
   - `2468`
6. In the control panel, enter the media folder path, for example:
   - `D:\TvShow\Media`
7. Open the display:
   - `http://localhost:3000/display`

Change the PIN before public use:

```bat
set ADMIN_PIN=YOUR_PIN
npm start
```

## Remote TV through the Internet

The TV does **not** need to be on the same Wi-Fi as the laptop. The laptop's local TvShow server can be published through an outbound tunnel such as Cloudflare Tunnel.

For a temporary test after installing `cloudflared`:

```bat
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will return a public HTTPS address. Open its `/display` path on the TV browser.

For permanent use, create a named Cloudflare Tunnel and attach it to a fixed hostname, then point that hostname to:

```
http://localhost:3000
```

Keep the laptop powered on and connected to the Internet while the TV is displaying media.

## Main routes

| Route | Purpose |
|---|---|
| `/admin` | Laptop control panel |
| `/display` | Full-screen TV display |
| `/api/playlist` | Current playlist |
| `/api/events` | Live Server-Sent Events channel |

## Current features

- Select any existing media folder by entering its Windows path.
- Automatically detects new media files.
- Full-screen browser display.
- Sequential playlist playback and looping.
- MP4/WebM streaming with HTTP Range support.
- Image duration control.
- Reorder playlist.
- "Show now" control.
- Next / previous / play / pause / refresh controls.
- Live TV online/offline indicator.
- No database.
- No cloud media upload.
- Local settings persist after restart.

## Notes

Browser autoplay policies vary. If the TV browser blocks autoplay with sound, TvShow displays a one-time **"Press to start"** overlay. After that interaction, playback continues normally.

The public display URL streams files from the laptop over its Internet upload connection. A stable upload speed is therefore important for large or high-bitrate videos.
