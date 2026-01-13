import { ChatEvent, ChzzkChat, DonationEvent } from 'chzzk';
import { ChatBot } from './Bot';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from './supabase';

export interface VoteOption {
    id: string;
    text: string;
}

export interface VoteSettings {
    mode: 'any' | 'command';
    allowDonation: boolean;
    donationWeight: number;
    subscriberOnly: boolean;
    duration: number;
}

export class VoteManager {
    private currentVote: any = null;
    private votes: any[] = [];
    private onStateChangeCallback: () => void = () => {};
    private timer: NodeJS.Timeout | null = null;

    constructor(private bot: ChatBot) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        this.saveToDB();
    }

    private async saveToDB() {
        if (!this.bot.getChannelId()) return;
        await supabase.from('channels').update({ current_vote: this.currentVote }).eq('channel_id', this.bot.getChannelId());
    }

    public setCurrentVote(vote: any) {
        this.currentVote = vote;
    }

    public createVote(question: string, options: string[], settings: VoteSettings) {
        this.currentVote = {
            id: uuidv4(),
            question,
            options: options.map((text, i) => ({ id: String(i + 1), text })),
            results: options.reduce((acc, _, i) => ({ ...acc, [String(i + 1)]: 0 }), {}),
            voters: [],
            isActive: false,
            settings: {
                ...settings,
                donationWeight: Math.max(1, settings.donationWeight || 100) // 0으로 나누기 방지
            },
            startTime: null,
            totalVotes: 0
        };
        this.notify();
    }

    public startVote() {
        if (!this.currentVote || this.currentVote.isActive) return;
        this.currentVote.isActive = true;
        this.currentVote.startTime = Date.now();
        if (this.currentVote.settings.duration > 0) {
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => this.endVote(), this.currentVote.settings.duration * 1000);
        }
        this.notify();
    }

    public async endVote() {
        if (!this.currentVote?.isActive) return;
        this.currentVote.isActive = false;
        this.currentVote.endTime = Date.now();
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }

        await supabase.from('votes').insert({
            channel_id: this.bot.getChannelId(),
            question: this.currentVote.question,
            options: this.currentVote.options,
            results: this.currentVote.results,
            settings: this.currentVote.settings,
            total_votes: this.currentVote.totalVotes,
            ended_at: new Date().toISOString()
        });

        this.notify();
    }

    public resetVote() {
        this.currentVote = null;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.notify();
    }

    public async handleChat(chat: ChatEvent) {
        if (!this.currentVote?.isActive) return;
        const userId = chat.profile.userIdHash;
        if (this.currentVote.voters.includes(userId)) return;
        if (this.currentVote.settings.subscriberOnly && !chat.profile.badge?.imageUrl?.includes('subscribe')) return;

        const msg = chat.message.trim();
        let choice = "";
        if (this.currentVote.settings.mode === 'any') {
            const match = msg.match(/\d+/);
            if (match) choice = match[0];
        } else if (msg.startsWith('!')) {
            const match = msg.match(/^\!(\d+)$/);
            if (match) choice = match[1];
        }

        if (choice && this.currentVote.results[choice] !== undefined) {
            this.currentVote.results[choice]++;
            this.currentVote.totalVotes++;
            this.currentVote.voters.push(userId);
            this.notify();
        }
    }

    public async handleDonation(donation: DonationEvent) {
        if (!this.currentVote?.isActive || !this.currentVote.settings.allowDonation) return;
        const msg = donation.message?.trim() || "";
        const match = msg.match(/\d+/);
        if (match) {
            const choice = match[0];
            if (this.currentVote.results[choice] !== undefined) {
                const weight = Math.floor(donation.payAmount / this.currentVote.settings.donationWeight);
                if (weight > 0) {
                    this.currentVote.results[choice] += weight;
                    this.currentVote.totalVotes += weight;
                    this.notify();
                }
            }
        }
    }

    public getState() { return { currentVote: this.currentVote }; }
    public getVotes() { return this.votes; }
}
