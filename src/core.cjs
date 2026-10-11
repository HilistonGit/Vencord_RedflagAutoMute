"use strict";

const snowflake = value => typeof value === "string" && /^[0-9]{17,20}$/.test(value);

function summarize(group, threshold = 2) {
    const result = {};
    for (const [id, votes] of Object.entries(group?.cards || {})) {
        if (!snowflake(id)) continue;
        let red = 0, yellow = 0;
        for (const [author, vote] of Object.entries(votes || {})) {
            if (!group.members?.[author]) continue;
            if (vote?.type === "red") red++;
            if (vote?.type === "yellow") yellow++;
        }
        if (red || yellow) result[id] = { red, yellow, type: red || yellow >= threshold ? "red" : "yellow" };
    }
    return result;
}

function desiredMutes(groups, options = {}, selfId) {
    const desired = new Set();
    const threshold = Math.max(2, Number(options.yellowThreshold) || 2);
    for (const group of groups) {
        for (const [id, card] of Object.entries(summarize(group, threshold))) {
            if (card.type === "red" || options.includeYellow) desired.add(id);
        }
    }
    for (const [id, choice] of Object.entries(options.overrides || {})) {
        if (!snowflake(id)) continue;
        if (choice === "allow") desired.delete(id);
        if (choice === "mute") desired.add(id);
    }
    desired.delete(selfId);
    return desired;
}

// Never take ownership of an existing manual mute. Persist ownership across reloads.
class MuteController {
    constructor(adapter, owned = [], save = () => {}) {
        this.adapter = adapter;
        this.owned = new Set(owned.filter(snowflake));
        this.save = save;
    }
    reconcile(desired) {
        for (const id of [...this.owned]) {
            if (desired.has(id)) continue;
            if (this.adapter.isMuted(id)) this.adapter.toggle(id);
            this.owned.delete(id);
            this.save([...this.owned]);
        }
        for (const id of desired) {
            if (!this.adapter.isMuted(id)) {
                this.adapter.toggle(id);
                this.owned.add(id);
                this.save([...this.owned]);
            }
        }
    }
}

module.exports = { snowflake, summarize, desiredMutes, MuteController };
