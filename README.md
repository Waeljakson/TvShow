# TvShow

TvShow is an Internet digital-signage system where the **TV opens a normal HTTPS page** and the **laptop remains the media source**.

## Public URLs

- Display: https://tvshow-ck1t.onrender.com/display
- Admin: https://tvshow-ck1t.onrender.com/admin
- Default admin PIN: 2468

The TV never opens localhost.

## Architecture

TV Browser → Render public relay → TvShow Agent on laptop → local media folder

Media files stay on the laptop. They are not uploaded in advance to a database or cloud storage.

## Laptop setup

1. Install Node.js 20 or newer.
2. Download this repository.
3. Run `start.bat`.
4. On first run, `agent-config.json` is created and opened.
5. Keep:
   - `serverUrl`: `https://tvshow-ck1t.onrender.com`
6. Paste the private Agent Key into `agentKey`.
7. Set `mediaDir` to the folder containing videos/images, for example:
   - `D:\TvShow\Media`
8. Save the file and run `start.bat` again.

Keep the Agent window open while the TV is displaying media.

## Supported media

- Video: MP4, WebM, M4V
- Images: JPG, JPEG, PNG, WebP, GIF

For Smart TV compatibility, H.264 MP4 is recommended.

## Current features

- Public Internet display page.
- Public Internet admin panel.
- Laptop Agent connects outbound; no router port forwarding is required.
- Media stays on the laptop.
- Automatic media-folder scanning.
- Playlist ordering.
- Individual image durations.
- Play / pause / next / previous / reload.
- Show any item immediately.
- Agent online/offline status.
- TV online/offline status.
- HTTP Range support for browser video seeking/streaming.
- Flow-controlled media relay to avoid buffering the whole file in server memory.

## Security

The public server uses two secrets:

- `ADMIN_PIN` for the admin page.
- `AGENT_KEY` for the laptop Agent connection.

Do not commit `agent-config.json`; it is already excluded by `.gitignore`.
