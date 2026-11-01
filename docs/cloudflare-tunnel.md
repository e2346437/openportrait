# Reaching OpenPortrait from the internet with Cloudflare Tunnel

Clients need to open your galleries, booking pages and contracts from anywhere. OpenPortrait does this with a Cloudflare Tunnel: the container makes an outbound connection to Cloudflare, and Cloudflare sends visitors to it. You don't open ports on your router, and your home IP address stays private.

The same steps are in the app under **Settings > Internet access**, with live checks at each step. This page is the reference version.

## What you need

- A domain, such as `yourstudio.com`, whose DNS is on Cloudflare. The free plan is enough. If your domain is somewhere else, add it in Cloudflare (**Add a domain**) and switch your registrar's nameservers to the two Cloudflare gives you. That usually takes a few minutes and can take up to a day.
- A Cloudflare account. Creating a tunnel doesn't need a credit or debit card.
- OpenPortrait installed and set up (see [install-docker.md](install-docker.md)).

## Setup (about five minutes)

### 1. Create a tunnel

1. In the Cloudflare dashboard, open **Networks**, then **Tunnels**.
2. Click **Create a tunnel**, and name it `openportrait`. Then click **Create tunnel**.
3. Choose your operating system and copy the install command. **Don't run it.** OpenPortrait already includes cloudflared. The command contains your token (a long value starting with `eyJ`).

### 2. Give the token to OpenPortrait

Either:

- paste the whole command into **Settings > Internet access > Paste the token** and click **Save and connect** (OpenPortrait finds the token in it and stores it encrypted), or
- put just the token in the container's `CLOUDFLARE_TUNNEL_TOKEN` variable (the Unraid template has a masked field for it) and restart the container.

Within a few seconds the status changes to **Connected**, and Cloudflare shows the tunnel as **Healthy**.

### 3. Add a public hostname

Open your tunnel, go to the **Routes** tab, click **Add route**, and choose **Published application**. Enter:

| Field | Value |
|---|---|
| Subdomain | `studio` (or anything you like) |
| Domain | your domain |
| Path | leave empty |
| Service URL | `http://localhost:8080` |

Click **Add route**. Cloudflare confirms with "Route added successfully" and creates the DNS record for you.

Use `localhost:8080` even though OpenPortrait runs in a container: the built-in cloudflared runs inside the same container. If you changed `PORT`, use that port.

### 4. Test it

Back in **Settings > Internet access**, click **Run the test**. OpenPortrait asks Cloudflare for your public address and checks that the answer comes from this server, not some other one. Your public address is filled in automatically and used in every link the app sends.

## Protect your back office (optional)

OpenPortrait already requires its own login, so this step is optional. You can skip it and still finish setup. If you want it, Cloudflare Access can put a sign-in in front of the studio pages, on top of your OpenPortrait password. Client pages need to stay public either way. Check Cloudflare's pricing page for the current user limit.

1. In Zero Trust, open **Access controls**, then **Applications**. Click **Create new application** and choose **Self-hosted and private**.
2. Click **Add public hostname** and choose your domain. Add your hostname with **one** path: `studio` (for example `studio.yourdomain.com/studio`). **Don't** add `api/studio` or `mcp`. Covering them breaks OpenPortrait's own requests (see the troubleshooting table) and blocks Claude's connector.
3. Under **Access policies**, add a policy that allows only your email address (and your staff's).
4. Set a session duration, then click **Create**.

Galleries (`/g`), booking pages (`/book`), the client portal (`/portal`), contract signing (`/sign`) and `/api/health` are not under those paths, so clients never see the Cloudflare sign-in.

On your home network you can always reach the studio directly at `http://<server-ip>:8080/studio`, which doesn't go through Cloudflare.

## Recommended Cloudflare settings

- **SSL/TLS mode:** Full. (The tunnel is encrypted end to end; Flexible can cause redirect loops with some apps.)
- **Rocket Loader:** off for your OpenPortrait hostname. It rewrites scripts and can break the app.
- **Caching:** the defaults are fine. OpenPortrait marks gallery previews as cacheable and full-resolution downloads as private.
- **Uploads:** Cloudflare's free plan limits a single request to 100 MB. OpenPortrait uploads in smaller chunks, so large galleries still work.

## Already run cloudflared yourself?

Leave the token empty in OpenPortrait. Point a public hostname in your existing tunnel at the OpenPortrait container (for example `http://openportrait:8080` if they share a Docker network, or `http://<server-ip>:8080`), and enter your public address under **Settings > Internet access > Advanced**.

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| Status says "Cloudflare rejected the tunnel token" | The token was mistyped or the tunnel was deleted. Copy the command again from the tunnel's page in Cloudflare and paste it. |
| Status says the server "can't look up Cloudflare's address" | The server has no working DNS or internet. Check the server's network settings. |
| Status says the server "can't reach Cloudflare" | A firewall is blocking outbound connections. Allow outbound port 7844 (UDP and TCP). |
| Cloudflare error **1033** | The tunnel isn't connected. Check the status in OpenPortrait; if the container is stopped, start it. |
| Cloudflare error **502** or **Bad gateway** | The tunnel is up but the public hostname points at the wrong place. The URL must be `localhost:8080` (with the built-in tunnel). |
| The test says another server answered | The hostname belongs to a different tunnel or server. Check which tunnel the hostname is attached to. |
| Redirect loop | Set SSL/TLS mode to Full. |
| OpenPortrait shows **"Can't reach OpenPortrait"** after you turn on Cloudflare Access | Access is covering `api/studio` or `mcp`, so OpenPortrait's own requests get redirected to a Cloudflare sign-in. In the Access application, remove the `api/studio` and `mcp` paths and keep only `studio`. If it still fails, delete the Access application. OpenPortrait's own login keeps the studio protected. |
| Uploads fail partway | A Cloudflare WAF or upload rule may be blocking large requests. Check **Security > Events** for blocked requests to your hostname. |

## When the tunnel is down

Nothing is lost. Clients can't reach your pages until it reconnects, but OpenPortrait keeps running, and you can still use the studio on your home network at `http://<server-ip>:8080/studio`. The built-in cloudflared restarts itself with increasing delays; the status on **Settings > Internet access** shows the last error.

## Camera uploads aren't carried by the tunnel

Cloudflare Tunnel carries web traffic only. Sending photos straight from a camera over SFTP or FTP uses a separate route (port forwarding with dynamic DNS, a WireGuard travel router, or your home network). Those have their own guide in the app.
