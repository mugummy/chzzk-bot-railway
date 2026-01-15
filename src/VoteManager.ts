import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { supabase } from './supabase';

export interface VoteOption {
    id: string;
    text: string;
}

export interface Voter {
    userIdHash: string;
    nickname: string;
    optionId: string;
}

export interface VoteSession {
    id: string;
    question: string;
    options: VoteOption[];
    results: { [optionId: string]: number };
    isActive: boolean;
    settings: any;
    startTime: number | null;
    endTime: number | null;
    totalVotes: number;
    voters: Voter[];
}

export class VoteManager {
    private currentVote: VoteSession | null = null;
    private voteHistory: VoteSession[] = [];
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        this.bot.saveAll();
    }

    public setCurrentVote(vote: VoteSession) {
        this.currentVote = vote;
    }

    public createVote(question: string, options: VoteOption[], settings: any) {
        if (!question || !options || options.length < 2) return;

        this.currentVote = {
            id: `vote_${Date.now()}`,
            question,
            options,
            results: options.reduce((acc, opt) => ({ ...acc, [opt.id]: 0 }), {}),
            isActive: false,
            settings,
            startTime: null,
            endTime: null,
            totalVotes: 0,
            voters: []
        };
        this.notify(); // 즉시 알림
    }

    public startVote() {
        if (this.currentVote) {
            this.currentVote.isActive = true;
            this.currentVote.startTime = Date.now();
            this.notify();
            if (this.bot.chat && this.bot.chat.connected) {
                const opts = this.currentVote.options.map((o, i) => `${i+1}. ${o.text}`).join(' / ');
                this.bot.chat.sendChat(`📊 투표 시작: ${this.currentVote.question} [ ${opts} ]`);
            }
        }
    }

    public async endVote() {
        if (this.currentVote) {
            this.currentVote.isActive = false;
            this.currentVote.endTime = Date.now();
            
            // DB 저장
            if (this.currentVote.voters.length > 0) {
                try {
                    const payload = this.currentVote.voters.map(v => ({
                        channel_id: this.bot.getChannelId(),
                        vote_id: this.currentVote!.id,
                        user_id_hash: v.userIdHash,
                        nickname: v.nickname,
                        option_id: v.optionId
                    }));
                    await supabase.from('vote_logs').insert(payload);
                } catch (e) {}
            }

            // 기록 이동
            this.voteHistory.unshift({ ...this.currentVote });
            if (this.voteHistory.length > 50) this.voteHistory.pop();
            
            if (this.bot.chat && this.bot.chat.connected) {
                this.bot.chat.sendChat(`📊 투표 종료! 총 ${this.currentVote.totalVotes}표`);
            }
            
            this.currentVote = null;
            this.notify();
        }
    }

    public resetVote() {
        this.currentVote = null;
        this.notify();
    }

    public deleteHistory(voteId: string) {
        this.voteHistory = this.voteHistory.filter(v => v.id !== voteId);
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const msg = chat.message.trim();
        const optionIndex = parseInt(msg) - 1;
        
        if (!isNaN(optionIndex) && this.currentVote.options[optionIndex]) {
            const userId = chat.profile.userIdHash;
            if (!this.currentVote.voters.some(v => v.userIdHash === userId)) {
                const optionId = this.currentVote.options[optionIndex].id;
                this.currentVote.results[optionId]++;
                this.currentVote.totalVotes++;
                this.currentVote.voters.push({
                    userIdHash: userId,
                    nickname: chat.profile.nickname,
                    optionId: optionId
                });
                this.notify();
            }
        }
    }

    public async handleDonation(donation: DonationEvent) {}

    public getState() { 
        return { 
            currentVote: this.currentVote,
            history: this.voteHistory 
        }; 
    }
    
    public getVoters(voteId?: string) {
        if (!voteId && this.currentVote) return this.currentVote.voters;
        if (voteId) {
            const pastVote = this.voteHistory.find(v => v.id === voteId);
            return pastVote ? pastVote.voters : [];
        }
        return [];
    }
}
