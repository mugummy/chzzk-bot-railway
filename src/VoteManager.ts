import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface VoteState {
    voteId: string | null;
    title: string;
    items: { id: number; name: string; count: number; voters: any[]; dbId?: string }[];
    status: 'idle' | 'active' | 'ended';
    mode: 'numeric' | 'donation';
    timer: number; // seconds
    allowMultiVote: boolean; // 복수 투표 허용 여부
    showOverlay: boolean;
    voteUnit: number; // 후원 투표 시 1표당 금액
}

export interface DrawState {
    sessionId: string | null;
    status: 'idle' | 'recruiting' | 'picking' | 'ended';
    keyword: string;
    candidates: { name: string; role: string; lastMessage: string }[];
    winner: any | null;
    previousWinners: string[];
    timer: number;
    showOverlay: boolean;
    subsOnly: boolean;
}

export interface RouletteState {
    items: { name: string; weight: number }[];
    activeItems: { name: string; weight: number }[]; // 실제로 돌아가는 항목 (수동 조작 시)
    isSpinning: boolean;
    winner: string | null;
    rotation: number;
    transition: string;
    showOverlay: boolean;
}

export class VoteManager {
    // Current In-Memory State (Synced via WebSocket)
    private voteState: VoteState = {
        voteId: null, title: '', items: [], status: 'idle', mode: 'numeric', timer: 0,
        allowMultiVote: false, showOverlay: false, voteUnit: 1000
    };
    private drawState: DrawState = {
        sessionId: null, status: 'idle', keyword: '!참여', candidates: [], winner: null, previousWinners: [],
        timer: 0, showOverlay: false, subsOnly: false
    };
    private rouletteState: RouletteState = {
        items: [], activeItems: [], isSpinning: false, winner: null, rotation: 0, transition: 'none', showOverlay: false
    };

    private intervals: { vote?: NodeJS.Timeout, draw?: NodeJS.Timeout } = {};

    constructor(private bot: BotInstance) {
        this.loadActiveState();
    }

    private async loadActiveState() {
        const channelId = this.bot.getChannelId();

        // 1. Load Active Vote
        try {
            const { data: vote } = await supabase.from('votes').select('*, vote_options(*)')
                .eq('channel_id', channelId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).single();

            if (vote) {
                // Restore Vote
                const { data: ballots } = await supabase.from('vote_ballots').select('*').eq('vote_id', vote.id);
                const options = (vote.vote_options || []).sort((a: any, b: any) => a.position - b.position);

                this.voteState = {
                    voteId: vote.id,
                    title: vote.title,
                    items: options.map((o: any, idx: number) => {
                        const oBallots = ballots?.filter((b: any) => b.option_id === o.id) || [];
                        const count = oBallots.reduce((sum: number, b: any) => sum + (b.weight || 1), 0);
                        const voters = oBallots.map((b: any) => ({ nickname: b.nickname, userId: b.user_id_hash }));
                        return { id: idx + 1, name: o.label, count, voters, dbId: o.id };
                    }),
                    status: 'active',
                    mode: vote.mode === 'chat' ? 'numeric' : 'donation',
                    timer: 0, // Timer reset on restart (can't easily sync exact seconds without complex diff)
                    allowMultiVote: vote.allow_multiple,
                    showOverlay: true,
                    voteUnit: 1000 // Default
                };
            }
        } catch (e) {
            console.error('[VoteManager] Load Vote Error:', e);
        }

        // 2. Load Active Draw
        try {
            const { data: draw } = await supabase.from('draw_sessions').select('*')
                .eq('channel_id', channelId).in('status', ['recruiting', 'picking']).order('created_at', { ascending: false }).limit(1).single();

            if (draw) {
                const { data: parts } = await supabase.from('draw_participants').select('*').eq('session_id', draw.id);
                this.drawState = {
                    sessionId: draw.id,
                    status: draw.status as any,
                    keyword: draw.keyword,
                    candidates: (parts || []).map((p: any) => ({ name: p.nickname, role: p.role, lastMessage: '' })),
                    winner: null,
                    // Typically do not load previous winners from old session if this is fresh init, 
                    // but if restoring session, we might want to check DB for past winners in this session? 
                    // For now, keep empty on restart to avoid complexity unless user complains.
                    previousWinners: [],
                    timer: 0,
                    showOverlay: true,
                    subsOnly: draw.subs_only
                };
            }
        } catch (e) {
            console.error('[VoteManager] Load Draw Error:', e);
        }

        // 3. Load Roulette Items
        try {
            const { data: rItems } = await supabase.from('roulette_items').select('*').eq('channel_id', channelId).order('position');
            if (rItems && rItems.length > 0) {
                const items = rItems.map((i: any) => ({ name: i.label, weight: i.weight }));
                this.rouletteState.items = items;
                this.rouletteState.activeItems = [...items];
            }
        } catch (e) {
            console.error('[VoteManager] Load Roulette Error:', e);
        }

        this.broadcast();
    }

    // ==========================================
    // Public Accessors & Sync
    // ==========================================
    public getStates() {
        return {
            vote: this.voteState,
            draw: this.drawState,
            roulette: this.rouletteState
        };
    }

    private broadcast() {
        // Broadcast full state to Dashboard & Overlay
        // 'voteSync' event
        this.bot.broadcast('voteSync', this.getStates());
    }

    // ==========================================
    // VOTE SYSTEM
    // ==========================================
    public async startVote(title: string, mode: 'numeric' | 'donation', items: string[], duration: number, allowMulti: boolean, unit: number = 1000) {
        // [DB] Insert Vote
        let dbVoteId: string | null = null;
        let dbOptionIds: string[] = [];

        try {
            // status in SQL: pending | active | ended
            // mode: chat | donation
            const { data: voteData } = await supabase.from('votes').insert({
                channel_id: this.bot.getChannelId(),
                title,
                mode: mode === 'numeric' ? 'chat' : 'donation',
                status: 'active',
                allow_multiple: allowMulti,
                started_at: new Date().toISOString()
            }).select().single();

            if (voteData) dbVoteId = voteData.id;

            if (dbVoteId && items.length > 0) {
                const { data: optData } = await supabase.from('vote_options').insert(
                    items.map((label, idx) => ({ vote_id: dbVoteId, label, position: idx }))
                ).select();

                if (optData) {
                    // Sort to match index
                    dbOptionIds = optData.sort((a, b) => a.position - b.position).map(o => o.id);
                }
            }
        } catch (e) { console.error('[VoteManager] DB Error:', e); }

        this.voteState = {
            voteId: dbVoteId || `vote_${Date.now()}`,
            title,
            items: items.map((name, idx) => ({
                id: idx + 1,
                name,
                count: 0,
                voters: [],
                dbId: dbOptionIds[idx]
            })),
            status: 'active',
            mode,
            timer: duration,
            allowMultiVote: allowMulti,
            showOverlay: true,
            voteUnit: unit
        };

        if (this.intervals.vote) clearInterval(this.intervals.vote);
        if (duration > 0) {
            this.intervals.vote = setInterval(() => {
                if (this.voteState.timer > 0) {
                    this.voteState.timer--;
                    if (this.voteState.timer % 5 === 0) this.broadcast();
                } else {
                    this.endVote();
                }
            }, 1000);
        }
        this.broadcast();
    }

    public async endVote() {
        if (this.voteState.status !== 'active') return;
        this.voteState.status = 'ended';
        if (this.intervals.vote) clearInterval(this.intervals.vote);

        // [DB] Update Status
        if (this.voteState.voteId && !this.voteState.voteId.startsWith('vote_')) {
            await supabase.from('votes').update({
                status: 'ended',
                ended_at: new Date().toISOString()
            }).eq('id', this.voteState.voteId);
        }

        this.broadcast();
    }

    public stopVote() {
        this.voteState.status = 'idle';
        this.voteState.voteId = null;
        this.voteState.showOverlay = false;
        if (this.intervals.vote) clearInterval(this.intervals.vote);
        this.broadcast();
    }

    public toggleVoteOverlay(show: boolean) {
        this.voteState.showOverlay = show;
        this.broadcast();
    }

    public handleVoteMessage(chat: ChatEvent) {
        if (this.voteState.status !== 'active' || this.voteState.mode !== 'numeric') return;

        const msg = chat.message.trim();
        if (msg.startsWith('!투표')) {
            const numStr = msg.replace('!투표', '').trim();
            const num = parseInt(numStr);
            if (!isNaN(num)) {
                this.recordVote(num, 1, chat.profile.nickname, chat.profile.userIdHash || 'anon', msg);
            }
        }
    }

    public updateSettings(title: string) {
        this.voteState.title = title;
        // Optionally update DB if active?
        this.broadcast();
    }

    public resetVote() {
        this.voteState = {
            ...this.voteState,
            status: 'idle',
            voteId: null,
            items: [],
            title: '',
            showOverlay: false
        };
        this.broadcast();
    }

    public transferVotesToRoulette() {
        const items = this.voteState.items
            .filter(i => i.count > 0)
            .map(i => ({ name: i.name, weight: i.count }));

        if (items.length === 0) return;

        this.updateRouletteItems(items);
    }

    public handleVoteDonation(donation: DonationEvent) {
        if (this.voteState.status !== 'active' || this.voteState.mode !== 'donation') return;

        const msg = (donation.message || '').trim();
        const amount = donation.extras?.payAmount || 0;
        const votes = Math.floor(amount / this.voteState.voteUnit);

        const match = msg.match(/^!투표\s*(\d+)/);
        if (votes >= 1 && match) {
            const num = parseInt(match[1]);
            this.recordVote(num, votes, donation.profile?.nickname || 'Anon', donation.profile?.userIdHash || 'anon', msg);
        }
    }

    private recordVote(itemIdx: number, weight: number, nickname: string, userId: string, msg: string) {
        const item = this.voteState.items.find(i => i.id === itemIdx);
        if (!item) return;

        // Check Duplicates if not allowed
        if (!this.voteState.allowMultiVote) {
            const alreadyVoted = this.voteState.items.some(i => i.voters.some(v => v.userId === userId));
            if (alreadyVoted) return;
        }

        item.count += weight;
        for (let i = 0; i < weight; i++) {
            item.voters.push({ nickname, userId, msg });
        }

        // [DB] Insert Ballot
        if (this.voteState.voteId && item.dbId) {
            supabase.from('vote_ballots').insert({
                vote_id: this.voteState.voteId,
                option_id: item.dbId,
                user_id_hash: userId,
                nickname,
                weight
            }).then(({ error }) => { if (error) console.error('Ballot Insert Error:', error); });
        }

        this.broadcast();
    }

    // ==========================================
    // DRAW SYSTEM (Viewer Pickup)
    // ==========================================
    public async startDrawRecruit(keyword: string, subsOnly: boolean, duration: number) {
        let dbSessionId: string | null = null;
        try {
            const { data } = await supabase.from('draw_sessions').insert({
                channel_id: this.bot.getChannelId(),
                keyword,
                subs_only: subsOnly,
                status: 'recruiting',
                created_at: new Date().toISOString()
            }).select().single();
            if (data) dbSessionId = data.id;
        } catch (e) { }

        this.drawState = {
            sessionId: dbSessionId || `draw_${Date.now()}`,
            status: 'recruiting',
            keyword,
            candidates: [],
            winner: null,
            previousWinners: [], // New draws start fresh usually
            timer: duration,
            showOverlay: true,
            subsOnly
        };

        if (this.intervals.draw) clearInterval(this.intervals.draw);
        if (duration > 0) {
            this.intervals.draw = setInterval(() => {
                if (this.drawState.timer > 0) {
                    this.drawState.timer--;
                    if (this.drawState.timer % 5 === 0) this.broadcast();
                } else {
                    if (this.intervals.draw) clearInterval(this.intervals.draw);
                    this.broadcast();
                }
            }, 1000);
        }
        this.broadcast();
    }

    public handleDrawMessage(chat: ChatEvent) {
        if (this.drawState.status !== 'recruiting') return;

        const msg = chat.message.trim();
        if (this.drawState.keyword && !msg.startsWith(this.drawState.keyword)) return;

        const role = (chat.extras?.extraToken as any)?.streamingProperty?.subscription ? '구독자' : '팬';
        if (this.drawState.subsOnly && role !== '구독자') return;

        const exists = this.drawState.candidates.find(c => c.name === chat.profile.nickname);
        if (!exists) {
            // Check Previous Winners Exclusion (TODO: if enable flag is true)
            // For now, always exclude
            if (this.drawState.previousWinners.includes(chat.profile.nickname)) return;

            this.drawState.candidates.push({ name: chat.profile.nickname, role, lastMessage: msg });

            // [DB] Insert
            if (this.drawState.sessionId && !this.drawState.sessionId.startsWith('draw_')) {
                supabase.from('draw_participants').insert({
                    session_id: this.drawState.sessionId,
                    user_id_hash: chat.profile.userIdHash || 'anon',
                    nickname: chat.profile.nickname,
                    role
                }).then(({ error }) => { if (error) console.error('Draw Part Insert Error:', error); });
            }
            this.broadcast();
        }
    }

    public async pickDrawWinner(count: number = 1) {
        if (this.drawState.candidates.length === 0) return;
        this.drawState.status = 'picking';

        // Filter out previous winners just in case
        const pool = this.drawState.candidates.filter(c => !this.drawState.previousWinners.includes(c.name));

        if (pool.length === 0) {
            // No valid candidates
            return;
        }

        const index = Math.floor(Math.random() * pool.length);
        const winner = pool[index];
        this.drawState.winner = winner;
        this.drawState.previousWinners.push(winner.name);
        this.drawState.status = 'ended';

        // [DB] Update Winner
        if (this.drawState.sessionId && !this.drawState.sessionId.startsWith('draw_')) {
            await supabase.from('draw_sessions').update({
                status: 'ended',
                winner_nickname: winner.name,
                ended_at: new Date().toISOString()
            }).eq('id', this.drawState.sessionId);
        }

        this.broadcast();
    }

    public undoLastWinner() {
        if (this.drawState.winner) {
            const nickname = this.drawState.winner.name;
            const idx = this.drawState.previousWinners.indexOf(nickname);
            if (idx > -1) this.drawState.previousWinners.splice(idx, 1); // Remove from history so they can win again?
            // Actually, if we undo, we probably want to *allow* them to be picked again OR just re-roll.
            // If we remove from history, they are eligible again.

            this.drawState.winner = null;
            this.drawState.status = 'recruiting'; // Go back to state that allows actions
            this.broadcast();
        }
    }

    public stopDraw() {
        this.drawState.status = 'idle';
        this.drawState.showOverlay = false;
        if (this.intervals.draw) clearInterval(this.intervals.draw);
        this.broadcast();
    }

    public resetDraw() {
        this.drawState = {
            ...this.drawState,
            status: 'idle',
            sessionId: null,
            candidates: [],
            winner: null,
            previousWinners: [],
            showOverlay: false
        };
        this.broadcast();
    }

    public toggleDrawOverlay(show: boolean) {
        this.drawState.showOverlay = show;
        this.broadcast();
    }

    // ==========================================
    // ROULETTE SYSTEM
    // ==========================================
    public async updateRouletteItems(items: { name: string; weight: number }[]) {
        const channelId = this.bot.getChannelId();
        // [DB] Sync: Delete Old -> Insert New
        await supabase.from('roulette_items').delete().eq('channel_id', channelId);

        if (items.length > 0) {
            await supabase.from('roulette_items').insert(
                items.map((i, idx) => ({
                    channel_id: channelId,
                    label: i.name,
                    weight: i.weight,
                    position: idx
                }))
            );
        }

        this.rouletteState.items = items;
        if (!this.rouletteState.isSpinning) {
            this.rouletteState.activeItems = [...items];
        }
        this.broadcast();
    }

    public spinRoulette() {
        if (this.rouletteState.isSpinning) return;

        if (this.rouletteState.activeItems.length < 2) {
            if (this.rouletteState.items.length < 2) return;
            this.rouletteState.activeItems = [...this.rouletteState.items];
        }

        this.rouletteState.isSpinning = true;
        this.rouletteState.showOverlay = true;
        this.rouletteState.winner = null;

        const items = this.rouletteState.activeItems;
        const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
        let random = Math.random() * totalWeight;
        let winnerIndex = 0;
        for (let i = 0; i < items.length; i++) {
            random -= items[i].weight;
            if (random <= 0) { winnerIndex = i; break; }
        }

        // [Physics Logic]
        let weightAccum = 0;
        for (let i = 0; i < winnerIndex; i++) weightAccum += items[i].weight;

        const segmentAngle = (items[winnerIndex].weight / totalWeight) * 360;
        const randomOffset = (Math.random() - 0.5) * (segmentAngle * 0.8);
        const winnerCenterAngle = ((weightAccum / totalWeight) * 360) + (segmentAngle / 2) + randomOffset;

        const spins = 10;
        const currentRot = this.rouletteState.rotation;
        // Target Rotation Calculation matches Vue logic
        const targetRot = Math.floor(currentRot / 360) * 360 - (360 * spins) - winnerCenterAngle;

        this.rouletteState.rotation = targetRot;
        this.rouletteState.transition = 'transform 4s cubic-bezier(0.2, 0.8, 0.2, 1)';

        this.broadcast();

        setTimeout(() => {
            this.rouletteState.winner = items[winnerIndex].name;
            this.rouletteState.isSpinning = false;
            this.broadcast();
        }, 4000);
    }

    public resetRoulette() {
        this.rouletteState.isSpinning = false;
        this.rouletteState.winner = null;
        this.rouletteState.showOverlay = false;
        this.broadcast();
    }

    public toggleRouletteOverlay(show: boolean) {
        this.rouletteState.showOverlay = show;
        this.broadcast();
    }
}
