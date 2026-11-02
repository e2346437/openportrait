# Email, inquiry form and booking pages

OpenPortrait sends email through your own account, so messages come from you and land in your clients' inboxes the way your other mail does.

## 1. Set up outgoing email

Go to **Settings > Email**. Use the buttons for common providers to fill in the server, then add your username, an **app password** (most providers don't accept your normal password for apps), and the address mail should come from. Choose **Send a test email**; it goes to your own sign-in address. If it fails, the message says what went wrong, for example a wrong password or a blocked port.

Passwords are stored encrypted. Emails that can't be sent are retried a few times, and every message appears under **Recent emails**.

Nothing breaks if email isn't set up: inquiries and bookings still arrive in the app, and clients just don't get an automatic message.

## 2. Inquiry form

**Booking > Inquiry form** shows your form's link (`/inquire`). Every submission creates a lead (source "Website form") and adds the person to your clients, or reuses them if their email is already there. The client gets a thank-you email and you get a notification, which you can turn off.

To put it on your own website, paste the snippet shown on that tab. The `?embed=1` version has no outer frame, so it fits inside your page.

Bots are slowed by a hidden field and rate limits per address.

## 3. Booking pages

**Booking > Booking pages** lets you create as many pages as you like (a consult, a mini session, a headshot slot). Each one has its own link, length, location, weekly hours, buffers before and after, minimum notice and how far ahead people can book.

- Open times come from your weekly hours minus anything already on your calendar (shoots, appointments, time off, and busy times from a connected Google calendar).
- With **Book instantly** off, a request holds the time on your calendar as "Pending" until you confirm or decline it under **Booking > Requests**. Either way the client is emailed, and every email carries a link to cancel.
- Two people can't take the same time: the slot is checked again when the request is made.
- The client's details are saved as a contact, and a lead is created if they are new.

Clients see times in your studio's time zone, which is shown on the page.

## For AI assistants

Everything above is also available through the MCP tools (`calendar_list_schedulers`, `calendar_list_bookings`, `calendar_confirm_booking`, `calendar_decline_booking`). Confirming or declining emails a client, so those tools require approval by default. Text clients write is always returned as untrusted content.

## Special dates and daily limits

Under **Booking > Booking pages > Edit**:

- **Special dates** replace the weekly hours for one calendar day. Tick *Closed* for a holiday or trip, or give that date its own hours, for example a Saturday mini-session day. Dates that have passed are dropped when you save.
- **Most bookings per day** stops a page from offering a day once it holds that many pending or confirmed bookings. Cancelling one frees the day again. Leave it at 0 for no limit.

## Booking becomes a shoot

If a booking page has a shoot type, switch on **Make a shoot when it's booked**. The moment a booking is confirmed (straight away on instant pages, or when you approve a request) it is turned into a shoot for that client with the booked time as its event, and the lead moves to Booked. The calendar shows the shoot's event instead of a separate appointment. If the booking is later cancelled or declined, the shoot is marked cancelled. Leave it off for calls and consults that should stay as leads.
