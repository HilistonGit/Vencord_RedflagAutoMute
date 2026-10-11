"use strict";

const { desiredMutes, summarize, MuteController, snowflake } = require("./core.cjs");
const { FirebaseClient, validateConfig } = require("./firebase.cjs");
const { transport } = require("./transport.cjs");
const { databaseFlags, VideoController, NoteController, Highlights } = require("./features.cjs");
const { settingsPanel } = require("./settings.cjs");
const {discordExport,exportList,bannedIds}=require("./transfer.cjs");
const NAME = "RedflagAutoMute";
const DEFAULT_CONFIG = require("../firebase.public.json");

function parseInvite(text) {
    if (typeof text!=="string" || !/^(rfam1|rfdb1)\.[A-Za-z0-9_-]+$/.test(text) || text.length > 4096) throw new Error("Ожидается приглашение rfam1.… или rfdb1.…");
    const data = JSON.parse(Buffer.from(text.slice(6).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const config = validateConfig(data);
    if(text.startsWith("rfdb1.")) return config;
    if (!/^[a-f0-9]{48}\.[a-f0-9]{48}$/.test(data.code)) throw new Error("Повреждённый код приглашения");
    return { ...config, code: data.code };
}

module.exports = class RedflagAutoMute {
    start() {
        this.running = true;
        this.epoch = (this.epoch || 0) + 1;
        this.config = BdApi.Data.load(NAME, "config") || DEFAULT_CONFIG;
        this.accounts = BdApi.Data.load(NAME, "accounts") || {};
        this.status = "Настройте Firebase и войдите";
        this.versions = {};
        BdApi.DOM?.addStyle(NAME, '.rfam-blocked { outline: 3px solid #ed4245 !important; outline-offset: -3px !important; } [data-call-tile].rfam-blocked::after { content: ""; position: absolute; inset: 0; z-index: 100; pointer-events: none; border-radius: inherit; box-shadow: inset 0 0 0 3px #ed4245; } img.rfam-blocked { border-radius: 50%; outline-offset: 1px !important; }');
        if (typeof document !== "undefined") this.highlights = new Highlights(BdApi, document);
        this.unpatches = ["user-context", "user-profile", "user-profile-overflow-menu"].map(nav =>
            BdApi.ContextMenu.patch(nav, (tree, props) => this.patchMenu(tree, props)));
        this.tick();
        this.timer = setInterval(() => this.tick(), 2000);
    }
    save() { BdApi.Data.save(NAME, "accounts", this.accounts); }
    error(error) {
        this.status = error.message || String(error);
        BdApi.UI.showToast(`Redflag: ${this.status}`, { type: "error" });
    }
    tick() {
        try {
            const id = BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id;
            if (!id) return;
            if (id !== this.accountId) {
                this.epoch++;
                this.accountId = id;
                this.account = this.accounts[id] ||= { groups: [], overrides: {}, owned: [], cache: {} };
                this.controller = null;
                this.video = null; this.notes = null;
                this.highlights?.update(new Set());
                this.makeClient();
                this.nextSync = 0;
            }
            if (!this.controller) {
                const store = BdApi.Webpack.getStore("MediaEngineStore");
                const actions = BdApi.Webpack.getByKeys("toggleLocalMute");
                if (!store?.isLocalMute || !actions?.toggleLocalMute) {
                    this.status = "Ожидание голосовых модулей Discord. Откройте голосовой канал.";
                    return;
                }
                const account = this.account;
                this.controller = new MuteController({
                    isMuted: uid => store.isLocalMute(uid), toggle: uid => actions.toggleLocalMute(uid)
                }, account.owned || [], owned => { account.owned = owned; this.save(); });
            }
            this.setupFeatures();
            this.setupVoiceWatchers();
            this.apply();
            if (this.client?.session && Date.now() >= (this.nextSync || 0)) void this.sync();
        } catch (error) { this.status = error.message; }
    }
    makeClient() {
        this.client = null;
        this.notes = null;
        try {
            const epoch = this.epoch, account = this.account;
            const project = validateConfig(this.config).databaseURL;
            if (account.project && account.project !== project) {
                account.session = null; account.firebaseUid = null; account.groups = []; account.cache = {};
            }
            account.project = project;
            this.client = new FirebaseClient(this.config, transport, account.session, session => {
                if (this.running && epoch === this.epoch) {
                    if (account.firebaseUid && account.firebaseUid !== session.uid) { account.groups = []; account.cache = {}; }
                    account.firebaseUid = session.uid; account.session = session; this.save();
                }
            });
        } catch { /* Empty configuration is expected on first run. */ }
    }
    active() {
        return (this.account?.groups || []).filter(g => g.enabled && this.account.cache?.[g.id]).map(g => ({ ...this.account.cache[g.id], id: g.id }));
    }
    setupFeatures() {
        const account = this.account, epoch = this.epoch;
        if (!this.video) {
            const store = BdApi.Webpack.getStore("MediaEngineStore");
            const actions = BdApi.Webpack.getByKeys("setDisableLocalVideo");
            if (store?.isLocalVideoDisabled && store?.getVideoToggleState && actions?.setDisableLocalVideo) {
                this.video = new VideoController({ disabled: id => store.isLocalVideoDisabled(id), state: id => store.getVideoToggleState(id), set: (id, value) => actions.setDisableLocalVideo(id, value) }, account.videoOwned || {}, owned => { account.videoOwned = owned; this.save(); });
            }
        }
        if (!this.notes) {
            const http = BdApi.Webpack.getModule(m => m && typeof m === "object" && typeof m.get === "function" && typeof m.put === "function" && typeof m.del === "function" && typeof m.patch === "function", { searchExports: true });
            const actions = BdApi.Webpack.getByKeys("updateNote");
            if (http && actions) this.notes = new NoteController({
                read: async id => {
                    try {
                        const res = await http.get({ url: `/users/@me/notes/${id}`, retries: 0 });
                        if (res.body?.note === null) return "";
                        if (typeof res.body?.note !== "string") throw new Error("Неизвестный формат заметки Discord");
                        return res.body.note;
                    } catch (e) { if (e.status === 404) return ""; throw e; }
                },
                write: (id, value) => actions.updateNote(id, value),
                editing: () => typeof document !== "undefined" && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
            }, account.noteOwned || {}, owned => { account.noteOwned = owned; this.save(); },
            () => this.running && this.epoch === epoch && BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id === this.accountId);
        }
    }
    setupVoiceWatchers() {
        this.voiceWatchers ||= [];
        for (const name of ["VoiceStateStore", "SelectedChannelStore", "MediaEngineStore"]) {
            const store = BdApi.Webpack.getStore(name);
            if (!store?.addChangeListener || !store?.removeChangeListener || this.voiceWatchers.some(item => item.store === store)) continue;
            const listener = () => {
                if (!this.running || this.voiceApplyTimer != null) return;
                // Leave Flux dispatch before toggling mute; coalesce simultaneous events.
                this.voiceApplyTimer = setTimeout(() => {
                    this.voiceApplyTimer = null;
                    if (this.running) try { this.apply(); } catch (error) { this.error(error); }
                }, 0);
            };
            store.addChangeListener(listener);
            this.voiceWatchers.push({ store, listener });
        }
    }
    voiceTargets(desired) {
        const selected = BdApi.Webpack.getStore("SelectedChannelStore");
        const voice = BdApi.Webpack.getStore("VoiceStateStore");
        // Unknown API must not cause a bulk mute of the entire database.
        if (!selected?.getVoiceChannelId || !voice?.getVoiceStatesForChannel) return null;
        const channel = selected.getVoiceChannelId();
        if (!channel) return new Set();
        const states = voice.getVoiceStatesForChannel(channel);
        if (!states || typeof states !== "object") return null;
        return new Set(Object.keys(states).filter(id => desired.has(id)));
    }
    apply() {
        if (!this.running || BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id !== this.accountId) return;
        const desired = desiredMutes(this.active(), this.account, this.accountId);
        const flags = databaseFlags(this.active(), this.account, this.accountId);
        const audible = this.voiceTargets(desired);
        if (audible) {
            this.controller?.reconcile(audible);
            this.video?.reconcile(this.account.disableVideo !== false ? audible : new Set());
        }
        this.highlights?.update(flags.blocked);
        void this.notes?.reconcile(this.account.markNotes !== false ? flags.notes : {});
    }
    async sync() {
        if (!this.client?.session) return;
        const epoch = this.epoch;
        if (this.syncEpoch === epoch) return;
        this.syncEpoch = epoch;
        const account = this.account, client = this.client;
        const problems = [];
        try {
            const revision = this.groupsRevision || 0;
            try {
                const ids = await client.listGroups(account.groups.map(g => g.id));
                if (!this.running || epoch !== this.epoch) return;
                if ((this.groupsRevision || 0) !== revision) { this.nextSync = 0; return; }
                const old = new Map(account.groups.map(g => [g.id, g]));
                account.groups = ids.map(id => old.get(id) || { id, name: id.slice(0,8), enabled: true });
                for (const id of Object.keys(account.cache)) if (!ids.includes(id)) delete account.cache[id];
            } catch (error) {
                if (!this.running || epoch !== this.epoch) return;
                problems.push(`Список групп: ${error.message}`);
            }
            for (const group of [...account.groups]) {
                try {
                    const version = this.versions[group.id] || 0;
                    const snapshot = await client.readGroup(group.id);
                    if (!this.running || epoch !== this.epoch) return;
                    if ((this.versions[group.id] || 0) !== version) continue;
                    if (!account.groups.some(g => g.id === group.id)) continue;
                    if (snapshot) { account.cache[group.id] = snapshot; group.name = snapshot.name; }
                    else { delete account.cache[group.id]; account.groups = account.groups.filter(g => g.id !== group.id); await client.forgetGroup(group.id); }
                } catch (error) {
                    if (!this.running || epoch !== this.epoch) return;
                    // Revoked access must not keep applying cached cards.
                    if ([401, 403].includes(error.status)) {
                        delete account.cache[group.id];
                        account.groups = account.groups.filter(g => g.id !== group.id);
                        try { await client.forgetGroup(group.id); } catch { /* Retry stale-index cleanup on next discovery. */ }
                    }
                    problems.push(`${group.name}: ${error.message}`);
                }
            }
            if (!this.running || epoch !== this.epoch) return;
            this.status = problems.length ? `Нет синхронизации: ${problems.join("; ")}` : `Синхронизировано ${new Date().toLocaleTimeString()}`;
            this.nextSync = Date.now() + (problems.length ? 30000 : 15000);
            this.save();
            this.apply();
        } finally { if (this.syncEpoch === epoch) this.syncEpoch = null; }
    }
    async deleteGroup(id) {
        const epoch = this.epoch;
        await this.client.deleteGroup(id);
        if (!this.running || epoch !== this.epoch) return;
        this.groupsRevision = (this.groupsRevision || 0) + 1;
        this.versions[id] = (this.versions[id] || 0) + 1;
        this.account.groups = this.account.groups.filter(g => g.id !== id);
        delete this.account.cache[id]; this.save(); this.apply(); this.nextSync = 0;
    }
    exportMutes(groupId,options={}) {
        const result=groupId?{ids:bannedIds(this.account.cache[groupId]||{})}:discordExport(BdApi.Webpack.getStore("MediaEngineStore"),this.accountId,BdApi.Webpack.getStore("RelationshipStore"),options);
        return {...result,text:exportList(result.ids,groupId?"group":"discord-local-selection")};
    }
    async importMutes(groupId,ids) {
        ids=ids.filter(id=>id!==this.accountId);
        if(!ids.length)throw Error("Нет пользователей для импорта");
        const epoch=this.epoch,client=this.client;
        await client.writeCards(groupId,ids,"red");
        if(!this.running||epoch!==this.epoch)return;
        this.versions[groupId]=(this.versions[groupId]||0)+1;
        const snapshot=await client.readGroup(groupId);
        if(!this.running||epoch!==this.epoch)return;
        this.account.cache[groupId]=snapshot;this.save();this.apply();this.nextSync=0;
        return ids.length;
    }
    async operation(fn) {
        try {
            if (!this.running || !this.account) throw new Error("Включите плагин и войдите в Discord");
            await fn();
        } catch (error) { this.error(error); }
    }
    async setCard(groupId, uid, type) {
        const epoch = this.epoch, client = this.client;
        if (!client?.session) throw new Error("Сначала войдите в Firebase");
        await client.card(groupId, uid, type);
        if (!this.running || epoch !== this.epoch) return;
        const version = this.versions[groupId] = (this.versions[groupId] || 0) + 1;
        // The acknowledged write is authoritative even if a previous poll is still in flight.
        const snapshot = await client.readGroup(groupId);
        if (!this.running || epoch !== this.epoch) return;
        if (this.versions[groupId] !== version) return;
        this.account.cache[groupId] = snapshot;
        this.save(); this.apply(); this.nextSync = 0;
        BdApi.UI.showToast(type ? "Карточка сохранена" : "Ваша карточка отозвана", { type: "success" });
    }
    override(uid, value) {
        if (!snowflake(uid)) throw new Error("Неверный Discord ID");
        if (value) this.account.overrides[uid] = value;
        else delete this.account.overrides[uid];
        this.save(); this.apply();
    }
    patchMenu(tree, props) {
        const uid = props?.user?.id;
        if (!this.account || !snowflake(uid) || uid === this.accountId || !tree?.props) return;
        const items = [
            { id: "rfam-allow", label: "Всегда разрешать лично мне", action: () => this.override(uid, "allow") },
            { id: "rfam-mute", label: "Всегда мутить лично мне", action: () => this.override(uid, "mute") },
            { id: "rfam-follow", label: "Следовать правилам групп", action: () => this.override(uid, null) }
        ];
        for (const group of this.account.groups.filter(g => g.enabled)) {
            items.push({ id: `rfam-group-${group.id}`, type: "submenu", label: group.name, items: [
                { id: "rfam-red", label: this.flagLabel("Красная карточка", "#ed4245"), action: () => this.operation(() => this.setCard(group.id, uid, "red")) },
                { id: "rfam-yellow", label: this.flagLabel("Жёлтая карточка", "#fee75c"), action: () => this.operation(() => this.setCard(group.id, uid, "yellow")) },
                { id: "rfam-revoke", label: "Отозвать мою карточку", action: () => this.operation(() => this.setCard(group.id, uid, null)) }
            ] });
        }
        const children = BdApi.React.Children.toArray(tree.props.children);
        children.push(BdApi.ContextMenu.buildItem({ type: "submenu", label: "Redflag", items }));
        tree.props.children = children;
    }
    flagIcon(color) {
        return BdApi.React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", "aria-hidden": true },
            BdApi.React.createElement("path", { d: "M5 22V3M5 4C10 0 15 8 21 3V14C15 19 10 11 5 15", fill: color, stroke: color, strokeWidth: 2, strokeLinejoin: "round" }));
    }
    flagLabel(text, color) {
        return BdApi.React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 8 } }, this.flagIcon(color), text);
    }
    stop() {
        this.running = false;
        this.epoch++;
        clearInterval(this.timer);
        clearTimeout(this.voiceApplyTimer); this.voiceApplyTimer = null;
        for (const { store, listener } of this.voiceWatchers || []) store.removeChangeListener(listener);
        this.voiceWatchers = [];
        for (const unpatch of this.unpatches || []) unpatch();
        if (BdApi.Webpack.getStore("UserStore")?.getCurrentUser()?.id === this.accountId) {
            try { this.controller?.reconcile(new Set()); } catch (error) { this.error(error); }
            try { this.video?.reconcile(new Set()); } catch (error) { this.error(error); }
        }
        this.highlights?.stop(); BdApi.DOM?.removeStyle(NAME);
        this.video = null; this.notes = null;
        this.accountId = null;
        this.controller = null;
        this.client = null;
    }
    getSettingsPanel() {
        // Discord's settings dialog traps focus outside BetterDiscord's modal.
        // Close that underlying dialog before showing the plugin settings.
        const settingsActions = BdApi.Webpack.getByKeys("openUserSettings", "USER_SETTINGS_MODAL_KEY");
        const modalModule = BdApi.Webpack.getModule(m => m && Object.values(m).some(fn => typeof fn === "function" && String(fn).includes("?.stackNextByDefault")));
        const closeModal = BdApi.Webpack.getByKeys("openModal", "closeModal")?.closeModal || Object.values(modalModule || {}).find(fn => typeof fn === "function" && String(fn).includes(".setState") && String(fn).includes(".getState()["));
        const settingsKey = settingsActions?.USER_SETTINGS_MODAL_KEY || Array.from(modalModule?.getOpenModalKeys?.() || []).find(key => /USER_SETTINGS/i.test(key)) || "USER_SETTINGS_MODAL_MODAL_KEY";
        if (document.querySelector('[role="dialog"]')) {
            closeModal?.(settingsKey);
        }
        return settingsPanel(this, parseInvite);
    }
    configure(config) {
        const next = validateConfig(config);
        if (next.apiKey === this.config.apiKey && next.databaseURL === this.config.databaseURL) return;
        this.config = next;
        BdApi.Data.save(NAME, "config", this.config);
        this.epoch++;
        this.account.groups = []; this.account.cache = {};
        this.save(); this.makeClient(); this.apply();
        this.status = "Firebase настроен";
    }
};

module.exports.parseInvite = parseInvite;
