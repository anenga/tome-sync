import { Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, debounce, setIcon, type App } from "obsidian";
import { Grimoire } from "./auth";
import { Engine, type Report } from "./engine";
import { SyncError } from "./http";
import { DeviceSessionStore, ObsidianFs, PluginStateStore, obsidianHttp } from "./obsidian-io";
import { Tome, type VaultInfo } from "./tome";

/*
 * Tome Sync: keeps this Obsidian vault and a Tome vault the same, both ways, signed in with
 * Grimoire. Any studio running Grimoire and Tome can use it: the person types their Grimoire
 * address, and Grimoire says where that studio's Tome is. Sync runs on start, a few seconds after
 * each edit, every few minutes and on demand. The engine (engine.ts) is shared with the
 * end-to-end tests; this file is the Obsidian side: settings, status and sign-in. Updates come
 * through Obsidian's community plugins, never from a server.
 */

interface Settings {
  /** Grimoire's address. */
  server: string;
  /** The Tome vault's slug and name. */
  vault: string | null;
  vaultName: string;
  autoSync: boolean;
  intervalMinutes: number;
  device: string;
}

interface LastSync {
  at: number;
  report?: Report;
  error?: string;
}

/** No default server: each studio has its own Grimoire. Tome's downloads preset it. */
const DEFAULTS: Settings = { server: "", vault: null, vaultName: "", autoSync: true, intervalMinutes: 5, device: "" };

/** Sync plugins that would fight Tome Sync over every file. */
const RIVALS: Record<string, string> = { "obsidian-livesync": "Self-hosted LiveSync", "remotely-save": "Remotely Save", "obsidian-git": "Obsidian Git" };

function defaultDevice() {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android";
  return Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows PC" : "Linux PC";
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

export default class TomeSync extends Plugin {
  settings: Settings = { ...DEFAULTS };
  grimoire!: Grimoire;
  tome!: Tome;
  last: LastSync | null = null;
  status: "idle" | "syncing" | "signedOut" | "offline" | "error" | "paused" = "idle";
  private running: Promise<void> | null = null;
  private again = false;
  private statusEl: HTMLElement | null = null;
  private ribbon: HTMLElement | null = null;
  private timer: number | null = null;
  private settingTab: TomeSyncSettings | null = null;

  async onload() {
    await this.loadSettings();
    this.grimoire = new Grimoire(obsidianHttp, new DeviceSessionStore(this.app));
    this.tome = new Tome(obsidianHttp, this.grimoire);

    this.ribbon = this.addRibbonIcon("refresh-cw", "Sync with Tome", () => this.syncNow(true));
    if (!Platform.isMobile) {
      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass("tome-sync-status");
      this.statusEl.onClickEvent(() => this.syncNow(true));
    }
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.syncNow(true) });
    this.addCommand({ id: "open-tome", name: "Open this vault in Tome", callback: () => this.openInTome() });
    this.settingTab = new TomeSyncSettings(this.app, this);
    this.addSettingTab(this.settingTab);

    // Grimoire's sign-in page hands the code back with obsidian://tome-sync?code=…&state=…
    this.registerObsidianProtocolHandler("tome-sync", async (p) => {
      if (!p.code || !p.state) return;
      await this.finishSignIn(() => this.grimoire.finish(p.code, p.state));
    });

    const soon = debounce(() => this.syncNow(false), 8000, true);
    this.app.workspace.onLayoutReady(() => {
      for (const ev of ["modify", "create", "delete", "rename"] as const) this.registerEvent(this.app.vault.on(ev as "modify", () => this.settings.autoSync && !this.running && soon()));
      this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.settings.autoSync && soon());
      this.schedule();
      if (!this.grimoire.session) {
        this.setStatus("signedOut");
        if (this.settings.vault) new Notice("Tome Sync: open Settings → Tome Sync and sign in with Grimoire to start syncing.", 10000);
        return;
      }
      window.setTimeout(() => void this.syncNow(false), 3000);
    });
    this.setStatus(this.grimoire.session ? "idle" : "signedOut");
  }

  onunload() {
    if (this.timer) window.clearInterval(this.timer);
  }

  async loadSettings() {
    const saved = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULTS, ...saved };
    if (!this.settings.device) this.settings.device = defaultDevice();
    this.last = saved.last ?? null;
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, last: this.last ? { ...this.last, report: this.last.report && { ...this.last.report, activity: this.last.report.activity.slice(-50) } } : null });
  }

  schedule() {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    if (!this.settings.autoSync) return;
    this.timer = window.setInterval(() => void this.syncNow(false), Math.max(1, this.settings.intervalMinutes) * 60_000);
    this.registerInterval(this.timer);
  }

  private stateStore() {
    return new PluginStateStore(this.app, `${this.manifest.dir}/sync/${(this.settings.vault ?? "none").replace(/[^\w-]/g, "_")}`);
  }

  setStatus(s: TomeSync["status"]) {
    this.status = s;
    const label = {
      idle: this.last?.at ? `Tome ✓ ${ago(this.last.at)}` : "Tome",
      syncing: "Tome: syncing…",
      signedOut: "Tome: sign in",
      offline: "Tome: offline",
      error: "Tome: problem",
      paused: "Tome: confirm deletions",
    }[s];
    if (this.statusEl) {
      this.statusEl.setText(label);
      this.statusEl.setAttr("aria-label", this.last?.error ?? "Sync with Tome now");
    }
    this.ribbon?.toggleClass("tome-sync-spinning", s === "syncing");
    this.settingTab?.refreshStatus();
  }

  private rival(): string | null {
    const plugins = (this.app as App & { plugins?: { enabledPlugins?: Set<string> } }).plugins?.enabledPlugins;
    for (const [id, name] of Object.entries(RIVALS)) if (plugins?.has(id)) return name;
    const core = (this.app as App & { internalPlugins?: { plugins?: Record<string, { enabled?: boolean }> } }).internalPlugins?.plugins;
    if (core?.sync?.enabled) return "Obsidian Sync";
    return null;
  }

  /** One sync, or a second one right after if something changed while it ran. `loud`: the person asked. */
  async syncNow(loud: boolean, allowDeletes = false): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (!this.grimoire.session) {
      this.setStatus("signedOut");
      if (loud) new Notice("Tome Sync: sign in with Grimoire first (Settings → Tome Sync).");
      return;
    }
    if (!this.settings.vault) {
      if (loud) new Notice("Tome Sync: pick a Tome vault in Settings → Tome Sync.");
      return;
    }
    const rival = this.rival();
    if (rival) {
      this.last = { at: Date.now(), error: `${rival} also syncs this vault. Two syncs on one vault fight over every file, so Tome Sync waits until ${rival} is turned off here.` };
      this.setStatus("error");
      if (loud) new Notice(`Tome Sync: ${this.last.error}`, 12000);
      return;
    }
    this.running = (async () => {
      this.setStatus("syncing");
      try {
        const engine = new Engine(this.tome, new ObsidianFs(this.app), this.stateStore(), { device: this.settings.device || defaultDevice(), caseInsensitive: !(Platform.isLinux && Platform.isDesktopApp) });
        const cycle = await engine.sync(this.settings.vault!, allowDeletes);
        if (cycle.outcome === "needsConfirmation") {
          this.setStatus("paused");
          new ConfirmDeletes(this.app, cycle, this.settings.vaultName, () => void this.syncNow(true, true)).open();
          return;
        }
        const r = cycle.report;
        this.last = { at: Date.now(), report: r };
        this.setStatus(r.errors.length ? "error" : "idle");
        if (r.conflicts.length) new Notice(`Tome Sync: ${r.conflicts.length === 1 ? "a note was" : `${r.conflicts.length} notes were`} changed here and in Tome at the same lines. Tome's version is in place; yours is kept as:\n${r.conflicts.join("\n")}`, 15000);
        if (r.errors.length && loud) new Notice(`Tome Sync: ${r.errors.length} file${r.errors.length === 1 ? "" : "s"} couldn't sync. See Settings → Tome Sync.`);
        else if (loud) new Notice(summary(r) || "Tome Sync: everything is up to date.");
      } catch (e) {
        const err = e instanceof SyncError ? e : new SyncError("other", e instanceof Error ? e.message : String(e));
        this.last = { at: this.last?.at ?? 0, report: this.last?.report, error: err.message };
        this.setStatus(err.kind === "signedOut" ? "signedOut" : err.kind === "network" ? "offline" : "error");
        if (loud || err.kind === "signedOut" || err.kind === "api") new Notice(`Tome Sync: ${err.message}`, 10000);
      } finally {
        await this.saveSettings();
      }
    })().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        window.setTimeout(() => void this.syncNow(false), 1000);
      }
    });
    return this.running;
  }

  async signIn() {
    if (!this.settings.server) {
      new Notice("Tome Sync: type your studio's Grimoire address first (Settings → Tome Sync).", 10000);
      return;
    }
    try {
      const url = await this.grimoire.begin(this.settings.server, this.app.vault.getName());
      window.open(url);
      new Notice("Tome Sync: finish signing in in your browser. Obsidian opens again when you're done.", 10000);
    } catch (e) {
      new Notice(`Tome Sync: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  }

  async finishSignIn(fn: () => Promise<{ name: string; email: string }>) {
    try {
      const user = await fn();
      new Notice(`Tome Sync: signed in as ${user.name || user.email}.`);
      this.setStatus("idle");
      if (!this.settings.vault) await this.pickDefaultVault();
      this.settingTab?.display();
      void this.syncNow(true);
    } catch (e) {
      new Notice(`Tome Sync: ${e instanceof Error ? e.message : String(e)}`, 12000);
    }
  }

  /** After the first sign-in: the only vault, or one called like this Obsidian vault. */
  private async pickDefaultVault() {
    try {
      const vaults = await this.tome.vaults();
      const mine = this.app.vault.getName().toLowerCase();
      const pick = vaults.length === 1 ? vaults[0] : vaults.find((v) => v.name.toLowerCase() === mine);
      if (pick) await this.useVault(pick);
    } catch {}
  }

  async useVault(v: VaultInfo | null) {
    if ((v?.slug ?? null) === this.settings.vault) return;
    this.settings.vault = v?.slug ?? null;
    this.settings.vaultName = v?.name ?? "";
    this.last = null;
    await this.saveSettings();
  }

  async signOut() {
    await this.grimoire.signOut();
    this.setStatus("signedOut");
    this.settingTab?.display();
  }

  async openInTome() {
    try {
      const base = await this.tome.url();
      window.open(this.settings.vault ? `${base}/v/${encodeURIComponent(this.settings.vault)}` : base);
    } catch (e) {
      new Notice(`Tome Sync: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function summary(r: Report) {
  const parts = [
    r.uploaded && `${r.uploaded} sent`,
    r.downloaded && `${r.downloaded} received`,
    r.merged && `${r.merged} merged`,
    r.moved && `${r.moved} renamed`,
    r.deletedRemote + r.deletedLocal && `${r.deletedRemote + r.deletedLocal} deleted`,
    r.keptLocal && `${r.keptLocal} kept here (view only)`,
  ].filter(Boolean);
  return parts.length ? `Tome Sync: ${parts.join(", ")}.` : "";
}

class ConfirmDeletes extends Modal {
  constructor(
    app: App,
    private c: { local: number; remote: number; of: number },
    private vaultName: string,
    private onYes: () => void,
  ) {
    super(app);
  }

  onOpen() {
    const { local, remote, of } = this.c;
    this.setTitle("Delete these files?");
    const p = this.contentEl.createEl("p");
    if (local === 0 && remote === of) p.setText(`This vault looks empty, but ${of} files synced with Tome before. If you go on, they're moved to Tome's trash. If the vault's folder moved or isn't available, stop here.`);
    else
      p.setText(
        `This sync would delete ${local ? `${local} file${local === 1 ? "" : "s"} here (they go to this vault's .trash folder)` : ""}${local && remote ? " and " : ""}${remote ? `${remote} file${remote === 1 ? "" : "s"} in ${this.vaultName || "Tome"} (they go to Tome's trash)` : ""}, out of ${of}. Nothing has been deleted yet.`,
      );
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Not now").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Delete them")
          .setWarning()
          .onClick(() => {
            this.close();
            this.onYes();
          }),
      );
  }
}

class PasteCode extends Modal {
  constructor(
    app: App,
    private plugin: TomeSync,
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle("Paste sign-in code");
    this.contentEl.createEl("p", { text: "Copy the code from the Grimoire page that opened after you signed in, and paste it here." });
    let value = "";
    new Setting(this.contentEl).setName("Code").addTextArea((t) => {
      t.inputEl.rows = 3;
      t.inputEl.addClass("tome-sync-code");
      t.onChange((v) => (value = v));
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Sign in")
        .setCta()
        .onClick(async () => {
          this.close();
          await this.plugin.finishSignIn(() => this.plugin.grimoire.finishPasted(value));
        }),
    );
  }
}

class TomeSyncSettings extends PluginSettingTab {
  private statusBox: HTMLElement | null = null;
  private vaults: VaultInfo[] | null = null;

  constructor(
    app: App,
    private plugin: TomeSync,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl: el } = this;
    const p = this.plugin;
    el.empty();
    el.addClass("tome-sync-settings");
    const session = p.grimoire.session;

    new Setting(el).setName("Account").setHeading();
    if (session) {
      new Setting(el)
        .setName(`Signed in as ${session.user.name || session.user.email}`)
        .setDesc(`${session.user.email} · ${session.server.replace(/^https?:\/\//, "")}`)
        .addButton((b) => b.setButtonText("Sign out").onClick(() => p.signOut()));
    } else {
      new Setting(el)
        .setName("Grimoire address")
        .setDesc("Where your studio signs in, like https://grimoire.example.com. Your admin or your studio's Tome (Connect Obsidian) has it.")
        .addText((t) =>
          t.setPlaceholder("https://grimoire.example.com").setValue(p.settings.server).onChange(async (v) => {
            p.settings.server = v.trim();
            await p.saveSettings();
          }),
        );
      new Setting(el)
        .setName("Sign in")
        .setDesc("Opens Grimoire in your browser. When you're signed in, Obsidian opens again by itself. If it doesn't, use Paste sign-in code.")
        .addButton((b) =>
          b
            .setButtonText("Sign in with Grimoire")
            .setCta()
            .onClick(() => p.signIn()),
        )
        .addButton((b) => b.setButtonText("Paste sign-in code").onClick(() => new PasteCode(this.app, p).open()));
    }

    new Setting(el).setName("Tome vault").setHeading();
    const vs = new Setting(el).setName("Sync this Obsidian vault with").setDesc(session ? "Your Obsidian vault and this Tome vault become the same, both ways." : "Sign in first.");
    if (session) {
      vs.addDropdown(async (d) => {
        d.addOption("", this.vaults ? "Choose a vault…" : (p.settings.vaultName || "Loading…"));
        if (p.settings.vault) d.addOption(p.settings.vault, p.settings.vaultName || p.settings.vault);
        d.setValue(p.settings.vault ?? "");
        try {
          this.vaults ??= await p.tome.vaults();
          d.selectEl.empty();
          d.addOption("", "Choose a vault…");
          for (const v of this.vaults) d.addOption(v.slug, `${v.name}${v.role === "viewer" ? " (view only)" : ""}`);
          d.setValue(p.settings.vault ?? "");
        } catch (e) {
          vs.setDesc(e instanceof Error ? e.message : String(e));
        }
        d.onChange(async (slug) => {
          await p.useVault(this.vaults?.find((v) => v.slug === slug) ?? null);
          this.display();
          if (slug) void p.syncNow(true);
        });
      });
      vs.addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Reload the list")
          .onClick(() => {
            this.vaults = null;
            this.display();
          }),
      );
    }

    new Setting(el).setName("Syncing").setHeading();
    new Setting(el)
      .setName("Sync automatically")
      .setDesc("On start, a few seconds after you edit, and every few minutes. Off: only when you press the sync button.")
      .addToggle((t) =>
        t.setValue(p.settings.autoSync).onChange(async (v) => {
          p.settings.autoSync = v;
          await p.saveSettings();
          p.schedule();
        }),
      );
    new Setting(el)
      .setName("Check Tome every")
      .addDropdown((d) => {
        for (const m of [1, 5, 15, 60]) d.addOption(String(m), m === 60 ? "hour" : `${m} minute${m === 1 ? "" : "s"}`);
        d.setValue(String(p.settings.intervalMinutes)).onChange(async (v) => {
          p.settings.intervalMinutes = Number(v);
          await p.saveSettings();
          p.schedule();
        });
      });
    new Setting(el)
      .setName("This device's name")
      .setDesc("Shown in conflict copies, like \"Note (conflict, iPhone, 2026-10-30 1432).md\".")
      .addText((t) =>
        t.setValue(p.settings.device).onChange(async (v) => {
          p.settings.device = v;
          await p.saveSettings();
        }),
      );

    new Setting(el).setName("Status").setHeading();
    this.statusBox = el.createDiv({ cls: "tome-sync-status-box" });
    this.refreshStatus();
    new Setting(el)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => p.syncNow(true)),
      )
      .addButton((b) => b.setButtonText("Open in Tome").onClick(() => p.openInTome()));
  }

  refreshStatus() {
    const box = this.statusBox;
    if (!box || !box.isConnected) return;
    const p = this.plugin;
    box.empty();
    const line = box.createDiv({ cls: "tome-sync-line" });
    const icon = line.createSpan();
    setIcon(icon, { idle: "check-circle", syncing: "refresh-cw", signedOut: "log-in", offline: "wifi-off", error: "alert-triangle", paused: "pause-circle" }[p.status]);
    const r = p.last?.report;
    line.createSpan({
      text:
        p.status === "syncing"
          ? "Syncing…"
          : p.status === "signedOut"
            ? "Not signed in."
            : p.last?.error
              ? p.last.error
              : r
                ? `Last synced ${ago(p.last!.at)}: ${r.files} files${r.readOnly ? " (you can view this vault, so your edits stay on this device)" : ""}.`
                : p.settings.vault
                  ? "Not synced yet."
                  : "Pick a Tome vault to start.",
    });
    if (!r) return;
    const section = (title: string, rows: [string, string][]) => {
      if (!rows.length) return;
      const d = box.createEl("details");
      d.createEl("summary", { text: `${title} (${rows.length})` });
      const ul = d.createEl("ul");
      for (const [path, why] of rows.slice(0, 200)) ul.createEl("li", { text: why ? `${path}: ${why}` : path });
    };
    section("Couldn't sync", r.errors);
    section("Conflict copies", r.conflicts.map((c) => [c, ""]));
    section("Stay on this device", r.skipped);
    section(
      "Last changes",
      r.activity
        .filter((a) => a.kind !== "error")
        .slice(-50)
        .reverse()
        .map((a) => [a.path, a.detail ?? a.kind.replace("_", " ")]),
    );
  }
}
