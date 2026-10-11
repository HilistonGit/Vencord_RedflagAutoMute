"use strict";

const { snowflake } = require("./core.cjs");
const {allocateTargets,MAX_OWNED_GROUPS}=require("./transfer.cjs");
const randomId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
const validKey = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function validateConfig(config) {
    const url = new URL(config.databaseURL);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)$/.test(url.hostname)
        || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Нужен корневой HTTPS URL Realtime Database (*.firebaseio.com или *.firebasedatabase.app)");
    }
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(config.apiKey || "")) throw new Error("Укажите Web API key Firebase");
    return { apiKey: config.apiKey, databaseURL: url.origin };
}

class FirebaseClient {
    constructor(config, transport, session, saveSession = () => {}) {
        this.config = validateConfig(config);
        this.transport = transport;
        this.session = session || null;
        this.saveSession = saveSession;
    }
    async json(url, options = {}) {
        const response = await this.transport(url, options);
        const data = await response.json();
        if (response.status < 200 || response.status >= 300) {
            const error = new Error(typeof data?.error === "string" ? data.error : data?.error?.message || `HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }
    async signIn(email, password, register = false) {
        const data = await this.json(`https://identitytoolkit.googleapis.com/v1/accounts:${register ? "signUp" : "signInWithPassword"}?key=${this.config.apiKey}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true })
        });
        this.session = { uid: data.localId, idToken: data.idToken, refreshToken: data.refreshToken, expiresAt: Date.now() + Number(data.expiresIn) * 1000 };
        this.saveSession(this.session);
    }
    async token() {
        if (!this.session) throw new Error("Сначала войдите в Firebase");
        if (this.session.expiresAt > Date.now() + 60000) return this.session.idToken;
        if (!this.refreshing) {
            this.refreshing = (async () => {
                const data = await this.json(`https://securetoken.googleapis.com/v1/token?key=${this.config.apiKey}`, {
                    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.session.refreshToken }).toString()
                });
                this.session = { uid: data.user_id, idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
                this.saveSession(this.session);
                return this.session.idToken;
            })().catch(error => {
                if (error.status === 400) error.status = 401;
                throw error;
            }).finally(() => { this.refreshing = null; });
        }
        return this.refreshing;
    }
    async request(path, method = "GET", body) {
        const token = await this.token();
        return this.json(`${this.config.databaseURL}/${path}.json?auth=${encodeURIComponent(token)}`, {
            method, headers: { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
    }
    async createGroup(name) {
        name = name.trim();
        if (!name || name.length > 80) throw new Error("Название группы: от 1 до 80 символов");
        await this.token();
        await this.listGroups();
        const id = randomId();
        for(let attempt=0;attempt<3;attempt++) {
        const slots=await this.request(`ownerSlots/${this.session.uid}`)||{};
        let n=0;while(n<MAX_OWNED_GROUPS && slots[`g${n}`])n++;
        if(n===MAX_OWNED_GROUPS)throw Error("Можно владеть не более чем 5 группами. Удалите ненужную группу.");
        const ownerSlot=`g${n}`;
        const group = {
            name, owner: this.session.uid, ownerSlot, inviteSecret: randomId(), createdAt: { ".sv": "timestamp" },
            members: { [this.session.uid]: "owner" }
        };
        try { await this.request("", "PATCH", { [`groups/${id}`]: group, [`userGroups/${this.session.uid}/${id}`]: true, [`ownerSlots/${this.session.uid}/${ownerSlot}`]:id }); }
        catch(error){if(attempt<2&&[401,403].includes(error.status))continue;throw error;}
        return id;
        }
    }
    async migrateOwnedGroup(id,group) {
        if(group.owner!==this.session.uid || group.ownerSlot)return;
        const slots=await this.request(`ownerSlots/${this.session.uid}`)||{};
        let n=0;while(n<MAX_OWNED_GROUPS&&slots[`g${n}`]&&slots[`g${n}`]!==id)n++;
        if(n===MAX_OWNED_GROUPS)throw Error("Не удалось перенести старые группы: лимит 5 групп владельца.");
        await this.request("","PATCH",{[`groups/${id}/ownerSlot`]:`g${n}`,[`ownerSlots/${this.session.uid}/g${n}`]:id});
    }
    async joinGroup(invite) {
        const [id, secret, extra] = invite.trim().split(".");
        if (!/^[a-f0-9]{48}$/.test(id) || !/^[a-f0-9]{48}$/.test(secret) || extra !== undefined) throw new Error("Неверный код приглашения");
        await this.token();
        try {
            if (await this.readGroup(id)) { await this.indexGroup(id); return id; }
        } catch (error) {
            if (![401, 403].includes(error.status)) throw error;
        }
        await this.request("", "PATCH", { [`groups/${id}/members/${this.session.uid}`]: secret, [`userGroups/${this.session.uid}/${id}`]: true });
        return id;
    }
    indexGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`userGroups/${this.session.uid}/${id}`, "PUT", true);
    }
    async listGroups(knownIds = []) {
        await this.token();
        const index = await this.request(`userGroups/${this.session.uid}`) || {};
        // Migrate groups saved by older versions without exposing a global directory.
        for (const id of knownIds.filter(validKey)) {
            if (index[id]) continue;
            try {
                const group = await this.readGroup(id);
                if (!group?.members?.[this.session.uid]) continue;
                await this.indexGroup(id); index[id] = true;
            } catch (error) { if (![401,403].includes(error.status)) throw error; }
        }
        for(const id of Object.keys(index).filter(validKey)) {
            try { const group=await this.readGroup(id);if(group)await this.migrateOwnedGroup(id,group); }
            catch(error){if(![401,403].includes(error.status))throw error;}
        }
        return Object.keys(index).filter(validKey);
    }
    forgetGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`userGroups/${this.session.uid}/${id}`, "DELETE");
    }
    async deleteGroup(id) {
        const group = await this.readGroup(id);
        if (!group) return this.forgetGroup(id);
        if (group.owner !== this.session.uid) throw new Error("Удалить группу может только владелец");
        const changes = { [`groups/${id}`]: null };
        if(group.ownerSlot)changes[`ownerSlots/${this.session.uid}/${group.ownerSlot}`]=null;
        for (const uid of Object.keys(group.members || {}).filter(validKey)) changes[`userGroups/${uid}/${id}`] = null;
        return this.request("", "PATCH", changes);
    }
    readGroup(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`groups/${id}`);
    }
    async card(groupId, userId, type) {
        if (!validKey(groupId) || !snowflake(userId) || !["red", "yellow", null].includes(type)) throw new Error("Неверная карточка");
        return this.writeCards(groupId,[userId],type);
    }
    async writeCards(groupId,ids,type="red") {
        if(!validKey(groupId)||!Array.isArray(ids)||ids.some(id=>!snowflake(id))||!["red","yellow",null].includes(type))throw Error("Некорректный список карточек");
        ids=[...new Set(ids)];
        for(let attempt=0;attempt<3;attempt++) {
            const group=await this.readGroup(groupId);
            if(!group?.members?.[this.session.uid])throw Error("Вы не участник группы");
            const allocated=allocateTargets(group,type?ids:[]),changes=allocated.changes;
            for(const id of ids) {
                // Import red cards without changing existing red-card timestamps.
                if(type && group.cards?.[id]?.[this.session.uid]?.type===type)continue;
                changes[`cards/${id}/${this.session.uid}`]=type?{type,updatedAt:{".sv":"timestamp"}}:null;
                if(!type && !Object.keys(group.cards?.[id]||{}).some(uid=>uid!==this.session.uid)) {
                    const slot=allocated.targets[id];
                    if(slot){changes[`slots/${slot}`]=null;changes[`targetSlots/${id}`]=null;}
                }
            }
            if(!Object.keys(changes).length)return;
            try{return await this.request(`groups/${groupId}`,"PATCH",changes);}
            catch(error){if(attempt<2&&[401,403].includes(error.status))continue;throw error;}
        }
    }
    rotateInvite(id) {
        if (!validKey(id)) throw new Error("Неверный ID группы");
        return this.request(`groups/${id}/inviteSecret`, "PUT", randomId());
    }
    removeMember(id, uid, rotate = false) {
        if (!validKey(id) || !validKey(uid)) throw new Error("Неверный ID");
        const changes = { [`groups/${id}/members/${uid}`]: null, [`userGroups/${uid}/${id}`]: null };
        if (rotate) changes[`groups/${id}/inviteSecret`] = randomId();
        return this.request("", "PATCH", changes);
    }
}

module.exports = { FirebaseClient, validateConfig };
