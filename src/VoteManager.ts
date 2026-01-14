import { ChatEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface VoteSession {
    id: string;
    question: string;
    options: any[];
    results: { [id: string]: number };
    isActive: boolean;
    totalVotes: number;
    voters: any[];
}

export class VoteManager {
    private currentVote: VoteSession | null = null;
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        this.bot.saveAll();
    }

    public setCurrentVote(vote: any) { this.currentVote = vote; }

    public createVote(question: string, options: any[]) {
        this.currentVote = {
            id: `vote_${Date.now()}`,
            question,
            options,
            results: options.reduce((acc, opt) => ({ ...acc, [opt.id]: 0 }), {}),
            isActive: false,
            totalVotes: 0,
            voters: []
        };
        this.notify();
    }

    public startVote() {
        if (this.currentVote) {
            this.currentVote.isActive = true;
            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 시작: ${this.currentVote.question}`);
        }
    }

    public async endVote() {
        if (this.currentVote) {
            this.currentVote.isActive = false;
            if (this.currentVote.voters.length > 0) {
                const logs = this.currentVote.voters.map(v => ({ channel_id: this.bot.getChannelId(), vote_id: this.currentVote!.id, user_id_hash: v.userIdHash, nickname: v.nickname, option_id: v.optionId }));
                await supabase.from('vote_logs').insert(logs);
            }
            this.notify();
            if (this.bot.chat) this.bot.chat.sendChat(`📊 투표 종료! 총 ${this.currentVote.totalVotes}표 집계되었습니다.`);
        }
    }

    public resetVote() {
        this.currentVote = null;
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const msg = chat.message.trim();
        const index = parseInt(msg) - 1;
        if (!isNaN(index) && this.currentVote.options[index]) {
            const userId = chat.profile.userIdHash;
            if (!this.currentVote.voters.some(v => v.userIdHash === userId)) {
                const optId = this.currentVote.options[index].id;
                this.currentVote.results[optId]++;
                this.currentVote.totalVotes++;
                this.currentVote.voters.push({ userIdHash: userId, nickname: chat.profile.nickname, optionId: optId });
                this.notify();
            }
        }
    }

    public getState() { return { currentVote: this.currentVote }; }
    public getVoters() { return this.currentVote?.voters || []; }
}
