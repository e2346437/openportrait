# Connect your AI

OpenPortrait has a built-in MCP (Model Context Protocol) server. Connect an AI assistant such as Claude, ChatGPT, Claude Code or Cursor, and it can look up clients, shoots, bookings, quotes and galleries, and help you run the studio.

Access is off until you turn it on, and it is built to keep you in charge.

## Turn it on

Go to **Settings > Connect your AI** (owner only) and switch it on. Remote assistants need a working [Cloudflare Tunnel](cloudflare-tunnel.md) or a URL they can reach. The page shows your MCP address with a copy button and the steps for each assistant.

- **Claude and ChatGPT** (custom connectors): paste the address into the connector. The assistant opens an OpenPortrait sign-in and consent page, and you approve the access it asks for.
- **Claude Code, Cursor and scripts:** create an access token on the same page. The token is shown once, so copy it then. It is stored only as a hash.

The page confirms the connection the first time the assistant calls OpenPortrait. **Test connection** runs a harmless read.

## Choose what it can do

Each connection has an access level:

| Level | What the assistant can do |
|---|---|
| **Read** | Look at contacts, leads, shoots, the calendar, orders and galleries |
| **Assist** | Read, plus make internal drafts such as notes, tasks and draft quotes. It can also ask to send, publish or record money, but every such request waits for your approval |
| **Full** | The same tools as Assist. Today the two differ only in label; Full is reserved for per-action auto-approval later. Anything that reaches a client or money still asks you first |

Use the per-area switches to limit a connection further, for example to galleries only.

## Approvals

Anything that reaches a client or touches money goes to **Approvals** first. That includes sending an email, sending a quote or contract, publishing a gallery, confirming a booking, sending a questionnaire, recording a payment, or issuing a credit. You see the exact content and can approve, edit or decline it. Pending items expire after 7 days. Approving checks the connection again at that moment: if it was revoked, expired, lost access to that area or was cut back to read-only after the request was made, the action does not run. Revoking a connection cancels everything it had waiting.

Auto-approval is a setting you can turn on for each kind of action. It is off by default, and new kinds of action always start in approval.

Client-written text, such as inquiry messages and questionnaire answers, is passed to the assistant as untrusted content. Assistants are told not to follow instructions found in it, and the approval step still applies.

## Limits and records

- Each connection is rate limited, and client emails sent through an assistant are capped per day.
- An assistant can only email people who are already your contacts.
- Every call is written to the activity log with the connection, the tool, the result, and who approved it. **Settings > Connect your AI > Activity** shows it as a timeline.
- No tool returns passwords, tokens or the tunnel secret, and no tool can change access settings.

## Stop it

**Pause all AI access** at the top of the page stops every connection at once. Revoke a single connection from its row, and its token stops working.
