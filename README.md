# Tome Sync

Keep an Obsidian vault and a [Tome](https://noto.gg) knowledge base the same, both ways, on
Windows, macOS, Linux, iPhone, iPad and Android.

Tome is a self-hosted wiki that stores plain Markdown files, so a Tome vault and an Obsidian
vault are the same thing: notes, boards (`.canvas`), images and attachments. Tome Sync connects
the two. People sign in with their studio's Grimoire account (Grimoire is the identity service
that runs alongside Tome) and get exactly the access they have in Tome.

## You need

- A studio running **Grimoire and Tome** (both self-hosted), and an account there with access
  to Tome. Open Tome once in your browser first, so it creates your account.
- Your studio's **Grimoire address**, like `https://grimoire.example.com`. Your admin has it,
  and Tome's **Connect Obsidian** page shows it.

## Set up

1. Install **Tome Sync** from Settings → Community plugins, and turn it on.
2. In Settings → Tome Sync, type your Grimoire address and press **Sign in with Grimoire**.
3. Sign in in the browser that opens. Obsidian opens again by itself. If it doesn't (some Linux
   setups), copy the code the page shows and press **Paste sign-in code**.
4. Pick the Tome vault to sync. The first sync brings everything down.

Use a vault meant for the team: every note in it goes to Tome.

## How it syncs

- Changes go both ways: on start, a few seconds after you edit, every few minutes, when you
  come back to the app, and when you press the sync button.
- A note changed here and in Tome at once is merged line by line. If the same lines changed,
  Tome's version stays and yours is kept next to it as `Note (conflict, <device>, <date>).md`.
- Deleting a note moves it to Tome's trash. A note deleted in Tome goes to this vault's `.trash`
  folder. A sync that would delete many files, or a vault that suddenly looks empty, asks first.
- Renames are moves in Tome.
- With view-only access, Tome's changes come down and your edits stay on your device.
- `.obsidian` and other hidden files, and file types Tome doesn't keep, stay on your device.
  Settings → Tome Sync lists them.
- It won't run in a vault that Obsidian Sync, Self-hosted LiveSync, Remotely Save or Obsidian Git
  also syncs: two syncs on one vault fight over every file.

## Network and privacy

- Tome Sync only talks to the Grimoire address you type and the Tome server that Grimoire
  names. It sends your vault's notes and attachments to that Tome server, which is the point.
- An account on your studio's Grimoire is required.
- Your sign-in is stored on this device (Obsidian's secret storage), never in a file in the
  vault. Signing out revokes it. Being removed in Grimoire stops the sync.
- No telemetry, ads or analytics. Free and open source (MIT).

## Develop

```sh
npm ci
npm run build      # main.js, manifest.json, styles.css in dist/
npm test
```

This repository is exported from the Team Noto tools monorepo, where the plugin is tested end to
end against real Grimoire and Tome servers. Please open issues here.
