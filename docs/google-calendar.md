# Connecting Google Calendar

OpenPortrait keeps a calendar of your shoots, appointments and time off, and can keep it in step with Google Calendar so it shows up on your phone. It uses your own Google Cloud project, so your calendar data goes straight between your server and Google.

The same steps are in the app under **Settings > Google Calendar**. This page is the reference version.

## What gets synced

| In OpenPortrait | In Google |
|---|---|
| Shoot times, appointments and time off | Events in a calendar named **OpenPortrait**, created for you |
| Edits to a time or place made in Google | Come back to OpenPortrait within a few minutes |
| An appointment or time off deleted in Google | Deleted in OpenPortrait too |
| A shoot time deleted in Google | **Comes back** on the next sync. Shoots are managed in OpenPortrait. |
| An event you create in the OpenPortrait calendar in Google | Appears in OpenPortrait as an appointment |
| Your other calendars (family, personal) | Read for **busy times only**. Titles are never copied. |

Changes you make in OpenPortrait reach Google within seconds. A background check every five minutes picks up changes made in Google. If the same item is changed on both sides between checks, Google's version wins.

A shoot's title in Google is always "subject: part of the day" from OpenPortrait. If you rename it in Google, the time and place edits are kept and the title is put back.

OpenPortrait only writes to the OpenPortrait calendar. It never changes events in your other calendars.

## Setup (about ten minutes, once)

You need a public address first (**Settings > Internet access**), because Google sends you back to it after you sign in.

### 1. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and create a project. The name doesn't matter, for example `OpenPortrait`.
2. Open **APIs & Services > Library**, find **Google Calendar API**, and click **Enable**.

### 2. Set up the consent screen

1. Open **APIs & Services > OAuth consent screen** (called **Google Auth Platform** in newer consoles).
2. Choose **External**. Enter an app name (`OpenPortrait`), your email as the support and developer contact, and save.
3. Under **Test users**, add your own Google address. If you also plan to connect a second Google account, add it too.
4. Click **Publish app** so the status reads **In production**.

Step 4 matters. While an app is in **Testing**, Google expires the sign-in every 7 days and sync stops until you reconnect. Publishing a personal app doesn't need Google's review. You'll see an "unverified app" warning when you sign in; choose **Advanced > Go to OpenPortrait**. It's your own app.

### 3. Create the credentials

1. Open **APIs & Services > Credentials > Create credentials > OAuth client ID**.
2. Type: **Web application**. Name: `OpenPortrait`.
3. Under **Authorized redirect URIs**, add the address shown in Settings > Google Calendar. It looks like `https://studio.example.com/api/studio/google/callback`.
4. Create it, then copy the **Client ID** and **Client secret**.

### 4. Connect

In **Settings > Google Calendar**, paste the client ID and secret, click **Save**, then **Connect Google Calendar**. Sign in, allow access, and you're sent back. The first sync starts at once.

Then, under **Calendars to treat as busy**, tick the calendars whose events should block your time, such as your personal or family calendar.

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| `redirect_uri_mismatch` on Google's page | The redirect address in Google Cloud doesn't exactly match the one in Settings. Copy it again, including `https://` and no trailing slash. |
| `access_denied` | You clicked Cancel, or your address isn't a test user. Add it under Test users and try again. |
| "Google didn't send a refresh token" | Remove OpenPortrait at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again. |
| "Reconnect needed" appears about once a week | The consent screen is still in **Testing**. Publish it (step 2.4), then reconnect once. |
| "Google doesn't recognize the client ID or secret" | A character was lost when pasting. Paste both again. |
| Events aren't appearing in Google | Look for a calendar named **OpenPortrait** in Google Calendar's left side. Tick it to show it. On a phone, open Settings > the calendar list and turn it on. |
| Something looks stale | Click **Sync now** in Settings. The status line shows the last sync and any error. |

## Disconnecting

**Settings > Google Calendar > Disconnect** forgets the connection and the busy times it cached. Events already created in Google stay there. To remove OpenPortrait's access entirely, also remove it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
