# Check remaining quota

Quota shows how much of your Claude, Codex, and Cursor subscription is left on
the machine running the T3 Code server. It is separate from the Usage page, which
estimates API-equivalent token cost from local session history.

On web and desktop, open **Quota** at the bottom of the left sidebar. The panel
stays open until you close it, including after a reload. On mobile, open
**Settings → Quota**.

Each provider can show a five-hour window, a weekly window, and any extra model
limits the provider reports. Percentages are remaining, not used. A refresh
button asks the environment for a new reading; recent readings are reused for a
couple of minutes so the providers are not hammered.

Claude quota needs a Claude Code subscription sign-in on that machine. An API
key or Bedrock setup has no subscription window to show. Codex quota needs the
Codex CLI signed in with ChatGPT. Cursor quota needs the Cursor desktop app
signed in on that machine — the `cursor-agent` CLI login is not enough. Grok
and OpenCode are not included.

If you are connected to more than one environment, each environment reports its
own remaining windows. When multiple environments use the same provider
subscription, T3 Code shows that subscription once. Distinct accounts remain
separate. Quota is never sent to a T3-owned server; the connected environment
reads it locally and returns percentages, reset times, and an opaque account
fingerprint that cannot reveal the account identifier.
