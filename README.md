# Halloween With Friends 🎃

A phone-first voting page for our Halloween weekend (Fri 30 Oct – Sun 1 Nov 2026).
Friends open the link, type their name (no sign-up), tap **I'm in** on activities, pick options, and add their own ideas with screenshots.

## How it's built
- `index.html` – the whole page (plain HTML/CSS/JS, no build step)
- `api/` – Azure Functions (Node 20) for the shared data
- Data lives in an Azure Storage account: activities and votes in Table Storage, screenshots in Blob Storage
- Hosted on Azure Static Web Apps (free tier), which deploys automatically on every push to `main`

## Settings (Static Web App → Environment variables)
| Name | Value |
| --- | --- |
| `STORAGE_CONNECTION_STRING` | Connection string from the storage account's **Access keys** |
| `ADMIN_CODE` | Optional. Any secret word. Open the site once with `?admin=<word>` to be able to remove anyone's activity on that device. |
