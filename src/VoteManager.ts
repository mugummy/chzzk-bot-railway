import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';
import { v4 as uuidv4 } from 'uuid';

/**
 * VoteManager: 실시간 투표 및 데이터 집계를 관리합니다.
 */
export class VoteManager {
    private currentVote: any = null;
    private onStateChangeCallback: () => void = () => {};
    private timer: NodeJS.Timeout | null = null;

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() { this.onStateChangeCallback(); }

    public setCurrentVote(vote: any) { this.currentVote = vote; }

    public createVote(question: string, options: string[], settings: any) {
        this.currentVote = {
            id: uuidv4(),
            question,
            options: options.map((text, i) => ({ id: String(i + 1), text })),
            results: options.reduce((acc, _, i) => ({ ...acc, [String(i + 1)]: 0 }), {}),
            voters: [],
            isActive: false,
            settings: { ...settings, donationWeight: Math.max(1, settings.donationWeight || 100) },
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

    public endVote() {
        if (!this.currentVote?.isActive) return;
        this.currentVote.isActive = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
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
}
