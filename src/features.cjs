"use strict";

const { summarize, desiredMutes, snowflake } = require("./core.cjs");
const BAN_NOTE = "[RedflagAutoMute] БАН в активной базе.";
const WARN_NOTE = "[RedflagAutoMute] В базе: жёлтый флаг (предупреждение).";

function databaseFlags(groups, options, selfId) {
    const blocked = desiredMutes(groups, { includeYellow: options.includeYellow }, selfId);
    const notes = {};
    const records = {};
    for (const group of groups) for (const [id, summary] of Object.entries(summarize(group))) {
        if (id === selfId) continue;
        const votes = Object.entries(group.cards[id]).filter(([author, vote]) => group.members?.[author] && ["red", "yellow"].includes(vote.type)).map(([, vote]) => vote);
        const isBan = summary.type === "red" || !!options.includeYellow;
        const times = type => votes.filter(v => v.type === type).map(v => Number(v.updatedAt)).filter(t => Number.isFinite(t) && t > 0).sort((a,b) => a-b);
        const red = times("red"), yellow = times("yellow");
        const at = isBan ? Math.min(red[0] || Infinity, yellow[options.includeYellow ? 0 : 1] || Infinity) : yellow[0];
        const record = { group: group.id, at: Number.isFinite(at) ? at : null, isBan };
        const old = records[id];
        if (!old || (isBan && !old.isBan) || (isBan === old.isBan && (record.at || Infinity) < (old.at || Infinity))) records[id] = record;
    }
    for (const [id, record] of Object.entries(records)) {
        const date = record.at ? new Date(record.at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "неизвестно";
        notes[id] = `[RedflagAutoMute] ${record.isBan ? "БАН" : "Предупреждение"}\nID: ${record.group ? record.group + "/" : ""}${id}\n${record.isBan ? "Забанен" : "Отмечен"}: ${date}`;
    }
    return { blocked, notes };
}

class VideoController {
    constructor(adapter, owned = {}, save = () => {}) {
        this.adapter = adapter;
        this.owned = Object.fromEntries(Object.entries(owned).filter(([id]) => snowflake(id)));
        this.save = save;
    }
    reconcile(desired) {
        for (const [id, previous] of Object.entries(this.owned)) {
            if (desired.has(id)) continue;
            if (this.adapter.state(id) === "DISABLED") this.adapter.set(id, previous);
            delete this.owned[id]; this.save({ ...this.owned });
        }
        for (const id of desired) {
            if (this.adapter.disabled(id)) continue;
            const previous = this.adapter.state(id);
            this.adapter.set(id, "DISABLED");
            if (!(id in this.owned)) this.owned[id] = previous;
            this.save({ ...this.owned });
        }
    }
}

function editNote(current, oldMarker, newMarker, limit = 256) {
    if (typeof current !== "string") throw new Error("Не удалось прочитать заметку Discord");
    if (newMarker && (current === newMarker || current.endsWith(`\n${newMarker}`))) return { text: current, skipped: false };
    let base = current;
    if (oldMarker) {
        if (base === oldMarker) base = "";
        else if (base.endsWith(`\n${oldMarker}`)) base = base.slice(0, -oldMarker.length - 1);
        else if (base.includes(oldMarker)) return { text: current, skipped: true };
    }
    const text = newMarker ? `${base}${base ? "\n" : ""}${newMarker}` : base;
    if (text.length > limit) return { text: current, skipped: true };
    return { text, skipped: false };
}

// One request chain at a time; never replace the user's note with a cached copy.
class NoteController {
    constructor(adapter, owned = {}, save = () => {}, valid = () => true) {
        this.adapter = adapter; this.owned = owned; this.save = save; this.valid = valid;
        this.desired = {}; this.checked = {}; this.busy = false; this.next = 0;
        this.priority = {}; this.revision = 0; this.retryAt = {};
        this.status = "Заметки: ожидание синхронизации";
    }
    async reconcile(desired, now = Date.now()) {
        const revision = ++this.revision;
        for (const id of new Set([...Object.keys(this.desired), ...Object.keys(desired)])) {
            if (this.desired[id] !== desired[id]) this.priority[id] = revision;
        }
        this.desired = { ...desired };
        if (this.busy || now < this.next || !this.valid() || this.adapter.editing?.()) return;
        const changed = uid => !this.checked[uid] || this.checked[uid].marker !== desired[uid];
        const id = [...new Set([...Object.keys(this.owned), ...Object.keys(desired)])].filter(snowflake).filter(uid => {
            const check = this.checked[uid];
            return now >= (this.retryAt[uid] || 0) && (changed(uid) || now - check.at >= 300000);
        }).sort((a,b) => Number(changed(b)) - Number(changed(a)) ||
            (changed(a) ? (this.priority[b] || 0) - (this.priority[a] || 0) : this.checked[a].at - this.checked[b].at))[0];
        if (!id) return;
        this.busy = true;
        try {
            const current = await this.adapter.read(id);
            if (!this.valid()) return;
            const marker = this.desired[id];
            const old = this.owned[id];
            const result = editNote(current, old, marker);
            if (result.skipped) {
                this.status = "Заметка пропущена: нет места или отметка отредактирована вручную";
            } else {
                if (result.text !== current) {
                    if (!this.valid()) return;
                    await this.adapter.write(id, result.text);
                }
                if (!this.valid()) return;
                if (marker) this.owned[id] = marker;
                else delete this.owned[id];
                this.save({ ...this.owned });
                this.status = "Заметки: синхронизированы";
            }
            this.checked[id] = { marker, at: now };
            delete this.retryAt[id];
            this.next = now + 2000;
        } catch (error) {
            this.status = `Заметки: ${error.message}`;
            this.retryAt[id] = now + 30000;
            this.next = now + (error.status === 429 ? 30000 : 2000);
        } finally { this.busy = false; }
    }
    get pendingCount() {
        return [...new Set([...Object.keys(this.owned), ...Object.keys(this.desired)])].filter(id =>
            !this.checked[id] || this.checked[id].marker !== this.desired[id]).length;
    }
}

class Highlights {
    constructor(api, doc) {
        this.api = api; this.doc = doc; this.marked = new Set(); this.blocked = new Set();
        this.selector = '[data-call-tile], [class*="voiceUser_"], img[src*="/avatars/"]';
        const Observer = doc.defaultView?.MutationObserver;
        this.observer = Observer ? new Observer(records => {
            // React can replace className or the whole tile on hover. Repair before
            // the next paint, rather than waiting for the one-second voice tick.
            if (records.some(r => r.type === "childList" || this.marked.has(r.target) || r.target.matches?.(this.selector))) this.refresh();
        }) : null;
        this.stopped = false;
    }
    observe() {
        if (!this.stopped && this.blocked.size && this.doc.body) this.observer?.observe(this.doc.body, {
            subtree: true, childList: true, attributes: true,
            attributeFilter: ["class", "src", "data-call-tile"]
        });
    }
    userId(element) {
        const avatarId = element.getAttribute("src")?.match(/\/avatars\/(\d{17,20})\//)?.[1];
        if (avatarId) return avatarId;
        let fiber = this.api.ReactUtils.getInternalInstance(element);
        for (let i = 0; fiber && i < 12; i++, fiber = fiber.return) {
            const p = fiber.memoizedProps;
            const id = p?.participantUserId || p?.user?.id || p?.userId;
            if (snowflake(id)) return id;
        }
    }
    update(blocked) {
        this.blocked = new Set(blocked);
        this.refresh();
    }
    refresh() {
        if (this.stopped) return;
        // Do not observe our own class mutations and create a feedback loop.
        this.observer?.disconnect();
        const next = new Set();
        if (this.blocked.size) for (const element of this.doc.querySelectorAll(this.selector)) {
            try {
                if (!this.blocked.has(this.userId(element))) continue;
                if (!element.classList.contains("rfam-blocked")) element.classList.add("rfam-blocked");
                next.add(element);
            } catch { /* Discord may detach a node during rendering. */ }
        }
        for (const element of this.marked) if (!next.has(element)) element.classList.remove("rfam-blocked");
        this.marked = next;
        this.observe();
    }
    stop() {
        this.stopped = true; this.observer?.disconnect(); this.blocked.clear();
        for (const e of this.marked) e.classList.remove("rfam-blocked"); this.marked.clear();
    }
}

module.exports = { databaseFlags, VideoController, NoteController, Highlights, editNote, BAN_NOTE, WARN_NOTE };
