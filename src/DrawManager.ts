import { ChatEvent, DonationEvent } from 'chzzk';
import { BotInstance } from './BotInstance';

export interface DrawCandidate {
    userIdHash: string;
    nickname: string;
    source: 'chat' | 'donation' | 'vote';
}

export class DrawManager {
    private candidates: Map<string, DrawCandidate> = new Map();
    private settings: any = { mode: 'chat', chatType: 'command', chatCommand: '!참가', donationType: 'all', donationAmount: 1000 };
    private isRolling: boolean = false;
    private isActive: boolean = false;
    private winners: DrawCandidate[] = [];
    private onStateChangeCallback: () => void = () => {};

    // [수정] 초기 데이터 로드
    constructor(private bot: BotInstance, initialData?: any) {
        if (initialData) {
            this.isActive = initialData.isActive || false;
            this.settings = initialData.settings || this.settings;
            // Map 복구 (JSON 배열 -> Map)
            if (Array.isArray(initialData.candidates)) {
                initialData.candidates.forEach((c: any) => this.candidates.set(c.userIdHash, c));
            }
        }
    }

    public setOnStateChangeListener(callback: () => void) {
        this.onStateChangeCallback = callback;
    }

    private notify() {
        this.onStateChangeCallback();
        // 중요한 상태 변경 시 저장 트리거 (BotInstance.saveAll 호출됨)
        this.bot.saveAll();
    }

    public startSession(settings: any) {
        this.candidates.clear();
        this.winners = [];
        this.isActive = true;
        this.isRolling = false;
        this.settings = { ...this.settings, ...settings };
        this.notify();
        
        if (this.bot.chat && this.bot.chat.connected) {
            let msg = `🎰 [추첨 모집 시작] `;
            if (this.settings.mode === 'chat') {
                msg += this.settings.chatType === 'any' ? "채팅창에 아무 말이나 입력하면 자동 응모!" : `'${this.settings.chatCommand}' 입력 시 자동 응모!`;
            } else {
                msg += this.settings.donationType === 'all' ? "후원 시 자동 응모!" : `${this.settings.donationAmount}치즈 후원 시 자동 응모!`;
            }
            this.bot.chat.sendChat(msg);
        }
    }

    public endSession() {
        this.isActive = false;
        this.notify();
        if (this.bot.chat && this.bot.chat.connected) {
            this.bot.chat.sendChat(`⛔ [모집 마감] 총 ${this.candidates.size}명이 응모했습니다.`);
        }
    }

    public injectCandidatesFromVote(voters: any[]) {
        this.candidates.clear();
        voters.forEach(v => this.candidates.set(v.userIdHash, { userIdHash: v.userIdHash, nickname: v.nickname, source: 'vote' }));
        this.isActive = false;
        this.notify();
    }

    public handleChat(chat: ChatEvent) {
        if (!this.isActive || this.settings.mode !== 'chat' || this.isRolling) return;
        if (chat.profile.userIdHash === this.bot.getChannelId()) return;

        let isValid = false;
        if (this.settings.chatType === 'any') isValid = true;
        else if (this.settings.chatType === 'command' && chat.message.trim() === this.settings.chatCommand.trim()) isValid = true;

        if (isValid && !this.candidates.has(chat.profile.userIdHash)) {
            this.candidates.set(chat.profile.userIdHash, { userIdHash: chat.profile.userIdHash, nickname: chat.profile.nickname, source: 'chat' });
            this.notify();
        }
    }

    public handleDonation(donation: DonationEvent) {
        if (!this.isActive || this.settings.mode !== 'donation' || this.isRolling) return;
        
        let isValid = false;
        if (this.settings.donationType === 'all') isValid = true;
        else if (this.settings.donationType === 'specific' && donation.payAmount === this.settings.donationAmount) isValid = true;

        if (isValid && !this.candidates.has(donation.profile.userIdHash)) {
            this.candidates.set(donation.profile.userIdHash, { userIdHash: donation.profile.userIdHash, nickname: donation.profile.nickname, source: 'donation' });
            this.notify();
        }
    }

    public draw(count: number = 1) {
        const pool = Array.from(this.candidates.values());
        if (pool.length === 0) return;

        this.isActive = false;
        this.isRolling = true;
        this.winners = [];
        this.notify();

        setTimeout(() => {
            this.isRolling = false;
            const shuffled = [...pool];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            this.winners = shuffled.slice(0, Math.min(count, shuffled.length));
            this.notify();

            if (this.winners.length > 0 && this.bot.chat && this.bot.chat.connected) {
                const names = this.winners.map(w => w.nickname).join(', ');
                this.bot.chat.sendChat(`🎉 [당첨자 발표] ${names} 축하드립니다!`);
            }
        }, 3000);
    }

    public reset() {
        this.candidates.clear();
        this.winners = [];
        this.isRolling = false;
        this.isActive = false;
        this.notify();
    }

    public getState() {
        return {
            candidatesCount: this.candidates.size,
            candidates: Array.from(this.candidates.values()).reverse().slice(0, 50), 
            settings: this.settings,
            isRolling: this.isRolling,
            isActive: this.isActive,
            winners: this.winners
        };
    }
}
