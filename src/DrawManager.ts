import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawCandidate {
    userIdHash: string;
    nickname: string;
    source: 'chat' | 'donation' | 'vote';
}

export class DrawManager {
    private candidates: Map<string, DrawCandidate> = new Map();
    private settings: any = { mode: 'chat', chatType: 'command', chatCommand: '!추첨', donationType: 'all', donationAmount: 1000 };
    private isRolling: boolean = false;
    private winners: DrawCandidate[] = [];
    private onStateChangeCallback: () => void = () => {};

    constructor(private bot: BotInstance) {}

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        this.bot.saveAll();
    }

    public startSession(settings: any) {
        this.candidates.clear();
        this.winners = [];
        this.settings = { ...this.settings, ...settings };
        this.notify();
        
        if (this.bot.chat && this.bot.chat.connected) {
            let msg = `🎰 추첨 모집 시작! `;
            if (this.settings.mode === 'chat') {
                msg += this.settings.chatType === 'any' ? "아무 채팅이나 치면 참가!" : `'${this.settings.chatCommand}' 입력 시 참가!`;
            } else {
                msg += this.settings.donationType === 'all' ? "후원 시 자동 참가!" : `${this.settings.donationAmount}치즈 후원 시 참가!`;
            }
            this.bot.chat.sendChat(msg);
        }
    }

    public injectCandidatesFromVote(voters: any[]) {
        this.candidates.clear();
        voters.forEach(v => {
            this.candidates.set(v.userIdHash, {
                userIdHash: v.userIdHash,
                nickname: v.nickname,
                source: 'vote'
            });
        });
        this.notify();
    }

    public handleChat(chat: ChatEvent) {
        if (this.settings.mode !== 'chat' || this.isRolling) return;
        if (chat.profile.userIdHash === this.bot.getChannelId()) return;

        let isValid = false;
        if (this.settings.chatType === 'any') isValid = true;
        else if (this.settings.chatType === 'command' && chat.message.trim() === this.settings.chatCommand) isValid = true;

        if (isValid && !this.candidates.has(chat.profile.userIdHash)) {
            this.candidates.set(chat.profile.userIdHash, {
                userIdHash: chat.profile.userIdHash,
                nickname: chat.profile.nickname,
                source: 'chat'
            });
            this.notify();
        }
    }

    public handleDonation(donation: DonationEvent) {
        if (this.settings.mode !== 'donation' || this.isRolling) return;

        let isValid = false;
        if (this.settings.donationType === 'all') isValid = true;
        else if (this.settings.donationType === 'specific' && donation.payAmount === this.settings.donationAmount) isValid = true;

        if (isValid && !this.candidates.has(donation.profile.userIdHash)) {
            this.candidates.set(donation.profile.userIdHash, {
                userIdHash: donation.profile.userIdHash,
                nickname: donation.profile.nickname,
                source: 'donation'
            });
            this.notify();
        }
    }

    public draw(count: number = 1) {
        const pool = Array.from(this.candidates.values());
        if (pool.length === 0) return;

        this.isRolling = true;
        this.winners = [];
        this.notify();

        // 3초간 슬롯머신 애니메이션 (대시보드/오버레이 동기화)
        setTimeout(() => {
            this.isRolling = false;
            // 피셔-예이츠 셔플
            const shuffled = [...pool];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            this.winners = shuffled.slice(0, Math.min(count, shuffled.length));
            this.notify();

            if (this.winners.length > 0 && this.bot.chat && this.bot.chat.connected) {
                const names = this.winners.map(w => w.nickname).join(', ');
                this.bot.chat.sendChat(`🎉 [추첨 결과] 당첨자: [ ${names} ] 축하드립니다!`);
            }
        }, 3000);
    }

    public reset() {
        this.candidates.clear();
        this.winners = [];
        this.isRolling = false;
        this.notify();
    }

    public getState() {
        return {
            candidatesCount: this.candidates.size,
            candidates: Array.from(this.candidates.values()).slice(-10),
            settings: this.settings,
            isRolling: this.isRolling,
            winners: this.winners
        };
    }
}