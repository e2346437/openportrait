# Camera upload

OpenPortrait includes a server your camera can send photos to as you shoot. The photos land in the **Incoming** share, where the live view ([tethering.md](tethering.md)) shows them and you can sort them into shoots.

Everything is set up in **Settings > Camera upload**.

## Choose a protocol

| Protocol | Encrypted | Use it when |
|---|---|---|
| **SFTP** (default) | Yes | Your camera offers SFTP. One port, nothing else to configure. |
| **FTPS** (explicit TLS) | Yes | Your camera offers FTPS. The camera must trust this server's certificate (see below). |
| **FTP** | **No** | Your camera only offers plain FTP. |

**Plain FTP sends the camera's password and your photos unencrypted.** Use it on your home network, or over a WireGuard connection. Don't forward the FTP port from your router to the internet. If a camera offers SFTP or FTPS, use that instead.

Only one protocol is active at a time. Switching restarts the server and disconnects any connected camera.

## Choose when the server is open

A port that nobody is using doesn't need to be listening. Pick one:

- **Only when needed** (recommended, the default). The server is closed until you press **Open now**, or start a live view from Tethering. It closes by itself after a quiet period you choose (default 30 minutes with no photos, connections or live view). A camera that powers on while the server is closed simply can't connect, so open it first.
- **On a schedule.** Choose days and hours, such as Saturday 09:00 to 17:00. Times use your studio's time zone, and a window can run past midnight. A photo that is still arriving when a window ends is allowed to finish.
- **Always open (not recommended).** Needs a confirmation. The port is reachable around the clock.

**Close now** shuts the server immediately. In schedule mode it stays closed until the current window ends. The settings page always shows whether the server is open, why, and when it will next open or close. Every open, close, failed sign-in and block is listed under **Recent activity**.

## Add a camera

Choose **Add a camera**, name it (for example "Nikon Z9"), and copy the values shown into the camera:

| Camera field | Value |
|---|---|
| Server type | The protocol you chose |
| Server address | The address shown, normally your server's address on your network |
| Port | `2222` for SFTP, `2121` for FTP and FTPS (the default container ports) |
| User ID | The username shown |
| Password | The generated password. It is shown once. Use **New password** if you lose it. |
| Destination folder | Leave empty, or enter `/` |

Each camera has its own login. It can only see its own folder inside Incoming (for example `Incoming/Nikon Z9/`), it can send files, make folders and list them, and it **can't download or delete** anything, so a lost camera card or a leaked password can't be used to take photos out. Remove a login or pick **Disable** to lock a camera out immediately.

By default each photo is filed into a folder for the day, such as `Incoming/Nikon Z9/2026-11-14/DSC_0001.NEF`. Turn that off in the same screen if you'd rather keep everything flat. Files arrive under a hidden temporary name and are renamed when the whole photo has arrived, so nothing sees a half-sent file.

Repeated failed sign-ins from one address are blocked for 15 minutes.

### SFTP with a key

SFTP logins can also use an SSH key. This is for computers and apps, because cameras sign in with a password. Choose **Use an SSH key as well** when adding a camera and paste the one-line public key.

### FTP and FTPS: passive connections

FTP sends each photo over a second connection, so the server has to tell the camera where to connect. Set **Address cameras connect back to** to your server's address on your network (for example `192.168.1.20`). The container must publish the passive port range (`30000-30009` by default, which you can change with `FTP_PASSIVE_MIN` and `FTP_PASSIVE_MAX`). Keep the host and container ranges identical.

### Power saving and reconnects

Some cameras log off from the server after a quiet spell to save battery, then reconnect when they have photos to send (Canon calls this Power saving). OpenPortrait treats that as normal. It doesn't log a warning or show an error, and the next photo is received as usual. The server also drops a connection that has been silent for 10 minutes.

### FTPS certificate

The FTPS server uses a certificate it creates for itself the first time it opens. A camera that checks certificates needs that certificate as a trusted (root) certificate. Open the server once, download the certificate from the settings page, copy it to the memory card, and import it on the camera. Canon cameras read a single file named `ROOT.PEM`, `ROOT.CRT` or `ROOT.CER`, so rename the download to one of those. Canon warns that a self-signed certificate may not be trusted. If your camera refuses it, use SFTP, or plain FTP on your home network.

## Which cameras

SFTP and FTPS support is a feature of the camera, and it differs between models. Check your camera's manual before you rely on a protocol. What has been confirmed so far:

- **Nikon Z9 and Z8:** SFTP, per Nikon's manuals. The Z8 also offers FTPS and lets you enter a custom port. Menu: **Connect to FTP server** in the Network menu, then choose the server type, enter the address, port, user ID and password, and choose **Home folder** as the destination.
- **Other Nikon Z bodies:** plain FTP.
- **Sony:** FTP over Wi-Fi is documented for recent bodies (**MENU > Network > FTP Transfer Func.**). SFTP and FTPS aren't confirmed, so use FTP.
- **Canon EOS R6 Mark II:** FTP, FTPS and SFTP, per Canon's manual. Menu: **Transfer images to FTP server > Add a device to connect to**, then choose the FTP mode, address and port (the camera suggests 21 for FTP and FTPS, 22 for SFTP, and you can type another). SFTP signs in with a user name and password. The camera asks **Trust server?** the first time it connects; compare the fingerprint it shows with the one on the settings page. The camera creates a missing destination folder itself.
- **Other Canon EOS R bodies:** FTP is documented on bodies such as the R3 and R5 family. SFTP and FTPS aren't confirmed for them, so use FTP unless your model's manual says otherwise.

Nikon's manual notes that it lists specific servers as supported. If a camera can't connect to OpenPortrait, check the address, port, username and password first, then try plain FTP on your home network to rule out a protocol problem.

If your camera's port field is fixed to 22 (SFTP) or 21 (FTP), the container's default ports (`2222` and `2121`) won't match. Map host port 22 or 21 to the container port if that port is free on the host, or give the container its own address on your network.

## Container settings

| Setting | Default | What it does |
|---|---|---|
| `SFTP_PORT` | `2222` | SFTP port inside the container |
| `FTP_PORT` | `2121` | FTP and FTPS port inside the container |
| `FTP_PASSIVE_MIN` / `FTP_PASSIVE_MAX` | `30000` / `30009` | FTP passive data ports. Publish the whole range. |
| `UPLOAD_PROTOCOL` | `sftp` | First-run protocol (`sftp`, `ftps`, `ftp`). Change it in the app afterwards. |
| `UPLOAD_ACCESS_MODE` | `on_demand` | First-run access mode (`on_demand`, `scheduled`, `always_on`). Change it in the app afterwards. |

On Unraid these are fields in the template. The SFTP and FTP ports and the passive range are published for you, but nothing listens on them until the server is opened in Settings.

Away from home, a camera needs a route to the server. Cloudflare Tunnel carries web traffic only, so use a WireGuard connection (recommended) or forward a single SFTP port. See [SPEC.md](SPEC.md) section 4.

## Troubleshooting

- **The camera can't connect.** Is the server open? Check the status at the top of the page. Then check the address, port and that the camera and server are on the same network.
- **It connects, then fails to send (FTP).** The passive address or port range is wrong. Set the address, and make sure the whole range is published.
- **Login incorrect.** Use **New password** and re-enter it. After several failures from the same address, it is blocked for 15 minutes.
- **Port already in use.** The page shows which setting to change.
