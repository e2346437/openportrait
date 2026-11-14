# Installing OpenPortrait

OpenPortrait is one container image, `ghcr.io/e2346437/openportrait`, built for amd64 and arm64. Unraid and plain Docker run the same image; only the way you fill in the settings differs.

## What you need

- A machine that runs Docker: Unraid, Synology, TrueNAS, any Linux server, or Docker Desktop.
- A folder (or share) for your photos. OpenPortrait creates one folder per shoot inside it.
- For client access from the internet: a domain on Cloudflare. The free plan is fine. See [cloudflare-tunnel.md](cloudflare-tunnel.md).

## Unraid

1. Open **Apps**, search for **OpenPortrait**, and click **Install**. (Until the app is listed in Community Applications, go to **Docker > Add Container**, paste `https://raw.githubusercontent.com/e2346437/openportrait/main/unraid/openportrait.xml` into **Template**, and continue.)
2. Check the three paths:
   - **App data** (`/mnt/user/appdata/openportrait`): the database, encryption key and backups.
   - **Galleries** (`/mnt/user/galleries`): your photo share.
   - **Incoming** (`/mnt/user/incoming`): photos sent straight from the camera.
3. Leave **Cloudflare Tunnel token** empty for now unless you already have one. The app walks you through it.
4. Click **Apply**, then open the WebUI from the container's menu.

The template uses Unraid's usual `99`/`100` (nobody:users) owner, so files OpenPortrait writes look like files from any other app on your shares.

## Docker Compose

The compose file runs the container hardened: all capabilities dropped except the four the start-up script needs, `no-new-privileges`, a read-only root filesystem and a process limit. If you write your own `docker run` command, keep the same flags (the flags are explained under [docker run](#docker-run)).

```sh
mkdir openportrait && cd openportrait
curl -O https://raw.githubusercontent.com/e2346437/openportrait/main/docker-compose.yml
# edit PUID, PGID, TZ and the volume paths if you like
docker compose up -d
```

Then open `http://<your-server>:8080`.

## docker run

```sh
docker run -d --name openportrait --restart unless-stopped \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER \
  --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --pids-limit 512 --memory 2g \
  -p 8080:8080 \
  -e PUID=1000 -e PGID=1000 -e TZ=America/New_York \
  -v /srv/openportrait/appdata:/config \
  -v /srv/photos/galleries:/galleries \
  -v /srv/photos/incoming:/incoming \
  -v /srv/openportrait/cache:/cache \
  ghcr.io/e2346437/openportrait:0.2.0-beta.2
```

What the flags do, and why they are there:

- **Pinned tag** (`:0.2.0-beta.2`). Use the newest number on the [Releases page](https://github.com/e2346437/openportrait/releases). `latest` moves whenever the project changes, so a restart or a pull could change your version without you choosing it. To update, change the number, then `docker stop openportrait && docker rm openportrait` and run the command again. Your data lives in the volumes, so nothing is lost.
- **Not root for the app.** The container starts as root only long enough to give your user (`PUID`/`PGID`) ownership of `/config` and `/cache`, then runs OpenPortrait as that user and keeps no root process. `--cap-drop ALL` and the four `--cap-add` lines leave only what that hand-off needs, and `--security-opt no-new-privileges` stops anything gaining more. Use `id -u` and `id -g` for your own numbers.
- **Read-only root filesystem.** `--read-only` with a small `/tmp` means a compromised app cannot change its own code. Everything it writes goes to your four volumes.
- **Limits.** `--pids-limit` and `--memory` stop a runaway job from starving the machine. Raise `--memory` if you edit very large galleries on a small server.
- **Volumes.** `/config` holds the database, `secret.key` and nightly backups, so back it up. `/cache` can be deleted at any time. Use real folders on the host, created beforehand.
- **No secrets on the command line.** Anything after `-e` shows up in `docker inspect`, `ps` and your shell history. The command above needs none: the setup code is printed in `docker logs openportrait`, and the Cloudflare Tunnel token, email password and API keys are entered in the app, which stores them encrypted. If you do need a variable such as `CLOUDFLARE_TUNNEL_TOKEN`, put it in a file only you can read and add `--env-file`:

  ```sh
  install -m 600 /dev/null /srv/openportrait/openportrait.env
  nano /srv/openportrait/openportrait.env      # CLOUDFLARE_TUNNEL_TOKEN=...
  # then add this line to the docker run command:  --env-file /srv/openportrait/openportrait.env
  ```

- **Ports.** `-p 8080:8080` is the web app. To make it reachable only from the machine itself (for example when a Cloudflare Tunnel or a reverse proxy runs on the same host), use `-p 127.0.0.1:8080:8080`. Camera upload ports (2222, 2121, 30000-30009) are left out; add them only when you use [camera upload](camera-upload.md).

!!! note "Why not `--user`?"
    Running with `--user 1000:1000` from the first instruction would remove the need for any capability, but that mode is not tested yet, so it is not in the example. The start-up script already skips its ownership step when it does not start as root; you would have to create and chown the host folders yourself.

## First run

The first visit opens a two-step setup: your studio's name and time zone, then the owner account. Because a new install is open to whoever reaches it first, the second step asks for a **setup code**. Find it in the container's log (`docker logs openportrait`, or the Logs button on Unraid): it looks like `==== OpenPortrait setup code: ABCDE-FGHJK ====` and changes each time the container starts until setup is done. To choose your own, set `SETUP_CODE`. After that, **Settings > Internet access** connects your domain through Cloudflare.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PUID` / `PGID` | `1000` / `1000` (`99` / `100` on Unraid) | Owner of the files OpenPortrait writes. Use `id -u` and `id -g` to find yours. |
| `UMASK` | `022` | Permission mask for new files. `002` lets the group write; on Unraid use `000` so SMB users can edit and delete. |
| `TZ` | `UTC` | Time zone for logs. Booking times use the studio time zone from Settings. |
| `CLOUDFLARE_TUNNEL_TOKEN` | empty | Starts the built-in Cloudflare Tunnel. Can be set in the app instead. |
| `LAN_URL` | empty | This server's address on your home network with the mapped port, such as `http://192.168.1.20:8090`. Used by Tethering and camera upload. Can be set in Settings > Internet access instead. |
| `SETUP_CODE` | empty | Optional code for the first-run setup screen. Left empty, a random one is printed to the log. Not needed once the owner exists. |
| `TRUSTED_PROXIES` | empty | Only if cloudflared runs in a separate container: its address (comma-separated IPs or IPv4 CIDRs, for example `172.18.0.0/16`). The built-in tunnel needs nothing. Without it, rate limits see every visitor as that container. |
| `APP_URL` | empty | Public address such as `https://studio.example.com`. Taken from the tunnel when empty. |
| `PORT` | `8080` | Port inside the container. |
| `SFTP_PORT`, `FTP_PORT` | `2222`, `2121` | Camera upload ports inside the container. See [camera-upload.md](camera-upload.md). |
| `FTP_PASSIVE_MIN`, `FTP_PASSIVE_MAX` | `30000`, `30009` | FTP/FTPS passive data ports. Publish the same range. |
| `UPLOAD_PROTOCOL`, `UPLOAD_ACCESS_MODE` | `sftp`, `on_demand` | First-run defaults for Settings > Camera upload. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `WATCH_RESCAN_MINUTES` | `5` | Backstop rescan of the galleries folder. |

| Path | Holds | Back it up? |
|---|---|---|
| `/config` | Database, `secret.key`, nightly backups in `/config/backups` | Yes. Without `secret.key`, saved secrets such as the tunnel token can't be read. |
| `/galleries` | Shoot folders: `Originals/RAW` and `Gallery` | Yes, as part of your photo backups. |
| `/incoming` | Camera uploads before sorting | Optional. |
| `/cache` | Previews and thumbnails | No. They are rebuilt when missing. |

OpenPortrait only changes the owner of the top level of `/galleries` and `/incoming`, never the files inside, so starting the container is quick even with a large library.

## Known issue: hosting OpenPortrait remotely

If OpenPortrait runs on a cloud server or another network that your computer is not on, your computer cannot map a drive letter or network share to the gallery folders. Exporting from Lightroom or Aftershoot straight into the share, as you can with a home or studio server, does not work in that setup.

The OpenPortrait container does not serve a network share itself. On Unraid the share comes from Unraid, so it is only reachable from the network the server is on.

What works instead:

- Upload photos through the web app, or use camera upload.
- Export to a folder on your computer, then upload that folder.

This is a known limit for now.

## Maintenance commands

```sh
# Locked out? Set a temporary password (it is printed once) and sign the account out everywhere.
docker exec -it openportrait openportrait reset-password you@example.com

# Lost your phone and your recovery codes? Turn off two-step sign-in for an account.
docker exec -it openportrait openportrait disable-mfa you@example.com

# Take a database snapshot now (one is also taken every night).
docker exec -it openportrait openportrait backup
```

## Backups and restore

OpenPortrait takes a backup every night (a zip in `/config/backups`, 14 kept). Settings > Backups changes the schedule, lets you include the gallery photos and the originals/RAW folders, and downloads or deletes backups. Backups can also be copied to a folder or mounted share.

**Keep `secret.key` yourself.** It lives in `/config` but is never inside a backup. Without it, saved secrets such as the tunnel token and payment keys can't be read, so you enter them again after a restore onto a new install. Copy `/config/secret.key` somewhere safe once.

### Restore onto a new or empty install

1. Start a new container with empty folders and finish the first-run setup (any studio name and owner account; the restore replaces them).
2. Open **Settings > Backups > Restore**. Pick one of the listed backups, or upload a backup zip you downloaded earlier.
3. Read the summary (contacts, shoots, orders, number of photos) and confirm. OpenPortrait takes a safety backup of what is there first.
4. Restart when asked. The database is swapped in at start-up, then photos are copied back into the galleries in the background. Photos already in the galleries are never overwritten or deleted.
5. Sign in with the account from the **backup**, not the temporary one you made in step 1.

A backup from a newer version of OpenPortrait than the one you are running is refused; update first. A damaged or edited backup is refused and nothing changes.

## Updating

Unraid: **Docker > Check for Updates**. Compose: `docker compose pull && docker compose up -d`. Plain Docker: change the version number in your command, then stop, remove and run it again. Database changes are applied automatically when the new version starts, and a backup is taken nightly.
