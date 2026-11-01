# SFTP Tethering

Tethering shows each photo on a big screen the moment your camera finishes uploading it, so you can check focus, light and expression on a monitor, laptop or tablet while you shoot. It works with the camera upload described in [SPEC.md](SPEC.md) section 4: the camera sends files over SFTP (or FTP/FTPS, see [camera-upload.md](camera-upload.md)), and OpenPortrait watches the folder they land in. Opening a live view also opens the upload server when it is set to "only when needed".

## Using it

1. Open **Photos > Tethering**.
2. Pick the set you're shooting. This is either a shoot (its folder, excluding the delivery folder) or **Incoming**, where unsorted camera uploads go.
3. Pick a background: black, white, or any colour from the colour picker or a hex code. The choice is remembered on that device and stored in the link.
4. Choose **Open live view**, or copy the link and open it on another screen. Press **F** for full screen and **B** to flip between black and white.

While a file is arriving, the bar at the bottom shows its name, size, speed and an estimated percentage. As soon as it finishes, the photo replaces the one on screen.

The link is a normal back-office page, so each device signs in once with the studio login.

## What gets shown

- JPEG, PNG, WebP and TIFF files directly.
- RAW files (NEF, CR2, CR3, ARW, DNG, RAF, ORF, RW2 and others) by their embedded JPEG preview, at up to 2560 px on the long edge, rotated by the camera's orientation. A RAW file with no embedded preview still counts as received; the screen says so instead of showing a picture.
- Files that were already in the folder when you opened the view are not treated as new. The newest one is shown first so the screen isn't empty.

A file counts as "landed" once its size has stopped changing for about a second and a half, which is how a growing upload is told from a finished one. Folders are polled once a second rather than watched with file-system events, because events are unreliable on network shares and Unraid user shares. Polling only runs while at least one live view is open.

## Speed

A photo takes this route: camera, Wi-Fi, router, internet, Cloudflare, your server, and back to the screen. Two things you can do:

- At home or in the studio, open the live view from your server's local address (for example `http://tower:8080`) so the picture doesn't leave your network. The Tethering page has a field for that address and builds the link.
- The live view shows the round-trip time to the server and whether you're on your network or going through the internet, and, after each photo, how long it took to reach the screen after it landed.

Large RAW previews are made once and cached under `/cache/tether`, and cleaned up after a day.

## API

All under `/api/studio/tether` and signed-in only.

| Endpoint | Purpose |
|---|---|
| `GET /sources` | Shoots with a folder, plus Incoming |
| `GET /:source/events` | Server-sent events: `hello`, `progress`, `photo`, `folder` |
| `GET /:source/photo?path=` | A screen-sized JPEG for one file |
| `GET /ping` | For measuring round-trip time |

`:source` is a shoot id or `incoming`.
